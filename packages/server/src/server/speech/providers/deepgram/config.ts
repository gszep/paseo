import type { PersistedConfig } from "../../../persisted-config.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";

export interface DeepgramSttOptions {
  model: "nova-3";
  languageHints?: string[];
}

export interface DeepgramSpeechConfig {
  apiKey: string;
  dictation?: DeepgramSttOptions;
  voice?: DeepgramSttOptions;
}

export function resolveDeepgramApiKey(
  persisted: PersistedConfig,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return persisted.providers?.deepgram?.apiKey?.trim() || env.DEEPGRAM_API_KEY?.trim() || undefined;
}

export function resolveDeepgramSpeechConfig(input: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
  providers: RequestedSpeechProviders;
  languages: { dictation: string; voice: string };
}): DeepgramSpeechConfig | undefined {
  const selected = (slot: keyof RequestedSpeechProviders) =>
    input.providers[slot].provider === "deepgram" && input.providers[slot].enabled !== false;
  if (!selected("dictationStt") && !selected("voiceStt")) return undefined;
  const options = (route: "dictation" | "voice"): DeepgramSttOptions => {
    const config =
      route === "dictation"
        ? input.persisted.features?.dictation?.stt
        : input.persisted.features?.voiceMode?.stt;
    if (config?.model && config.model !== "nova-3")
      throw new Error("Deepgram STT requires model nova-3");
    if (config?.languageHints?.length && input.languages[route] !== "multi")
      throw new Error("Deepgram language hints require language multi");
    return {
      model: "nova-3",
      ...(config?.languageHints?.length ? { languageHints: [...config.languageHints] } : {}),
    };
  };
  const dictation = selected("dictationStt") ? options("dictation") : undefined;
  const voice = selected("voiceStt") ? options("voice") : undefined;
  // Same operator-owned configuration/environment precedence as the existing
  // speech credentials. Never discover credentials from other applications.
  const apiKey = resolveDeepgramApiKey(input.persisted, input.env);
  if (!apiKey) return undefined; // Selected but unavailable; never fall back to a different provider.
  return { apiKey, ...(dictation ? { dictation } : {}), ...(voice ? { voice } : {}) };
}
