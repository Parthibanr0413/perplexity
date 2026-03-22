import type { ProviderId } from "@/lib/types";

export const MODEL_REFRESH_SECONDS = 60 * 60 * 4;
export const MODEL_REFRESH_MS = MODEL_REFRESH_SECONDS * 1000;
export const KEY_ROTATION_SECONDS = 60 * 60 * 4;
export const KEY_ROTATION_MS = KEY_ROTATION_SECONDS * 1000;

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_FASTROUTER_BASE_URL = "https://api.fastrouter.ai/api/v1";

interface ServerConfig {
  openRouterKey: string;
  openRouterKeyHash: string;
  openRouterManagementKey: string;
  fastRouterKey: string;
  openRouterBaseUrl: string;
  fastRouterBaseUrl: string;
  openRouterSiteUrl: string;
  openRouterSiteName: string;
  defaultSourceLimit: number;
  defaultOpenRouterModel: string;
}

function sanitizeUrl(url: string) {
  return url.replace(/\/+$/, "");
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function getServerConfig(): ServerConfig {
  const sourceLimit = Number.parseInt(process.env.DEFAULT_SOURCE_LIMIT ?? "6", 10);

  return {
    openRouterKey: process.env.OPENROUTER_API_KEY?.trim() ?? "",
    openRouterKeyHash: process.env.OPENROUTER_API_KEY_HASH?.trim() ?? "",
    openRouterManagementKey: process.env.OPENROUTER_MANAGEMENT_API_KEY?.trim() ?? "",
    fastRouterKey: process.env.FASTROUTER_API_KEY?.trim() ?? "",
    openRouterBaseUrl: sanitizeUrl(process.env.OPENROUTER_BASE_URL?.trim() || DEFAULT_OPENROUTER_BASE_URL),
    fastRouterBaseUrl: sanitizeUrl(process.env.FASTROUTER_BASE_URL?.trim() || DEFAULT_FASTROUTER_BASE_URL),
    openRouterSiteUrl: process.env.OPENROUTER_SITE_URL?.trim() || "http://localhost:3000",
    openRouterSiteName: process.env.OPENROUTER_SITE_NAME?.trim() || "Scout Query",
    defaultSourceLimit: clamp(Number.isFinite(sourceLimit) ? sourceLimit : 6, 3, 8),
    defaultOpenRouterModel: process.env.OPENROUTER_DEFAULT_MODEL?.trim() || "openrouter/free",
  };
}

export function getProviderBaseUrl(providerId: ProviderId, config = getServerConfig()) {
  return providerId === "openrouter" ? config.openRouterBaseUrl : config.fastRouterBaseUrl;
}

export function getProviderApiKey(providerId: ProviderId, config = getServerConfig()) {
  return providerId === "openrouter" ? config.openRouterKey : config.fastRouterKey;
}

export function isProviderConfigured(providerId: ProviderId, config = getServerConfig()) {
  return getProviderApiKey(providerId, config).length > 0;
}

export function getProviderLabel(providerId: ProviderId) {
  return providerId === "openrouter" ? "OpenRouter" : "FastRouter";
}

export function getProviderDocsUrl(providerId: ProviderId) {
  return providerId === "openrouter"
    ? "https://openrouter.ai/docs/api-reference/overview/"
    : "https://docs.fastrouter.ai/api-reference/chat-completions";
}

export function getOpenRouterHeaders(config = getServerConfig()) {
  return {
    "HTTP-Referer": config.openRouterSiteUrl,
    "X-Title": config.openRouterSiteName,
  };
}

export function isOpenRouterRotationConfigured(config = getServerConfig()) {
  return config.openRouterManagementKey.length > 0;
}
