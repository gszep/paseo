import { create } from "zustand";

export interface EntryTarget {
  host: string;
  agentId: string;
  workspaceId: string;
  entryId: string;
  epoch: string;
  seq: number;
}
export const useEntryTarget = create<{ target: EntryTarget | null }>(() => ({ target: null }));
