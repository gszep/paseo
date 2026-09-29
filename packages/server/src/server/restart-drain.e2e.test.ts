import { expect, test, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { RestartDrainTimeoutError } from "@getpaseo/client/internal/daemon-client";
import { ChiOperationError } from "@getpaseo/protocol/chi-mentions";
import { createTestPaseoDaemon, DaemonClient } from "./test-utils/index.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "restart-drain-"));
}

async function startHeldTurn(
  daemon: Awaited<ReturnType<typeof createTestPaseoDaemon>>,
  client: DaemonClient,
  prompt: string,
) {
  await client.connect();
  await client.fetchAgents({ subscribe: {} });
  const agent = await client.createAgent({
    provider: "codex",
    cwd: tmpCwd(),
    title: "Held turn agent",
    modeId: "full-access",
    model: "gpt-5.4-mini",
    initialPrompt: prompt,
  });
  expect(agent.status).toBe("running");
  return agent;
}

function holdMatching(pattern: RegExp) {
  const gates: Array<{ promise: Promise<void>; resolve: () => void }> = [];
  const agentClients = createTestAgentClients({
    holdTurnFor: (prompt) => {
      if (!pattern.test(prompt)) return null;
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    },
  });
  return { agentClients, gates };
}

test("restart --wait-idle waits for a running turn, rejects new prompts retryably, and lets the turn finish", async () => {
  const { agentClients, gates } = holdMatching(/hold/i);
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false, agentClients });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    const agent = await startHeldTurn(daemon, client, "hold this turn");

    const progress: string[][] = [];
    let settled = false;
    const restart = client
      .restartServer("test_drain", undefined, {
        waitIdle: true,
        idleTimeoutMs: 5_000,
        onDrainProgress: (status) => progress.push(status.runningAgents),
      })
      .then((ack) => {
        settled = true;
        return ack;
      });

    await vi.waitFor(() => expect(progress.length).toBeGreaterThan(0));
    expect(progress.some((ids) => ids.includes(agent.id))).toBe(true);

    // The restart must not resolve while the turn is still running.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);

    // A prompt submitted during drain is provably rejected, not silently queued.
    let rejection: unknown;
    try {
      await client.sendAgentMessage(agent.id, "a prompt during drain");
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(ChiOperationError);
    expect((rejection as ChiOperationError).message).toBe("host_restarting");
    expect((rejection as ChiOperationError).failure?.outcome).toBe("not_committed");

    // Release the fake turn: the drain completes and the turn finishes cleanly.
    expect(gates.length).toBeGreaterThan(0);
    gates[0]!.resolve();
    const ack = await restart;
    expect(ack.status).toBe("restart_requested");

    const final = await client.waitForFinish(agent.id, 5_000);
    expect(final.status).toBe("idle");
    const fetched = await client.fetchAgent({ agentId: agent.id });
    expect(fetched?.agent.status).toBe("idle");
  } finally {
    for (const gate of gates) gate.resolve();
    await client.close();
    await daemon.close();
  }
});

test("restart --wait-idle fails on timeout without restarting and stops draining", async () => {
  const { agentClients, gates } = holdMatching(/hold/i);
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false, agentClients });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    const agent = await startHeldTurn(daemon, client, "hold this turn");

    await expect(
      client.restartServer("test_timeout", undefined, { waitIdle: true, idleTimeoutMs: 150 }),
    ).rejects.toBeInstanceOf(RestartDrainTimeoutError);

    // The daemon was not restarted and the turn is untouched.
    const stillRunning = await client.fetchAgent({ agentId: agent.id });
    expect(stillRunning?.agent.status).toBe("running");

    // Draining ended cleanly: release the turn, then a fresh prompt is admitted.
    gates[0]!.resolve();
    const finished = await client.waitForFinish(agent.id, 5_000);
    expect(finished.status).toBe("idle");

    await client.sendAgentMessage(agent.id, "after timeout");
    const after = await client.waitForFinish(agent.id, 5_000);
    expect(after.status).toBe("idle");
  } finally {
    for (const gate of gates) gate.resolve();
    await client.close();
    await daemon.close();
  }
});

test("restart --wait-idle --force swaps on drain timeout as before", async () => {
  const { agentClients, gates } = holdMatching(/hold/i);
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false, agentClients });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    const agent = await startHeldTurn(daemon, client, "hold this turn");

    const ack = await client.restartServer("test_force", undefined, {
      waitIdle: true,
      idleTimeoutMs: 150,
      force: true,
    });
    expect(ack.status).toBe("restart_requested");

    // Force swapped while the turn was still running (today's behaviour).
    const stillRunning = await client.fetchAgent({ agentId: agent.id });
    expect(stillRunning?.agent.status).toBe("running");
  } finally {
    for (const gate of gates) gate.resolve();
    await client.close();
    await daemon.close();
  }
});
