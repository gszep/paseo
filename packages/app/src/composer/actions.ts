import type { SelectedFile } from "@/attachments/selected-file";
import type { ForgeSearchItem } from "@getpaseo/protocol/messages";
import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";
import type {
  AttachmentMetadata,
  ComposerAttachment,
  UserComposerAttachment,
} from "@/attachments/types";
import {
  isWorkspaceAttachment,
  userAttachmentsOnly,
} from "@/attachments/workspace-attachment-utils";
import {
  splitComposerAttachmentsForSubmit,
  type ComposerAttachmentSubmitFormat,
} from "@/composer/attachments/submit";
import { createUserMessage, generateMessageId, type UserMessageItem } from "@/types/stream";
import type { MessageSubmissionRejectionOutcome } from "@/composer/submission/model";
import type { PickedImageAttachmentInput } from "@/hooks/image-attachment-picker";
import { i18n } from "@/i18n/i18next";
import type { ChiMentionContext } from "@getpaseo/protocol/chi-mentions";
import { mentionSubmissions } from "@/chi/mention-submission-storage";
import { ChiOperationError } from "@getpaseo/protocol/chi-mentions";

export interface QueuedComposerMessage {
  id: string;
  text: string;
  attachments: ComposerAttachment[];
  chiMentions?: string[];
  chiMentionContext?: ChiMentionContext;
  attempted?: boolean;
}

export interface AttachmentPersister {
  persistFromBlob: (input: {
    blob: Blob;
    mimeType: string;
    fileName: string | null;
  }) => Promise<AttachmentMetadata>;
  persistFromFileUri: (input: {
    uri: string;
    mimeType: string;
    fileName: string | null;
  }) => Promise<AttachmentMetadata>;
  persistFromDataUrl: (input: {
    dataUrl: string;
    mimeType: string;
    fileName: string | null;
  }) => Promise<AttachmentMetadata>;
  deleteAttachments: (metadata: AttachmentMetadata[]) => Promise<void> | void;
}

export interface ComposerSendClient {
  sendAgentMessage: (
    agentId: string,
    text: string,
    options: {
      messageId: string;
      chiMentions?: string[];
      chiMentionContext?: ChiMentionContext;
      chiMentionAuthorization?: ChiMentionContext;
      activeTurnBehavior?: ActiveTurnBehavior;
      images: Array<{ data: string; mimeType: string }>;
      attachments: ReturnType<typeof splitComposerAttachmentsForSubmit>["attachments"];
    },
  ) => Promise<void>;
  uploadFile: (input: { fileName: string; mimeType: string; bytes: Uint8Array }) => Promise<{
    requestId: string;
    file: {
      type: "uploaded_file";
      id: string;
      fileName: string;
      mimeType: string;
      size: number;
      path: string;
    } | null;
    error: string | null;
  }>;
}

export interface ComposerCancelClient {
  cancelAgent: (agentId: string) => Promise<void> | void;
}

export interface MessageSubmissionWriter {
  begin: (agentId: string, message: UserMessageItem) => void;
  accept: (agentId: string, clientMessageId: string) => void;
  reject: (agentId: string, clientMessageId: string) => MessageSubmissionRejectionOutcome;
}

export interface QueueWriter {
  read: (agentId: string) => QueuedComposerMessage[];
  write: (
    updater: (prev: Map<string, QueuedComposerMessage[]>) => Map<string, QueuedComposerMessage[]>,
  ) => void;
}

export async function pickAndPersistImages(input: {
  pickImages: () => Promise<PickedImageAttachmentInput[] | null>;
  persister: Pick<
    AttachmentPersister,
    "persistFromBlob" | "persistFromFileUri" | "persistFromDataUrl"
  >;
}): Promise<AttachmentMetadata[]> {
  const result = await input.pickImages();
  if (!result?.length) return [];
  return await Promise.all(
    result.map(async (picked) => {
      const fileName = picked.fileName ?? null;
      const mimeType = picked.mimeType;
      if (picked.source.kind === "blob") {
        return await input.persister.persistFromBlob({
          blob: picked.source.blob,
          mimeType,
          fileName,
        });
      }
      if (picked.source.kind === "data_url") {
        return await input.persister.persistFromDataUrl({
          dataUrl: picked.source.dataUrl,
          mimeType,
          fileName,
        });
      }
      return await input.persister.persistFromFileUri({
        uri: picked.source.uri,
        mimeType,
        fileName,
      });
    }),
  );
}

export async function uploadFileAttachments(input: {
  client: ComposerSendClient;
  files: SelectedFile[];
}): Promise<Extract<ComposerAttachment, { kind: "file" }>[]> {
  const result: Extract<ComposerAttachment, { kind: "file" }>[] = [];
  const prepared: Array<{ fileName: string; mimeType: string; bytes: Uint8Array }> = [];

  for (const file of input.files) {
    const bytes = await file.readBytes();
    if (bytes.byteLength > 50 * 1024 * 1024) {
      throw new Error(
        i18n.t("composer.errors.fileTooLarge", { size: "50MB", fileName: file.fileName }),
      );
    }
    prepared.push({
      fileName: file.fileName,
      mimeType: file.mimeType,
      bytes,
    });
  }

  for (const file of prepared) {
    const response = await input.client.uploadFile(file);
    if (response.error || !response.file) {
      throw new Error(response.error ?? "Upload failed.");
    }
    result.push({ kind: "file", attachment: response.file });
  }

  return result;
}

export function removeComposerAttachmentAtIndex<T extends ComposerAttachment>(input: {
  attachments: T[];
  index: number;
  deleteAttachments: AttachmentPersister["deleteAttachments"];
}): T[] {
  const removed = input.attachments[input.index];
  if (removed?.kind === "image") {
    void input.deleteAttachments([removed.metadata]);
  }
  return input.attachments.filter((_, i) => i !== input.index);
}

export interface CancelComposerAgentInput {
  client: ComposerCancelClient | null;
  agentId: string;
  isAgentRunning: boolean;
  isCancellingAgent: boolean;
  isConnected: boolean;
}

export function cancelComposerAgent(input: CancelComposerAgentInput): Promise<void> | null {
  if (!input.isAgentRunning || input.isCancellingAgent) return null;
  if (!input.isConnected || !input.client) return null;
  try {
    return Promise.resolve(input.client.cancelAgent(input.agentId));
  } catch (error) {
    return Promise.reject(error);
  }
}

export interface DispatchComposerAgentMessageInput {
  mentions?: typeof mentionSubmissions;
  serverId?: string;
  messageId?: string;
  chiMentions?: string[];
  chiMentionContext?: ChiMentionContext;
  client: ComposerSendClient;
  agentId: string;
  text: string;
  attachments: ComposerAttachment[];
  attachmentSubmitFormat?: ComposerAttachmentSubmitFormat;
  encodeImages: (
    images: AttachmentMetadata[],
  ) => Promise<Array<{ data: string; mimeType: string }> | undefined>;
  submission: MessageSubmissionWriter;
  activeTurnBehavior?: ActiveTurnBehavior;
  activeTurnId?: string;
}

export async function dispatchComposerAgentMessage(
  input: DispatchComposerAgentMessageInput,
): Promise<void> {
  const wirePayload = splitComposerAttachmentsForSubmit(input.attachments, {
    format: input.attachmentSubmitFormat,
  });
  assertMentionPrompt(input);
  const clientMessageId = input.messageId ?? generateMessageId();
  const userMessage = createUserMessage({
    clientMessageId,
    text: input.text,
    timestamp: new Date(),
    images: wirePayload.images,
    attachments: wirePayload.attachments,
    ...(input.activeTurnBehavior === "steer" && input.activeTurnId
      ? { turnId: input.activeTurnId }
      : {}),
  });
  input.submission.begin(input.agentId, userMessage);
  let mentionAttempt: string | undefined;
  const mentionHost = input.chiMentions?.length ? input.serverId : undefined;
  const mentions = input.mentions ?? mentionSubmissions;
  try {
    const imagesData = await input.encodeImages(wirePayload.images);
    const options = {
      messageId: clientMessageId,
      ...(input.chiMentions?.length ? { chiMentions: input.chiMentions } : {}),
      ...(input.chiMentionContext ? { chiMentionContext: input.chiMentionContext } : {}),
      ...(input.activeTurnBehavior ? { activeTurnBehavior: input.activeTurnBehavior } : {}),
      images: imagesData ?? [],
      attachments: wirePayload.attachments,
    };
    const request = { agentId: input.agentId, text: input.text, ...options };
    if (input.serverId) await mentions.prepare(input.serverId, request);
    if (mentionHost) mentionAttempt = await mentions.beginAttempt(mentionHost, request);
    await input.client.sendAgentMessage(input.agentId, input.text, options);
    if (mentionHost) await mentions.complete(mentionHost, input.agentId, clientMessageId);
    input.submission.accept(input.agentId, clientMessageId);
  } catch (error) {
    if (mentionHost)
      await mentions.reject(mentionHost, input.agentId, clientMessageId, error, mentionAttempt);
    input.submission.reject(input.agentId, clientMessageId);
    throw error;
  }
}

export interface QueueComposerMessageInput {
  agentId: string;
  text: string;
  attachments: ComposerAttachment[];
  chiMentions?: string[];
  chiMentionContext?: ChiMentionContext;
  queue: QueueWriter;
}

export interface QueueComposerMessageResult {
  queued: QueuedComposerMessage | null;
}

export function assertMentionPrompt(input: {
  text: string;
  attachments: readonly unknown[];
  chiMentions?: readonly string[];
}) {
  if (input.chiMentions?.length && input.text.length > 8000)
    throw new ChiOperationError("chi-mention-text-too-long", {
      accessLost: false,
      outcome: "not_committed",
    });
  if (
    input.chiMentions?.length &&
    (input.text.trimStart().startsWith("/") || input.attachments.length)
  )
    throw new ChiOperationError("chi-mention-plain-text-required", {
      accessLost: false,
      outcome: "not_committed",
    });
}

export function queueComposerMessage(input: QueueComposerMessageInput): QueueComposerMessageResult {
  assertMentionPrompt(input);
  const trimmed = input.text.trim();
  if (!trimmed && input.attachments.length === 0) {
    return { queued: null };
  }
  const item: QueuedComposerMessage = {
    id: generateMessageId(),
    text: trimmed,
    attachments: input.attachments,
    ...(input.chiMentions?.length
      ? {
          chiMentions: [...input.chiMentions],
          chiMentionContext: input.chiMentionContext ? { ...input.chiMentionContext } : undefined,
        }
      : {}),
  };
  input.queue.write((prev) => {
    const next = new Map(prev);
    next.set(input.agentId, [...(prev.get(input.agentId) ?? []), item]);
    return next;
  });
  return { queued: item };
}

export interface EditQueuedComposerMessageInput {
  agentId: string;
  messageId: string;
  queue: QueueWriter;
}

export interface EditQueuedComposerMessageResult {
  text: string;
  attachments: UserComposerAttachment[];
  chiMentions?: string[];
  chiMentionContext?: ChiMentionContext;
}

export function editQueuedComposerMessage(
  input: EditQueuedComposerMessageInput,
): EditQueuedComposerMessageResult | null {
  const item = input.queue.read(input.agentId).find((q) => q.id === input.messageId);
  if (!item) return null;
  if (item.attempted && item.chiMentions?.length)
    throw new Error("chi-mention-submission-unresolved");
  input.queue.write((prev) => {
    const next = new Map(prev);
    next.set(
      input.agentId,
      (prev.get(input.agentId) ?? []).filter((q) => q.id !== input.messageId),
    );
    return next;
  });
  return {
    text: item.text,
    attachments: userAttachmentsOnly(item.attachments),
    chiMentions: item.chiMentions,
    chiMentionContext: item.chiMentionContext,
  };
}

export interface SendQueuedComposerMessageNowInput {
  agentId: string;
  messageId: string;
  queue: QueueWriter;
  submitMessage: (input: QueuedComposerMessage) => Promise<void>;
  failedToSendMessage?: string;
}

export type SendQueuedComposerMessageNowResult =
  | { status: "missing" }
  | { status: "submitted" }
  | { status: "failed"; errorMessage: string };

export async function sendQueuedComposerMessageNow(
  input: SendQueuedComposerMessageNowInput,
): Promise<SendQueuedComposerMessageNowResult> {
  const item = input.queue.read(input.agentId).find((q) => q.id === input.messageId);
  if (!item) return { status: "missing" };
  input.queue.write((prev) => {
    const next = new Map(prev);
    next.set(
      input.agentId,
      (prev.get(input.agentId) ?? []).filter((q) => q.id !== input.messageId),
    );
    return next;
  });
  try {
    await input.submitMessage(item);
    return { status: "submitted" };
  } catch (error) {
    const uncertain = !(
      error instanceof ChiOperationError && error.failure?.outcome === "not_committed"
    );
    input.queue.write((prev) => {
      const next = new Map(prev);
      next.set(input.agentId, [
        item.chiMentions?.length ? { ...item, attempted: uncertain } : item,
        ...(prev.get(input.agentId) ?? []),
      ]);
      return next;
    });
    return {
      status: "failed",
      errorMessage:
        error instanceof Error
          ? error.message
          : (input.failedToSendMessage ?? i18n.t("composer.errors.failedToSend")),
    };
  }
}

export interface OpenComposerAttachmentInput {
  attachment: ComposerAttachment;
  setLightboxMetadata: (metadata: AttachmentMetadata) => void;
  openWorkspaceAttachment: (input: { attachment: ComposerAttachment }) => boolean;
  openExternalUrl: (url: string) => void;
}

export function openComposerAttachment(input: OpenComposerAttachmentInput): void {
  if (input.attachment.kind === "image") {
    input.setLightboxMetadata(input.attachment.metadata);
    return;
  }
  if (input.attachment.kind === "file" || input.attachment.kind === "workspace_file") {
    return;
  }
  if (isWorkspaceAttachment(input.attachment)) {
    input.openWorkspaceAttachment({ attachment: input.attachment });
    return;
  }
  input.openExternalUrl(input.attachment.item.url);
}

export function buildForgeAttachment(item: ForgeSearchItem): UserComposerAttachment {
  return item.kind === "change_request"
    ? { kind: "forge_change_request", item }
    : { kind: "forge_issue", item };
}

function isForgeAttachment(
  attachment: UserComposerAttachment,
): attachment is Extract<
  UserComposerAttachment,
  { kind: "forge_issue" | "forge_change_request" | "github_issue" | "github_pr" }
> {
  return (
    attachment.kind === "forge_issue" ||
    attachment.kind === "forge_change_request" ||
    // COMPAT(githubAttachmentKinds): accept legacy persisted attachment kinds
    // until 2027-01-17, when supported floors are >= v0.2.0 and old drafts no
    // longer require them.
    attachment.kind === "github_issue" ||
    attachment.kind === "github_pr"
  );
}

export function toggleForgeAttachment(
  current: UserComposerAttachment[],
  item: ForgeSearchItem,
): UserComposerAttachment[] {
  const matches = (attachment: UserComposerAttachment) =>
    isForgeAttachment(attachment) &&
    attachment.item.kind === item.kind &&
    attachment.item.number === item.number;
  if (current.some(matches)) {
    return current.filter((attachment) => !matches(attachment));
  }
  return [...current, buildForgeAttachment(item)];
}

interface ToggleForgeAttachmentFromPickerInput {
  current: UserComposerAttachment[];
  item: ForgeSearchItem;
  markForgeAttachmentRemoved: (attachment: UserComposerAttachment) => void;
}

export function toggleForgeAttachmentFromPicker({
  current,
  item,
  markForgeAttachmentRemoved,
}: ToggleForgeAttachmentFromPickerInput): UserComposerAttachment[] {
  const existingAttachment = current.find(
    (attachment) =>
      isForgeAttachment(attachment) &&
      attachment.item.kind === item.kind &&
      attachment.item.number === item.number,
  );
  if (existingAttachment) {
    markForgeAttachmentRemoved(existingAttachment);
  }
  return toggleForgeAttachment(current, item);
}

export function findForgeItemByOption(
  items: readonly ForgeSearchItem[],
  optionId: string,
): ForgeSearchItem | undefined {
  return items.find((candidate) => `${candidate.kind}:${candidate.number}` === optionId);
}

export function isAttachmentSelectedForForgeItem(
  current: readonly ComposerAttachment[],
  item: ForgeSearchItem,
): boolean {
  return userAttachmentsOnly(current).some(
    (attachment) =>
      isForgeAttachment(attachment) &&
      attachment.item.kind === item.kind &&
      attachment.item.number === item.number,
  );
}
