import { describe, expect, it } from "vitest";

import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import { V2Harness } from "../test-utils/v2-harness.js";
import { OpenCodeV2AgentClient } from "./agent.js";

describe("OpenCode V2 sandboxed sessions", () => {
  const cwd = "/work/subagent";
  const sandboxed = { agentId: "agent-a", env: {}, sandbox: { agentId: "agent-a", cwd } };
  const unconfined = { agentId: "agent-a", env: {} };

  function setup() {
    const harness = new V2Harness();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const handle = { provider: "opencode", sessionId: harness.info.id, metadata: { cwd } };
    // Resume selects its server before reading the session; stop right after selection.
    const stopAfterSelection = () => {
      harness.api.session.get = async () => {
        throw new Error("selected");
      };
    };
    return { harness, client, handle, stopAfterSelection };
  }

  it("launches a sandboxed agent on its own confined server", async () => {
    const { harness, client } = setup();
    const session = await client.createSession({ provider: "opencode", cwd }, sandboxed);
    expect(harness.acquisitions).toEqual([{ env: {}, sandbox: { agentId: "agent-a", cwd } }]);
    await session.close();
  });

  it("reuses a live server only when its confinement matches the launch", async () => {
    const { harness, client, handle, stopAfterSelection } = setup();
    const confined = await client.createSession({ provider: "opencode", cwd }, sandboxed);
    stopAfterSelection();
    await expect(client.resumeSession(handle, { cwd }, sandboxed)).rejects.toThrow("selected");
    // Same confinement: the live sandboxed server was retained, nothing new started.
    expect(harness.acquisitions).toHaveLength(1);
    await expect(client.resumeSession(handle, { cwd }, unconfined)).rejects.toThrow("selected");
    // Different confinement: the sandboxed server is never handed to an unconfined launch.
    expect(harness.acquisitions).toHaveLength(2);
    expect(harness.acquisitions[1]).toEqual({});
    await confined.close();
  });

  it("never runs a sandboxed resume on a live unconfined server", async () => {
    const { harness, client, handle, stopAfterSelection } = setup();
    const plain = await client.createSession({ provider: "opencode", cwd }, unconfined);
    stopAfterSelection();
    await expect(client.resumeSession(handle, { cwd }, sandboxed)).rejects.toThrow("selected");
    expect(harness.acquisitions.at(-1)).toEqual({
      env: {},
      sandbox: { agentId: "agent-a", cwd },
    });
    await plain.close();
  });
});
