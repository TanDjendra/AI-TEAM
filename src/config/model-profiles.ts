import type { ModelProfile } from "../domain/types.js";

export const MODEL_PROFILES: readonly ModelProfile[] = [
  {
    id: "grip/deepseek-v4.1-flash",
    providerId: "9router",
    contextWindow: 128_000,
    features: {
      supportsToolCalling: true,
    },
  },
  {
    id: "grip/gpt-5.6-luna",
    providerId: "9router",
    contextWindow: 128_000,
    features: {
      supportsToolCalling: true,
    },
  },
];

export function getModelProfile(id: string): ModelProfile | undefined {
  return MODEL_PROFILES.find((m) => m.id === id);
}

/**
 * Creates a fallback profile for an unknown model ID, assuming the default provider.
 */
export function synthesizeModelProfile(
  id: string,
  contextWindow: number,
  providerId: string = "9router"
): ModelProfile {
  return {
    id,
    providerId,
    contextWindow,
    features: {
      // By default assume unknown models support tool calling since V2 requires it for Coder.
      supportsToolCalling: true,
    },
  };
}
