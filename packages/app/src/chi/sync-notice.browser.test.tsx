import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

import {
  SyncNoticeView,
  SyncWarningView,
  WorkspaceSyncNoticeView,
  WORKSPACE_NOTICE_TITLE,
  WORKSPACE_DESTINATION_NOTICE_TITLE,
  useSyncNoticeDismissal,
  syncNoticeReason,
  OMITTED_CONTENT_WARNING,
} from "./sync-notice-view";
import { isTerminalSyncError } from "./sync-destination";
import { WorkspaceSyncNotice } from "./sync-notice";
import { useSessionStore, type Agent } from "@/stores/session-store";

// The destination verdict is injected so the assembled notice can be driven
// through cold/current/late states; the session store below stays real.
const syncState = vi.hoisted(() => {
  const base = {
    destination: null as null,
    pending: false,
    error: null as string | null,
    warning: null as string | null,
    mentionsAvailable: false,
    loading: true,
    available: false,
    retry: () => {},
  };
  return { byHost: {} as Record<string, typeof base>, base };
});
vi.mock("./use-sync-destination", () => ({
  useSyncDestination: (serverId: string) => syncState.byHost[serverId] ?? syncState.base,
}));

const SERVER_A = "server-a";
const SERVER_B = "server-b";
const WORKSPACE_ID = "ws-1";
const AGENT_TIMESTAMP = new Date("2026-10-13T00:00:00.000Z");

function makeAgent(input: {
  id: string;
  serverId: string;
  title?: string;
  workspaceId?: string;
  association?: string | null;
}): Agent {
  return {
    serverId: input.serverId,
    id: input.id,
    provider: "codex",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: AGENT_TIMESTAMP,
    updatedAt: AGENT_TIMESTAMP,
    lastUserMessageAt: null,
    lastActivityAt: AGENT_TIMESTAMP,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    runtimeInfo: undefined,
    lastUsage: undefined,
    lastError: null,
    title: input.title ?? `Session ${input.id}`,
    cwd: "/repo/worktree",
    workspaceId: input.workspaceId ?? WORKSPACE_ID,
    model: null,
    features: undefined,
    thinkingOptionId: undefined,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    parentAgentId: null,
    labels: input.association ? { "chi.native": input.association } : {},
    projectPlacement: null,
  };
}

function seedSession(serverId: string, agents: Agent[], focusedAgentId: string | null): void {
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null);
  store.setAgents(serverId, new Map(agents.map((agent) => [agent.id, agent])));
  store.setFocusedAgentId(serverId, focusedAgentId);
}

function chiAssociation(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    repo: "github:owner/repo",
    actor: "github:user",
    sourceId: "source-a",
    head: "head-1",
    error: null,
    warning: null,
    ...overrides,
  });
}

const errorRef = { current: null as string | null };
const subjectRef = { current: "" };
const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return { root, container };
}
function notice(container: HTMLElement) {
  return container.querySelector('[data-testid="chi-sync-notice"]');
}
function button(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("*")).find(
    (element) => element.textContent === label,
  ) as HTMLElement | undefined;
}

function DismissProbe() {
  const { visible, dismiss } = useSyncNoticeDismissal(errorRef.current, subjectRef.current);
  return (
    <div>
      <span data-testid="probe" data-visible={String(visible)} />
      <button type="button" data-testid="dismiss" onClick={dismiss}>
        dismiss
      </button>
    </div>
  );
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  errorRef.current = null;
  subjectRef.current = "";
  syncState.byHost = {};
  for (const serverId of [SERVER_A, SERVER_B]) {
    useSessionStore.getState().clearSession(serverId);
  }
  vi.clearAllMocks();
});

describe("SyncNoticeView", () => {
  it("explains divergence recovery and hides Retry without leaking a head or server diagnostic", () => {
    const error = "capture-head-diverged";
    const { container } = mount(
      <SyncNoticeView
        error={error}
        terminal={isTerminalSyncError(error)}
        onDismiss={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(container.textContent).toContain("preserve local work");
    expect(container.textContent).toContain("Removed sources are never recreated automatically");
    expect(container.textContent).toContain("OpenCode Fork");
    expect(button(container, "Retry")).toBeUndefined();
    expect(container.textContent).not.toContain(error);
  });
  it("invalid recovery proof stops automatic sync and hides Retry with fixed human recovery copy", () => {
    const error = "capture-recovery-invalid";
    const { container } = mount(
      <SyncNoticeView
        error={error}
        terminal={isTerminalSyncError(error)}
        onDismiss={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(container.textContent).toContain("could not verify the archived history");
    expect(container.textContent).toContain("Automatic sync stopped");
    expect(button(container, "Retry")).toBeUndefined();
    expect(container.textContent).not.toContain(error);
  });
  it("explains an uncertain timeout and offers a safe Retry", () => {
    const error = "chi-operation-timeout";
    const retry = vi.fn();
    const { container } = mount(
      <SyncNoticeView
        error={error}
        terminal={isTerminalSyncError(error)}
        onDismiss={vi.fn()}
        onRetry={retry}
      />,
    );
    expect(container.textContent).toContain("may already have committed");
    expect(container.textContent).toContain("same request");
    act(() => button(container, "Retry")!.click());
    expect(retry).toHaveBeenCalledOnce();
  });
  it("explains destination setup and paused history without exposing diagnostics", () => {
    const { container } = mount(
      <SyncNoticeView error="chi-destination-required" onDismiss={vi.fn()} onRetry={vi.fn()} />,
    );
    expect(container.textContent).toContain("Configure a Chi destination and repository mapping");
    expect(container.textContent).toContain("original endpoint");
    expect(container.textContent).not.toContain("chi-destination-required");
  });
  it("renders the required copy, a safe reason and both actions", () => {
    const { container } = mount(
      <SyncNoticeView error="evidence-http-503" onDismiss={vi.fn()} onRetry={vi.fn()} />,
    );
    const element = notice(container);
    expect(element).not.toBeNull();
    expect(element?.textContent).toContain(
      "For others to see this session and for its mentions to appear, sync needs to succeed.",
    );
    expect(element?.textContent).toContain(syncNoticeReason("evidence-http-503"));
    expect(button(container, "Dismiss")).toBeInstanceOf(HTMLElement);
    expect(button(container, "Retry")).toBeInstanceOf(HTMLElement);
  });

  it("explains a repository that is not accepting v3 writes without advising reconnect", () => {
    const error = "append-http-503-source-writers-drained";
    const { container } = mount(
      <SyncNoticeView
        error={error}
        terminal={isTerminalSyncError(error)}
        onDismiss={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(container.textContent).toContain("setup or maintenance");
    expect(container.textContent).toContain("repository admin or operator");
    expect(container.textContent).not.toContain("Reconnect this host and retry");
    // Bounded auto-retry stays possible once the backend state changes.
    expect(button(container, "Retry")).toBeInstanceOf(HTMLElement);
    expect(container.textContent).not.toContain(error);
  });

  it("routes dismiss and retry through their callbacks", () => {
    const onDismiss = vi.fn();
    const onRetry = vi.fn();
    const { container } = mount(
      <SyncNoticeView error="chi-destination-unmapped" onDismiss={onDismiss} onRetry={onRetry} />,
    );
    act(() => button(container, "Dismiss")!.click());
    act(() => button(container, "Retry")!.click());
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("hides Retry for a terminal secret rejection and shows the safe copy", () => {
    const { container } = mount(
      <SyncNoticeView
        error="capture-local-secret-rejected"
        terminal
        onDismiss={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(button(container, "Retry")).toBeUndefined();
    expect(container.textContent).toContain("A secret was detected in this batch. Sync stopped.");
    expect(container.textContent).not.toContain("Reconnect");
  });

  it("keeps Retry for a missing local scanner and shows the host-dependency copy", () => {
    const { container } = mount(
      <SyncNoticeView
        error="capture-local-scanner-unavailable"
        onDismiss={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(button(container, "Retry")).toBeInstanceOf(HTMLElement);
    expect(container.textContent).toContain("The secret scanner is unavailable on this host");
  });
  it("explains scan deadlines separately and retries the saved batch", () => {
    const retry = vi.fn();
    const { container } = mount(
      <SyncNoticeView error="capture-local-scan-timeout" onDismiss={vi.fn()} onRetry={retry} />,
    );
    expect(container.textContent).toContain("The secret scan exceeded its deadline");
    expect(container.textContent).toContain(
      "earlier attempts or batches may already have committed",
    );
    expect(container.textContent).not.toContain("Install gitleaks");
    act(() => button(container, "Retry")!.click());
    expect(retry).toHaveBeenCalledOnce();
  });
  it("explains a terminal cut-scan limit without claiming a secret finding", () => {
    const { container } = mount(
      <SyncNoticeView
        error="capture-local-cut-scan-limit"
        terminal
        onDismiss={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(container.textContent).toContain(
      "This batch exceeds the local truncation safety-scan limit. Sync stopped.",
    );
    expect(container.textContent).not.toContain("A secret was detected");
    expect(button(container, "Retry")).toBeUndefined();
  });
  it("explains a terminal over-cap reasoning record without claiming a secret finding", () => {
    const { container } = mount(
      <SyncNoticeView
        error="native-capture-bounds"
        terminal
        onDismiss={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(container.textContent).toContain(
      "This session has a record too large to keep its reasoning within the shared evidence limit.",
    );
    expect(container.textContent).not.toContain("A secret was detected");
    expect(button(container, "Retry")).toBeUndefined();
  });
  it("names the affected session for a workspace-level error instead of claiming this session", () => {
    const { container } = mount(
      <WorkspaceSyncNoticeView
        error="capture-local-cut-scan-limit"
        affected={[{ id: "b", title: "Opening new session" }]}
        terminal
        onDismiss={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    const element = container.querySelector('[data-testid="chi-sync-notice-workspace"]');
    expect(element).not.toBeNull();
    expect(element?.textContent).toContain(WORKSPACE_NOTICE_TITLE);
    expect(element?.textContent).toContain("Opening new session");
    expect(element?.textContent).not.toContain("For others to see this session");
    expect(button(container, "Retry")).toBeUndefined();
  });
  it("renders the non-blocking omitted-content warning with Dismiss only", () => {
    const { container } = mount(
      <SyncWarningView warning="capture-local-secret-omitted-content" onDismiss={vi.fn()} />,
    );
    const element = container.querySelector('[data-testid="chi-sync-warning"]');
    expect(element).not.toBeNull();
    expect(container.textContent).toContain(OMITTED_CONTENT_WARNING);
    expect(button(container, "Dismiss")).toBeInstanceOf(HTMLElement);
    expect(button(container, "Retry")).toBeUndefined();
  });
});

describe("useSyncNoticeDismissal", () => {
  it("hides on dismissal and clears on success so a later failure shows again", () => {
    errorRef.current = "chi-destination-unmapped";
    const { root, container } = mount(<DismissProbe />);
    const probe = container.querySelector('[data-testid="probe"]') as HTMLElement;
    expect(probe.dataset.visible).toBe("true");

    act(() => (container.querySelector('[data-testid="dismiss"]') as HTMLButtonElement).click());
    expect(probe.dataset.visible).toBe("false");

    // Success clears the dismissal.
    errorRef.current = null;
    act(() => root.render(<DismissProbe />));
    expect(probe.dataset.visible).toBe("false");

    // A later distinct failure shows again.
    errorRef.current = "evidence-http-503";
    act(() => root.render(<DismissProbe />));
    expect(probe.dataset.visible).toBe("true");
  });

  it("does not carry one session's dismissal onto another with the same error", () => {
    subjectRef.current = "session:a:s1:h1";
    errorRef.current = "capture-local-cut-scan-limit";
    const { root, container } = mount(<DismissProbe />);
    const probe = container.querySelector('[data-testid="probe"]') as HTMLElement;
    expect(probe.dataset.visible).toBe("true");

    act(() => (container.querySelector('[data-testid="dismiss"]') as HTMLButtonElement).click());
    expect(probe.dataset.visible).toBe("false");

    // Switch conversations: the same error code must show again for the new subject.
    subjectRef.current = "session:b:s2:h2";
    act(() => root.render(<DismissProbe />));
    expect(probe.dataset.visible).toBe("true");
  });
});

describe("WorkspaceSyncNoticeView destination scope", () => {
  it("states workspace/destination scope when no session is attributable", () => {
    const { container } = mount(
      <WorkspaceSyncNoticeView
        error="chi-destination-unmapped"
        affected={[]}
        onDismiss={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(container.textContent).toContain(WORKSPACE_DESTINATION_NOTICE_TITLE);
    expect(container.textContent).toContain(
      "This workspace's destination did not complete the last sync.",
    );
    expect(container.textContent).not.toContain("did not sync.");
  });
});

describe("WorkspaceSyncNotice (assembled with the real session store)", () => {
  function renderNotice(serverId: string) {
    return mount(<WorkspaceSyncNotice serverId={serverId} workspaceId={WORKSPACE_ID} />);
  }

  it("stays silent on cold cached labels, then shows the focused session's own error once the verdict resolves", () => {
    seedSession(
      SERVER_A,
      [
        makeAgent({
          id: "secret",
          serverId: SERVER_A,
          association: chiAssociation({ error: "capture-local-secret-rejected" }),
        }),
        makeAgent({
          id: "cut",
          serverId: SERVER_A,
          association: chiAssociation({ error: "capture-local-cut-scan-limit" }),
        }),
      ],
      "secret",
    );
    syncState.byHost[SERVER_A] = { ...syncState.base, available: false };
    const { root, container } = renderNotice(SERVER_A);
    // No current destination verdict: cached labels must not assert a failure.
    expect(container.querySelector('[data-testid^="chi-sync-notice"]')).toBeNull();

    // The sibling's aggregate error must not be shown as the focused session's.
    syncState.byHost[SERVER_A] = {
      ...syncState.base,
      available: true,
      error: "capture-local-cut-scan-limit",
    };
    act(() => root.render(<WorkspaceSyncNotice serverId={SERVER_A} workspaceId={WORKSPACE_ID} />));
    expect(container.textContent).toContain("A secret was detected in this batch");
    expect(container.textContent).not.toContain("truncation safety-scan limit");
  });

  it("surfaces a late failure for the focused session after a clean verdict", () => {
    seedSession(
      SERVER_A,
      [
        makeAgent({
          id: "parent",
          serverId: SERVER_A,
          association: chiAssociation({ error: null }),
        }),
      ],
      "parent",
    );
    syncState.byHost[SERVER_A] = { ...syncState.base, available: true, error: null };
    const { root, container } = renderNotice(SERVER_A);
    expect(container.querySelector('[data-testid^="chi-sync-notice"]')).toBeNull();

    act(() => {
      seedSession(
        SERVER_A,
        [
          makeAgent({
            id: "parent",
            serverId: SERVER_A,
            association: chiAssociation({ error: "capture-local-secret-rejected" }),
          }),
        ],
        "parent",
      );
    });
    syncState.byHost[SERVER_A] = {
      ...syncState.base,
      available: true,
      error: "capture-local-secret-rejected",
    };
    act(() => root.render(<WorkspaceSyncNotice serverId={SERVER_A} workspaceId={WORKSPACE_ID} />));
    expect(container.textContent).toContain("A secret was detected in this batch");
  });
  it("rescopes to another host context instead of carrying the first host's status", () => {
    seedSession(
      SERVER_A,
      [
        makeAgent({
          id: "secret",
          serverId: SERVER_A,
          association: chiAssociation({ error: "capture-local-secret-rejected" }),
        }),
      ],
      "secret",
    );
    syncState.byHost[SERVER_A] = {
      ...syncState.base,
      available: true,
      error: "capture-local-secret-rejected",
    };
    const { root, container } = renderNotice(SERVER_A);
    expect(container.textContent).toContain("A secret was detected in this batch");

    act(() => {
      seedSession(
        SERVER_B,
        [
          makeAgent({
            id: "healthy",
            serverId: SERVER_B,
            association: chiAssociation({ error: null }),
          }),
          makeAgent({
            id: "cut",
            serverId: SERVER_B,
            title: "Opening new session",
            association: chiAssociation({ error: "capture-local-cut-scan-limit" }),
          }),
        ],
        "healthy",
      );
    });
    syncState.byHost[SERVER_B] = {
      ...syncState.base,
      available: true,
      error: "capture-local-cut-scan-limit",
    };
    act(() => root.render(<WorkspaceSyncNotice serverId={SERVER_B} workspaceId={WORKSPACE_ID} />));
    expect(container.textContent).toContain(WORKSPACE_NOTICE_TITLE);
    expect(container.textContent).toContain("Opening new session");
    expect(container.textContent).not.toContain("A secret was detected in this batch");
  });
});
