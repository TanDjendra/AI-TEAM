/**
 * Model profiles (Phase V2-02, extended in V2.1).
 *
 * A model profile describes a model the router can serve: its context window,
 * output cap and capability flags. Business logic reads these rather than
 * hard-coding limits per model.
 *
 * V2.1 lets the JSON config file extend this catalogue, so a model the operator
 * types into the dashboard is a first-class entry (with real metadata) instead of
 * falling back to a synthesized guess.
 */

import type { ModelProfile } from "../domain/types.js";
import type { ConfiguredModel } from "./config-file.js";

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

export function getModelProfile(
  id: string,
  profiles: readonly ModelProfile[] = MODEL_PROFILES,
): ModelProfile | undefined {
  return profiles.find((m) => m.id === id);
}

/**
 * Merges the static catalogue with model entries from the config file.
 *
 * Duplicate ids: the configured entry wins, so the dashboard can correct a
 * context window without editing source. New ids are appended.
 */
export function resolveModelProfiles(
  configured: readonly ConfiguredModel[] = [],
): readonly ModelProfile[] {
  const resolved = new Map<string, ModelProfile>();
  for (const base of MODEL_PROFILES) resolved.set(base.id, base);
  for (const model of configured) resolved.set(model.id, toModelProfile(model));
  return [...resolved.values()];
}

function toModelProfile(model: ConfiguredModel): ModelProfile {
  return {
    id: model.id,
    providerId: model.providerId ?? "9router",
    contextWindow: model.contextWindow ?? 128_000,
    ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
    features: {
      supportsToolCalling: model.supportsToolCalling ?? true,
      ...(model.supportsVision !== undefined ? { supportsVision: model.supportsVision } : {}),
    },
  };
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
