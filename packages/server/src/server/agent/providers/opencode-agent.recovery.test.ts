import {
  waitForLocationReady,
  OpenCodeLocationReadyTimeoutError,
} from "./opencode/v2/readiness.js";
import { OpenCode, type SessionMessageInfo } from "@opencode/client";
import { OpenCodeV2AgentClient } from "./opencode/v2/agent.js";
import { SessionTurns } from "./opencode/v2/turns.js";
import { V2Harness } from "./opencode/test-utils/v2-harness.js";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import {
  OpenCodeEventConsumer,
  type OpenCodeEventConsumerTiming,
} from "./opencode/event-consumer.js";
import { OpenCodeServerManager } from "./opencode/server-manager.js";

test("dispatches ascending OpenCode message identifiers through the public provider path", async () => {
  const upstream = await createRecoveryUpstream();
  const fixture = await createPublicRecoverySession(upstream, new RecoveryTiming());
  const observed: AgentStreamEvent[] = [];
  fixture.session.subscribe((event) => observed.push(event));
  await upstream.connected(1);
  upstream.send(0, connectedRecord());

  await fixture.session.startTurn("first");
  await upstream.dispatched(1);
  upstream.send(0, idleRecord());
  await eventually(() =>
    expect(observed.filter((event) => event.type === "turn_completed")).toHaveLength(1),
  );
  await fixture.session.startTurn("second");
  const ids = await upstream.dispatched(2);

  expect(ids).toHaveLength(2);
  expect(ids[0]).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  expect(ids[1]).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  expect((ids[0] as string) < (ids[1] as string)).toBe(true);

  await fixture.session.close();
  await fixture.manager.shutdown();
  await upstream.close();
});

test("recovers missed output after EOF without failing the active turn", async () => {
  const upstream = await createRecoveryUpstream();
  const timing = new RecoveryTiming();
  const fixture = await createPublicRecoverySession(upstream, timing);
  const { session } = fixture;
  const observed: AgentStreamEvent[] = [];
  session.subscribe((event) => observed.push(event));

  await upstream.connected(1);
  upstream.send(0, connectedRecord());
  await session.startTurn("hello");
  const [dispatchId] = await upstream.dispatched();
  expect(upstream.messageReads()).toBe(0);
  upstream.setRecoveredMessages(dispatchId as string);
  upstream.end(0);
  await timing.waiting();
  timing.advance();
  await upstream.connected(2);
  upstream.send(1, connectedRecord());

  await eventually(() => expect(observed.map((event) => event.type)).toContain("turn_completed"));
  expect(observed.filter((event) => event.type === "turn_started")).toHaveLength(1);
  expect(observed.filter((event) => event.type === "turn_failed")).toHaveLength(0);
  const assistantTexts = observed.flatMap((event) =>
    event.type === "timeline" && event.item.type === "assistant_message" ? [event.item.text] : [],
  );
  expect(assistantTexts).toHaveLength(52);
  expect(assistantTexts.at(-1)).toBe("recovered output");
  expect(assistantTexts).not.toContain("before boundary");
  expect(upstream.messageReads()).toBe(1);

  await session.close();
  await fixture.manager.shutdown();
  await upstream.close();
});

test("orders queued live deltas behind an incomplete recovery snapshot and suppresses late output", async () => {
  const upstream = await createRecoveryUpstream();
  const timing = new RecoveryTiming();
  const fixture = await createPublicRecoverySession(upstream, timing);
  const { session } = fixture;
  const observed: AgentStreamEvent[] = [];
  session.subscribe((event) => observed.push(event));

  await upstream.connected(1);
  upstream.send(0, connectedRecord());
  await session.startTurn("hello");
  const [dispatchId] = await upstream.dispatched();
  upstream.send(0, assistantMessageRecord("message-race"));
  upstream.send(0, textDeltaRecord("message-race", "part-race", "Hello"));
  await eventually(() => expect(assistantText(observed)).toEqual(["Hello"]));

  upstream.setStatus("busy");
  upstream.setMessages([
    { info: { id: dispatchId as string, sessionID: "session-1", role: "user" }, parts: [] },
    {
      info: { id: "message-race", sessionID: "session-1", role: "assistant" },
      parts: [
        {
          id: "part-race",
          sessionID: "session-1",
          messageID: "message-race",
          type: "text",
          text: "",
          time: { start: 1 },
        },
      ],
    },
  ]);
  upstream.end(0);
  await timing.waiting();
  timing.advance();
  await upstream.connected(2);
  upstream.send(1, connectedRecord());
  upstream.send(1, textDeltaRecord("message-race", "part-race", " world"));
  await eventually(() => expect(assistantText(observed)).toEqual(["Hello", " world"]));

  upstream.setMessages([
    {
      info: {
        id: "message-race",
        sessionID: "session-1",
        role: "assistant",
        time: { created: 1, completed: 2 },
      },
      parts: [
        {
          id: "part-race",
          sessionID: "session-1",
          messageID: "message-race",
          type: "text",
          text: "Hello world!",
          time: { start: 1, end: 2 },
        },
      ],
    },
  ]);
  upstream.send(1, finalTextRecord("message-race", "part-race", "Hello world!"));
  upstream.send(1, {
    directory: "/workspace",
    payload: {
      type: "session.status",
      properties: { sessionID: "session-1", status: { type: "idle" } },
    },
  });
  upstream.send(1, textDeltaRecord("message-race", "part-race", " too late"));

  await eventually(() =>
    expect(observed.filter((event) => event.type === "turn_completed")).toHaveLength(1),
  );
  expect(observed.filter((event) => event.type === "turn_started")).toHaveLength(1);
  expect(observed.filter((event) => event.type === "turn_failed")).toHaveLength(0);
  expect(observed.filter((event) => event.type === "turn_canceled")).toHaveLength(0);
  expect(assistantText(observed)).toEqual(["Hello", " world", "!"]);
  expect(assistantText(observed).join("")).toBe("Hello world!");
  const ordered = observed.flatMap((event) => {
    if (event.type === "turn_started" || event.type === "turn_completed") return [event.type];
    if (event.type === "timeline" && event.item.type === "assistant_message") {
      return [event.item.text];
    }
    return [];
  });
  expect(ordered).toEqual(["turn_started", "Hello", " world", "!", "turn_completed"]);

  await session.close();
  await fixture.manager.shutdown();
  await upstream.close();
});

class RecoveryTiming implements OpenCodeEventConsumerTiming {
  private resolveWait: (() => void) | null = null;
  arm(): () => void {
    return () => undefined;
  }
  wait(_delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      this.resolveWait = resolve;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
  async waiting(): Promise<void> {
    await eventually(() => expect(this.resolveWait).not.toBeNull());
  }
  advance(): void {
    this.resolveWait?.();
    this.resolveWait = null;
  }
}

async function createPublicRecoverySession(
  upstream: Awaited<ReturnType<typeof createRecoveryUpstream>>,
  timing: OpenCodeEventConsumerTiming,
) {
  let serverProcess: RecoveryServerProcess | null = null;
  const manager = new OpenCodeServerManager({
    logger: createTestLogger(),
    portAllocator: async () => upstream.port,
    resolveCommandPrefix: async () => ({ command: "opencode", args: [] }),
    resolveHomeDir: () => process.cwd(),
    spawnServerProcess: () => {
      serverProcess = new RecoveryServerProcess();
      return serverProcess as unknown as ChildProcess;
    },
    terminateProcess: async () => {
      serverProcess?.exit();
      return "terminated";
    },
    createEventSource: (options) => new OpenCodeEventConsumer({ ...options, timing }),
  });
  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: manager,
    createClient: ({ baseUrl, directory }) => createOpencodeClient({ baseUrl, directory }),
  });
  const session = await client.createSession({ provider: "opencode", cwd: "/workspace" });
  return { manager, session };
}

class RecoveryServerProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid = 42_001;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor() {
    super();
    queueMicrotask(() => this.stdout.emit("data", Buffer.from("listening on test server\n")));
  }

  exit(): void {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}

async function createRecoveryUpstream() {
  const streams: ServerResponse[] = [];
  const dispatchIds: string[] = [];
  let messages: unknown[] = [];
  let messageReadCount = 0;
  let status: "busy" | "idle" = "idle";
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.url?.startsWith("/global/event")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      streams.push(response);
      return;
    }
    if (request.method === "POST" && pathname === "/session") {
      return json(response, { id: "session-1", directory: "/workspace" });
    }
    if (request.url?.includes("/prompt_async")) {
      const body = JSON.parse(await readBody(request)) as { messageID: string };
      dispatchIds.push(body.messageID);
      return json(response, {});
    }
    if (request.url?.includes("/message")) {
      messageReadCount += 1;
      return json(response, messages);
    }
    if (request.url?.includes("/status"))
      return json(response, status === "busy" ? { "session-1": { type: "busy" } } : {});
    return json(response, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    connected: async (count: number) => eventually(() => expect(streams).toHaveLength(count)),
    send(index: number, value: unknown) {
      streams[index]?.write(`data: ${JSON.stringify(value)}\n\n`);
    },
    end(index: number) {
      streams[index]?.end();
    },
    dispatched: async (count = 1) => {
      await eventually(() => expect(dispatchIds).toHaveLength(count));
      return [...dispatchIds];
    },
    messageReads: () => messageReadCount,
    setMessages(nextMessages: unknown[]) {
      messages = nextMessages;
    },
    setStatus(nextStatus: "busy" | "idle") {
      status = nextStatus;
    },
    setRecoveredMessages(messageId: string) {
      messages = [
        {
          info: {
            id: "msg_before_boundary",
            sessionID: "session-1",
            role: "assistant",
            time: { created: 1, completed: 2 },
          },
          parts: [
            {
              id: "part-before",
              sessionID: "session-1",
              messageID: "msg_before_boundary",
              type: "text",
              text: "before boundary",
              time: { start: 1, end: 2 },
            },
          ],
        },
        {
          info: { id: messageId, sessionID: "session-1", role: "user" },
          parts: [],
        },
        ...Array.from({ length: 51 }, (_, index) => ({
          info: {
            id: `msg_step_${index}`,
            sessionID: "session-1",
            role: "assistant",
            time: { created: index + 3, completed: index + 4 },
          },
          parts: [
            {
              id: `part-step-${index}`,
              sessionID: "session-1",
              messageID: `msg_step_${index}`,
              type: "text",
              text: `step ${index}`,
              time: { start: index + 3, end: index + 4 },
            },
          ],
        })),
        {
          info: { id: "msg_compaction", sessionID: "session-1", role: "user" },
          parts: [
            {
              id: "part-compaction",
              sessionID: "session-1",
              messageID: "msg_compaction",
              type: "compaction",
              auto: true,
            },
          ],
        },
        {
          info: {
            id: "msg_assistant",
            sessionID: "session-1",
            role: "assistant",
            time: { created: 1, completed: 2 },
          },
          parts: [
            {
              id: "part-1",
              sessionID: "session-1",
              messageID: "msg_assistant",
              type: "text",
              text: "recovered output",
              time: { start: 1, end: 2 },
            },
          ],
        },
      ];
    },
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function assistantMessageRecord(messageId: string) {
  return {
    directory: "/workspace",
    payload: {
      type: "message.updated",
      properties: { info: { id: messageId, sessionID: "session-1", role: "assistant" } },
    },
  };
}

function textDeltaRecord(messageId: string, partId: string, delta: string) {
  return {
    directory: "/workspace",
    payload: {
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: messageId,
        partID: partId,
        field: "text",
        delta,
      },
    },
  };
}

function finalTextRecord(messageId: string, partId: string, text: string) {
  return {
    directory: "/workspace",
    payload: {
      type: "message.part.updated",
      properties: {
        part: {
          id: partId,
          sessionID: "session-1",
          messageID: messageId,
          type: "text",
          text,
          time: { start: 1, end: 2 },
        },
      },
    },
  };
}

function assistantText(events: AgentStreamEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "timeline" && event.item.type === "assistant_message" ? [event.item.text] : [],
  );
}

function connectedRecord() {
  return { directory: "/workspace", payload: { type: "server.connected", properties: {} } };
}

function idleRecord() {
  return {
    directory: "/workspace",
    payload: {
      type: "session.status",
      properties: { sessionID: "session-1", status: { type: "idle" } },
    },
  };
}

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  assertion();
}

describe("OpenCode v2 lifecycle", () => {
  test.each([false, true])(
    "does not renew a late transport rejection when session cancellation is %s",
    async (cancelSession) => {
      const harness = new V2Harness();
      const abort = new AbortController();
      let signal: AbortSignal | null | undefined;
      let rejectFetch!: (reason: unknown) => void;
      let waits = 0;
      const upstream = OpenCode.make({
        baseUrl: "http://127.0.0.1:1",
        fetch: async (_request, init) => {
          waits++;
          if (waits > 1) return new Response(null, { status: 204 });
          signal = init?.signal;
          return new Promise<Response>((_resolve, reject) => {
            rejectFetch = reject;
          });
        },
      });
      harness.wait = upstream.session.wait;
      const events: AgentStreamEvent[] = [];
      const turns = new SessionTurns({
        client: harness.api,
        id: "session",
        cwd: "/tmp/project",
        signal: abort.signal,
        emit: (event) => events.push(event),
        reconcile: async () => ({ info: harness.info, history: [] }),
        clearPermissions: async () => {},
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await turns.startTurn("synthetic prompt");
        await vi.advanceTimersByTimeAsync(240_001);
        expect(signal?.aborted).toBe(true);
        if (cancelSession) abort.abort(new Error("session stopped"));
        // Equal messages are not equal causes. In the cancellation case, even the
        // exact SDK-wrapped renewal must lose to the session's own abort reason.
        rejectFetch(cancelSession ? signal?.reason : new Error(signal?.reason.message));
        await vi.advanceTimersByTimeAsync(0);
        expect(waits).toBe(1);
        expect(events.filter((event) => event.type === "turn_failed")).toEqual([
          expect.objectContaining({
            error: cancelSession
              ? "session stopped"
              : "Transport\ncaused by: OpenCode idle wait renewal",
          }),
        ]);
        expect(events.filter((event) => event.type === "turn_completed")).toEqual([]);
      } finally {
        abort.abort();
        vi.useRealTimers();
      }
    },
  );

  test("propagates an SDK 503 decoded after the renewal deadline without retrying the wait", async () => {
    const harness = new V2Harness();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    let signal: AbortSignal | null | undefined;
    let waits = 0;
    const upstream = OpenCode.make({
      baseUrl: "http://127.0.0.1:1",
      fetch: async (_request, init) => {
        waits++;
        if (waits > 1) return new Response(null, { status: 204 });
        signal = init?.signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller;
            },
          }),
          {
            status: 503,
            headers: { "content-type": "application/json" },
          },
        );
      },
    });
    harness.wait = upstream.session.wait;
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await session.startTurn("synthetic prompt");
      await vi.advanceTimersByTimeAsync(240_001);
      expect(signal?.aborted).toBe(true);
      body.enqueue(
        new TextEncoder().encode(
          JSON.stringify({ _tag: "ServiceUnavailableError", message: "fixture wait unavailable" }),
        ),
      );
      body.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(waits).toBe(1);
      expect(events.filter((event) => event.type === "turn_failed")).toEqual([
        expect.objectContaining({ error: expect.stringContaining("fixture wait unavailable") }),
      ]);
      expect(events.filter((event) => event.type === "turn_completed")).toEqual([]);
      expect(harness.prompts).toEqual(["synthetic prompt"]);
    } finally {
      await session.close();
      vi.useRealTimers();
    }
  });

  test("keeps a question-blocked turn alive beyond the HTTP headers deadline without resubmitting", async () => {
    const harness = new V2Harness();
    let settle!: () => void;
    let waits = 0;
    let replyCount = 0;
    const upstream = OpenCode.make({
      baseUrl: "http://127.0.0.1:1",
      fetch: async (_request, init) => {
        waits++;
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new TypeError("fetch failed", {
                  cause: Object.assign(new Error("Headers Timeout Error"), {
                    code: "UND_ERR_HEADERS_TIMEOUT",
                  }),
                }),
              ),
            300_000,
          );
          const abort = () => {
            clearTimeout(timer);
            reject(init?.signal?.reason);
          };
          init?.signal?.addEventListener("abort", abort, { once: true });
          settle = () => {
            clearTimeout(timer);
            init?.signal?.removeEventListener("abort", abort);
            resolve(new Response(null, { status: 204 }));
          };
        });
      },
    });
    harness.wait = upstream.session.wait;
    harness.api.session.form.list = async () =>
      replyCount
        ? []
        : [
            {
              id: "question",
              sessionID: "session",
              title: "Choose",
              fields: [
                { key: "color", type: "string", options: [{ label: "Blue", value: "blue" }] },
              ],
            },
          ];
    harness.api.session.form.reply = async () => {
      replyCount++;
      settle();
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await session.startTurn("synthetic question");
      await vi.advanceTimersByTimeAsync(600_000);
      expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
      expect(waits).toBeGreaterThan(1);
      expect(harness.prompts).toEqual(["synthetic question"]);
      expect(session.getPendingPermissions()).toHaveLength(1);
      await session.respondToPermission("question", {
        behavior: "allow",
        updatedInput: { answers: { color: "Blue" } },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(replyCount).toBe(1);
      expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
      expect(session.getPendingPermissions()).toEqual([]);
    } finally {
      await session.close();
      vi.useRealTimers();
    }
  });

  test("fails initialization when the event stream ends before connecting", async () => {
    const harness = new V2Harness();
    harness.api.event.subscribe = async function* () {};
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    await expect(
      client.createSession({ provider: "opencode", cwd: "/tmp/project" }),
    ).rejects.toThrow("event stream ended before connecting");
    expect(harness.releases).toBeGreaterThan(0);
  });

  test("does not retry a failed idle wait or replay its accepted prompt", async () => {
    const harness = new V2Harness();
    let waits = 0;
    harness.wait = async () => {
      waits++;
      throw new Error("wait transport disconnected");
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await expect(session.run("synthetic prompt")).rejects.toThrow("wait transport disconnected");
      expect(waits).toBe(1);
      expect(harness.prompts).toEqual(["synthetic prompt"]);
    } finally {
      await session.close();
    }
  });

  test("closing a session aborts its idle wait without renewing it", async () => {
    const harness = new V2Harness();
    let waits = 0;
    let cancellations = 0;
    harness.wait = async (_input, options) =>
      new Promise<void>((_resolve, reject) => {
        waits++;
        options?.signal?.addEventListener(
          "abort",
          () => {
            cancellations++;
            reject(options.signal?.reason);
          },
          { once: true },
        );
      });
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await session.startTurn("synthetic prompt");
      await vi.advanceTimersByTimeAsync(0);
      expect(waits).toBe(1);
      await session.close();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(cancellations).toBe(1);
      expect(waits).toBe(1);
      expect(harness.prompts).toEqual(["synthetic prompt"]);
    } finally {
      await session.close();
      vi.useRealTimers();
    }
  });

  test("returns only validated structured output and preserves it in history", async () => {
    const harness = new V2Harness();
    harness.prompt = async (input) => {
      harness.history.push({
        id: "user",
        type: "user",
        text: input.text,
        metadata: input.metadata,
        time: { created: 1 },
      });
      harness.history.push({
        id: "answer",
        type: "assistant",
        agent: "build",
        model: { providerID: "test", id: "model" },
        time: { created: 2 },
        content: [
          { type: "text", text: "Here is the answer" },
          {
            type: "tool",
            id: "output",
            name: "paseo_structured_output",
            time: { created: 2 },
            state: {
              status: "completed",
              input: { value: { answer: 42 } },
              content: [{ type: "text", text: "accepted" }],
              metadata: { paseoStructuredOutput: { answer: 42 } },
            },
          },
        ],
      });
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      const result = await session.run("answer", {
        outputSchema: {
          type: "object",
          properties: { answer: { const: 42 } },
          required: ["answer"],
        },
      });
      expect(result.finalText).toBe('{"answer":42}');
      const history = [];
      for await (const event of session.streamHistory!()) history.push(event);
      expect(history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "timeline",
            item: expect.objectContaining({ type: "assistant_message", text: result.finalText }),
          }),
        ]),
      );
    } finally {
      await session.close();
    }
  });

  test("fails a structured turn when the model omits the validated output tool", async () => {
    const harness = new V2Harness();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await expect(session.run("answer", { outputSchema: { type: "object" } })).rejects.toThrow(
        "without submitting the required structured output",
      );
    } finally {
      await session.close();
    }
  });

  test("resumes the native session ID and never replaces a missing session", async () => {
    const harness = new V2Harness();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const handle = {
      provider: "opencode",
      sessionId: "session",
      nativeHandle: "session",
      metadata: { cwd: "/tmp/project" },
    } as const;
    harness.api.session.switchAgent = async ({ agent }) => {
      harness.info.agent = agent;
    };
    harness.api.session.switchModel = async ({ model }) => {
      harness.info.model = model;
    };
    const session = await client.resumeSession(handle, {
      modeId: "plan",
      model: "synthetic/test",
      thinkingOptionId: "low",
    });
    try {
      expect(await session.getRuntimeInfo!()).toMatchObject({
        modeId: "plan",
        model: "synthetic/test",
        thinkingOptionId: "low",
      });
      expect(await session.describePersistence()).toMatchObject({
        sessionId: "session",
        nativeHandle: "session",
      });
      expect(harness.creates).toEqual([]);
    } finally {
      await session.close();
    }
    harness.api.session.get = async () => {
      throw new Error("Session not found");
    };
    await expect(client.resumeSession(handle)).rejects.toThrow("Session not found");
    expect(harness.creates).toEqual([]);
  });

  test("reconciles reconnect snapshots without replaying text or losing repeated chunks", async () => {
    const harness = new V2Harness();
    let finish!: () => void;
    harness.wait = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const chunks: string[] = [];
    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "assistant_message")
        chunks.push(event.item.text);
    });
    try {
      const running = session.run("laugh");
      await expect.poll(() => typeof finish).toBe("function");
      const answer = {
        id: "answer",
        type: "assistant",
        agent: "build",
        model: { providerID: "test", id: "model" },
        time: { created: 2 },
        content: [{ type: "text", text: "ha" }],
      } satisfies SessionMessageInfo;
      harness.history.push(answer);
      harness.push({ id: "reconnect-1", created: 2, type: "server.connected", data: {} });
      await expect.poll(() => chunks).toEqual(["ha"]);
      answer.content[0].text = "haha";
      harness.push({ id: "reconnect-2", created: 3, type: "server.connected", data: {} });
      await expect.poll(() => chunks).toEqual(["ha", "ha"]);
      finish();
      expect((await running).finalText).toBe("haha");
      expect(chunks).toEqual(["ha", "ha"]);
    } finally {
      await session.close();
    }
  });

  test("reports a terminal failure when reading the execution error fails", async () => {
    const harness = new V2Harness();
    harness.info.outcome = "failed";
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("hello");
      const failures = () => events.filter((event) => event.type === "turn_failed");
      await expect.poll(failures).toHaveLength(1);
      expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(0);
    } finally {
      await session.close();
    }
  });

  test("waits for prompt acceptance before interrupting", async () => {
    const harness = new V2Harness();
    let accept!: () => void;
    let settle!: () => void;
    let interruptions = 0;
    harness.prompt = () =>
      new Promise<void>((resolve) => {
        accept = resolve;
      });
    harness.wait = () =>
      new Promise<void>((resolve) => {
        settle = resolve;
      });
    harness.interrupt = async () => {
      interruptions += 1;
      harness.info.outcome = "interrupted";
      settle();
      return { interrupted: true };
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await session.startTurn("first");
      const stopping = session.interrupt();
      await Promise.resolve();
      expect(interruptions).toBe(0);
      accept();
      await stopping;
      expect(interruptions).toBe(1);
    } finally {
      await session.close();
    }
  });

  test("completes a submitted turn once and reconciles its final text", async () => {
    const harness = new V2Harness();
    harness.prompt = async (input) => {
      harness.prompts.push(input.text);
      harness.history.push({
        id: "answer",
        type: "assistant",
        agent: "build",
        model: { providerID: "test", id: "model" },
        time: { created: 2 },
        content: [{ type: "text", text: "done" }],
      });
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      const result = await session.run("hello");
      expect(result.finalText).toBe("done");
      expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
      expect(harness.creates[0]).toMatchObject({
        agent: "build",
        location: { directory: "/tmp/project" },
      });
    } finally {
      await session.close();
    }
    expect(harness.releases).toBe(1);
  });

  test("waits for interruption settlement before submitting replacement work", async () => {
    const harness = new V2Harness();
    let finishFirst!: () => void;
    let finishStop!: () => void;
    harness.wait = () =>
      new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
    harness.interrupt = () =>
      new Promise((resolve) => {
        finishStop = () => {
          harness.info.outcome = "interrupted";
          finishFirst();
          resolve({ interrupted: true });
        };
      });
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await session.startTurn("first");
      await expect.poll(() => typeof finishFirst).toBe("function");
      const stopping = session.interrupt();
      const replacement = session.startTurn("second");
      await Promise.resolve();
      expect(harness.prompts).toEqual(["first"]);
      harness.wait = async () => undefined;
      finishStop();
      await stopping;
      await replacement;
      await expect.poll(() => harness.prompts).toEqual(["first", "second"]);
    } finally {
      await session.close();
    }
  });

  test("reuses the shared helper for sessions whose env is only agent identity", async () => {
    const harness = new V2Harness();
    const acquires: Array<{ env?: Record<string, string>; dedicated?: boolean }> = [];
    const runtime = {
      acquire: async (input: { env?: Record<string, string>; dedicated?: boolean } = {}) => {
        acquires.push(input);
        return harness.connection;
      },
      shutdown: async () => undefined,
    };
    const client = new OpenCodeV2AgentClient({ logger: createTestLogger(), runtime });
    const session = await client.createSession(
      { provider: "opencode", cwd: "/tmp/project" },
      { agentId: "agent", env: { PASEO_AGENT_ID: "agent", PASEO_AGENT_CWD: "/tmp/project" } },
    );
    try {
      expect(acquires).toEqual([{}]);
      expect(harness.environments).toEqual([
        {
          sessionID: "session",
          variables: { PASEO_AGENT_ID: "agent", PASEO_AGENT_CWD: "/tmp/project" },
        },
      ]);
    } finally {
      await session.close();
    }
  });

  test("starts a dedicated helper when the session carries custom MCP", async () => {
    const harness = new V2Harness();
    const acquires: Array<{ env?: Record<string, string>; dedicated?: boolean }> = [];
    const runtime = {
      acquire: async (input: { env?: Record<string, string>; dedicated?: boolean } = {}) => {
        acquires.push(input);
        return harness.connection;
      },
      shutdown: async () => undefined,
    };
    const client = new OpenCodeV2AgentClient({ logger: createTestLogger(), runtime });
    const session = await client.createSession(
      {
        provider: "opencode",
        cwd: "/tmp/project",
        mcpServers: { custom: { type: "stdio", command: "custom", args: [] } },
      },
      { agentId: "agent", env: { PASEO_AGENT_ID: "agent", PASEO_AGENT_CWD: "/tmp/project" } },
    );
    try {
      expect(acquires).toHaveLength(1);
      expect(acquires[0]?.dedicated).toBe(true);
    } finally {
      await session.close();
    }
  });

  test("fails location readiness when the plugin inventory never populates", async () => {
    await expect(
      waitForLocationReady({
        client: { plugin: { list: async () => ({ location: { directory: "/tmp" }, data: [] }) } },
        location: { directory: "/tmp" },
        timeoutMs: 25,
      }),
    ).rejects.toBeInstanceOf(OpenCodeLocationReadyTimeoutError);
  });

  test("bounds location readiness even when the inventory request never settles", async () => {
    await expect(
      waitForLocationReady({
        client: { plugin: { list: () => new Promise(() => undefined) } },
        location: { directory: "/tmp" },
        timeoutMs: 25,
      }),
    ).rejects.toBeInstanceOf(OpenCodeLocationReadyTimeoutError);
  });

  test("preserves inventory errors instead of reporting a readiness timeout", async () => {
    const error = new Error("inventory unavailable");
    await expect(
      waitForLocationReady({
        client: {
          plugin: {
            list: async () => {
              throw error;
            },
          },
        },
        location: { directory: "/tmp" },
      }),
    ).rejects.toBe(error);
  });

  test("refuses replacement work after a failed stop until Stop succeeds", async () => {
    const harness = new V2Harness();
    let finishFirst!: () => void;
    harness.wait = () =>
      new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
    harness.interrupt = async () => {
      throw new Error("stop failed");
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await session.startTurn("first");
      await expect.poll(() => typeof finishFirst).toBe("function");
      await expect(session.interrupt()).rejects.toThrow("stop failed");
      await expect(session.startTurn("unsafe replacement")).rejects.toThrow("stop failed");
      expect(harness.prompts).toEqual(["first"]);
      harness.interrupt = async () => {
        finishFirst();
        return { interrupted: true };
      };
      await session.interrupt();
      harness.wait = async () => undefined;
      await session.startTurn("retry");
      await expect.poll(() => harness.prompts).toEqual(["first", "retry"]);
    } finally {
      await session.close();
    }
  });
});
