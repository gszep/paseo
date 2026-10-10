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

describe("parseChiAssociation", () => {
  it("reads the per-session error, warning and checkpoint", () => {
    expect(
      parseChiAssociation(association({ error: "capture-local-secret-rejected", sourceId: "s1" })),
    ).toMatchObject({ error: "capture-local-secret-rejected", sourceId: "s1" });
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

  it("uses the focused conversation's own error, not the workspace aggregate", () => {
    const scope = deriveSyncNoticeScope({
      agents,
      focusedAgentId: "secret",
      // Aggregate last-wins would be the sibling's cut-limit.
      workspaceError: "capture-local-cut-scan-limit",
      workspaceWarning: null,
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
      deriveSyncNoticeScope({
        agents,
        focusedAgentId: "cut",
        workspaceError: "capture-local-secret-rejected",
        workspaceWarning: null,
      }),
    ).toMatchObject({ kind: "session", agentId: "cut", error: "capture-local-cut-scan-limit" });
  });

  it("falls back to a workspace notice naming the affected session when a healthy one is focused", () => {
    const scope = deriveSyncNoticeScope({
      agents,
      focusedAgentId: "healthy",
      workspaceError: "capture-local-cut-scan-limit",
      workspaceWarning: null,
    });
    expect(scope).toMatchObject({
      kind: "workspace",
      error: "capture-local-cut-scan-limit",
      affected: [{ id: "cut", title: "Session cut" }],
    });
  });

  it("keeps a workspace-level destination error with no attributable session", () => {
    const scope = deriveSyncNoticeScope({
      agents,
      focusedAgentId: "healthy",
      workspaceError: "chi-destination-unmapped",
      workspaceWarning: null,
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
    const scope = deriveSyncNoticeScope({
      agents: [...agents, warningAgent],
      focusedAgentId: "warn",
      workspaceError: null,
      workspaceWarning: null,
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
    const scope = deriveSyncNoticeScope({
      agents: [...agents, warningAgent],
      focusedAgentId: "warn",
      workspaceError: "capture-local-secret-rejected",
      workspaceWarning: null,
    });
    expect(scope).toMatchObject({
      kind: "workspace",
      error: "capture-local-secret-rejected",
      affected: [{ id: "secret", title: "Session secret" }],
    });
  });

  it("returns nothing when the focused session and the workspace are clean", () => {
    expect(
      deriveSyncNoticeScope({
        agents,
        focusedAgentId: "healthy",
        workspaceError: null,
        workspaceWarning: null,
      }),
    ).toBeNull();
  });

  it("rescopes the dismissal subject when the checkpoint or error changes", () => {
    const first = deriveSyncNoticeScope({
      agents,
      focusedAgentId: "secret",
      workspaceError: null,
      workspaceWarning: null,
    });
    const moved = deriveSyncNoticeScope({
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
      workspaceError: null,
      workspaceWarning: null,
    });
    expect(first!.subjectKey).not.toBe(moved!.subjectKey);
  });
});
