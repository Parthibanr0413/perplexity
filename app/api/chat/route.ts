import { NextRequest, NextResponse } from "next/server";

import { getOpenRouterHeaders, getServerConfig } from "@/lib/env";
import { getOpenRouterModelById } from "@/lib/openrouter-models";
import { getOpenRouterRuntimeKey } from "@/lib/openrouter-key";
import { searchWeb } from "@/lib/research";
import type { ChatTurn, ResearchSource } from "@/lib/types";

export const runtime = "nodejs";

type ChatMode = "ask" | "think" | "agent";

type ChatBody = {
  mode?: ChatMode;
  modelId?: string;
  prompt?: string;
  history?: ChatTurn[];
  useResearch?: boolean;
  sourceLimit?: number;
};

type ToolCall = {
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type CompletionResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
      tool_calls?: ToolCall[];
    };
  }>;
};

const SEARCH_WEB_TOOL = {
  type: "function",
  function: {
    name: "search_web",
    description: "Search the web and return short result snippets for research or verification.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query to run.",
        },
        num_results: {
          type: "integer",
          description: "How many results to return.",
          minimum: 1,
          maximum: 8,
        },
      },
      required: ["query"],
    },
  },
} as const;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeHistory(history: unknown) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter((turn): turn is ChatTurn => {
      if (!turn || typeof turn !== "object") {
        return false;
      }

      const role = (turn as ChatTurn).role;
      const content = (turn as ChatTurn).content;
      return (role === "user" || role === "assistant") && typeof content === "string" && content.trim().length > 0;
    })
    .slice(-10);
}

function normalizeMode(value: unknown): ChatMode {
  return value === "think" || value === "agent" ? value : "ask";
}

function serializeSources(sources: ResearchSource[]) {
  return sources
    .map(
      (source) =>
        `[${source.id}] ${source.title}\nURL: ${source.url}\nSnippet: ${source.snippet || "No snippet provided."}`,
    )
    .join("\n\n");
}

function buildSystemMessage(mode: ChatMode, hasSources: boolean) {
  const base = [
    "You are Scout, a research-first assistant.",
    "Give direct, useful answers without filler.",
  ];

  if (mode === "think") {
    base.push("Think carefully before answering.");
    base.push("Do not reveal chain-of-thought; provide only the useful final answer and concise reasoning summary.");
  }

  if (mode === "agent") {
    base.push("Act like a practical agent.");
    base.push("If tools or sources are available, use them to verify important claims before answering.");
  }

  if (hasSources) {
    base.push("Cite supported claims inline using bracketed references like [1] and [2].");
    base.push("Do not invent sources.");
  } else {
    base.push("Be honest when you are uncertain or when fresh evidence was not retrieved.");
  }

  return base.join(" ");
}

function buildPromptMessages(history: ChatTurn[], prompt: string, sources: ResearchSource[], mode: ChatMode) {
  const messages: Array<Record<string, unknown>> = [
    {
      role: "system",
      content: buildSystemMessage(mode, sources.length > 0),
    },
    ...history.map((turn) => ({
      role: turn.role,
      content: turn.content,
    })),
  ];

  if (sources.length > 0) {
    messages.push({
      role: "system",
      content: `Research pack:\n\n${serializeSources(sources)}`,
    });
  }

  messages.push({
    role: "user",
    content: prompt.trim(),
  });

  return messages;
}

function extractContentDelta(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          return part.text;
        }

        return "";
      })
      .join("");
  }

  return "";
}

function encodeEvent(event: string, payload: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

async function readErrorText(response: Response) {
  try {
    return await response.text();
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

function buildResponseHeaders() {
  return {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
  };
}

function createSingleResponseStream(meta: { modelId: string; sources: ResearchSource[] }, content: string) {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          encodeEvent("meta", {
            modelId: meta.modelId,
            providerLabel: "OpenRouter",
            sources: meta.sources,
          }),
        ),
      );
      controller.enqueue(encoder.encode(encodeEvent("delta", { text: content })));
      controller.enqueue(encoder.encode(encodeEvent("done", { ok: true })));
      controller.close();
    },
  });
}

async function createSseBridge(
  upstream: ReadableStream<Uint8Array>,
  meta: {
    modelId: string;
    sources: ResearchSource[];
  },
) {
  const reader = upstream.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      controller.enqueue(
        encoder.encode(
          encodeEvent("meta", {
            modelId: meta.modelId,
            providerLabel: "OpenRouter",
            sources: meta.sources,
          }),
        ),
      );

      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

          while (buffer.includes("\n\n")) {
            const separatorIndex = buffer.indexOf("\n\n");
            const rawEvent = buffer.slice(0, separatorIndex);
            buffer = buffer.slice(separatorIndex + 2);

            const lines = rawEvent.split(/\r?\n/);
            const dataLines = lines
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim());

            if (dataLines.length === 0) {
              continue;
            }

            const payload = dataLines.join("\n");

            if (payload === "[DONE]") {
              controller.enqueue(encoder.encode(encodeEvent("done", { ok: true })));
              controller.close();
              closed = true;
              return;
            }

            let parsed: unknown;

            try {
              parsed = JSON.parse(payload);
            } catch {
              continue;
            }

            if (parsed && typeof parsed === "object" && "error" in parsed) {
              const errorPayload = parsed as { error?: unknown };

              controller.enqueue(
                encoder.encode(
                  encodeEvent("error", {
                    message:
                      typeof errorPayload.error === "string"
                        ? errorPayload.error
                        : "Upstream provider returned an error.",
                  }),
                ),
              );
              controller.close();
              closed = true;
              return;
            }

            const choice = Array.isArray((parsed as { choices?: unknown[] }).choices)
              ? (parsed as { choices: Array<Record<string, unknown>> }).choices[0]
              : null;
            const deltaContent =
              choice && choice.delta && typeof choice.delta === "object"
                ? (choice.delta as Record<string, unknown>).content
                : choice && choice.message && typeof choice.message === "object"
                  ? (choice.message as Record<string, unknown>).content
                  : null;
            const delta = choice ? extractContentDelta(deltaContent) : "";

            if (delta) {
              controller.enqueue(encoder.encode(encodeEvent("delta", { text: delta })));
            }
          }
        }

        controller.enqueue(encoder.encode(encodeEvent("done", { ok: true })));
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            encodeEvent("error", {
              message: error instanceof Error ? error.message : "Stream bridge failed.",
            }),
          ),
        );
      } finally {
        if (!closed) {
          controller.close();
        }
      }
    },
  });
}

function dedupeSources(sources: ResearchSource[]) {
  return Array.from(new Map(sources.map((source) => [source.url, source])).values()).map((source, index) => ({
    ...source,
    id: index + 1,
  }));
}

function getReasoningPayload(mode: ChatMode, supportsReasoning: boolean) {
  if (!supportsReasoning) {
    return undefined;
  }

  if (mode === "think") {
    return {
      enabled: true,
      effort: "high",
      exclude: true,
    };
  }

  if (mode === "agent") {
    return {
      enabled: true,
      effort: "medium",
      exclude: true,
    };
  }

  return undefined;
}

async function callOpenRouterJson(apiKey: string, body: Record<string, unknown>) {
  const config = getServerConfig();
  const response = await fetch(`${config.openRouterBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...getOpenRouterHeaders(config),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await readErrorText(response));
  }

  return (await response.json()) as CompletionResponse;
}

async function runAgentLoop(params: {
  apiKey: string;
  history: ChatTurn[];
  modelId: string;
  prompt: string;
  sourceLimit: number;
  supportsReasoning: boolean;
  supportsTools: boolean;
  useResearch: boolean;
}) {
  const { apiKey, history, modelId, prompt, sourceLimit, supportsReasoning, supportsTools, useResearch } = params;
  let gatheredSources: ResearchSource[] = [];

  if (!useResearch || !supportsTools) {
    if (useResearch) {
      try {
        gatheredSources = await searchWeb(prompt, sourceLimit);
      } catch {
        gatheredSources = [];
      }
    }

    const fallbackResponse = await callOpenRouterJson(apiKey, {
      model: modelId,
      messages: buildPromptMessages(history, prompt, gatheredSources, "agent"),
      stream: false,
      temperature: 0.2,
      max_tokens: 1400,
      ...(getReasoningPayload("agent", supportsReasoning)
        ? { reasoning: getReasoningPayload("agent", supportsReasoning) }
        : {}),
    });
    const fallbackText = extractContentDelta(fallbackResponse.choices?.[0]?.message?.content);

    return {
      content: fallbackText || "No answer was returned.",
      sources: dedupeSources(gatheredSources),
    };
  }

  const messages: Array<Record<string, unknown>> = buildPromptMessages(history, prompt, [], "agent");

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const response = await callOpenRouterJson(apiKey, {
      model: modelId,
      messages,
      tools: [SEARCH_WEB_TOOL],
      tool_choice: "auto",
      parallel_tool_calls: false,
      stream: false,
      temperature: 0.2,
      max_tokens: 1400,
      ...(getReasoningPayload("agent", supportsReasoning)
        ? { reasoning: getReasoningPayload("agent", supportsReasoning) }
        : {}),
    });
    const message = response.choices?.[0]?.message;

    if (!message) {
      break;
    }

    messages.push(message as Record<string, unknown>);

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    if (toolCalls.length === 0) {
      return {
        content: extractContentDelta(message.content) || "No answer was returned.",
        sources: dedupeSources(gatheredSources),
      };
    }

    for (const toolCall of toolCalls.slice(0, 3)) {
      const queryFallback = prompt;
      let query = queryFallback;
      let numResults = sourceLimit;

      if (toolCall.function?.arguments) {
        try {
          const parsedArguments = JSON.parse(toolCall.function.arguments) as {
            query?: unknown;
            num_results?: unknown;
          };

          if (typeof parsedArguments.query === "string" && parsedArguments.query.trim()) {
            query = parsedArguments.query.trim();
          }

          if (typeof parsedArguments.num_results === "number") {
            numResults = clamp(parsedArguments.num_results, 1, 8);
          }
        } catch {
          query = queryFallback;
        }
      }

      const results = await searchWeb(query, numResults).catch(() => []);
      gatheredSources = dedupeSources([...gatheredSources, ...results]);

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id || "search-web",
        content: JSON.stringify({
          query,
          results,
        }),
      });
    }
  }

  return {
    content: "I hit the agent step limit before producing a final answer.",
    sources: dedupeSources(gatheredSources),
  };
}

export async function POST(request: NextRequest) {
  let body: ChatBody;

  try {
    body = (await request.json()) as ChatBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const prompt = body.prompt?.trim();
  const mode = normalizeMode(body.mode);
  const config = getServerConfig();
  const modelId = body.modelId?.trim() || config.defaultOpenRouterModel;

  if (!prompt) {
    return NextResponse.json({ error: "prompt is required." }, { status: 400 });
  }

  const history = normalizeHistory(body.history);
  const sourceLimit = clamp(body.sourceLimit ?? config.defaultSourceLimit, 3, 8);
  const useResearch = Boolean(body.useResearch);
  const model = await getOpenRouterModelById(modelId);
  const supportsReasoning = model?.supportsReasoning ?? false;
  const supportsTools = model?.supportsTools ?? false;

  let apiKey = "";

  try {
    apiKey = await getOpenRouterRuntimeKey();
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "OpenRouter key setup failed.",
      },
      { status: 400 },
    );
  }

  if (mode === "agent") {
    try {
      const result = await runAgentLoop({
        apiKey,
        history,
        modelId,
        prompt,
        sourceLimit,
        supportsReasoning,
        supportsTools,
        useResearch,
      });

      const stream = createSingleResponseStream(
        {
          modelId,
          sources: result.sources,
        },
        result.content,
      );

      return new Response(stream, {
        headers: buildResponseHeaders(),
      });
    } catch (error) {
      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : "Agent mode failed.",
        },
        { status: 500 },
      );
    }
  }

  let sources: ResearchSource[] = [];

  if (useResearch) {
    try {
      sources = await searchWeb(prompt, sourceLimit);
    } catch {
      sources = [];
    }
  }

  const configBody: Record<string, unknown> = {
    model: modelId,
    messages: buildPromptMessages(history, prompt, sources, mode),
    stream: true,
    temperature: mode === "think" || sources.length > 0 ? 0.25 : 0.6,
    max_tokens: mode === "think" ? 1600 : 1200,
  };

  const reasoning = getReasoningPayload(mode, supportsReasoning);

  if (reasoning) {
    configBody.reasoning = reasoning;
  }

  const response = await fetch(`${config.openRouterBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...getOpenRouterHeaders(config),
    },
    body: JSON.stringify(configBody),
  });

  if (!response.ok || !response.body) {
    const errorText = await readErrorText(response);

    return NextResponse.json(
      {
        error: errorText || "The upstream provider returned an empty response.",
      },
      { status: response.status || 502 },
    );
  }

  const stream = await createSseBridge(response.body, {
    modelId,
    sources,
  });

  return new Response(stream, {
    headers: buildResponseHeaders(),
  });
}
