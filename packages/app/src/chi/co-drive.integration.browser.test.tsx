import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, inject, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import {
  ChiMentionResultSchema,
  type ChiMentionContext,
  type ChiMentionOperation,
  type ChiEntryRef,
  type CoDriveView,
} from "@getpaseo/protocol/chi-mentions";
import { CoDrivePanel } from "./co-drive-panel";
import { ReadOnlyStreamView } from "@/agent-stream/read-only-view";
import { conversationPresentation } from "./pinned-conversation";
import type { InboxContext } from "./use-inbox";

declare module "vitest" {
  export interface ProvidedContext {
    coDriveFixture: { address: string; key: string } | null;
  }
}
vi.mock("@/constants/layout", async (original) => ({
  ...(await original<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => window.innerWidth < 500,
}));

const fixture = inject("coDriveFixture");
const readerStyle = { height: 600, display: "flex", flexDirection: "column" } as const;
const pagination = {
  hasOlder: false,
  isLoadingOlder: false,
  progressKey: null,
  onLoadOlder: () => false,
};
const originalReference = (pin: ChiEntryRef["pin"]): ChiEntryRef => ({ pin, seq: 0 });
let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
});

test.skipIf(!fixture)(
  "synthetic browser → authenticated broker → original daemon: one canonical send, lost reply, two readers, revoke",
  async () => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const call = async (path: string, value: unknown = {}) => {
      const response = await fetch(fixture!.address + path, {
        method: "POST",
        headers: { "x-fixture-key": fixture!.key, "content-type": "application/json" },
        body: JSON.stringify(value),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      return result;
    };
    const bootstrap = (await call("/bootstrap")) as {
      repo: string;
      original: ChiEntryRef["pin"];
      scopes: Record<"alice" | "bob", ChiMentionContext>;
      handoffId: string;
    };
    const reference = originalReference(bootstrap.original);
    const makeContext = (name: "alice" | "bob"): InboxContext => ({
      identity: bootstrap.scopes[name],
      queryKey: ["synthetic-control", name],
      isCurrent: () => true,
      execute: async (op: ChiMentionOperation) =>
        ChiMentionResultSchema.parse((await call(`/op/${name}`, op)).result),
    });
    const contexts = { alice: makeContext("alice"), bob: makeContext("bob") };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const mount = async (actor: "alice" | "bob", pin = bootstrap.original) =>
      act(async () => {
        root!.render(
          <CoDrivePanel key={actor} context={contexts[actor]} source={reference} pin={pin} />,
        );
      });
    const summary = () =>
      call("/summary") as Promise<{
        runs: number;
        original: ChiEntryRef["pin"];
        nativeSessionId: string;
        bindingUnchanged: boolean;
        views: Record<"alice" | "bob", CoDriveView>;
      }>;
    await mount("alice");
    await expect.element(page.getByRole("textbox", { name: "Co-drive recipient" })).toBeVisible();
    await userEvent.fill(page.getByRole("textbox", { name: "Co-drive recipient" }), "bob");
    await page.getByRole("button", { name: "Grant session send access", exact: true }).click();
    await expect
      .poll(async () => (await summary()).views.bob.control?.recipient)
      .toBe("github:bob");
    expect((await summary()).runs).toBe(0);
    expect(await call("/tick")).toEqual({ ok: true });
    const granted = (await summary()).views.bob.control!;
    await mount("bob");
    await expect
      .element(page.getByTestId("co-drive-execution-context"))
      .toHaveTextContent(`Runs on ${granted.executor.host}`);
    await expect
      .element(page.getByTestId("co-drive-execution-context"))
      .toHaveTextContent("fixture-provider/fixture-model");
    await expect
      .element(page.getByTestId("co-drive-execution-context"))
      .toHaveTextContent("not your account");
    expect((await summary()).runs).toBe(0);
    const text = "Synthetic recipient message for the original canonical session";
    await userEvent.fill(page.getByRole("textbox", { name: "Shared session message" }), text);
    await page.getByRole("button", { name: "Send to shared session", exact: true }).click();
    await expect.poll(async () => (await summary()).views.alice.operation?.phase).toBe("queued");
    const operation = (await summary()).views.alice.operation!;
    // A lost native acknowledgement must reconcile after daemon reconstruction;
    // no second native dispatch is permitted even though the browser is polling.
    await call("/lose-next-native-reply");
    expect((await call("/tick")).ok).toBe(false);
    expect((await summary()).runs).toBe(1);
    await call("/restart-owner");
    expect(await call("/tick")).toEqual({ ok: true });
    const recorded = await contexts.bob.execute({
      action: "control",
      repo: bootstrap.repo,
      request: { action: "read", sourceId: bootstrap.original.sourceId, operationId: operation.id },
    });
    expect(recorded.kind).toBe("control");
    if (recorded.kind !== "control") throw Error("control response required");
    expect(recorded.view.operation?.phase).toBe("recorded");
    expect(recorded.view.operation?.actor).toBe("github:bob");
    const current = await summary();
    expect(current.runs).toBe(1);
    expect(current.nativeSessionId).toBe("ses_original");
    expect(current.bindingUnchanged).toBe(true);
    expect(current.views.alice.pin).toEqual(current.views.bob.pin);
    expect(current.views.bob.pin.sourceId).toBe(bootstrap.original.sourceId);
    expect(current.views.bob.pin.count).toBe(bootstrap.original.count + 1);
    for (const name of ["alice", "bob"] as const) {
      const result = await contexts[name].execute({
        action: "context",
        repo: bootstrap.repo,
        id: bootstrap.handoffId,
        index: 0,
        latest: true,
      });
      if (result.kind !== "context") throw Error("conversation response required");
      expect(result.source.kind === "neutral" && result.source.appendRef).toEqual(reference);
      expect(result.viewPin).toEqual(current.views.bob.pin);
      const presentation = conversationPresentation(reference, [result], name);
      await act(async () =>
        root!.render(
          <div style={readerStyle}>
            <ReadOnlyStreamView
              historyId={name}
              streamItems={presentation.items}
              verifiedAuthors={presentation.verifiedAuthors}
              historyPagination={pagination}
            />
          </div>,
        ),
      );
      await expect.element(page.getByText(text, { exact: true })).toBeVisible();
      await expect.element(page.getByText("@bob", { exact: true })).toBeVisible();
    }
    await mount("alice", current.views.alice.pin);
    await page.getByRole("button", { name: "Revoke session control", exact: true }).click();
    await expect.poll(async () => (await summary()).views.bob.control?.active).toBe(false);
    await mount("bob", current.views.bob.pin);
    await expect
      .element(
        page.getByText("No active session-control grant. Read access does not authorize sending."),
      )
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Send to shared session", exact: true }))
      .not.toBeInTheDocument();
    await expect(
      contexts.bob.execute({
        action: "control",
        repo: bootstrap.repo,
        request: {
          action: "submit",
          id: crypto.randomUUID(),
          sourceId: reference.pin.sourceId,
          generation: granted.generation,
          contextDigest: granted.contextDigest,
          expectedPin: current.views.bob.pin,
          text: "Must not dispatch",
        },
      }),
    ).rejects.toThrow();
    expect(await call("/tick")).toEqual({ ok: true });
    expect((await summary()).runs).toBe(1);
  },
  30000,
);
