import { getOpenRouterHeaders, getServerConfig, MODEL_REFRESH_MS } from "@/lib/env";

export type OpenRouterModelOption = {
  id: string;
  label: string;
  description: string;
  note: string;
  contextLength: number | null;
  isFree: boolean;
  supportsReasoning: boolean;
  supportsTools: boolean;
  tags: string[];
};

export type OpenRouterModelsPayload = {
  models: OpenRouterModelOption[];
  refreshedAt: string;
  nextRefreshAt: string;
  source: "live" | "fallback";
};

type CachedModels = {
  payload: OpenRouterModelsPayload;
  expiresAt: number;
};

type RawModel = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  context_length?: unknown;
  supported_parameters?: unknown;
  pricing?: {
    prompt?: unknown;
    completion?: unknown;
  };
  architecture?: {
    modality?: unknown;
    input_modalities?: unknown;
    output_modalities?: unknown;
  };
};

const OPENROUTER_FREE_ROUTER: OpenRouterModelOption = {
  id: "openrouter/free",
  label: "OpenRouter Free Router",
  description: "Automatically routes your prompt to an available free model on OpenRouter.",
  note: "Best default when you want OpenRouter to pick an available model with the features your request needs.",
  contextLength: 200000,
  isFree: true,
  supportsReasoning: true,
  supportsTools: true,
  tags: ["free", "router", "thinking", "tools"],
};

export const FALLBACK_OPENROUTER_MODEL_OPTIONS: OpenRouterModelOption[] = [
  OPENROUTER_FREE_ROUTER,
  {
    id: "stepfun/step-3.5-flash:free",
    label: "Step 3.5 Flash",
    description: "A strong general-purpose free model and one of OpenRouter's top current free picks.",
    note: "Good fast everyday model.",
    contextLength: 256000,
    isFree: true,
    supportsReasoning: false,
    supportsTools: true,
    tags: ["free", "general"],
  },
  {
    id: "openai/gpt-oss-120b:free",
    label: "gpt-oss-120b",
    description: "An open-weight reasoning model from OpenAI tuned for stronger general-purpose and agentic use.",
    note: "Best fallback for heavier reasoning.",
    contextLength: 131072,
    isFree: true,
    supportsReasoning: true,
    supportsTools: true,
    tags: ["free", "reasoning"],
  },
  {
    id: "qwen/qwen3-coder:free",
    label: "Qwen3 Coder",
    description: "A coding-focused model for debugging, generation, and repo work.",
    note: "Use this for code-heavy chats.",
    contextLength: 262000,
    isFree: true,
    supportsReasoning: true,
    supportsTools: true,
    tags: ["free", "coding"],
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct:free",
    label: "Llama 3.3 70B Instruct",
    description: "A strong multilingual general assistant model.",
    note: "Reliable for broad general chat.",
    contextLength: 128000,
    isFree: true,
    supportsReasoning: false,
    supportsTools: true,
    tags: ["free", "general"],
  },
];

let cache: CachedModels | null = null;

function normalizeText(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function toInteger(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isTextChatModel(raw: RawModel) {
  const modality = normalizeText(raw.architecture?.modality).toLowerCase();
  const outputModalities = normalizeStringArray(raw.architecture?.output_modalities).map((item) => item.toLowerCase());

  if (outputModalities.length > 0) {
    return outputModalities.includes("text");
  }

  if (!modality) {
    return true;
  }

  return modality.endsWith("->text") || modality === "text->text";
}

function buildNote(model: Omit<OpenRouterModelOption, "note">) {
  if (model.id === "openrouter/free") {
    return "Best default when you want OpenRouter to choose a free model automatically.";
  }

  const tags: string[] = [];

  if (model.isFree) {
    tags.push("free");
  }

  if (model.supportsReasoning) {
    tags.push("thinking");
  }

  if (model.supportsTools) {
    tags.push("tools");
  }

  if (model.contextLength && model.contextLength >= 100000) {
    tags.push("long context");
  }

  return tags.length > 0 ? `Supports ${tags.join(", ")}.` : "Standard chat model.";
}

function normalizeModel(raw: RawModel): OpenRouterModelOption | null {
  if (!isTextChatModel(raw)) {
    return null;
  }

  const id = normalizeText(raw.id);

  if (!id) {
    return null;
  }

  if (id === "openrouter/free") {
    return {
      ...OPENROUTER_FREE_ROUTER,
      label: normalizeText(raw.name, OPENROUTER_FREE_ROUTER.label),
      description: normalizeText(raw.description, OPENROUTER_FREE_ROUTER.description),
    };
  }

  const supportedParameters = normalizeStringArray(raw.supported_parameters);
  const inputPrice = toNumber(raw.pricing?.prompt);
  const outputPrice = toNumber(raw.pricing?.completion);
  const model = {
    id,
    label: normalizeText(raw.name, id),
    description: normalizeText(raw.description, "OpenRouter model."),
    contextLength: toInteger(raw.context_length),
    isFree: id.endsWith(":free") || (inputPrice === 0 && outputPrice === 0),
    supportsReasoning: supportedParameters.includes("reasoning"),
    supportsTools:
      supportedParameters.includes("tools") ||
      supportedParameters.includes("tool_choice") ||
      supportedParameters.includes("parallel_tool_calls"),
    tags: [
      ...(id.startsWith("openrouter/") ? ["router"] : []),
      ...(id.endsWith(":free") || (inputPrice === 0 && outputPrice === 0) ? ["free"] : []),
      ...(supportedParameters.includes("reasoning") ? ["thinking"] : []),
      ...(supportedParameters.includes("tools") ? ["tools"] : []),
    ],
  };

  return {
    ...model,
    note: buildNote(model),
  };
}

function dedupeModels(models: OpenRouterModelOption[]) {
  return Array.from(new Map(models.map((model) => [model.id, model])).values());
}

function sortModels(models: OpenRouterModelOption[]) {
  return [...models].sort((left, right) => {
    if (left.id === "openrouter/free") {
      return -1;
    }

    if (right.id === "openrouter/free") {
      return 1;
    }

    if (left.isFree !== right.isFree) {
      return left.isFree ? -1 : 1;
    }

    if (left.supportsReasoning !== right.supportsReasoning) {
      return left.supportsReasoning ? -1 : 1;
    }

    return left.label.localeCompare(right.label);
  });
}

async function fetchModelFeed(pathname: "/models" | "/models/user") {
  const config = getServerConfig();
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...getOpenRouterHeaders(config),
  };

  if (config.openRouterKey) {
    headers.Authorization = `Bearer ${config.openRouterKey}`;
  }

  const response = await fetch(`${config.openRouterBaseUrl}${pathname}`, {
    headers,
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const payload = (await response.json()) as { data?: RawModel[] };
  return Array.isArray(payload.data) ? payload.data : [];
}

export async function getOpenRouterModels(forceRefresh = false): Promise<OpenRouterModelsPayload> {
  const now = Date.now();

  if (!forceRefresh && cache && cache.expiresAt > now) {
    return cache.payload;
  }

  try {
    const config = getServerConfig();
    const records = config.openRouterKey
      ? await fetchModelFeed("/models/user").catch(() => fetchModelFeed("/models"))
      : await fetchModelFeed("/models");
    const normalized = records
      .map((record) => normalizeModel(record))
      .filter((model): model is OpenRouterModelOption => Boolean(model));
    const models = dedupeModels(
      normalized.some((model) => model.id === "openrouter/free")
        ? normalized
        : [OPENROUTER_FREE_ROUTER, ...normalized],
    );
    const refreshedAt = new Date();
    const payload: OpenRouterModelsPayload = {
      models: sortModels(models),
      refreshedAt: refreshedAt.toISOString(),
      nextRefreshAt: new Date(refreshedAt.getTime() + MODEL_REFRESH_MS).toISOString(),
      source: "live",
    };

    cache = {
      payload,
      expiresAt: now + MODEL_REFRESH_MS,
    };

    return payload;
  } catch {
    const refreshedAt = new Date();
    return {
      models: FALLBACK_OPENROUTER_MODEL_OPTIONS,
      refreshedAt: refreshedAt.toISOString(),
      nextRefreshAt: new Date(refreshedAt.getTime() + MODEL_REFRESH_MS).toISOString(),
      source: "fallback",
    };
  }
}

export async function getOpenRouterModelById(modelId: string) {
  const payload = await getOpenRouterModels();
  return payload.models.find((model) => model.id === modelId) ?? null;
}
