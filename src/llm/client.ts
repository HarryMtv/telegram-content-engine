import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";
import type {
  LlmCallOptions,
  LlmCallResult,
  LlmConfig,
  LlmProvider,
  ModelRole,
} from "./types.js";
import { calculateCallCost } from "./pricing.js";

export class LlmClient {
  private readonly providerMap: Record<ModelRole, LlmProvider>;

  constructor(
    private readonly db: Kysely<Database>,
    providerOrMap: LlmProvider | Record<ModelRole, LlmProvider>,
    private readonly config: LlmConfig,
  ) {
    if (providerOrMap && "chat" in providerOrMap) {
      this.providerMap = {
        cheap: providerOrMap,
        strong: providerOrMap,
      };
    } else {
      this.providerMap = providerOrMap as Record<ModelRole, LlmProvider>;
    }
  }

  async call<T = unknown>(options: LlmCallOptions<T>): Promise<LlmCallResult<T>> {
    const modelConfig = this.config.models[options.role];
    const model = modelConfig.model;
    const provider = this.providerMap[options.role] ?? this.providerMap.cheap;
    const startTime = Date.now();

    const chatOpts: {
      model: string;
      messages: typeof options.messages;
      temperature?: number;
      maxTokens?: number;
      jsonMode?: boolean;
    } = {
      model,
      messages: options.messages,
      jsonMode: Boolean(options.schema),
    };
    if (options.temperature !== undefined) chatOpts.temperature = options.temperature;
    if (options.maxTokens !== undefined) chatOpts.maxTokens = options.maxTokens;

    const response = await provider.chat(chatOpts);

    const latencyMs = Date.now() - startTime;
    const costUsd = calculateCallCost(
      response.inputTokens,
      response.outputTokens,
      modelConfig,
    );

    // Запись в аудит llm_calls с фиксацией модели
    const inserted = await this.db
      .insertInto("llm_calls")
      .values({
        stage: options.stage,
        channel_id: options.channelId ?? null,
        model,
        input_tokens: response.inputTokens,
        output_tokens: response.outputTokens,
        cost_usd: costUsd as never,
        latency_ms: latencyMs,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    let parsedData: T = response.text as unknown as T;
    if (options.schema) {
      let cleanText = response.text.trim();
      if (cleanText.startsWith("```json")) {
        cleanText = cleanText.replace(/^```json\s*/, "").replace(/\s*```$/, "");
      } else if (cleanText.startsWith("```")) {
        cleanText = cleanText.replace(/^```\s*/, "").replace(/\s*```$/, "");
      }
      const json = JSON.parse(cleanText);
      parsedData = options.schema.parse(json);
    }

    return {
      id: inserted.id,
      model,
      data: parsedData,
      raw: response.text,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      costUsd,
      latencyMs,
    };
  }
}
