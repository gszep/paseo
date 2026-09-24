import { V2Timeline } from "./timeline.js";
import type { ModelInfo, SessionMessageAssistant } from "@opencode/client";
import { describe, expect, test, vi } from "vitest";
import { applyResumeOverrides } from "./configuration.js";
import { OpenCodeV2AgentClient } from "./agent.js";
import { V2Harness } from "../test-utils/v2-harness.js";
import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import type { AgentStreamEvent, AgentUsage } from "../../../agent-sdk-types.js";

function collectAssistantText(session: {
  subscribe: (cb: (e: AgentStreamEvent) => void) => () => void;
}) {
  const chunks: string[] = [];
  session.subscribe((event) => {
    if (event.type === "timeline" && event.item.type === "assistant_message")
      chunks.push(event.item.text);
  });
  return chunks;
}

describe("OpenCode v2 resume configuration", () => {
  test("importing a verified fork does not append a same-agent or same-model switch", async () => {
    const harness = new V2Harness();
    harness.info.model = { providerID: "fixture", id: "local", variant: "default" };
    harness.history.push({
      id: "msg_pin",
      type: "user",
      text: "pinned transfer",
      time: { created: 1 },
      files: [],
    });
    const original = structuredClone(harness.history);
    const agentSwitch = vi
      .spyOn(harness.api.session, "switchAgent")
      .mockImplementation(async (input) => {
        harness.history.push({
          id: "msg_switch",
          type: "agent-switched",
          agent: input.agent,
          previous: "build",
          time: { created: 2 },
        });
      });
    const modelSwitch = vi.spyOn(harness.api.session, "switchModel").mockResolvedValue(undefined);
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const config = { provider: "opencode" as const, cwd: "/tmp/project" };
    const imported = await client.importSession(
      { providerHandleId: harness.info.id, cwd: config.cwd },
      { config, storedConfig: config },
    );
    try {
      expect(harness.history).toEqual(original);
      expect(agentSwitch).not.toHaveBeenCalled();
      expect(modelSwitch).not.toHaveBeenCalled();
      expect(harness.prompts).toEqual([]);
    } finally {
      await imported.session.close();
    }
  });

  test("explicit changed mode/model/variant still applies once, then unchanged resume is read-only", async () => {
    const harness = new V2Harness();
    harness.info.model = { providerID: "fixture", id: "local", variant: "default" };
    const agentSwitch = vi.spyOn(harness.api.session, "switchAgent").mockResolvedValue(undefined);
    const modelSwitch = vi.spyOn(harness.api.session, "switchModel").mockResolvedValue(undefined);
    const overrides = { modeId: "plan", model: "fixture/other", thinkingOptionId: "high" };
    await applyResumeOverrides(harness.api, harness.info, overrides);
    expect(agentSwitch).toHaveBeenCalledWith({ sessionID: harness.info.id, agent: "plan" });
    expect(modelSwitch).toHaveBeenCalledWith({
      sessionID: harness.info.id,
      model: { providerID: "fixture", id: "other", variant: "high" },
    });
    await applyResumeOverrides(harness.api, harness.info, overrides);
    expect(agentSwitch).toHaveBeenCalledTimes(1);
    expect(modelSwitch).toHaveBeenCalledTimes(1);
    await applyResumeOverrides(harness.api, harness.info, { thinkingOptionId: "low" });
    expect(modelSwitch).toHaveBeenCalledTimes(2);
    expect(harness.info.model.variant).toBe("low");
  });
});

function assistant(content: SessionMessageAssistant["content"]): SessionMessageAssistant {
  return {
    id: "answer",
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "model" },
    time: { created: 2 },
    content,
  };
}

function contextModel(id = "model", context = 200_000): ModelInfo {
  return {
    id,
    modelID: id,
    providerID: "test",
    name: id,
    enabled: true,
    status: "active",
    time: { released: 0 },
    variants: [{ id: "high" }],
    cost: [],
    limit: { context, output: 8_000 },
    capabilities: { input: ["text"], output: ["text"], tools: true },
  };
}

describe("OpenCode v2 context usage", () => {
  test("restores the last measured assistant on resume without running a turn or counting lifetime usage", async () => {
    const harness = new V2Harness();
    harness.models.push(contextModel());
    harness.info.tokens = {
      input: 5_448_234,
      output: 275_013,
      reasoning: 7,
      cache: { read: 210_907_392, write: 800 },
    };
    harness.info.cost = 12;
    harness.history.push(
      {
        ...assistant([]),
        id: "previous",
        tokens: { input: 400, output: 200, reasoning: 10, cache: { read: 1_000, write: 50 } },
      },
      {
        ...assistant([]),
        model: { providerID: "test", id: "model", variant: "high" },
        tokens: { input: 618, output: 586, reasoning: 30, cache: { read: 191_616, write: 150 } },
      },
      { ...assistant([]), id: "streaming" },
    );
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.resumeSession({
      provider: "opencode",
      sessionId: harness.info.id,
      metadata: { cwd: "/tmp/project" },
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });
    try {
      expect((await session.getRuntimeInfo()).usage).toEqual({
        inputTokens: 5_448_234,
        outputTokens: 275_013,
        cachedInputTokens: 210_907_392,
        totalCostUsd: 12,
        contextWindowUsedTokens: 193_000,
        contextWindowMaxTokens: 200_000,
      });
      expect(events).toEqual([]);
      expect(harness.prompts).toEqual([]);
    } finally {
      await session.close();
    }
  });

  test("publishes completed native steps while the Paseo turn is still running, then returns the same usage at completion", async () => {
    const harness = new V2Harness();
    harness.models.push(contextModel());
    let settle!: () => void;
    harness.wait = () =>
      new Promise<void>((resolve) => {
        settle = resolve;
      });
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const usage: AgentUsage[] = [(await session.getRuntimeInfo()).usage!];
    session.subscribe((event) => {
      if (event.type === "usage_updated") usage.push(event.usage);
    });
    try {
      let finished = false;
      const result = session.run("fixture").then((value) => {
        finished = true;
        return value;
      });
      await expect.poll(() => harness.prompts).toEqual(["fixture"]);
      const tokens = { input: 100, output: 20, reasoning: 10, cache: { read: 200, write: 30 } };
      harness.history.push({ ...assistant([]), tokens });
      harness.push({
        id: "step",
        created: 3,
        type: "session.step.ended",
        durable: { aggregateID: "session", seq: 1, version: 1 },
        data: {
          sessionID: "session",
          assistantMessageID: "answer",
          finish: "tool-calls",
          cost: 0,
          tokens,
        },
      });
      const measured = {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        totalCostUsd: 0,
        contextWindowUsedTokens: 360,
        contextWindowMaxTokens: 200_000,
      };
      await expect.poll(() => usage.at(-1)).toEqual(measured);
      expect(finished).toBe(false);
      // The next in-flight assistant has no measurement yet.
      harness.history.push({ ...assistant([]), id: "next" });
      await session.getRuntimeInfo();
      expect(usage.at(-1)).toEqual(measured);
      expect(usage).toHaveLength(2);
      settle();
      expect((await result).usage).toEqual(measured);
    } finally {
      await session.close();
    }
  });

  test("clears a completed compaction's old measurement, then recovers from a post-compaction assistant", async () => {
    const harness = new V2Harness();
    harness.models.push(contextModel());
    const tokens = { input: 1_000, output: 100, reasoning: 50, cache: { read: 100, write: 0 } };
    harness.history.push({ ...assistant([]), tokens });
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const usage: AgentUsage[] = [(await session.getRuntimeInfo()).usage!];
    session.subscribe((event) => {
      if (event.type === "usage_updated") usage.push(event.usage);
    });
    const totals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalCostUsd: 0 };
    try {
      expect(usage.at(-1)).toEqual({
        ...totals,
        contextWindowUsedTokens: 1_250,
        contextWindowMaxTokens: 200_000,
      });
      harness.history.push({
        id: "compact",
        type: "compaction",
        status: "running",
        reason: "auto",
        time: { created: 3 },
      });
      await session.getRuntimeInfo();
      expect(usage).toHaveLength(1);
      harness.history[1] = {
        id: "compact",
        type: "compaction",
        status: "failed",
        reason: "auto",
        time: { created: 3 },
        error: { type: "fixture", message: "fixture failure" },
      };
      await session.getRuntimeInfo();
      expect(usage).toHaveLength(1);
      const compact = {
        id: "compact",
        type: "compaction",
        status: "completed",
        reason: "auto",
        time: { created: 3 },
        summary: "fixture summary",
        recent: "",
        tokens,
      } as const;
      harness.history[1] = compact;
      harness.push({
        id: "compacted",
        created: 4,
        type: "session.compaction.ended",
        durable: { aggregateID: "session", seq: 2, version: 1 },
        data: {
          sessionID: "session",
          reason: "auto",
          text: compact.summary,
          recent: compact.recent,
          tokens,
        },
      });
      await expect.poll(() => usage.at(-1)).toEqual(totals);
      harness.history.push({ ...assistant([]), id: "after", tokens: { ...tokens, input: 200 } });
      await session.getRuntimeInfo();
      expect(usage.at(-1)).toEqual({
        ...totals,
        contextWindowUsedTokens: 450,
        contextWindowMaxTokens: 200_000,
      });
      expect(harness.prompts).toEqual([]);
    } finally {
      await session.close();
    }
  });

  test("rewind measures strictly before its boundary and fails closed when that boundary is missing", async () => {
    const harness = new V2Harness();
    harness.models.push(contextModel());
    const tokens = { input: 100, output: 20, reasoning: 10, cache: { read: 200, write: 30 } };
    harness.history.push(
      { ...assistant([]), id: "before", tokens },
      { id: "boundary", type: "user", text: "fixture", time: { created: 3 }, files: [] },
      {
        id: "compact",
        type: "compaction",
        status: "completed",
        reason: "manual",
        time: { created: 4 },
        summary: "fixture",
        recent: "",
      },
      { ...assistant([]), id: "after", tokens: { ...tokens, input: 800 } },
    );
    harness.info.revert = { messageID: "boundary" };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.resumeSession({
      provider: "opencode",
      sessionId: harness.info.id,
      metadata: { cwd: "/tmp/project" },
    });
    const usage: AgentUsage[] = [(await session.getRuntimeInfo()).usage!];
    session.subscribe((event) => {
      if (event.type === "usage_updated") usage.push(event.usage);
    });
    const totals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalCostUsd: 0 };
    try {
      expect(usage.at(-1)).toEqual({
        ...totals,
        contextWindowUsedTokens: 360,
        contextWindowMaxTokens: 200_000,
      });
      harness.info.revert = { messageID: "missing" };
      await session.getRuntimeInfo();
      expect(usage.at(-1)).toEqual(totals);
      harness.info.revert = { messageID: "before" };
      await session.getRuntimeInfo();
      expect(usage.at(-1)).toEqual(totals);
      delete harness.info.revert;
      await session.getRuntimeInfo();
      expect(usage.at(-1)).toEqual({
        ...totals,
        contextWindowUsedTokens: 1_060,
        contextWindowMaxTokens: 200_000,
      });
      // Native revert commit removes the boundary and suffix from history.
      harness.api.session.revert.stage = async (input) => {
        harness.info.revert = { messageID: input.messageID };
        return { messageID: input.messageID };
      };
      harness.api.session.revert.commit = async () => {
        harness.history.splice(1);
        delete harness.info.revert;
      };
      await session.revertBoth!({ messageId: "boundary" });
      expect(usage.at(-1)).toEqual({
        ...totals,
        contextWindowUsedTokens: 360,
        contextWindowMaxTokens: 200_000,
      });
    } finally {
      await session.close();
    }
  });

  test("pairs a measurement with its actual model's limit across selected-model and variant changes", async () => {
    const harness = new V2Harness();
    harness.models.push(contextModel(), contextModel("other", 1_000_000));
    const tokens = { input: 100, output: 20, reasoning: 10, cache: { read: 200, write: 30 } };
    harness.history.push({ ...assistant([]), tokens });
    harness.api.session.switchModel = async ({ model }) => {
      harness.info.model = model;
    };
    harness.api.model.default = async () => ({
      location: harness.info.location,
      data: { providerID: "test", id: "other" },
    });
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const usage: AgentUsage[] = [(await session.getRuntimeInfo()).usage!];
    session.subscribe((event) => {
      if (event.type === "usage_updated") usage.push(event.usage);
    });
    const totals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalCostUsd: 0 };
    try {
      await session.setModel!(null);
      // This is still the last native measurement, not an estimate for the newly selected model.
      expect(usage.at(-1)).toEqual({
        ...totals,
        contextWindowUsedTokens: 360,
        contextWindowMaxTokens: 200_000,
      });
      await session.setThinkingOption!("high");
      harness.history.push({
        ...assistant([]),
        id: "new-model",
        model: { providerID: "test", id: "other", variant: "high" },
        tokens: { ...tokens, input: 200 },
      });
      await session.getRuntimeInfo();
      expect(usage.at(-1)).toEqual({
        ...totals,
        contextWindowUsedTokens: 460,
        contextWindowMaxTokens: 1_000_000,
      });
      expect(harness.prompts).toEqual([]);
    } finally {
      await session.close();
    }
  });

  test("never fabricates a percent for unknown limits or an assistant with zero/absent usage", async () => {
    const harness = new V2Harness();
    harness.models.push(contextModel("model", 0));
    const tokens = { input: 100, output: 20, reasoning: 10, cache: { read: 200, write: 30 } };
    harness.history.push({ ...assistant([]), tokens });
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const usage: AgentUsage[] = [(await session.getRuntimeInfo()).usage!];
    session.subscribe((event) => {
      if (event.type === "usage_updated") usage.push(event.usage);
    });
    const totals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalCostUsd: 0 };
    try {
      expect(usage.at(-1)).toEqual({ ...totals, contextWindowUsedTokens: 360 });
      harness.history.push({
        ...assistant([]),
        id: "unknown-model",
        model: { providerID: "unknown", id: "model" },
        tokens: { ...tokens, input: 200 },
      });
      await session.getRuntimeInfo();
      expect(usage.at(-1)).toEqual({ ...totals, contextWindowUsedTokens: 460 });
      harness.history.push({
        ...assistant([]),
        id: "zero",
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      });
      await session.getRuntimeInfo();
      expect(usage.at(-1)).toEqual(totals);
      harness.history.splice(0, harness.history.length, assistant([]));
      await session.getRuntimeInfo();
      expect(usage.at(-1)).toEqual(totals);
    } finally {
      await session.close();
    }
  });

  test("drops an old limit when catalog acquisition fails on reconnect without blocking history access", async () => {
    const harness = new V2Harness();
    harness.models.push(contextModel());
    harness.history.push({
      ...assistant([]),
      tokens: { input: 100, output: 20, reasoning: 10, cache: { read: 200, write: 30 } },
    });
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const usage: AgentUsage[] = [(await session.getRuntimeInfo()).usage!];
    session.subscribe((event) => {
      if (event.type === "usage_updated") usage.push(event.usage);
    });
    try {
      expect(usage.at(-1)?.contextWindowMaxTokens).toBe(200_000);
      harness.api.model.list = async () => {
        throw new Error("fixture catalog unavailable");
      };
      harness.push({ id: "reconnected", created: 3, type: "server.connected", data: {} });
      await expect
        .poll(() => usage.at(-1))
        .toEqual({
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          totalCostUsd: 0,
          contextWindowUsedTokens: 360,
        });
      await session.getRuntimeInfo();
      expect(usage).toHaveLength(2);
      expect(harness.prompts).toEqual([]);
    } finally {
      await session.close();
    }
  });
});

describe("OpenCode v2 token streaming", () => {
  test("emits text and reasoning deltas as they arrive", async () => {
    const harness = new V2Harness();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const text = collectAssistantText(session);
    const reasoning: string[] = [];
    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "reasoning")
        reasoning.push(event.item.text);
    });
    try {
      harness.push({
        id: "rs",
        created: 2,
        type: "session.reasoning.started",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0 },
      });
      harness.push({
        id: "r1",
        created: 3,
        type: "session.reasoning.delta",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0, delta: "think" },
      });
      harness.push({
        id: "ts",
        created: 2,
        type: "session.text.started",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0 },
      });
      harness.push({
        id: "t1",
        created: 4,
        type: "session.text.delta",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0, delta: "Hel" },
      });
      harness.push({
        id: "t2",
        created: 5,
        type: "session.text.delta",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0, delta: "lo" },
      });
      await expect.poll(() => text).toEqual(["Hel", "lo"]);
      expect(reasoning).toEqual(["think"]);
    } finally {
      await session.close();
    }
  });

  test("deduplicates snapshots before and after deltas using per-type ordinals", () => {
    const timeline = new V2Timeline();
    const text = { assistantMessageID: "answer", type: "text", ordinal: 0 } as const;
    const reasoning = { ...text, type: "reasoning" } as const;
    timeline.startPart(text);
    timeline.startPart(reasoning);
    expect(timeline.delta({ ...text, delta: "Hel" })).toMatchObject({ item: { text: "Hel" } });
    expect(timeline.delta({ ...reasoning, delta: "think" })).toMatchObject({
      item: { text: "think" },
    });
    const snapshot = assistant([
      {
        type: "reasoning",
        text: "think",
        state: { reasoningField: "reasoning_content" },
        time: { created: 2, completed: 2 },
      },
      { type: "text", text: "Hello" },
    ]);
    expect(timeline.messages([snapshot])).toMatchObject([{ item: { text: "lo" } }]);
    expect(timeline.delta({ ...text, delta: "lo" })).toBeNull();
    expect(timeline.messages([snapshot])).toEqual([]);
    expect(timeline.delta({ ...text, delta: "!" })).toMatchObject({ item: { text: "!" } });
    expect(timeline.messages([snapshot])).toEqual([]);
  });

  test("recovers missed fragments from snapshots after reconnect", () => {
    const timeline = new V2Timeline();
    const part = { assistantMessageID: "answer", type: "text", ordinal: 0 } as const;
    timeline.startPart(part);
    expect(timeline.delta({ ...part, delta: "Hel" })).toMatchObject({ item: { text: "Hel" } });
    timeline.resetStreams();
    expect(timeline.delta({ ...part, delta: "!" })).toBeNull();
    expect(timeline.messages([assistant([{ type: "text", text: "Hello!" }])])).toMatchObject([
      { item: { text: "lo!" } },
    ]);
    expect(timeline.messages([assistant([{ type: "text", text: "Hello!" }])])).toEqual([]);
  });

  test("withholds streamed prose during a structured-output turn", async () => {
    const harness = new V2Harness();
    let settle!: () => void;
    harness.wait = () =>
      new Promise<void>((resolve) => {
        settle = resolve;
      });
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const text = collectAssistantText(session);
    const reasoning: string[] = [];
    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "reasoning")
        reasoning.push(event.item.text);
    });
    const failures: AgentStreamEvent[] = [];
    session.subscribe((event) => {
      if (event.type === "turn_failed") failures.push(event);
    });
    try {
      await session.startTurn("answer", {
        outputSchema: { type: "object", properties: { answer: { type: "integer" } } },
      });
      await expect.poll(() => harness.prompts).toEqual(["answer"]);
      harness.push({
        id: "ts",
        created: 2,
        type: "session.text.started",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0 },
      });
      harness.push({
        id: "t1",
        created: 3,
        type: "session.text.delta",
        data: {
          sessionID: "session",
          assistantMessageID: "answer",
          ordinal: 0,
          delta: "ignore me",
        },
      });
      // A following reasoning delta is still delivered, so its arrival proves
      // the text delta was seen and suppressed rather than merely not yet read.
      harness.push({
        id: "rs",
        created: 2,
        type: "session.reasoning.started",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0 },
      });
      harness.push({
        id: "r1",
        created: 4,
        type: "session.reasoning.delta",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0, delta: "thought" },
      });
      await expect.poll(() => reasoning).toEqual(["thought"]);
      expect(text).toEqual([]);
      // A late delta after the structured turn failed must remain suppressed.
      settle();
      await expect.poll(() => failures.length).toBe(1);
      harness.push({
        id: "late",
        created: 5,
        type: "session.text.delta",
        data: {
          sessionID: "session",
          assistantMessageID: "answer",
          ordinal: 0,
          delta: "still hidden",
        },
      });
      harness.push({
        id: "r2",
        created: 6,
        type: "session.reasoning.delta",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0, delta: "done" },
      });
      await expect.poll(() => reasoning).toEqual(["thought", "done"]);
      expect(text).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
