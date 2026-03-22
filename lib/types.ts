export type ProviderId = "openrouter" | "fastrouter";
export type ChatRole = "user" | "assistant" | "system";

export interface ProviderSummary {
  id: ProviderId;
  label: string;
  configured: boolean;
  ready: boolean;
  message: string;
  baseUrl: string;
  docsUrl: string;
}

export interface CatalogModel {
  providerId: ProviderId;
  id: string;
  name: string;
  description: string;
  contextLength: number | null;
  inputPrice: number | null;
  outputPrice: number | null;
  isFree: boolean;
  isRouter: boolean;
  featured: boolean;
  tags: string[];
}

export interface ModelCatalog {
  refreshedAt: string;
  nextRefreshAt: string;
  providers: ProviderSummary[];
  models: CatalogModel[];
  defaults: {
    providerId: ProviderId;
    modelId: string;
  };
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ResearchSource {
  id: number;
  title: string;
  url: string;
  domain: string;
  snippet: string;
}

export interface ChatRequestBody {
  providerId: ProviderId;
  modelId: string;
  prompt: string;
  history: ChatTurn[];
  useResearch: boolean;
  sourceLimit?: number;
}
