import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { AgentManager } from "./agent-manager.js";
import { HostRestartingError } from "./host-restarting-error.js";
import { startAgentRun } from "./agent-prompt.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function setup(options?: { holdTurnFor?: (prompt: string) => Promise<void> | null }) {
  const manager = new AgentManager({
    clients: { claude: createTestAgentClient("claude", { holdTurnFor: options?.holdTurnFor }) },
    logger: createTestLogger(),
  });
  const agent = await manager.createAgent({ provider: "claude", cwd: process.cwd() }, undefined, {
    workspaceId: undefined,
  });
  return { manager, agent };
}

test("draining freezes prompt admission until draining is cleared", async () => {
  const { manager, agent } = await setup();
  try {
    expect(manager.isDraining()).toBe(false);
    expect(manager.assertAcceptingPrompts()).toBeUndefined();

    manager.beginDraining();
    expect(manager.isDraining()).toBe(true);
    expect(() => manager.assertAcceptingPrompts()).toThrow(HostRestartingError);

    // Idempotent.
    manager.beginDraining();
    manager.endDraining();
    manager.endDraining();
    expect(manager.isDraining()).toBe(false);
    expect(manager.assertAcceptingPrompts()).toBeUndefined();
  } finally {
    await manager.closeAgent(agent.id);
  }
});

test("waitForAllIdle reports running agents, then resolves once the turn settles", async () => {
  const gate = deferred();
  const { manager, agent } = await setup({
    holdTurnFor: (prompt) => (prompt.includes("hold") ? gate.promise : null),
  });
  try {
    void startAgentRun(manager, agent.id, "hold this turn", createTestLogger());
    await vi.waitFor(() => expect(manager.hasInFlightRun(agent.id)).toBe(true));

    manager.beginDraining();
    const progress: string[][] = [];
    const wait = manager.waitForAllIdle({
      timeoutMs: 5_000,
      pollIntervalMs: 10,
      onProgress: (running) => progress.push(running.map((entry) => entry.agentId)),
    });

    // The wait must not resolve while the turn is still held.
    const settledEarly = await Promise.race([
      wait.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(settledEarly).toBe(false);
    expect(progress.some((ids) => ids.includes(agent.id))).toBe(true);

    gate.resolve();
    await expect(wait).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(manager.hasInFlightRun(agent.id)).toBe(false));
  } finally {
    await manager.closeAgent(agent.id);
  }
});

test("waitForAllIdle returns the remaining agents after the deadline", async () => {
  const gate = deferred();
  const { manager, agent } = await setup({
    holdTurnFor: (prompt) => (prompt.includes("hold") ? gate.promise : null),
  });
  try {
    void startAgentRun(manager, agent.id, "hold this turn", createTestLogger());
    await vi.waitFor(() => expect(manager.hasInFlightRun(agent.id)).toBe(true));

    manager.beginDraining();
    const outcome = await manager.waitForAllIdle({ timeoutMs: 30, pollIntervalMs: 10 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.runningAgents.map((entry) => entry.agentId)).toContain(agent.id);
    }
    gate.resolve();
  } finally {
    await manager.closeAgent(agent.id);
  }
});

test("waitForAllIdle cancels promptly when the requesting signal aborts", async () => {
  const gate = deferred();
  const { manager, agent } = await setup({
    holdTurnFor: (prompt) => (prompt.includes("hold") ? gate.promise : null),
  });
  try {
    void startAgentRun(manager, agent.id, "hold this turn", createTestLogger());
    await vi.waitFor(() => expect(manager.hasInFlightRun(agent.id)).toBe(true));

    manager.beginDraining();
    const controller = new AbortController();
    const wait = manager.waitForAllIdle({
      timeoutMs: 60_000,
      pollIntervalMs: 10,
      signal: controller.signal,
    });
    controller.abort();
    await expect(wait).rejects.toThrow("drain_canceled");
    manager.endDraining();
    expect(manager.isDraining()).toBe(false);
    gate.resolve();
  } finally {
    await manager.closeAgent(agent.id);
  }
});
