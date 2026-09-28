import type { AutocompleteOption } from "@/components/ui/autocomplete";
import { orderAutocompleteOptions } from "@/components/ui/autocomplete-utils";
import { selectMention, type SelectedMention } from "@/chi/mention-selection";
import {
  applyFileMentionReplacement,
  type FileMentionRange,
} from "@/utils/file-mention-autocomplete";

export interface DirectorySuggestionEntry {
  path: string;
  kind: "file" | "directory";
}

export type MentionAutocompleteOption =
  | (AutocompleteOption & { type: "human"; participant: SelectedMention })
  | (AutocompleteOption & { type: "workspace_entry"; entryPath: string });

interface MentionAutocompleteSources {
  text: string;
  mention: FileMentionRange;
  participants: readonly SelectedMention[];
  files: readonly DirectorySuggestionEntry[];
}

export function buildMentionAutocompleteOptions({
  text,
  mention,
  participants,
  files,
}: MentionAutocompleteSources): MentionAutocompleteOption[] {
  const canMentionPerson = mention.start === 0 || /[\s(]/.test(text[mention.start - 1]!);
  const query = mention.query.toLowerCase();
  const people: MentionAutocompleteOption[] = canMentionPerson
    ? participants
        .filter((participant) => participant.handle.toLowerCase().startsWith(query))
        .map((participant) => ({
          type: "human",
          id: `human:${participant.ownerId}`,
          kind: "human",
          label: `@${participant.handle}`,
          description: "Person · Chi",
          participant,
        }))
    : [];
  const entries: MentionAutocompleteOption[] = files.map((entry) => ({
    type: "workspace_entry",
    id: `${entry.kind}:${entry.path}`,
    label: entry.path,
    kind: entry.kind,
    entryPath: entry.path,
  }));
  // Rank sources before reversing for the popup above the input. Its nearest
  // row is also the shared keyboard handler's default selection.
  return orderAutocompleteOptions([...people, ...entries]);
}

interface ApplyMentionAutocompleteInput {
  option: MentionAutocompleteOption;
  text: string;
  mention: FileMentionRange;
  serverId: string;
  agentId: string;
}

export function applyMentionAutocompleteOption(input: ApplyMentionAutocompleteInput): string {
  if (input.option.type === "human") {
    const { participant } = input.option;
    selectMention(input.serverId, input.agentId, participant);
    return `${input.text.slice(0, input.mention.start)}@${participant.handle} ${input.text.slice(input.mention.end)}`;
  }
  return applyFileMentionReplacement({
    text: input.text,
    mention: input.mention,
    relativePath: input.option.entryPath,
  });
}
