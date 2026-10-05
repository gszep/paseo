import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AppendClient, type AppendScope } from "@henkaku-center/chi-native/append-client";
import {
  canonicalJson,
  encodeEntry,
  sourceId,
  type Pin,
} from "@henkaku-center/chi-native/append-codec";
import {
  minimiseNativeExport,
  scanCaptureVerdict,
  type LocalScanInput,
  type LocalScanVerdict,
} from "@henkaku-center/chi-native/capture";
import {
  publishConversationReceipt,
  readConversationReceipt,
  syncConversationReceiptDirectory,
} from "@henkaku-center/chi-native/conversations";

const record = z.record(z.string(), z.unknown());
const nativeSchema = z.object({ info: record, messages: z.array(record) }).strict();
const wrappedSchema = z.object({ data: nativeSchema }).strict();
type NativeExport = z.infer<typeof nativeSchema>;
type Creation = Parameters<typeof AppendClient.open>[0]["creation"];
type ScanOptions = NonNullable<Parameters<typeof AppendClient.open>[1]>["scan"];

export interface CapturedAppendMessage {
  id: string;
  seq: number;
  payload: Record<string, unknown>;
}
export interface AppendCaptureInput {
  home: string;
  endpoint: string;
  deployment: string;
  repo: string;
  actor: string;
  token: string;
  instanceId: string;
  hostId: string;
  sessionId: string;
  cwd: string;
  visibility: "private" | "shared";
  native: unknown;
  expected: Pin | null;
  onConfirmed: (pin: Pin) => Promise<void>;
  request: typeof fetch;
  scanner?: ScanOptions;
  scanCapture?: (full: LocalScanInput, minimised: LocalScanInput) => Promise<LocalScanVerdict>;
}
export interface AppendCaptureResult {
  pin: Pin;
  messages: CapturedAppendMessage[];
  warning: string | null;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function nativeExport(input: unknown): NativeExport {
  if (typeof input === "object" && input !== null && Object.hasOwn(input, "data")) {
    return wrappedSchema.parse(input).data;
  }
  return nativeSchema.parse(input);
}
function rawRecords(messages: NativeExport["messages"]): string[] {
  return messages.map((message) => JSON.stringify(message));
}
async function captureExport(
  input: Pick<AppendCaptureInput, "native" | "sessionId" | "expected" | "cwd">,
): Promise<NativeExport> {
  const native = nativeExport(input.native);
  if (native.info.id !== input.sessionId) throw new Error("capture-head-diverged");
  if (native.info.fork || native.info.parentID) throw new Error("chi-native-fork-unsupported");
  if (native.messages.length === 0 && input.expected === null) throw new Error("chi-session-busy");
  const location = z.object({ directory: z.string() }).parse(native.info.location);
  if (location.directory !== input.cwd) {
    const paths = await Promise.all([realpath(location.directory), realpath(input.cwd)]).catch(
      () => null,
    );
    if (paths === null || paths[0] !== paths[1]) throw new Error("chi-native-workspace-mismatch");
  }
  return native;
}

/** The runtime owner holds the settled-export fence. Only new records are
 * projected/scanned; the immutable ledger compares the older native prefix.
 * A saved request always finishes before another batch is constructed. */
export async function captureAppend(input: AppendCaptureInput): Promise<AppendCaptureResult> {
  input = { ...input };
  const native = await captureExport(input);
  const scope: AppendScope = {
    endpoint: input.endpoint,
    deployment: input.deployment,
    repo: input.repo,
    actor: input.actor.toLowerCase(),
    sourceId: sourceId("opencode-v2", input.instanceId, input.sessionId),
    bindingRevision: 1,
    instanceId: input.instanceId,
    nativeSessionId: input.sessionId,
  };
  const selected = input.expected;
  if (selected !== null && selected.sourceId !== scope.sourceId) {
    throw new Error("capture-head-diverged");
  }
  const root = join(input.home, "chi", "append", digest(canonicalJson(scope)));
  for (const directory of [join(input.home, "chi"), join(input.home, "chi", "append"), root]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await syncConversationReceiptDirectory(directory);
  }
  const mapping = {
    instanceId: input.instanceId,
    workspace: { hostId: input.hostId, path: input.cwd },
  };
  const coverage = { kind: "export" as const, reason: null };
  function projection(messages: NativeExport["messages"]) {
    const full: LocalScanInput = {
      native: JSON.stringify({ info: native.info, messages }),
      mapping,
      coverage,
      sessionId: input.sessionId,
    };
    const { capture } = minimiseNativeExport(full);
    const projected = nativeExport(JSON.parse(capture.native));
    const minimised: LocalScanInput = {
      ...full,
      native: capture.native,
      projection: capture.projection,
    };
    return { full, minimised, projected };
  }
  function batchAt(position: { messages: number; header: string; pin: Pin }) {
    const start = position.messages;
    let end = Math.min(native.messages.length, start + 64);
    for (;;) {
      const batch = projection(native.messages.slice(start, end));
      const entries: string[] = [];
      const header = JSON.stringify(batch.projected.info);
      if (position.header !== header) {
        entries.push(
          encodeEntry({
            v: 3,
            seq: position.pin.count,
            kind: "metadata",
            minimiser: "min-v1",
            payload: { native: header, before: digest(position.header) },
          }),
        );
      }
      for (const message of batch.projected.messages) {
        entries.push(
          encodeEntry({
            v: 3,
            seq: position.pin.count + entries.length,
            kind: "message",
            minimiser: "min-v1",
            payload: { native: JSON.stringify(message) },
          }),
        );
      }
      // Leave room for C, native digest rows and fixed tails in the 1 MiB receipt.
      const bytes = entries.reduce(
        (total, entry) => total + Buffer.byteLength(JSON.stringify(entry)) + 1,
        2,
      );
      if (bytes <= 512 * 1024) return { end, batch, entries };
      if (end - start <= 1) throw new Error("capture-local-secret-scan-limit");
      end = start + Math.floor((end - start) / 2);
    }
  }
  const creationPath = join(root, "creation.json");
  let saved = await readConversationReceipt(creationPath);
  if (saved === null) {
    if (selected !== null) throw new Error("append-recovery-required");
    const initial = projection(native.messages);
    const creation: Creation = {
      harness: "opencode-v2",
      instanceId: scope.instanceId,
      nativeSessionId: scope.nativeSessionId,
      ownerId: scope.actor,
      header: JSON.stringify(initial.projected.info),
      coverage: {
        kind: "minimised",
        minimiser: "min-v1",
        initialCount: native.messages.length,
        digest: digest(initial.minimised.native),
      },
      parent: null,
      runtime: "2.0.15-chi.1",
      nativeReducer: "opencode-chi1-r1",
    };
    await publishConversationReceipt(creationPath, creation);
    saved = await readConversationReceipt(creationPath);
  }
  // open validates every creation field against the authenticated source scope.
  const creation = creationSchema.parse(saved);
  await syncConversationReceiptDirectory(creationPath);
  const client = await AppendClient.open(
    { directory: root, scope, creation },
    { fetch: input.request, scan: input.scanner },
  );
  let pin = selected === null ? client.initialPin : selected;
  let pending = await client.pending(pin);
  while (pending !== null) {
    pin = await client.submit(pending, input.token);
    await input.onConfirmed(pin);
    pending = await client.pending(pin);
  }
  let state = await client.state(pin);
  const prefix = native.messages.slice(0, state.messages);
  const refs = await client.verifyPrefix(pin, rawRecords(prefix));
  let warning: string | null = null;
  let sent = false;
  let headerPending = true;
  while (state.messages < native.messages.length || headerPending) {
    const { end, batch, entries } = batchAt({ ...state, pin });
    headerPending = false;
    if (entries.length === 0) break;
    const scan =
      input.scanCapture ??
      ((full, minimised) => scanCaptureVerdict(full, minimised, input.scanner));
    const verdict = await scan(batch.full, batch.minimised);
    if (verdict.verdict === "omitted-warning") warning = "capture-local-secret-omitted-content";
    if (verdict.verdict === "attribution-unavailable" && warning === null)
      warning = "capture-local-attribution-unavailable";
    const receiptId = await client.prepare({
      expected: pin,
      entries,
      nativeRecords: rawRecords(native.messages.slice(0, end)),
      ...(pin.count === 0 ? { visibility: input.visibility } : {}),
    });
    const messageStart = pin.count + entries.length - batch.projected.messages.length;
    pin = await client.submit(receiptId, input.token);
    for (let offset = 0; offset < batch.projected.messages.length; offset++) {
      const message = batch.projected.messages[offset];
      const id = z.string().parse(message.id);
      refs.push({ id, seq: messageStart + offset });
    }
    await input.onConfirmed(pin);
    state = await client.state(pin);
    sent = true;
  }
  if (!sent) pin = await client.verify(pin, input.token);
  return {
    pin,
    messages: refs.map((ref, index) => ({
      id: ref.id,
      seq: ref.seq,
      payload: native.messages[index],
    })),
    warning,
  };
}

const creationSchema = z
  .object({
    harness: z.literal("opencode-v2"),
    instanceId: z.string(),
    nativeSessionId: z.string(),
    ownerId: z.string(),
    header: z.string(),
    coverage: z
      .object({
        kind: z.literal("minimised"),
        minimiser: z.literal("min-v1"),
        initialCount: z.number().int().nonnegative(),
        digest: z.string(),
      })
      .strict(),
    parent: z.null(),
    runtime: z.literal("2.0.15-chi.1"),
    nativeReducer: z.literal("opencode-chi1-r1"),
  })
  .strict();
