import { expect, test } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createMentionScope, mentionQueryKey, type ScopedMentionResult } from "./mention-context";
import type { ChiMentionContext, ChiMentionOperation } from "@getpaseo/protocol/chi-mentions";
import { ChiOperationError } from "@getpaseo/protocol/chi-mentions";
import { selectInboxHost } from "./inbox-host";

test("inbox automatically prefers the connected capable selected host and falls back without workspace selection", () => {
  const connected = new Map([
    ["first", "online"],
    ["selected", "online"],
    ["old", "online"],
  ]);
  expect(
    selectInboxHost(["first", "selected", "old"], "selected", connected, ["first", "selected"]),
  ).toBe("selected");
  connected.set("selected", "offline");
  expect(
    selectInboxHost(["first", "selected", "old"], "selected", connected, ["first", "selected"]),
  ).toBe("first");
  expect(selectInboxHost(["old"], "old", connected, [])).toBe("");
  expect(selectInboxHost([], undefined, connected, [])).toBe("");
});

const identity: ChiMentionContext = {
  actor: "github:sender",
  repo: "github:fixture/repo",
  generation: "a".repeat(64),
};
test("a transient read failure preserves scope and is not reported as access loss", async () => {
  let clears = 0;
  const scope = createMentionScope(
    async (operation) => {
      if (operation.action === "scope")
        return { kind: "scope", actor: identity.actor, context: identity };
      throw new ChiOperationError("chi-mentions-http-409", {
        accessLost: false,
        outcome: "not_committed",
      });
    },
    () => {
      clears++;
    },
  );
  await scope.acquire();
  await expect(scope.run({ action: "inbox", inbox: true })).rejects.toThrow(
    "chi-mentions-http-409",
  );
  expect(scope.getState().context).toEqual(identity);
  expect(clears).toBe(0);
});

test("pending acquisition and a network failure do not become an access-loss warning", async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<ScopedMentionResult>((_, fail) => {
    reject = fail;
  });
  const scope = createMentionScope(
    () => pending,
    () => undefined,
  );
  const acquiring = scope.acquire();
  expect(scope.getState()).toMatchObject({ loading: true, error: null });
  reject(new Error("network-unavailable"));
  await expect(acquiring).rejects.toThrow("network-unavailable");
  expect(scope.getState()).toMatchObject({ loading: false, accessLost: false });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test.each(["actor", "repo", "generation", "deployment"] as const)(
  "changed %s clears parent and child caches and rejects delayed old responses",
  async (field) => {
    let context = identity;
    const cache = new QueryClient();
    const late = deferred<ScopedMentionResult>();
    let delayed = false;
    const calls: Array<{ operation: ChiMentionOperation; expected?: ChiMentionContext }> = [];
    const scope = createMentionScope(
      async (operation, expected) => {
        calls.push({ operation, expected });
        if (operation.action !== "scope" && delayed) return late.promise;
        return { kind: "scope", actor: context.actor, context };
      },
      () => cache.removeQueries({ queryKey: ["chi-mentions", "host", "workspace"] }),
    );
    await scope.acquire();
    const oldKey = mentionQueryKey("host", "workspace", scope.getState());
    for (const child of ["inbox", "handoff", "source", "context", "participants", "delivery"])
      cache.setQueryData([...oldKey, child], "protected old contents");
    delayed = true;
    const old = scope.run({ action: "list", inbox: true, offset: 0 });
    context = {
      ...identity,
      [field]:
        field === "generation" ? "b".repeat(64) : `github:other${field === "repo" ? "/repo" : ""}`,
    };
    await scope.acquire();
    expect(cache.getQueryCache().getAll()).toHaveLength(0);
    expect(mentionQueryKey("host", "workspace", scope.getState())).not.toEqual(oldKey);
    late.resolve({
      kind: "list",
      actor: identity.actor,
      handoffs: [],
      nextOffset: null,
      context: identity,
    });
    await expect(old).rejects.toThrow("chi-mention-context-changed");
    expect(scope.getState().context).toEqual(context);
    const before = calls.length;
    await expect(scope.run({ action: "retry", agentId: "agent" }, identity)).rejects.toThrow(
      "chi-mention-context-changed",
    );
    expect(calls).toHaveLength(before);
    cache.clear();
  },
);

test("a child denial clears every protected view and late parent data cannot revive it", async () => {
  let denied = false;
  let cleared = 0;
  const late = deferred<ScopedMentionResult>();
  const scope = createMentionScope(
    async (operation) => {
      if (operation.action === "scope")
        return { kind: "scope", actor: identity.actor, context: identity };
      if (operation.action === "list") return late.promise;
      if (denied)
        throw new ChiOperationError("chi-mentions-http-404", {
          accessLost: true,
          outcome: "unknown",
        });
      throw new Error("unexpected");
    },
    () => {
      cleared++;
    },
  );
  await scope.acquire();
  const parent = scope.run({ action: "list", inbox: true, offset: 0 });
  denied = true;
  await expect(scope.run({ action: "source", id: "id", index: 0 })).rejects.toThrow(
    "chi-mentions-http-404",
  );
  expect(scope.getState().context).toBeNull();
  late.resolve({
    kind: "list",
    actor: identity.actor,
    handoffs: [],
    nextOffset: null,
    context: identity,
  });
  await expect(parent).rejects.toThrow("chi-mention-context-changed");
  expect(cleared).toBe(1);
});

test("same-scope revalidation retains the directory key and accepts an in-flight participant read", async () => {
  const late = deferred<ScopedMentionResult>();
  const scope = createMentionScope(
    async (operation) => {
      if (operation.action === "scope")
        return { kind: "scope", actor: identity.actor, context: identity };
      return late.promise;
    },
    () => {
      throw new Error("same scope must not clear");
    },
  );
  await scope.acquire();
  const before = scope.getState();
  const read = scope.run({ action: "participants" });
  await scope.acquire();
  expect(scope.getState()).toBe(before);
  late.resolve({
    kind: "participants",
    actor: identity.actor,
    context: identity,
    participants: [],
  });
  expect(await read).toMatchObject({ kind: "participants", participants: [] });
});

test("uncertain mutations retain identity for exact retry, while account failures close the scope", async () => {
  let failure = "chi-mentions-unavailable";
  const expectations: Array<ChiMentionContext | undefined> = [];
  const scope = createMentionScope(
    async (operation, expected) => {
      if (operation.action === "scope")
        return { kind: "scope", actor: identity.actor, context: identity };
      expectations.push(expected);
      throw new ChiOperationError(failure, {
        accessLost: failure === "chi-http-401",
        outcome: "unknown",
      });
    },
    () => undefined,
  );
  await scope.acquire();
  const op = {
    action: "reply" as const,
    id: "handoff",
    operationId: "stable",
    revision: 1,
    text: "reply",
  };
  await expect(scope.run(op)).rejects.toThrow(failure);
  expect(scope.getState().context).toEqual(identity);
  failure = "chi-http-401";
  await expect(scope.run(op)).rejects.toThrow(failure);
  expect(scope.getState().context).toBeNull();
  expect(expectations).toEqual([identity, identity]);
});

test.each(["reply", "acknowledge", "retry"] as const)(
  "production logout during %s clears all protected caches and rejects delayed reads",
  async (action) => {
    const cache = new QueryClient();
    const late = deferred<ScopedMentionResult>();
    const scope = createMentionScope(
      async (operation) => {
        if (operation.action === "scope")
          return { kind: "scope", actor: identity.actor, context: identity };
        if (operation.action === "list") return late.promise;
        throw new ChiOperationError("chi-github-login-required", {
          accessLost: true,
          outcome: "unknown",
        });
      },
      () => cache.clear(),
    );
    await scope.acquire();
    for (const child of ["inbox", "handoff", "source", "context", "participants", "delivery"])
      cache.setQueryData(
        [...mentionQueryKey("host", "workspace", scope.getState()), child],
        "protected",
      );
    const pending = scope.run({ action: "list", inbox: true, offset: 0 });
    await expect(
      scope.run(
        action === "retry"
          ? { action, agentId: "agent" }
          : {
              action,
              id: "handoff",
              operationId: "operation",
              revision: 1,
              text: "reply",
            },
      ),
    ).rejects.toThrow("chi-github-login-required");
    expect(scope.getState().context).toBeNull();
    expect(cache.getQueryCache().getAll()).toHaveLength(0);
    late.resolve({ kind: "scope", actor: identity.actor, context: identity });
    await expect(pending).rejects.toThrow("chi-mention-context-changed");
  },
);
