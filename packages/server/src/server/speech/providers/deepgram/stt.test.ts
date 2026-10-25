import { EventEmitter, once } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import pino from "pino";
import { DeepgramSTT } from "./stt.js";
import type { StreamingTranscriptionEvent } from "../../speech-provider.js";
import { STTManager } from "../../../agent/stt-manager.js";

const { constructor } = vi.hoisted(() => ({ constructor: vi.fn() }));
vi.mock("ws", () => ({ WebSocket: constructor }));
interface Socket extends EventEmitter {
  readyState: number;
  bufferedAmount: number;
  send: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}
let sockets: Socket[];
const sessions: ReturnType<DeepgramSTT["createSession"]>[] = [];
const logger = pino({ level: "silent" });
beforeEach(() => {
  sockets = [];
  constructor.mockReset();
  Object.assign(constructor, { OPEN: 1 });
  constructor.mockImplementation(function () {
    const socket = Object.assign(new EventEmitter(), {
      readyState: 0,
      bufferedAmount: 0,
      send: vi.fn((_data, callback) => callback?.()),
      terminate: vi.fn(),
    });
    sockets.push(socket);
    return socket;
  });
});
afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  vi.useRealTimers();
});
function setup() {
  const session = new DeepgramSTT({
    apiKey: "fixture-key",
    model: "nova-3",
    languageHints: ["en", "ja"],
  }).createSession({ logger, language: "multi" });
  sessions.push(session);
  const transcripts: StreamingTranscriptionEvent[] = [];
  const errors: Error[] = [];
  const committed: Array<{ segmentId: string; previousSegmentId: string | null }> = [];
  session.on("transcript", (event) => transcripts.push(event));
  session.on("error", (error) => errors.push(error as Error));
  session.on("committed", (event) => committed.push(event));
  return { session, transcripts, errors, committed };
}
function open(socket: Socket) {
  socket.readyState = 1;
  socket.emit("open");
}
function result(socket: Socket, text: string, start = 0, final = true) {
  socket.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "Results",
        start,
        duration: 1,
        is_final: final,
        speech_final: true,
        channel: { alternatives: [{ transcript: text }] },
      }),
    ),
    false,
  );
}
function finish(socket: Socket) {
  socket.emit("message", Buffer.from('{"type":"Metadata"}'), false);
  socket.readyState = 3;
  socket.emit("close", 1000);
}

test("uses Nova V1 raw PCM and repeated user hints; commit waits for trailing results and close metadata", async () => {
  const { session, transcripts, committed, errors } = setup();
  const connected = session.connect();
  open(sockets[0]);
  await connected;
  const [url, options] = constructor.mock.calls[0];
  expect(String(url)).toContain("wss://api.deepgram.com/v1/listen?");
  expect(url.searchParams.getAll("language_hint")).toEqual(["en", "ja"]);
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    model: "nova-3",
    language: "multi",
    encoding: "linear16",
    channels: "1",
    sample_rate: "24000",
    endpointing: "false",
  });
  expect(options).toMatchObject({
    followRedirects: false,
    headers: { Authorization: "Token fixture-key" },
  });
  const audio = Buffer.from([1, 0, 2, 0]);
  session.appendPcm16(audio);
  expect(sockets[0].send.mock.calls[0][0]).toEqual(audio);
  result(sockets[0], "English から日本語", 0);
  expect(transcripts).toEqual([]);
  session.commit();
  expect(sockets[0].send.mock.calls.at(-1)?.[0]).toBe('{"type":"CloseStream"}');
  result(sockets[0], "English から日本語", 0); // retransmitted frame, not another spoken repetition
  result(sockets[0], "また English", 1);
  expect(transcripts.every((event) => !event.isFinal)).toBe(true);
  finish(sockets[0]);
  expect(transcripts.filter((event) => event.isFinal)).toEqual([
    {
      segmentId: committed[0].segmentId,
      transcript: "English から日本語 また English",
      isFinal: true,
    },
  ]);
  expect(errors).toEqual([]);
});

test("serializes committed segments, keeps exact repetitions, and orders final pieces by audio time", async () => {
  const { session, transcripts, committed } = setup();
  const connected = session.connect();
  open(sockets[0]);
  await connected;
  session.appendPcm16(Buffer.from([1, 0]));
  session.commit();
  session.appendPcm16(Buffer.from([2, 0]));
  session.commit();
  expect(sockets).toHaveLength(1);
  expect(committed[1].previousSegmentId).toBe(committed[0].segmentId);
  result(sockets[0], "no", 1);
  result(sockets[0], "no", 0);
  finish(sockets[0]);
  expect(sockets).toHaveLength(2);
  open(sockets[1]);
  expect(sockets[1].send.mock.calls.map(([data]) => data)).toEqual([
    Buffer.from([2, 0]),
    '{"type":"CloseStream"}',
  ]);
  result(sockets[1], "はい42", 0);
  finish(sockets[1]);
  expect(
    transcripts
      .filter((event) => event.isFinal)
      .map((event) => [event.segmentId, event.transcript]),
  ).toEqual([
    [committed[0].segmentId, "no no"],
    [committed[1].segmentId, "はい42"],
  ]);
});

test("clear discards only an uncommitted tail and never drops an earlier pending commit", async () => {
  const { session, transcripts } = setup();
  const connected = session.connect();
  open(sockets[0]);
  await connected;
  session.appendPcm16(Buffer.from([1, 0]));
  session.commit();
  session.appendPcm16(Buffer.from([2, 0]));
  session.clear();
  result(sockets[0], "kept 日本語");
  finish(sockets[0]);
  expect(sockets).toHaveLength(1);
  session.appendPcm16(Buffer.from([3, 0]));
  open(sockets[1]);
  session.commit();
  result(sockets[1], "next");
  finish(sockets[1]);
  expect(transcripts.filter((event) => event.isFinal).map((event) => event.transcript)).toEqual([
    "kept 日本語",
    "next",
  ]);
  expect(sockets[1].send.mock.calls[0][0]).toEqual(Buffer.from([3, 0]));
});

test("clear retires an uncommitted socket and ignores its delayed results", async () => {
  const { session, transcripts, errors } = setup();
  const connected = session.connect();
  open(sockets[0]);
  await connected;
  session.appendPcm16(Buffer.from([1, 0]));
  session.clear();
  result(sockets[0], "must not appear");
  finish(sockets[0]);
  session.commit();
  expect(transcripts).toHaveLength(1);
  expect(transcripts[0]).toMatchObject({ transcript: "", isFinal: true });
  expect(errors).toEqual([]);
});

test("close cancels connection setup and pending finalization without late text", async () => {
  const { session, transcripts, errors } = setup();
  const connected = session.connect();
  const rejected = expect(connected).rejects.toThrow("cancelled");
  session.close();
  await rejected;
  open(sockets[0]);
  result(sockets[0], "late");
  finish(sockets[0]);
  expect(transcripts).toEqual([]);
  expect(errors).toEqual([]);
  await expect(session.connect()).rejects.toThrow("closed");
});

test("failure is terminal and sanitized; no audio replay or automatic reconnect", async () => {
  const { session, transcripts, errors } = setup();
  const connected = session.connect();
  open(sockets[0]);
  await connected;
  session.appendPcm16(Buffer.from([1, 0]));
  session.commit();
  sockets[0].emit("error", new Error("Authorization: Token private-canary"));
  sockets[0].emit("close", 1006);
  result(sockets[0], "late");
  finish(sockets[0]);
  expect(errors.map((error) => error.message)).toEqual(["Deepgram STT connection failed"]);
  expect(transcripts).toEqual([]);
  expect(sockets).toHaveLength(1);
  await expect(session.connect()).rejects.toThrow("closed");
});

test("conflicting finalized payloads and bounded queued audio fail rather than duplicate or silently discard text", async () => {
  const a = setup();
  const first = a.session.connect();
  open(sockets[0]);
  await first;
  result(sockets[0], "original");
  result(sockets[0], "different");
  expect(a.errors.map((error) => error.message)).toEqual([
    "Deepgram STT returned an invalid response",
  ]);
  expect(a.transcripts).toEqual([]);
  const b = setup();
  const second = b.session.connect();
  open(sockets[1]);
  await second;
  b.session.appendPcm16(Buffer.from([1, 0]));
  b.session.commit();
  b.session.appendPcm16(Buffer.alloc(16 * 1024 * 1024 + 2));
  expect(b.errors.map((error) => error.message)).toEqual([
    "Deepgram STT audio queue exceeded its limit",
  ]);
  expect(sockets).toHaveLength(2); // No second segment connection or replay.
});

test("rejects authentication/redirect responses without retaining their body", async () => {
  const { session, errors } = setup();
  const connected = session.connect();
  const rejected = expect(connected).rejects.toThrow("rejected");
  const destroy = vi.fn();
  sockets[0].emit("unexpected-response", {}, { destroy });
  await rejected;
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(errors.map((error) => error.message)).toEqual(["Deepgram STT connection was rejected"]);
});

test("sends text KeepAlive and fails bounded finalization rather than treating speech_final as commit", async () => {
  vi.useFakeTimers();
  const { session, errors, transcripts } = setup();
  const connected = session.connect();
  open(sockets[0]);
  await connected;
  await vi.advanceTimersByTimeAsync(3000);
  expect(sockets[0].send.mock.calls[0][0]).toBe('{"type":"KeepAlive"}');
  session.appendPcm16(Buffer.from([1, 0]));
  session.commit();
  result(sockets[0], "not yet final");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(errors.map((error) => error.message)).toEqual(["Deepgram STT finalization timed out"]);
  expect(transcripts.some((event) => event.isFinal)).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test("connection timeout rejects connect and drains owned timers", async () => {
  vi.useFakeTimers();
  const { session } = setup();
  const connected = session.connect();
  const rejected = expect(connected).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(10_000);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

test.each([
  "{invalid",
  '{"type":"Results","channel":{}}',
  '{"type":"Error","description":"private-canary"}',
])("fails closed on malformed/error response %s", async (frame) => {
  const { session, errors, transcripts } = setup();
  const connected = session.connect();
  open(sockets[0]);
  await connected;
  sockets[0].emit("message", Buffer.from(frame), false);
  expect(errors).toHaveLength(1);
  expect(errors[0].message).not.toContain("private-canary");
  expect(transcripts).toEqual([]);
});

test("abnormal close, PCM alignment and websocket backpressure fail explicitly", async () => {
  const a = setup();
  const c = a.session.connect();
  open(sockets[0]);
  await c;
  a.session.appendPcm16(Buffer.from([1]));
  expect(a.errors[0].message).toContain("aligned");
  const b = setup();
  const d = b.session.connect();
  open(sockets[1]);
  await d;
  sockets[1].bufferedAmount = 17 * 1024 * 1024;
  b.session.appendPcm16(Buffer.from([1, 0]));
  expect(b.errors[0].message).toContain("cannot accept");
  const e = setup();
  const f = e.session.connect();
  open(sockets[2]);
  await f;
  e.session.appendPcm16(Buffer.from([1, 0]));
  e.session.commit();
  sockets[2].emit("close", 1000);
  expect(e.errors[0].message).toContain("before finalization");
});

test("the existing STT manager resamples 16kHz input into headerless 24kHz PCM and keeps mixed-script results", async () => {
  const create = constructor.getMockImplementation()!;
  constructor.mockImplementation(function () {
    const socket = create() as Socket;
    const complete = () => {
      result(socket, "yes 日本語 42");
      finish(socket);
    };
    socket.send.mockImplementation((data, callback) => {
      callback?.();
      if (data === '{"type":"CloseStream"}') queueMicrotask(complete);
    });
    queueMicrotask(() => open(socket));
    return socket;
  });
  const provider = new DeepgramSTT({
    apiKey: "fixture-key",
    model: "nova-3",
    languageHints: ["en", "ja"],
  });
  const manager = new STTManager("fixture", logger, provider, { language: "multi" });
  const pcm = Buffer.alloc(320);
  for (let i = 0; i < 160; i++) pcm.writeInt16LE(i * 100, i * 2);
  const transcript = await manager.transcribe(pcm, "audio/pcm;rate=16000");
  expect(transcript.text).toBe("yes 日本語 42");
  const audio = sockets[0].send.mock.calls.map(([data]) => data).filter(Buffer.isBuffer);
  expect(Buffer.concat(audio)).toHaveLength(478); // 239 interpolated samples; last sample retained by the shared resampler.
  expect(Buffer.concat(audio).subarray(0, 4).toString()).not.toBe("RIFF");
  expect(sockets[0].terminate).toHaveBeenCalled();
});

test("real loopback WebSockets carry binary PCM and CloseStream without contacting Deepgram", async () => {
  const actual = await vi.importActual<typeof import("ws")>("ws");
  const server = new actual.WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture listener unavailable");
  const peers = new Set<import("ws").WebSocket>();
  const audio: Buffer[] = [];
  const controls: string[] = [];
  server.on("connection", (peer, request) => {
    peers.add(peer);
    expect(request.headers.authorization).toBe("Token fixture-key");
    peer.on("message", (data, binary) => {
      if (binary) {
        audio.push(Buffer.from(data as Buffer));
        return;
      }
      controls.push(data.toString());
      if (data.toString() === '{"type":"CloseStream"}') {
        peer.send(
          JSON.stringify({
            type: "Results",
            start: 0,
            duration: 1,
            is_final: true,
            channel: { alternatives: [{ transcript: "日本語 English" }] },
          }),
        );
        peer.send('{"type":"Metadata"}');
        peer.close(1000);
      }
    });
  });
  constructor.mockImplementation(function (url, options) {
    expect(url.origin).toBe("wss://api.deepgram.com");
    return new actual.WebSocket(`ws://127.0.0.1:${address.port}/v1/listen${url.search}`, options);
  });
  const { session, errors } = setup();
  try {
    await session.connect();
    const final = new Promise<StreamingTranscriptionEvent>((resolve, reject) => {
      session.on("transcript", (event) => {
        if (event.isFinal) resolve(event);
      });
      session.on("error", reject);
    });
    const pcm = Buffer.from([0xff, 0x7f, 0x00, 0x80]);
    session.appendPcm16(pcm);
    session.commit();
    expect(await final).toMatchObject({ transcript: "日本語 English", isFinal: true });
    expect(Buffer.concat(audio)).toEqual(pcm);
    expect(controls).toEqual(['{"type":"CloseStream"}']);
    expect(errors).toEqual([]);
  } finally {
    session.close();
    for (const peer of peers) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
