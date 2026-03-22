"use client";

import Link from "next/link";
import { useDeferredValue, useEffect, useRef, useState } from "react";

import type { OpenRouterModelOption, OpenRouterModelsPayload } from "@/lib/openrouter-models";
import type { ResearchSource } from "@/lib/types";

type ChatMode = "ask" | "think" | "agent";
type ModelsMeta = {
  refreshedAt: string | null;
  nextRefreshAt: string | null;
  source: "live" | "fallback";
};
type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  pending?: boolean;
  sources?: ResearchSource[];
};
type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  messages: Message[];
};

type SimpleChatProps = {
  defaultModel: string;
  defaultSourceLimit: number;
  fallbackModelOptions: OpenRouterModelOption[];
  hasChatKey: boolean;
  hasInitialHash: boolean;
  rotationEnabled: boolean;
  rotationSource: string;
  rotatedAt: string | null;
  nextRotationAt: string | null;
};

const STARTERS = [
  "How do I build a multi-model chat app with OpenRouter?",
  "Compare the latest coding models in a short table.",
  "Draft a clean personal finance plan for the next 6 months.",
  "Create a quick product research brief with risks and opportunities.",
];

const MODE_COPY: Record<ChatMode, { title: string; description: string }> = {
  ask: {
    title: "Ask",
    description: "Direct answer mode for regular chat and quick questions.",
  },
  think: {
    title: "Think",
    description: "Careful reasoning mode for harder prompts and structured answers.",
  },
  agent: {
    title: "Agent",
    description: "Tool-using mode that can search before answering when supported.",
  },
};

function createId() {
  return crypto.randomUUID();
}

function makeTitle(input: string) {
  const compact = input.replace(/\s+/g, " ").trim();

  if (!compact) {
    return "New chat";
  }

  return compact.length > 38 ? `${compact.slice(0, 38)}...` : compact;
}

function formatTime(value: string | null) {
  if (!value) {
    return "Not started yet";
  }

  return new Date(value).toLocaleString();
}

function formatSectionLabel(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "RECENT";
  }

  return date
    .toLocaleString("en-US", {
      month: "long",
      year: "numeric",
    })
    .toUpperCase();
}

function formatContextLength(value: number | null) {
  if (!value) {
    return "Unknown context";
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M ctx`;
  }

  return `${Math.round(value / 1_000)}K ctx`;
}

function extractErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function groupConversations(conversations: Conversation[]) {
  const groups = new Map<string, Conversation[]>();

  for (const conversation of conversations) {
    const label = formatSectionLabel(conversation.createdAt);
    const current = groups.get(label) ?? [];
    current.push(conversation);
    groups.set(label, current);
  }

  return Array.from(groups.entries());
}

function buildCollections(models: OpenRouterModelOption[]) {
  const pick = (predicate: (model: OpenRouterModelOption) => boolean, fallbackCount = 4) => {
    const matches = models.filter(predicate);
    return (matches.length > 0 ? matches : models).slice(0, fallbackCount);
  };

  return [
    {
      title: "Flagship models",
      models: pick((model) => /gpt|claude|gemini|grok|llama 4|opus|sonnet/i.test(`${model.label} ${model.id}`)),
    },
    {
      title: "Best roleplay models",
      models: pick((model) => /mistral|llama|qwen|gemma|magnum|mytho|eva/i.test(`${model.label} ${model.id}`)),
    },
    {
      title: "Best coding models",
      models: pick((model) => /code|coder|devstral|codestral|gpt-oss|qwen3-coder/i.test(`${model.label} ${model.id}`)),
    },
    {
      title: "Reasoning models",
      models: pick((model) => model.supportsReasoning || /r1|reason|think|gpt-oss/i.test(`${model.label} ${model.id}`)),
    },
  ];
}

export function SimpleChat({
  defaultModel,
  defaultSourceLimit,
  fallbackModelOptions,
  hasChatKey,
  hasInitialHash,
  rotationEnabled,
  rotationSource,
  rotatedAt,
  nextRotationAt,
}: SimpleChatProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<OpenRouterModelOption[]>(fallbackModelOptions);
  const [selectedModel, setSelectedModel] = useState(defaultModel);
  const [modelQuery, setModelQuery] = useState("");
  const [roomQuery, setRoomQuery] = useState("");
  const [mode, setMode] = useState<ChatMode>("ask");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isModelsLoading, setIsModelsLoading] = useState(true);
  const [useResearch, setUseResearch] = useState(true);
  const [modelsMeta, setModelsMeta] = useState<ModelsMeta>({
    refreshedAt: null,
    nextRefreshAt: null,
    source: "fallback",
  });
  const endRef = useRef<HTMLDivElement | null>(null);
  const modelSelectRef = useRef<HTMLSelectElement | null>(null);
  const deferredModelQuery = useDeferredValue(modelQuery);
  const deferredRoomQuery = useDeferredValue(roomQuery);

  const activeConversation =
    conversations.find((conversation) => conversation.id === activeConversationId) ?? null;
  const activeMessages = activeConversation?.messages ?? [];
  const filteredModels = availableModels.filter((model) => {
    const query = deferredModelQuery.trim().toLowerCase();

    if (!query) {
      return true;
    }

    return `${model.label} ${model.id} ${model.description} ${model.tags.join(" ")}`
      .toLowerCase()
      .includes(query);
  });
  const visibleModels =
    filteredModels.length > 0 ? filteredModels : availableModels.filter((model) => model.id === selectedModel);
  const filteredConversations = conversations.filter((conversation) => {
    const query = deferredRoomQuery.trim().toLowerCase();

    if (!query) {
      return true;
    }

    return conversation.title.toLowerCase().includes(query);
  });
  const activeModel = availableModels.find((model) => model.id === selectedModel) ?? null;
  const activeMode = MODE_COPY[mode];
  const collections = buildCollections(availableModels);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [conversations, activeConversationId]);

  useEffect(() => {
    void loadModels();
  }, []);

  useEffect(() => {
    if (availableModels.length === 0) {
      return;
    }

    if (!availableModels.some((model) => model.id === selectedModel)) {
      setSelectedModel(availableModels[0].id);
    }
  }, [availableModels, selectedModel]);

  async function loadModels() {
    setIsModelsLoading(true);

    try {
      const response = await fetch("/api/models", { cache: "no-store" });

      if (!response.ok) {
        throw new Error(`Model list failed with ${response.status}.`);
      }

      const payload = (await response.json()) as OpenRouterModelsPayload;
      setAvailableModels(payload.models);
      setModelsMeta({
        refreshedAt: payload.refreshedAt,
        nextRefreshAt: payload.nextRefreshAt,
        source: payload.source,
      });
      setModelsError(null);
    } catch (caughtError) {
      setModelsError(extractErrorMessage(caughtError));
    } finally {
      setIsModelsLoading(false);
    }
  }

  function createConversation(title = "New chat") {
    const conversation: Conversation = {
      id: createId(),
      title,
      createdAt: new Date().toISOString(),
      messages: [],
    };

    setConversations((current) => [conversation, ...current]);
    setActiveConversationId(conversation.id);
    return conversation.id;
  }

  function updateConversation(conversationId: string, updater: (conversation: Conversation) => Conversation) {
    setConversations((current) =>
      current.map((conversation) => (conversation.id === conversationId ? updater(conversation) : conversation)),
    );
  }

  function handleNewChat() {
    createConversation();
    setPrompt("");
    setError(null);
  }

  async function submitQuestion(question: string) {
    const trimmedQuestion = question.trim();

    if (!trimmedQuestion || isLoading) {
      return;
    }

    const conversationId = activeConversation?.id ?? createConversation(makeTitle(trimmedQuestion));
    const currentConversation = conversations.find((conversation) => conversation.id === conversationId) ?? {
      id: conversationId,
      title: makeTitle(trimmedQuestion),
      createdAt: new Date().toISOString(),
      messages: [],
    };
    const history = currentConversation.messages
      .filter((message) => !message.pending)
      .map((message) => ({ role: message.role, content: message.content }));
    const userMessage: Message = {
      id: createId(),
      role: "user",
      content: trimmedQuestion,
    };
    const assistantId = createId();

    setActiveConversationId(conversationId);
    setPrompt("");
    setError(null);
    setIsLoading(true);
    setConversations((current) => {
      const exists = current.some((conversation) => conversation.id === conversationId);

      if (!exists) {
        return [
          {
            id: conversationId,
            title: makeTitle(trimmedQuestion),
            createdAt: new Date().toISOString(),
            messages: [
              userMessage,
              { id: assistantId, role: "assistant", content: "", pending: true, sources: [] },
            ],
          },
          ...current,
        ];
      }

      return current.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              title: conversation.title === "New chat" ? makeTitle(trimmedQuestion) : conversation.title,
              messages: [
                ...conversation.messages,
                userMessage,
                { id: assistantId, role: "assistant", content: "", pending: true, sources: [] },
              ],
            }
          : conversation,
      );
    });

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mode,
          modelId: selectedModel,
          prompt: trimmedQuestion,
          history,
          useResearch,
          sourceLimit: defaultSourceLimit,
        }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || `Chat failed with ${response.status}.`);
      }

      if (!response.body) {
        throw new Error("The chat stream did not return a body.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";

        for (const block of blocks) {
          const lines = block.split("\n");
          const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
          const data = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");

          if (!data) {
            continue;
          }

          let payload: Record<string, unknown>;

          try {
            payload = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }

          if (event === "meta") {
            updateConversation(conversationId, (conversation) => ({
              ...conversation,
              messages: conversation.messages.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      sources: Array.isArray(payload.sources) ? (payload.sources as ResearchSource[]) : [],
                    }
                  : message,
              ),
            }));
          }

          if (event === "delta") {
            updateConversation(conversationId, (conversation) => ({
              ...conversation,
              messages: conversation.messages.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      content: message.content + (typeof payload.text === "string" ? payload.text : ""),
                    }
                  : message,
              ),
            }));
          }

          if (event === "error") {
            throw new Error(typeof payload.message === "string" ? payload.message : "Streaming failed.");
          }

          if (event === "done") {
            updateConversation(conversationId, (conversation) => ({
              ...conversation,
              messages: conversation.messages.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      pending: false,
                    }
                  : message,
              ),
            }));
          }
        }
      }
    } catch (caughtError) {
      const message = extractErrorMessage(caughtError);
      setError(message);
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        messages: conversation.messages.map((entry) =>
          entry.id === assistantId
            ? {
                ...entry,
                pending: false,
                content: entry.content || message,
              }
            : entry,
        ),
      }));
    } finally {
      setIsLoading(false);
    }
  }

  const groupedConversations = groupConversations(filteredConversations);
  const researchLabel = mode === "agent" ? "Web tool on" : useResearch ? "Web grounding on" : "Web grounding off";

  return (
    <main className="or-shell">
      <header className="or-topbar">
        <div className="or-brand">
          <span className="or-brand-mark">&lt;</span>
          <span>OpenRouter</span>
        </div>
        <nav className="or-nav">
          <span>Models</span>
          <span>Chat</span>
          <span>Rankings</span>
          <span>Apps</span>
          <span>Docs</span>
        </nav>
        <div className="or-profile">
          <span className="or-avatar">P</span>
          <span>Personal</span>
        </div>
      </header>

      <section className="or-grid">
        <aside className="or-sidebar">
          <div className="sidebar-actions">
            <button className="sidebar-action-button" onClick={handleNewChat} type="button">
              New Chat
            </button>
            <button
              className="sidebar-action-button"
              onClick={() => modelSelectRef.current?.focus()}
              type="button"
            >
              Add Model
            </button>
          </div>

          <input
            className="sidebar-search"
            onChange={(event) => setRoomQuery(event.target.value)}
            placeholder="Search rooms..."
            value={roomQuery}
          />

          <div className="conversation-scroll">
            {groupedConversations.length === 0 ? (
              <p className="subtle-copy">No chats yet.</p>
            ) : (
              groupedConversations.map(([label, items]) => (
                <section className="conversation-group" key={label}>
                  <h3>{label}</h3>
                  <div className="conversation-list">
                    {items.map((conversation) => (
                      <button
                        className={
                          conversation.id === activeConversationId
                            ? "conversation-item conversation-item-active"
                            : "conversation-item"
                        }
                        key={conversation.id}
                        onClick={() => setActiveConversationId(conversation.id)}
                        type="button"
                      >
                        {conversation.title}
                      </button>
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>
        </aside>

        <section className="or-main">
          <div className="or-center">
            {activeMessages.length === 0 ? (
              <>
                <div className="collection-grid">
                  {collections.map((collection) => (
                    <button
                      className="collection-card"
                      key={collection.title}
                      onClick={() => {
                        if (collection.models[0]) {
                          setSelectedModel(collection.models[0].id);
                        }
                      }}
                      type="button"
                    >
                      <span className="collection-title">{collection.title}</span>
                      <div className="collection-pill-row">
                        {collection.models.slice(0, 4).map((model) => (
                          <span className="collection-pill" key={`${collection.title}-${model.id}`}>
                            {model.label.slice(0, 2).toUpperCase()}
                          </span>
                        ))}
                      </div>
                    </button>
                  ))}
                </div>

                <div className="starter-strip">
                  {STARTERS.map((starter) => (
                    <button className="starter-chip" key={starter} onClick={() => void submitQuestion(starter)} type="button">
                      {starter}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="transcript-shell">
                <div className="transcript-header">
                  <div>
                    <span className="panel-kicker">Current Chat</span>
                    <h2>{activeConversation?.title ?? "Chat"}</h2>
                  </div>
                  <div className="chat-status-row">
                    <span className="hero-badge">{selectedModel}</span>
                    <span className="hero-badge">{activeMode.title}</span>
                    <span className="hero-badge">{researchLabel}</span>
                  </div>
                </div>

                <div className="message-list transcript-list">
                  {activeMessages.map((message) => (
                    <article
                      className={message.role === "user" ? "message-card message-user" : "message-card message-assistant"}
                      key={message.id}
                    >
                      <div className="message-topline">
                        <strong>{message.role === "user" ? "You" : "Assistant"}</strong>
                      </div>
                      <div className="message-body">{message.content || (message.pending ? "Thinking..." : "")}</div>
                    </article>
                  ))}
                  <div ref={endRef} />
                </div>
              </div>
            )}
          </div>

          <div className="composer-dock">
            <div className="composer-shell">
              <div className="composer-topline">Create Artifact...</div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitQuestion(prompt);
                }}
              >
                <textarea
                  className="composer-input composer-input-large"
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Start a new message..."
                  rows={4}
                  value={prompt}
                />

                <div className="dock-toolbar">
                  <div className="dock-left">
                    <button className="dock-icon-button" onClick={() => modelSelectRef.current?.focus()} type="button">
                      +
                    </button>
                    <button className="dock-icon-button" type="button">
                      Mic
                    </button>
                    <select
                      className="dock-select"
                      onChange={(event) => setMode(event.target.value as ChatMode)}
                      value={mode}
                    >
                      {(Object.keys(MODE_COPY) as ChatMode[]).map((entry) => (
                        <option key={entry} value={entry}>
                          {MODE_COPY[entry].title}
                        </option>
                      ))}
                    </select>
                    <select
                      className="dock-select dock-select-wide"
                      onChange={(event) => setSelectedModel(event.target.value)}
                      ref={modelSelectRef}
                      value={selectedModel}
                    >
                      {visibleModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label} {model.isFree ? "· free" : "· paid"}
                        </option>
                      ))}
                    </select>
                    <button
                      className={useResearch ? "dock-toggle dock-toggle-active" : "dock-toggle"}
                      onClick={() => setUseResearch((current) => !current)}
                      type="button"
                    >
                      Web
                    </button>
                  </div>

                  <div className="dock-right">
                    <span className="dock-stat">{availableModels.length}</span>
                    <button className="dock-send" disabled={isLoading || !prompt.trim()} type="submit">
                      Send
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>

          <div className="meta-strip">
            <div className="meta-card">
              <strong>{activeMode.title}</strong>
              <span>{activeMode.description}</span>
            </div>
            <div className="meta-card">
              <strong>{activeModel?.label ?? selectedModel}</strong>
              <span>
                {activeModel ? `${formatContextLength(activeModel.contextLength)} · ${activeModel.isFree ? "Free" : "Paid"}` : "Model selected"}
              </span>
            </div>
            <div className="meta-card">
              <strong>Catalog</strong>
              <span>
                {modelsMeta.source} · {modelsMeta.refreshedAt ? formatTime(modelsMeta.refreshedAt) : "Loading"}
              </span>
            </div>
          </div>

          {modelsError ? <p className="error-callout">{modelsError}</p> : null}
          {error ? <p className="error-callout">{error}</p> : null}

          <div className="support-strip">
            <span>{rotationEnabled ? `Key rotation active until ${formatTime(nextRotationAt)}` : "Static key mode"}</span>
            <span>{hasChatKey ? "Chat key ready" : "Missing initial chat key"}</span>
            <span>{hasInitialHash ? "Initial key hash set" : "Initial key hash missing"}</span>
            <Link href="https://openrouter.ai/docs/api-reference/list-available-models" target="_blank">
              Models API
            </Link>
            <Link href="https://openrouter.ai/docs/features/tool-calling/" target="_blank">
              Tool calling
            </Link>
          </div>
        </section>
      </section>
    </main>
  );
}
