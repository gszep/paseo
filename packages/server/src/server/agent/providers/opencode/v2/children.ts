import { V2Timeline } from "./timeline.js";

import { ClientError, type SessionInfo } from "@opencode/client";
import { stat } from "node:fs/promises";
import { OpenCodeHttpError } from "../http-error.js";

import type { AgentStreamEvent } from "../../../agent-sdk-types.js";

import type { ProviderSubagentInputEvent } from "../../../provider-subagents/store.js";

import { messages } from "./history.js";

import type { V2Api } from "./api.js";
interface ChildrenOptions {
  client: V2Api;
  id: string;
  emit(event: AgentStreamEvent): void;
  reconcilePermissions(id: string): Promise<void>;
  bindChild?: (id: string) => void;
}
export class SessionChildren {
  private readonly children = new Map<string, V2Timeline>();
  private readonly childStates = new Map<string, string>();
  private readonly unavailablePermissions = new Map<string, string>();
  constructor(private readonly options: ChildrenOptions) {}
  *warnings(): Generator<AgentStreamEvent> {
    for (const message of this.unavailablePermissions.values()) {
      yield {
        type: "timeline",
        provider: "opencode",
        item: { type: "notification", level: "warning", message },
      };
    }
  }
  async observe(event: import("@opencode/client").OpenCodeEvent) {
    if (
      event.type === "session.created" &&
      event.data.parentID &&
      (event.data.parentID === this.options.id || this.children.has(event.data.parentID))
    ) {
      await this.reconcile(event.data.parentID);
    }
    if (
      "sessionID" in event.data &&
      typeof event.data.sessionID === "string" &&
      this.children.has(event.data.sessionID)
    ) {
      await this.reconcileChild(
        await this.options.client.session.get({ sessionID: event.data.sessionID }),
      );
    }
  }
  async reconcile(parentID: string) {
    let cursor: string | undefined;
    do {
      const page = await this.options.client.session.list({
        ...(cursor ? { cursor } : { parentID }),
        limit: 100,
      });
      for (const child of page.data) {
        await this.reconcileChild(child);
        await this.reconcile(child.id);
      }
      cursor = page.cursor.next ?? undefined;
    } while (cursor);
  }
  private async reconcileChild(info: SessionInfo) {
    const active = await this.options.client.session.active();
    let unavailable = false;
    try {
      await this.options.reconcilePermissions(info.id);
    } catch (error) {
      if (!(await missingHistoricalWorkspace(info, error, Boolean(active[info.id])))) throw error;
      if ((await this.options.client.session.active())[info.id]) throw error;
      unavailable = true;
      if (!this.unavailablePermissions.has(info.id)) {
        const message = `Child ${info.id}: permissions unknown because its historical workspace is missing. Known requests remain pending; responses are blocked until permission checks recover.`;
        this.unavailablePermissions.set(info.id, message);
        this.options.emit({
          type: "timeline",
          provider: "opencode",
          item: { type: "notification", level: "warning", message },
        });
      }
    }
    if (!unavailable && this.unavailablePermissions.delete(info.id)) {
      this.options.emit({
        type: "timeline",
        provider: "opencode",
        item: {
          type: "notification",
          level: "info",
          message: `Child ${info.id}: permission checks recovered.`,
        },
      });
    }
    let timeline = this.children.get(info.id);
    if (!timeline) {
      timeline = new V2Timeline();
      this.children.set(info.id, timeline);
    }
    if (!unavailable) this.options.bindChild?.(info.id);
    let status: "running" | "failed" | "canceled" | "completed" = "completed";
    if (active[info.id]) status = "running";
    else if (info.outcome === "failed") status = "failed";
    else if (info.outcome === "interrupted") status = "canceled";
    const presentation: ProviderSubagentInputEvent = {
      type: "upsert",
      id: info.id,
      parentSubagentId: info.parentID === this.options.id ? null : info.parentID,
      title: info.title ?? null,
      status,
      cwd: info.location.directory,
      subtitle: unavailable ? "Permissions unknown · historical workspace missing" : null,
      timestamp: new Date(info.time.updated).toISOString(),
    };
    const signature = JSON.stringify(presentation);
    if (this.childStates.get(info.id) !== signature) {
      this.childStates.set(info.id, signature);
      this.options.emit({ type: "provider_subagent", provider: "opencode", event: presentation });
    }
    for (const event of timeline.messages(await messages(this.options.client, info.id))) {
      if (event.type === "timeline")
        this.options.emit({
          type: "provider_subagent",
          provider: "opencode",
          event: { type: "timeline", id: info.id, item: event.item, timestamp: event.timestamp },
        });
    }
  }
}

async function missingHistoricalWorkspace(
  info: SessionInfo,
  error: unknown,
  active: boolean,
): Promise<boolean> {
  // A general child error, active execution, authentication failure or a workspace
  // that still exists must retain the ordinary fail-closed behavior.
  if (active || !info.outcome) return false;
  const cause = error instanceof ClientError && error.reason === "Transport" ? error.cause : error;
  if (!(cause instanceof OpenCodeHttpError) || cause.status !== 500 || cause.html) return false;
  const prefix = `/api/session/${encodeURIComponent(info.id)}`;
  if (cause.operation !== `${prefix}/permission` && cause.operation !== `${prefix}/form`)
    return false;
  try {
    await stat(info.location.directory);
    return false;
  } catch (failure) {
    return failure instanceof Error && "code" in failure && failure.code === "ENOENT";
  }
}
