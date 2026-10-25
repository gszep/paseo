import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { z } from "zod";
import type { SpeechToTextProvider, StreamingTranscriptionSession } from "../../speech-provider.js";
import type { DeepgramSttOptions } from "./config.js";

const Results = z.object({
  type: z.literal("Results"),
  is_final: z.boolean(),
  start: z.number().finite().nonnegative(),
  duration: z.number().finite().nonnegative(),
  channel: z.object({ alternatives: z.array(z.object({ transcript: z.string() })).min(1) }),
});
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
interface Piece {
  start: number;
  duration: number;
  text: string;
}
interface Segment {
  id: string;
  chunks: Buffer[];
  bytes: number;
  committed: boolean;
  disposed: boolean;
  finalizing: boolean;
  metadata: boolean;
  finals: Map<string, Piece>;
  finalBytes: number;
  interim?: Piece;
  socket?: WebSocket;
  timeout?: ReturnType<typeof setTimeout>;
  keepAlive?: ReturnType<typeof setInterval>;
}

export class DeepgramSTT implements SpeechToTextProvider {
  readonly id = "deepgram";
  constructor(private readonly config: DeepgramSttOptions & { apiKey: string }) {}

  createSession(
    params: Parameters<SpeechToTextProvider["createSession"]>[0],
  ): StreamingTranscriptionSession {
    if (!this.config.apiKey.trim()) throw new Error("Deepgram STT credentials are missing");
    const language = params.language ?? "en";
    if (this.config.languageHints?.length && language !== "multi")
      throw new Error("Deepgram language hints require language multi");
    const url = new URL("wss://api.deepgram.com/v1/listen");
    url.searchParams.set("model", this.config.model);
    url.searchParams.set("language", language);
    for (const hint of this.config.languageHints ?? [])
      url.searchParams.append("language_hint", hint);
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", "24000");
    url.searchParams.set("channels", "1");
    url.searchParams.set("interim_results", "true");
    url.searchParams.set("endpointing", "false");
    // Do not send the generic prose prompt: Nova-3 language hints are not an
    // instruction/translation prompt. Leave smart formatting and replacements off.
    return new DeepgramSession(url, this.config.apiKey, language);
  }
}

/** V1 CloseStream is the commit fence. One connection per committed segment
 * avoids guessing which Finalize response belongs to which audio: Finalize may
 * produce no from_finalize response when the server has no buffered audio.
 * Connections run sequentially; audio for later segments is bounded and queued.
 */
class DeepgramSession extends EventEmitter implements StreamingTranscriptionSession {
  readonly requiredSampleRate = 24000;
  private state: "new" | "connecting" | "ready" | "failed" | "closed" = "new";
  private readonly queue: Segment[] = [];
  private current: Segment | null = null;
  private previous: string | null = null;
  private queuedBytes = 0;
  private queuedChunks = 0;
  private connecting?: Promise<void>;
  private resolveConnect?: () => void;
  private rejectConnect?: (error: Error) => void;

  constructor(
    private readonly url: URL,
    private readonly apiKey: string,
    private readonly language: string,
  ) {
    super();
  }

  connect(): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    if (this.state === "connecting") return this.connecting!;
    if (this.state !== "new") return Promise.reject(new Error("Deepgram STT session is closed"));
    this.state = "connecting";
    this.connecting = new Promise((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    this.segment();
    this.pump();
    return this.connecting;
  }

  appendPcm16(bytes: Buffer): void {
    if (this.state !== "ready") {
      this.fail("Deepgram STT session is not connected");
      return;
    }
    if (bytes.length % 2 !== 0) {
      this.fail("Deepgram STT requires aligned PCM16LE audio");
      return;
    }
    if (!bytes.length) return;
    const segment = this.segment();
    segment.bytes += bytes.length;
    if (segment.socket?.readyState === WebSocket.OPEN) this.send(segment, bytes);
    else {
      this.queuedBytes += bytes.length;
      if (this.queuedBytes > MAX_QUEUED_BYTES || this.queuedChunks >= 8192) {
        this.fail("Deepgram STT audio queue exceeded its limit");
        return;
      }
      segment.chunks.push(Buffer.from(bytes));
      this.queuedChunks += 1;
    }
    this.pump();
  }

  commit(): void {
    if (this.state !== "ready") {
      this.fail("Deepgram STT session is not connected");
      return;
    }
    const segment = this.segment();
    segment.committed = true;
    this.current = null;
    const previousSegmentId = this.previous;
    this.previous = segment.id;
    this.emit("committed", { segmentId: segment.id, previousSegmentId });
    if (this.queue.length > 256) {
      this.fail("Deepgram STT segment queue exceeded its limit");
      return;
    }
    this.pump();
    this.flush(segment);
  }

  clear(): void {
    // Clear only uncommitted audio. Dictation uses this for a silence-only tail
    // while preceding committed segments may still be waiting for final results.
    if (this.state === "connecting") {
      this.close();
      return;
    }
    const segment = this.current;
    if (!segment) return;
    this.current = null;
    const index = this.queue.indexOf(segment);
    if (index >= 0) this.queue.splice(index, 1);
    this.retire(segment);
    this.pump();
  }

  close(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.rejectConnect?.(new Error("Deepgram STT connection cancelled"));
    this.rejectConnect = undefined;
    this.resolveConnect = undefined;
    for (const segment of this.queue.splice(0)) this.retire(segment);
    this.current = null;
  }

  private segment(): Segment {
    if (this.current) return this.current;
    this.current = {
      id: randomUUID(),
      chunks: [],
      bytes: 0,
      committed: false,
      disposed: false,
      finalizing: false,
      metadata: false,
      finals: new Map(),
      finalBytes: 0,
    };
    this.queue.push(this.current);
    return this.current;
  }

  private pump(): void {
    if (this.state !== "ready" && this.state !== "connecting") return;
    const segment = this.queue[0];
    if (!segment || segment.socket || segment.disposed) return;
    if (segment.committed && segment.bytes === 0) {
      this.finish(segment);
      return;
    }
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url, {
        headers: { Authorization: `Token ${this.apiKey}` },
        followRedirects: false,
        handshakeTimeout: TIMEOUT_MS,
        maxPayload: 1024 * 1024,
      });
    } catch {
      this.fail("Deepgram STT connection failed");
      return;
    }
    segment.socket = socket;
    segment.timeout = setTimeout(() => this.fail("Deepgram STT connection timed out"), TIMEOUT_MS);
    socket.on("error", () => {
      if (!segment.disposed) this.fail("Deepgram STT connection failed");
    });
    socket.on("unexpected-response", (_request, response) => {
      response.destroy();
      if (!segment.disposed) this.fail("Deepgram STT connection was rejected");
    });
    socket.on("open", () => {
      if (segment.disposed) {
        socket.terminate();
        return;
      }
      clearTimeout(segment.timeout);
      segment.timeout = undefined;
      if (this.state === "connecting") {
        this.state = "ready";
        this.resolveConnect?.();
        this.resolveConnect = undefined;
        this.rejectConnect = undefined;
      }
      segment.keepAlive = setInterval(() => {
        if (!segment.disposed && !segment.finalizing)
          this.send(segment, JSON.stringify({ type: "KeepAlive" }));
      }, 3000);
      for (const chunk of segment.chunks.splice(0)) {
        this.queuedBytes -= chunk.length;
        this.queuedChunks -= 1;
        this.send(segment, chunk);
      }
      this.flush(segment);
    });
    socket.on("message", (data, binary) => {
      if (segment.disposed) return;
      try {
        if (binary) throw new Error();
        const value: unknown = JSON.parse(data.toString());
        if (!value || typeof value !== "object" || !("type" in value)) throw new Error();
        if (value.type === "Error") {
          this.fail("Deepgram STT transcription failed");
          return;
        }
        if (value.type === "Metadata") {
          if (segment.finalizing) segment.metadata = true;
          return;
        }
        if (value.type !== "Results") return;
        this.recordResult(segment, Results.parse(value));
      } catch {
        this.fail("Deepgram STT returned an invalid response");
      }
    });
    socket.on("close", (code) => {
      if (segment.disposed) return;
      if ((code === 1000 || code === 1005) && segment.finalizing && segment.metadata)
        this.finish(segment);
      else this.fail("Deepgram STT connection ended before finalization");
    });
  }

  private recordResult(segment: Segment, result: z.infer<typeof Results>): void {
    const piece = {
      start: result.start,
      duration: result.duration,
      text: result.channel.alternatives[0]!.transcript,
    };
    if (result.is_final) {
      const key = JSON.stringify([piece.start, piece.duration]);
      const existing = segment.finals.get(key);
      if (existing && existing.text !== piece.text) throw new Error();
      if (!existing) {
        if (segment.finals.size >= 2048) throw new Error();
        segment.finalBytes += Buffer.byteLength(piece.text);
        if (segment.finalBytes > 1024 * 1024) throw new Error();
        for (const prior of segment.finals.values()) {
          if (
            piece.start < prior.start + prior.duration - 0.00001 &&
            prior.start < piece.start + piece.duration - 0.00001
          )
            throw new Error();
        }
        segment.finals.set(key, piece);
      }
      if (segment.interim && segment.interim.start <= piece.start) segment.interim = undefined;
    } else segment.interim = piece;
    if (segment.committed) this.transcript(segment, false);
  }

  private send(segment: Segment, data: Buffer | string): void {
    if (segment.disposed) return;
    const socket = segment.socket;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      socket.bufferedAmount > MAX_QUEUED_BYTES
    ) {
      this.fail("Deepgram STT connection cannot accept audio");
      return;
    }
    try {
      socket.send(data, (error) => {
        if (error && !segment.disposed) this.fail("Deepgram STT send failed");
      });
    } catch {
      this.fail("Deepgram STT send failed");
    }
  }

  private flush(segment: Segment): void {
    if (!segment.committed || segment.disposed || segment.finalizing || this.queue[0] !== segment)
      return;
    if (!segment.bytes) {
      this.finish(segment);
      return;
    }
    if (segment.socket?.readyState !== WebSocket.OPEN) return;
    segment.finalizing = true;
    clearInterval(segment.keepAlive);
    segment.timeout = setTimeout(
      () => this.fail("Deepgram STT finalization timed out"),
      TIMEOUT_MS,
    );
    this.send(segment, JSON.stringify({ type: "CloseStream" }));
  }

  private transcript(segment: Segment, final: boolean): void {
    const parts = [...segment.finals.values()];
    if (
      !final &&
      segment.interim &&
      !parts.some((piece) => segment.interim!.start < piece.start + piece.duration)
    )
      parts.push(segment.interim);
    parts.sort((a, b) => a.start - b.start);
    this.emit("transcript", {
      segmentId: segment.id,
      transcript: parts
        .map((part) => part.text)
        .filter((text) => text.length > 0)
        .join(" "),
      isFinal: final,
      ...(this.language !== "multi" ? { language: this.language } : {}),
    });
  }

  private finish(segment: Segment): void {
    if (segment.disposed) return;
    this.retire(segment);
    if (this.queue[0] === segment) this.queue.shift();
    if (this.current === segment) this.current = null;
    this.transcript(segment, true);
    this.pump();
  }

  private retire(segment: Segment): void {
    segment.disposed = true;
    clearTimeout(segment.timeout);
    clearInterval(segment.keepAlive);
    for (const chunk of segment.chunks.splice(0)) {
      this.queuedBytes -= chunk.length;
      this.queuedChunks -= 1;
    }
    segment.socket?.terminate();
  }

  private fail(message: string): void {
    if (this.state === "failed" || this.state === "closed") return;
    this.state = "failed";
    const error = new Error(message); // Never forward provider bodies, URLs or credential-bearing errors.
    this.rejectConnect?.(error);
    this.rejectConnect = undefined;
    this.resolveConnect = undefined;
    for (const segment of this.queue.splice(0)) this.retire(segment);
    this.current = null;
    if (this.listenerCount("error")) this.emit("error", error);
  }
}
