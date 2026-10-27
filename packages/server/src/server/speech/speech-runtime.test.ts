import { beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { EventEmitter } from "node:events";
import { resolveSpeechConfig } from "./speech-config-resolver.js";
import { PersistedConfigSchema } from "../persisted-config.js";

import type { PaseoSpeechConfig } from "../bootstrap.js";
import type { InitializedLocalSpeech } from "./providers/local/runtime.js";
import type { SpeechToTextProvider, TextToSpeechProvider } from "./speech-provider.js";
import type { TurnDetectionProvider } from "./turn-detection-provider.js";
import { createSpeechService } from "./speech-runtime.js";

const { ensureLocalSpeechModelsMock, initializeLocalSpeechServicesMock, webSocketMock } =
  vi.hoisted(() => ({
    ensureLocalSpeechModelsMock: vi.fn(async () => ({})),
    initializeLocalSpeechServicesMock: vi.fn<(args: unknown) => Promise<InitializedLocalSpeech>>(),
    webSocketMock: vi.fn(),
  }));
vi.mock("ws", () => ({ WebSocket: webSocketMock }));

vi.mock("./providers/local/runtime.js", () => ({
  initializeLocalSpeechServices: initializeLocalSpeechServicesMock,
}));

vi.mock("./providers/openai/runtime.js", () => ({
  getOpenAiSpeechAvailability: () => ({ configured: false }),
  initializeOpenAiSpeechServices: (args: {
    existing: {
      turnDetectionService: TurnDetectionProvider | null;
      sttService: SpeechToTextProvider | null;
      ttsService: TextToSpeechProvider | null;
      dictationSttService: SpeechToTextProvider | null;
    };
  }) => ({
    turnDetectionService: args.existing.turnDetectionService,
    sttService: args.existing.sttService,
    ttsService: args.existing.ttsService,
    dictationSttService: args.existing.dictationSttService,
  }),
  validateOpenAiCredentialRequirements: () => {},
}));

vi.mock("./providers/local/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./providers/local/models.js")>()),
  ensureLocalSpeechModels: ensureLocalSpeechModelsMock,
  getLocalSpeechModelDir: vi.fn(() => ""),
  listLocalSpeechModels: vi.fn(() => []),
}));

function createStubStt(id: string): SpeechToTextProvider {
  return {
    id,
    createSession: vi.fn(() => {
      throw new Error("not used in this test");
    }),
  };
}

function createStubTts(id: string): TextToSpeechProvider {
  return {
    id,
    synthesizeSpeech: vi.fn(async () => {
      throw new Error("not used in this test");
    }),
  };
}

function createStubTurnDetection(id: string): TurnDetectionProvider {
  return {
    id,
    createSession: vi.fn(() => {
      throw new Error("not used in this test");
    }),
  };
}

function rejectWhenAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function createSpeechConfig(providers: PaseoSpeechConfig["providers"]): PaseoSpeechConfig {
  return {
    providers,
    sttLanguages: {
      dictation: "en",
      voice: "en",
    },
  };
}

describe("createSpeechService readiness", () => {
  beforeEach(() => {
    ensureLocalSpeechModelsMock.mockReset();
    ensureLocalSpeechModelsMock.mockResolvedValue({});
    initializeLocalSpeechServicesMock.mockReset();
    webSocketMock.mockReset();
    Object.assign(webSocketMock, { OPEN: 1 });
  });

  it("both resolved EN/JA routes construct the actual Nova-3 multi request with repeated hints and preserve TTS", async () => {
    const tts = createStubTts("local");
    const detector = createStubTurnDetection("local");
    initializeLocalSpeechServicesMock.mockResolvedValue({
      turnDetectionService: detector,
      sttService: null,
      ttsService: tts,
      dictationSttService: null,
      localVoiceTtsProvider: tts,
      localModelConfig: null,
      availability: { configured: false, modelsDir: null, missingModelIds: [] },
      cleanup: () => undefined,
    });
    webSocketMock.mockImplementation(function () {
      const socket = Object.assign(new EventEmitter(), {
        readyState: 1,
        bufferedAmount: 0,
        send: vi.fn(),
        terminate: vi.fn(),
      });
      queueMicrotask(socket.emit.bind(socket, "open"));
      return socket;
    });
    const stt = {
      provider: "deepgram",
      model: "nova-3",
      language: "multi",
      languageHints: ["en", "ja"],
    };
    const config = resolveSpeechConfig({
      paseoHome: "/fixture",
      env: {},
      persisted: PersistedConfigSchema.parse({
        providers: { deepgram: { apiKey: "fixture-key" } },
        features: { dictation: { enabled: true, stt }, voiceMode: { enabled: true, stt } },
      }),
    });
    const service = createSpeechService({
      logger: pino({ level: "silent" }),
      speechConfig: config.speech,
    });
    service.start();
    await service.ready;
    try {
      for (const [provider, language] of [
        [service.resolveDictationStt(), service.resolveDictationSttLanguage()],
        [service.resolveStt(), service.resolveSttLanguage()],
      ] as const) {
        expect(provider?.id).toBe("deepgram");
        const session = provider!.createSession({ logger: pino({ level: "silent" }), language });
        try {
          await session.connect();
        } finally {
          session.close();
        }
      }
      expect(webSocketMock).toHaveBeenCalledTimes(2);
      for (const [url] of webSocketMock.mock.calls) {
        expect(url.origin + url.pathname).toBe("wss://api.deepgram.com/v1/listen");
        expect(url.searchParams.get("model")).toBe("nova-3");
        expect(url.searchParams.get("language")).toBe("multi");
        expect(url.searchParams.getAll("language_hint")).toEqual(["en", "ja"]);
        expect(url.searchParams.has("prompt")).toBe(false);
      }
      expect(service.resolveTts()).toBe(tts);
      expect(service.resolveTurnDetection()).toBe(detector);
    } finally {
      await service.stop();
    }
  });

  it.each([true, false])(
    "initializes selected Deepgram STT only when configured (credentials=%s), keeping TTS unchanged",
    async (configured) => {
      const tts = createStubTts("local");
      initializeLocalSpeechServicesMock.mockResolvedValue({
        turnDetectionService: null,
        sttService: null,
        ttsService: tts,
        dictationSttService: null,
        localVoiceTtsProvider: tts,
        localModelConfig: null,
        availability: { configured: false, modelsDir: null, missingModelIds: [] },
        cleanup: () => undefined,
      });
      const speechConfig = createSpeechConfig({
        dictationStt: { provider: "deepgram", explicit: true },
        voiceStt: { provider: "deepgram", explicit: true },
        voiceTurnDetection: { provider: "local", explicit: false, enabled: false },
        voiceTts: { provider: "local", explicit: false },
      });
      if (configured)
        speechConfig.deepgram = {
          apiKey: "fixture-key",
          voice: { model: "nova-3" },
          dictation: { model: "nova-3" },
        };
      const service = createSpeechService({ logger: pino({ level: "silent" }), speechConfig });
      service.start();
      await service.ready;
      expect(service.resolveDictationStt()?.id ?? null).toBe(configured ? "deepgram" : null);
      expect(service.resolveStt()?.id ?? null).toBe(configured ? "deepgram" : null);
      expect(service.resolveTts()).toBe(tts);
      expect(service.getReadiness().dictation.available).toBe(configured);
      await service.stop();
    },
  );

  it("keeps voice feature available when only dictation is enabled and ready", async () => {
    const dictationStt = createStubStt("dictation-local");

    initializeLocalSpeechServicesMock.mockResolvedValue({
      turnDetectionService: null,
      sttService: null,
      ttsService: null,
      dictationSttService: dictationStt,
      localVoiceTtsProvider: null,
      localModelConfig: null,
      availability: {
        configured: false,
        modelsDir: null,
      },
      cleanup: () => {},
    });

    const runtime = createSpeechService({
      logger: pino({ level: "silent" }),
      speechConfig: createSpeechConfig({
        dictationStt: { provider: "local", enabled: true, explicit: true },
        voiceTurnDetection: { provider: "local", enabled: false, explicit: true },
        voiceStt: { provider: "local", enabled: false, explicit: true },
        voiceTts: { provider: "local", enabled: false, explicit: true },
      }),
    });
    runtime.start();
    await runtime.ready;

    const readiness = runtime.getReadiness();
    expect(readiness.dictation.available).toBe(true);
    expect(readiness.realtimeVoice.reasonCode).toBe("disabled");
    expect(readiness.voiceFeature.available).toBe(true);
    expect(readiness.voiceFeature.reasonCode).toBe("ready");

    await runtime.stop();
  });

  it("keeps voice feature available when only realtime voice is enabled and ready", async () => {
    const voiceStt = createStubStt("voice-local");
    const voiceTts = createStubTts("tts-local");
    const turnDetection = createStubTurnDetection("turn-local");

    initializeLocalSpeechServicesMock.mockResolvedValue({
      turnDetectionService: turnDetection,
      sttService: voiceStt,
      ttsService: voiceTts,
      dictationSttService: null,
      localVoiceTtsProvider: voiceTts,
      localModelConfig: null,
      availability: {
        configured: false,
        modelsDir: null,
      },
      cleanup: () => {},
    });

    const runtime = createSpeechService({
      logger: pino({ level: "silent" }),
      speechConfig: createSpeechConfig({
        dictationStt: { provider: "local", enabled: false, explicit: true },
        voiceTurnDetection: { provider: "local", enabled: true, explicit: true },
        voiceStt: { provider: "local", enabled: true, explicit: true },
        voiceTts: { provider: "local", enabled: true, explicit: true },
      }),
    });
    runtime.start();
    await runtime.ready;

    const readiness = runtime.getReadiness();
    expect(readiness.realtimeVoice.available).toBe(true);
    expect(readiness.dictation.reasonCode).toBe("disabled");
    expect(readiness.voiceFeature.available).toBe(true);
    expect(readiness.voiceFeature.reasonCode).toBe("ready");

    await runtime.stop();
  });

  it("aborts and joins an in-flight model download when stopped", async () => {
    let downloadSignal: AbortSignal | undefined;
    ensureLocalSpeechModelsMock.mockImplementation(({ signal }: { signal?: AbortSignal }) => {
      downloadSignal = signal;
      return rejectWhenAborted(signal);
    });
    initializeLocalSpeechServicesMock.mockResolvedValue({
      turnDetectionService: null,
      sttService: null,
      ttsService: null,
      dictationSttService: null,
      localVoiceTtsProvider: null,
      localModelConfig: {
        modelsDir: "/tmp/missing-local-speech-models",
        defaultModelIds: ["parakeet-tdt-0.6b-v2-int8"],
      },
      availability: {
        configured: true,
        modelsDir: "/tmp/missing-local-speech-models",
      },
      cleanup: () => {},
    });

    const runtime = createSpeechService({
      logger: pino({ level: "silent" }),
      speechConfig: createSpeechConfig({
        dictationStt: { provider: "local", enabled: true, explicit: true },
        voiceTurnDetection: { provider: "local", enabled: false, explicit: true },
        voiceStt: { provider: "local", enabled: false, explicit: true },
        voiceTts: { provider: "local", enabled: false, explicit: true },
      }),
    });
    runtime.start();
    await runtime.ready;
    expect(ensureLocalSpeechModelsMock).toHaveBeenCalledOnce();

    await runtime.stop();

    expect(downloadSignal?.aborted).toBe(true);
  });
});
