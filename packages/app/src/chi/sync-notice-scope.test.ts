import { describe, expect, it } from "vitest";
import {
  deriveSyncNoticeScope,
  parseChiAssociation,
  type SyncNoticeAgent,
} from "./sync-notice-scope";

function association(overrides: Record<string, unknown> = {}): string {
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

function agent(
  id: string,
  associationLabel: string | undefined,
  title: string | null = `Session ${id}`,
): SyncNoticeAgent {
  return { id, title, association: parseChiAssociation(associationLabel) };
}

function derive(
  overrides: Partial<Parameters<typeof deriveSyncNoticeScope>[0]> = {},
): ReturnType<typeof deriveSyncNoticeScope> {
  return deriveSyncNoticeScope({
    hostId: "server-1",
    workspaceId: "ws-1",
    agents: [],
    focusedAgentId: null,
    workspaceError: null,
    workspaceWarning: null,
    hasCurrentVerdict: true,
    ...overrides,
  });
}

describe("parseChiAssociation", () => {
  it("reads the per-session error, warning, account and checkpoint", () => {
    expect(
      parseChiAssociation(
        association({ error: "capture-local-secret-rejected", actor: "github:u2", sourceId: "s1" }),
      ),
    ).toMatchObject({
      error: "capture-local-secret-rejected",
      actor: "github:u2",
      sourceId: "s1",
    });
  });

  it("treats malformed, empty and wrong-shape labels as absent without throwing", () => {
    expect(parseChiAssociation(undefined)).toBeNull();
    expect(parseChiAssociation("")).toBeNull();
    expect(parseChiAssociation("{not json")).toBeNull();
    expect(parseChiAssociation("null")).toBeNull();
    expect(parseChiAssociation("123")).toBeNull();
    // Unknown keys are ignored; the label is still parsed without throwing.
    expect(parseChiAssociation(JSON.stringify({ repo: 1 }))).toMatchObject({
      error: null,
      warning: null,
    });
  });
});

describe("deriveSyncNoticeScope", () => {
  const healthy = agent("healthy", association());
  const secretRejected = agent(
    "secret",
    association({ sourceId: "s-secret", head: "h-secret", error: "capture-local-secret-rejected" }),
  );
  const cutLimit = agent(
    "cut",
    association({ sourceId: "s-cut", head: "h-cut", error: "capture-local-cut-scan-limit" }),
  );
  const agents = [healthy, secretRejected, cutLimit, agent("untracked", undefined)];

  it("does not assert a current failure without a resolved destination verdict", () => {
    expect(
      derive({
        agents,
        focusedAgentId: "secret",
        workspaceError: "capture-local-cut-scan-limit",
        hasCurrentVerdict: false,
      }),
    ).toBeNull();
  });

  it("uses the focused conversation's own error, not the workspace aggregate", () => {
    const scope = derive({
      agents,
      focusedAgentId: "secret",
      // Aggregate last-wins would be the sibling's cut-limit.
      workspaceError: "capture-local-cut-scan-limit",
    });
    expect(scope).toMatchObject({
      kind: "session",
      agentId: "secret",
      error: "capture-local-secret-rejected",
    });
    expect(scope!.subjectKey).toContain("session:secret");
  });

  it("resolves each differently failing conversation to its own status", () => {
    expect(
      derive({
        agents,
        focusedAgentId: "cut",
        workspaceError: "capture-local-secret-rejected",
      }),
    ).toMatchObject({ kind: "session", agentId: "cut", error: "capture-local-cut-scan-limit" });
  });

  it("falls back to a workspace notice naming the affected session when a healthy one is focused", () => {
    const scope = derive({
      agents,
      focusedAgentId: "healthy",
      workspaceError: "capture-local-cut-scan-limit",
    });
    expect(scope).toMatchObject({
      kind: "workspace",
      error: "capture-local-cut-scan-limit",
      affected: [{ id: "cut", title: "Session cut" }],
    });
  });

  it("keeps a workspace-level destination error with no attributable session", () => {
    const scope = derive({
      agents,
      focusedAgentId: "healthy",
      workspaceError: "chi-destination-unmapped",
    });
    expect(scope).toMatchObject({
      kind: "workspace",
      error: "chi-destination-unmapped",
      affected: [],
    });
  });

  it("shows the focused session's warning when it has no error", () => {
    const warningAgent = agent(
      "warn",
      association({ error: null, warning: "capture-local-secret-omitted-content" }),
    );
    const scope = derive({
      agents: [...agents, warningAgent],
      focusedAgentId: "warn",
    });
    expect(scope).toMatchObject({
      kind: "session",
      agentId: "warn",
      warning: "capture-local-secret-omitted-content",
    });
  });

  it("never hides a workspace error behind the focused session's warning", () => {
    const warningAgent = agent(
      "warn",
      association({ error: null, warning: "capture-local-secret-omitted-content" }),
    );
    const scope = derive({
      agents: [...agents, warningAgent],
      focusedAgentId: "warn",
      workspaceError: "capture-local-secret-rejected",
    });
    expect(scope).toMatchObject({
      kind: "workspace",
      error: "capture-local-secret-rejected",
      affected: [{ id: "secret", title: "Session secret" }],
    });
  });

  it("returns nothing when the focused session and the workspace are clean", () => {
    expect(derive({ agents, focusedAgentId: "healthy" })).toBeNull();
  });

  it("rescopes the session dismissal subject when the checkpoint changes", () => {
    const first = derive({ agents, focusedAgentId: "secret" });
    const moved = derive({
      agents: [
        agent(
          "secret",
          association({
            sourceId: "s-secret",
            head: "h-new",
            error: "capture-local-secret-rejected",
          }),
        ),
      ],
      focusedAgentId: "secret",
    });
    expect(first!.subjectKey).not.toBe(moved!.subjectKey);
  });

  it("rescopes the workspace dismissal subject on a new head with the same error", () => {
    const first = derive({
      agents,
      focusedAgentId: "healthy",
      workspaceError: "capture-local-cut-scan-limit",
    });
    const moved = derive({
      agents: [
        healthy,
        agent(
          "cut",
          association({ sourceId: "s-cut", head: "h-new", error: "capture-local-cut-scan-limit" }),
        ),
      ],
      focusedAgentId: "healthy",
      workspaceError: "capture-local-cut-scan-limit",
    });
    expect(first!.subjectKey).not.toBe(moved!.subjectKey);
  });

  it("rescopes the workspace dismissal subject across host and workspace identity", () => {
    const first = derive({
      agents,
      focusedAgentId: "healthy",
      workspaceError: "chi-destination-unmapped",
    });
    const otherWorkspace = derive({
      hostId: "server-1",
      workspaceId: "ws-2",
      agents: [healthy],
      focusedAgentId: "healthy",
      workspaceError: "chi-destination-unmapped",
    });
    const otherHost = derive({
      hostId: "server-2",
      workspaceId: "ws-1",
      agents: [healthy],
      focusedAgentId: "healthy",
      workspaceError: "chi-destination-unmapped",
    });
    expect(first!.subjectKey).not.toBe(otherWorkspace!.subjectKey);
    expect(first!.subjectKey).not.toBe(otherHost!.subjectKey);
  });

  it("rescopes the workspace dismissal subject when the pinned account changes", () => {
    const first = derive({
      agents: [
        agent("cut", association({ actor: "github:one", error: "capture-local-cut-scan-limit" })),
      ],
      focusedAgentId: "healthy",
      workspaceError: "capture-local-cut-scan-limit",
    });
    const otherAccount = derive({
      agents: [
        agent("cut", association({ actor: "github:two", error: "capture-local-cut-scan-limit" })),
      ],
      focusedAgentId: "healthy",
      workspaceError: "capture-local-cut-scan-limit",
    });
    expect(first!.subjectKey).not.toBe(otherAccount!.subjectKey);
  });
});
