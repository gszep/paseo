import { mkdtemp, realpath, rm, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertWriteConfinementAvailable } from "./admission.js";
import { OpenCodeRuntimeClient } from "../providers/opencode/runtime-client.js";

describe("write confinement admission", () => {
  let cwd: string;
  let records: unknown[];
  let logger: pino.Logger;
  beforeEach(async () => {
    cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "paseo-admission-")));
    records = [];
    logger = pino(
      { level: "warn" },
      {
        write(line) {
          records.push(JSON.parse(line));
        },
      },
    );
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("leaves the default and explicit off behavior unchanged", async () => {
    // No filesystem work or provider launch is needed for the off mode.
    await assertWriteConfinementAvailable({ config: { cwd: "missing" }, logger });
    await assertWriteConfinementAvailable({
      config: { cwd: "missing", featureValues: { writeConfinement: { mode: "off" } } },
      logger,
    });
    expect(records).toEqual([]);
  });

  it.each(["worktree", "read-only"])(
    "refuses %s admission and emits a structured guardrail",
    async (mode) => {
      await expect(
        assertWriteConfinementAvailable({
          config: { cwd, featureValues: { writeConfinement: { mode } } },
          launch: { agentId: "builder" },
          logger,
        }),
      ).rejects.toMatchObject({ reason: "integration-unavailable" });
      expect(records).toEqual([
        expect.objectContaining({
          type: "guardrail",
          scope: "agent-admission",
          agentId: "builder",
          cwd,
          worktreeRoot: cwd,
          policyDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          outcome: "launch-refused",
          evidence: "admission",
          coverage: "complete",
          policyViolation: false,
          reason: "integration-unavailable",
        }),
      ]);
    },
  );

  it("refuses malformed opt-ins instead of treating them as off", async () => {
    await expect(
      assertWriteConfinementAvailable({
        config: { cwd, featureValues: { writeConfinement: true } },
        logger,
      }),
    ).rejects.toMatchObject({ reason: "invalid-root" });
    expect(records).toHaveLength(1);
  });

  it("guards actual OpenCode creation and persisted resume before binary resolution", async () => {
    const client = new OpenCodeRuntimeClient(logger, {
      command: { mode: "replace", argv: [path.join(cwd, "must-not-execute")] },
    });
    const config = {
      provider: "opencode",
      cwd,
      featureValues: { writeConfinement: { mode: "worktree" } },
    };
    await expect(client.createSession(config, { agentId: "builder" })).rejects.toMatchObject({
      reason: "integration-unavailable",
    });
    await expect(
      client.resumeSession({ provider: "opencode", sessionId: "persisted", metadata: config }),
    ).rejects.toMatchObject({ reason: "integration-unavailable" });
    await expect(
      client.resumeSession(
        { provider: "opencode", sessionId: "persisted", metadata: config },
        { featureValues: { auto_accept: true } },
      ),
    ).rejects.toMatchObject({ reason: "integration-unavailable" });
    await expect(
      client.importSession({ providerHandleId: "imported", cwd }, { config, storedConfig: config }),
    ).rejects.toMatchObject({ reason: "integration-unavailable" });
    expect(records).toHaveLength(4);
    await client.shutdown();
  });

  it.each(["listCommands", "listFeatures"] as const)(
    "guards %s before an unconfined provider probe can execute",
    async (operation) => {
      const marker = path.join(cwd, "unconfined-probe");
      const executable = path.join(cwd, "provider.cjs");
      await writeFile(
        executable,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); console.log('probe executed');`,
      );
      const client = new OpenCodeRuntimeClient(logger, {
        command: { mode: "replace", argv: [process.execPath, executable] },
      });
      try {
        await expect(
          client[operation]({
            provider: "opencode",
            cwd,
            featureValues: { writeConfinement: { mode: "worktree" } },
          }),
        ).rejects.toMatchObject({ reason: "integration-unavailable" });
        await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
        const guardrails = records.filter(
          (record) =>
            typeof record === "object" &&
            record !== null &&
            "type" in record &&
            record.type === "guardrail",
        );
        expect(guardrails).toEqual([
          expect.objectContaining({ outcome: "launch-refused", reason: "integration-unavailable" }),
        ]);
      } finally {
        await client.shutdown();
      }
    },
  );
});
