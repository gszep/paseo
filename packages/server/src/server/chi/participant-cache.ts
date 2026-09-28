import type { ChiParticipant } from "@getpaseo/protocol/chi-mentions";
import type { MentionIdentity } from "./mentions.js";

interface Directory {
  key: string;
  expires: number;
  pending: Promise<ChiParticipant[]>;
}

/** Host/deployment-owned, workspace-scoped cache. Expired reads wait for authorization;
 * stale-while-revalidate belongs to the app, where failures can clear visible data. */
export class ParticipantCache {
  private readonly workspaces = new Map<string, Directory>();
  private credential: string | null = null;
  generation = 0;

  clear() {
    this.generation++;
    this.workspaces.clear();
    this.credential = null;
  }

  observe(workspace: string, identity: MentionIdentity) {
    const credential = JSON.stringify([
      identity.actor,
      identity.credentialGeneration ?? identity.token,
    ]);
    if (this.credential !== credential) this.clear();
    this.credential = credential;
    const key = JSON.stringify([credential, identity.repo]);
    const previous = this.workspaces.get(workspace);
    if (previous && previous.key !== key) {
      this.generation++;
      this.workspaces.delete(workspace);
    }
    return key;
  }

  async read(workspace: string, identity: MentionIdentity, load: () => Promise<ChiParticipant[]>) {
    const key = this.observe(workspace, identity);
    let entry = this.workspaces.get(workspace);
    if (!entry || entry.expires <= Date.now()) {
      for (const [id, value] of this.workspaces)
        if (value.expires <= Date.now()) this.workspaces.delete(id);
      if (this.workspaces.size >= 64) this.workspaces.delete(this.workspaces.keys().next().value!);
      const next: Directory = {
        key,
        expires: Date.now() + 30_000,
        pending: Promise.resolve().then(load),
      };
      this.workspaces.set(workspace, next);
      entry = next;
    }
    try {
      const participants = await entry.pending;
      if (this.workspaces.get(workspace) !== entry) throw new Error("chi-mention-context-changed");
      return participants.map(({ ownerId, handle }) => ({ ownerId, handle }));
    } catch (error) {
      if (this.workspaces.get(workspace) === entry) this.workspaces.delete(workspace);
      throw error;
    }
  }
}
