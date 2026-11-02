import { z } from "zod";
import type { EmbeddingProviderType } from "./embeddings/factory.js";
import type { KnownLlmProvider } from "./llm/config.js";

// Репозиторий публичный: дефолты и заглушки из .env.example известны всем,
// в production они не должны проходить валидацию (иначе /ingest и вебхук
// окажутся защищены общеизвестным значением).
const PLACEHOLDER_SECRETS = new Set(["dev-ingest-token", "change-me", "change-me-8-chars-min"]);

const schema = z.object({
  appEnv: z.enum(["development", "production"]).default("development"),
  databaseUrl: z.string().url(),
  databaseUrlDirect: z.string().url().optional(),
  telegramBotToken: z.string().min(10),
  telegramChannelChatId: z.string().regex(/^-?\d+$/),
  telegramOwnerChatId: z.string().regex(/^-?\d+$/),
  telegramWebhookSecret: z.string().min(8),
  telegramWebhookUrl: z.string().url().optional(),
  ingestToken: z.string().min(8).default("dev-ingest-token"),
  apiPort: z.coerce.number().int().positive().default(8080),
  healthPort: z.coerce.number().int().positive().default(8081),

  // Общие API-ключи провайдеров
  openAiApiKey: z.string().optional().default(""),
  cohereApiKey: z.string().optional().default(""),
  openRouterApiKey: z.string().optional().default(""),
  deepseekApiKey: z.string().optional().default(""),

  // Конфигурация модели cheap (Stage 2 триаж, FactSheet, черновик)
  llmCheapProvider: z.string().default("openai"),
  llmCheapModel: z.string().default("gpt-4o-mini"),
  llmCheapBaseUrl: z.string().optional(),
  llmCheapApiKey: z.string().optional(),
  llmCheapInputPrice: z.coerce.number().optional(),
  llmCheapOutputPrice: z.coerce.number().optional(),

  // Конфигурация модели strong (Переписать лучше)
  llmStrongProvider: z.string().default("openai"),
  llmStrongModel: z.string().default("gpt-4o"),
  llmStrongBaseUrl: z.string().optional(),
  llmStrongApiKey: z.string().optional(),
  llmStrongInputPrice: z.coerce.number().optional(),
  llmStrongOutputPrice: z.coerce.number().optional(),

  // Конфигурация эмбеддингов (Story кластеризация, profile_vector)
  embeddingProvider: z.string().default("cohere"),
  embeddingModel: z.string().default("embed-multilingual-v3.0"),
  embeddingBaseUrl: z.string().optional(),
  embeddingApiKey: z.string().optional(),
  embeddingDimensions: z.coerce.number().int().default(1024),

  // Конфигурация MTProto (GramJS для чтения каналов и сбора метрик)
  tgApiId: z.coerce.number().int().optional(),
  tgApiHash: z.string().optional(),
  tgSession: z.string().optional(),
  tgSessionPath: z.string().default("./data/tg-session"),

  // Конфигурация веб-поиска для агентов (Scout, Resolver)
  searchProvider: z.enum(["tavily", "brave", "mock"]).default("tavily"),
  tavilyApiKey: z.string().optional().default(""),
  braveSearchApiKey: z.string().optional().default(""),
}).superRefine((cfg, ctx) => {
  if (cfg.appEnv !== "production") return;

  // Не задан INGEST_TOKEN нельзя отличить от дефолта после .default(),
  // поэтому проверяем членство в PLACEHOLDER_SECRETS — оно покрывает оба случая.
  if (PLACEHOLDER_SECRETS.has(cfg.ingestToken)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ingestToken"], message: "секрет-заглушка" });
  }
  if (PLACEHOLDER_SECRETS.has(cfg.telegramWebhookSecret)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["telegramWebhookSecret"], message: "секрет-заглушка" });
  }
});

export interface AppConfig extends Omit<z.infer<typeof schema>, "databaseUrlDirect"> {
  databaseUrlDirect: string;
  llmCheapProvider: KnownLlmProvider | string;
  llmStrongProvider: KnownLlmProvider | string;
  embeddingProvider: EmbeddingProviderType | string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;

  const openAiKey = env.OPENAI_API_KEY || env.LLM_API_KEY || "";
  const cohereKey = env.COHERE_API_KEY || env.EMBEDDINGS_API_KEY || "";
  const openRouterKey = env.OPENROUTER_API_KEY || "";
  const deepseekKey = env.DEEPSEEK_API_KEY || "";

  const parsed = schema.safeParse({
    appEnv: env.APP_ENV,
    databaseUrl,
    databaseUrlDirect: env.DATABASE_URL_DIRECT ?? databaseUrl,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramChannelChatId: env.TELEGRAM_CHANNEL_CHAT_ID,
    telegramOwnerChatId: env.TELEGRAM_OWNER_CHAT_ID,
    telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    telegramWebhookUrl: env.TELEGRAM_WEBHOOK_URL,
    ingestToken: env.INGEST_TOKEN,
    apiPort: env.API_PORT,
    healthPort: env.HEALTH_PORT,

    openAiApiKey: openAiKey,
    cohereApiKey: cohereKey,
    openRouterApiKey: openRouterKey,
    deepseekApiKey: deepseekKey,

    llmCheapProvider: env.LLM_CHEAP_PROVIDER || (openRouterKey ? "openrouter" : deepseekKey ? "deepseek" : "openai"),
    llmCheapModel: env.LLM_CHEAP_MODEL || (env.LLM_CHEAP_PROVIDER === "deepseek" ? "deepseek-chat" : "gpt-4o-mini"),
    llmCheapBaseUrl: env.LLM_CHEAP_BASE_URL,
    llmCheapApiKey: env.LLM_CHEAP_API_KEY || (env.LLM_CHEAP_PROVIDER === "openrouter" ? openRouterKey : env.LLM_CHEAP_PROVIDER === "deepseek" ? deepseekKey : openAiKey),
    llmCheapInputPrice: env.LLM_CHEAP_INPUT_PRICE,
    llmCheapOutputPrice: env.LLM_CHEAP_OUTPUT_PRICE,

    llmStrongProvider: env.LLM_STRONG_PROVIDER || (openRouterKey ? "openrouter" : deepseekKey ? "deepseek" : "openai"),
    llmStrongModel: env.LLM_STRONG_MODEL || (env.LLM_STRONG_PROVIDER === "deepseek" ? "deepseek-reasoner" : "gpt-4o"),
    llmStrongBaseUrl: env.LLM_STRONG_BASE_URL,
    llmStrongApiKey: env.LLM_STRONG_API_KEY || (env.LLM_STRONG_PROVIDER === "openrouter" ? openRouterKey : env.LLM_STRONG_PROVIDER === "deepseek" ? deepseekKey : openAiKey),
    llmStrongInputPrice: env.LLM_STRONG_INPUT_PRICE,
    llmStrongOutputPrice: env.LLM_STRONG_OUTPUT_PRICE,

    embeddingProvider: env.EMBEDDING_PROVIDER || (cohereKey ? "cohere" : openAiKey ? "openai" : "cohere"),
    embeddingModel: env.EMBEDDING_MODEL || (env.EMBEDDING_PROVIDER === "openai" ? "text-embedding-3-small" : "embed-multilingual-v3.0"),
    embeddingBaseUrl: env.EMBEDDING_BASE_URL,
    embeddingApiKey: env.EMBEDDING_API_KEY || (env.EMBEDDING_PROVIDER === "openai" ? openAiKey : cohereKey),
    embeddingDimensions: env.EMBEDDING_DIMENSIONS || 1024,

    tgApiId: env.TG_API_ID,
    tgApiHash: env.TG_API_HASH,
    tgSession: env.TG_SESSION,
    tgSessionPath: env.TG_SESSION_PATH || "./data/tg-session",

    searchProvider: env.SEARCH_PROVIDER || (env.BRAVE_SEARCH_API_KEY && !env.TAVILY_API_KEY ? "brave" : "tavily"),
    tavilyApiKey: env.TAVILY_API_KEY || "",
    braveSearchApiKey: env.BRAVE_SEARCH_API_KEY || "",
  });

  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Некорректная конфигурация env: ${fields}`);
  }

  return {
    ...parsed.data,
    databaseUrlDirect: parsed.data.databaseUrlDirect ?? parsed.data.databaseUrl,
    llmCheapProvider: parsed.data.llmCheapProvider as KnownLlmProvider,
    llmStrongProvider: parsed.data.llmStrongProvider as KnownLlmProvider,
    embeddingProvider: parsed.data.embeddingProvider as EmbeddingProviderType,
  };
}
