import { expect, test } from "vitest";
import { z } from "zod";
import { encodeEntry } from "@henkaku-center/chi-native/append-codec";
import { ChiSourceSchema, type ChiEntryRef } from "@getpaseo/protocol/chi-mentions";
import { createDaemonTestContext } from "../test-utils/daemon-test-context.js";

// Frozen context-reader shape from ed4da8d7: an older client ignores additive
// timeline fields rather than failing its existing metadata-only read.
const priorContext = z.object({
  kind: z.literal("context"),
  actor: z.string(),
  source: ChiSourceSchema,
  entries: z
    .array(
      z.object({
        nativeId: z.string(),
        type: z.string(),
        seq: z.number().int().nonnegative().optional(),
      }),
    )
    .max(30),
  nextCursor: z.string().nullable(),
});

test.skipIf(process.platform === "win32")(
  "pinned rows survive actual client serialization, session dispatch and generated response decoding",
  async () => {
    const repo = "github:fixture/repo";
    const actor = "github:recipient";
    const ref: ChiEntryRef = {
      pin: {
        v: 3,
        deployment: "fixture",
        repo,
        sourceId: "a".repeat(64),
        count: 30,
        head: "b".repeat(64),
      },
      seq: 27,
    };
    const id = "00000000-0000-4000-8000-000000000143";
    const reads: string[] = [];
    let denied = false;
    const ctx = await createDaemonTestContext({
      mcpEnabled: false,
      chi: {
        destinations: { fixture: { name: "Fixture", endpoint: "https://chi.invalid" } },
        mappings: [{ repo, destination: "fixture", audience: "shared" }],
      },
      chiAuthority: {
        endpoint: "https://chi.invalid",
        invalidate() {},
        login: async () => ({
          sessionToken: "synthetic",
          chiUserId: actor,
          credentialGeneration: "fixture",
        }),
        request: async (input, init) => {
          const url = new URL(String(input));
          expect(url.origin).toBe("https://chi.invalid");
          expect(init?.method ?? "GET").toBe("GET");
          reads.push(url.pathname);
          if (url.pathname === "/auth/session")
            return Response.json({
              ok: true,
              chiUserId: actor,
              capabilities: {
                appendLog: { v: 3, deployment: "fixture" },
                handoffs: { v: 3, references: "pin-seq" },
              },
            });
          expect(new Headers(init?.headers).get("x-chi-repo")).toBe(repo);
          if (denied)
            return Response.json({ reason: "private diagnostic canary" }, { status: 403 });
          if (url.pathname === "/handoffs")
            return Response.json({
              ok: true,
              handoff: {
                v: 3,
                id,
                repo,
                author: "github:sender",
                recipient: actor,
                text: "Synthetic mention",
                sources: [ref],
                state: "open",
                revision: 2,
                createdAt: "2020-01-01T00:00:00Z",
                updatedAt: "2020-01-01T00:01:00Z",
                readAt: "2020-01-01T00:01:00Z",
              },
            });
          if (url.pathname === "/evidence/entries") {
            expect(JSON.parse(url.searchParams.get("pin")!)).toEqual(ref.pin);
            expect(url.searchParams.get("start")).toBe("24");
            expect(url.searchParams.get("end")).toBe("30");
            return Response.json({
              entries: Array.from({ length: 6 }, (_, n) =>
                encodeEntry({
                  v: 3,
                  seq: 24 + n,
                  kind: "message",
                  minimiser: "min-v1",
                  payload: {
                    native: JSON.stringify({
                      id: `msg_${24 + n}`,
                      type: "user",
                      time: { created: 1000 + n },
                      text: `Shared message ${24 + n}`,
                    }),
                  },
                }),
              ),
            });
          }
          throw new Error("Unexpected backend operation");
        },
      },
    });
    try {
      expect(ctx.client.getLastServerInfoMessage()?.features?.chiPinnedTimeline).toBe(true);
      const scope = await ctx.client.chiMentions({
        operation: { action: "scope", includeRepositories: false },
      });
      const result = await ctx.client.chiMentions({
        expectedContext: scope.context,
        operation: { action: "context", repo, id, index: 0, cursor: `${ref.pin.head}:24` },
      });
      expect(result.kind).toBe("context");
      if (result.kind !== "context") throw new Error("Expected context");
      expect(result.entries[3]).toEqual({
        nativeId: "msg_27",
        type: "user",
        seq: 27,
        timestamp: "1970-01-01T00:00:01.003Z",
        items: [{ type: "user_message", text: "Shared message 27", messageId: "msg_27" }],
      });
      expect(result.nextCursor).toBeNull();
      expect(priorContext.parse(JSON.parse(JSON.stringify(result))).entries[3]).toEqual({
        nativeId: "msg_27",
        type: "user",
        seq: 27,
      });
      expect(reads).not.toContain("/repos");
      expect((await ctx.client.fetchAgents({})).entries).toEqual([]);
      denied = true;
      await expect(
        ctx.client.chiMentions({
          expectedContext: scope.context,
          operation: { action: "context", repo, id, index: 0, cursor: `${ref.pin.head}:24` },
        }),
      ).rejects.toMatchObject({ message: "chi-mentions-http-403", failure: { accessLost: true } });
      expect(reads.filter((path) => path === "/evidence/entries")).toHaveLength(1);
    } finally {
      await ctx.cleanup();
    }
  },
  30000,
);
