import type { ProviderConfig } from "../domain/types.js";

export const PROVIDER_PROFILES: readonly ProviderConfig[] = [
  {
    id: "9router",
    defaultBaseUrl: "http://localhost:20128/v1",
    requiresApiKey: true,
  },
  {
    id: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    requiresApiKey: true,
  },
];

export function getProviderProfile(id: string): ProviderConfig | undefined {
  return PROVIDER_PROFILES.find((p) => p.id === id);
}
