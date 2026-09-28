import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), publish: vi.fn(), navigate: vi.fn() }));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ fetchAgentTimeline: mocks.fetch }),
}));
vi.mock("@/utils/navigate-to-agent", () => ({ navigateToAgent: mocks.navigate }));
vi.mock("./entry-target", () => ({ useEntryTarget: { setState: mocks.publish } }));
import { openMentionTarget } from "./entry-navigation";
import { createMentionScope } from "./mention-context";

afterEach(() => vi.clearAllMocks());
test.each(["access loss", "detail unmount"])(
  "delayed timeline fetch cannot publish or navigate after %s",
  async (reason) => {
    const identity = {
      actor: "github:alice",
      repo: "github:fixture/repo",
      generation: "a".repeat(64),
    };
    const scope = createMentionScope(
      async () => ({ kind: "scope", actor: identity.actor, context: identity }),
      () => {},
    );
    await scope.acquire();
    const generation = scope.getState().generation;
    let mounted = true;
    let finish!: () => void;
    mocks.fetch.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const pending = openMentionTarget(
      {
        host: "host",
        agentId: "agent",
        workspaceId: "workspace",
        entryId: "entry",
        epoch: "epoch",
        seq: 1,
      },
      () => mounted && scope.getState().generation === generation,
    );
    expect(mocks.fetch).toHaveBeenCalledOnce();
    if (reason === "access loss") scope.lose();
    else mounted = false;
    finish();
    await pending;
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  },
);
