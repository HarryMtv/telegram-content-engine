import type { Kysely } from "kysely";
import type PgBoss from "pg-boss";
import type { Database } from "../db/types.js";
import { getAdapter } from "../sources/registry.js";
import { onError, onSuccess } from "../sources/health.js";
import { SourceConfig } from "../domain/schemas.js";
import { normalizeRef, normalizeFetched } from "../pipeline/normalize.js";
import { insertItemsIgnoreDuplicates, selectPendingIds, completeItem, markItemFailed } from "../db/repo/items.js";
import { stage0Filter } from "../pipeline/stage0.js";
import { selectScorableItems, scoreBatch, parseStage1Weights } from "../pipeline/stage1.js";
import { runStage2Triage } from "../pipeline/stage2.js";
import { selectDiversifiedCandidates } from "../pipeline/mmr.js";
import { generateFactSheet } from "../generation/factsheet.js";
import { verifyFactSheet } from "../generation/fact-check.js";
import { generateLlmDraft } from "../generation/llm-draft.js";
import { buildTemplateDraft } from "../generation/template-draft.js";
import { LlmClient } from "../llm/client.js";
import { HttpOpenAiProvider, MockLlmProvider } from "../llm/provider.js";
import { DEFAULT_LLM_CONFIG } from "../llm/pricing.js";
import { evaluateBudgetGuard } from "../llm/budget.js";
import { JobNames } from "./index.js";
import type { PollSourceJob, FetchItemJob, BuildBatchJob, SendBatchJob } from "./index.js";

import type { AppConfig } from "../config.js";
import { createLlmClient } from "../llm/factory.js";
import { createEmbeddingProvider } from "../embeddings/factory.js";
import { formatItemForEmbedding } from "../embeddings/service.js";
import type { EmbeddingProvider } from "../embeddings/types.js";

export interface HandlerDeps {
  db: Kysely<Database>;
  boss: PgBoss;
  notifyOwner: (text: string) => Promise<void>;
  config?: AppConfig;
  openAiApiKey?: string;
}

export interface ChannelTuning {
  channelId: string;
  allowedLangs: string[];
  domainBlacklist: string[];
  halfLifeHours: number;
  weights: unknown;
  dailyCap: number;
  selectionRules: string;
  styleGuide: string;
  taboos: string[];
  profileVersion: number;
  profileVector: number[] | null;
  formatId?: string | undefined;
  formatSlug: string;
  promptTemplate?: string | undefined;
  targetLength?: number | undefined;
}

/** Конфигурация канала и активного профиля для скоринга и генерации. */
export async function loadChannelTuning(db: Kysely<Database>): Promise<ChannelTuning> {
  const channel = await db
    .selectFrom("channels")
    .select(["id", "source_langs"])
    .where("status", "=", "active")
    .orderBy("created_at")
    .executeTakeFirstOrThrow(() => new Error("Нет активного канала — запусти seed"));

  const profile = await db
    .selectFrom("channel_profiles")
    .select([
      "version",
      "domain_blacklist",
      "score_weights",
      "selection_rules",
      "style_guide",
      "taboos",
      "profile_vector",
    ])
    .where("channel_id", "=", channel.id)
    .orderBy("version", "desc")
    .executeTakeFirst();

  const format = await db
    .selectFrom("post_formats")
    .select(["id", "slug", "freshness_half_life_hours", "daily_cap", "prompt_template", "target_length"])
    .where("channel_id", "=", channel.id)
    .orderBy("slug")
    .executeTakeFirst();

  const blacklist = Array.isArray(profile?.domain_blacklist)
    ? (profile?.domain_blacklist as string[])
    : [];

  let profileVector: number[] | null = null;
  if (profile?.profile_vector) {
    profileVector = Array.isArray(profile.profile_vector)
      ? (profile.profile_vector as number[])
      : JSON.parse(String(profile.profile_vector));
  }

  return {
    channelId: channel.id,
    allowedLangs: channel.source_langs ?? ["en", "ru"],
    domainBlacklist: blacklist,
    halfLifeHours: format?.freshness_half_life_hours ?? 120,
    weights: profile?.score_weights,
    dailyCap: format?.daily_cap ?? 5,
    selectionRules: profile?.selection_rules ?? "",
    styleGuide: profile?.style_guide ?? "",
    taboos: (profile?.taboos as string[]) ?? [],
    profileVersion: profile?.version ?? 1,
    profileVector,
    formatId: format?.id,
    formatSlug: format?.slug ?? "digest",
    promptTemplate: format?.prompt_template ?? undefined,
    targetLength: format?.target_length ?? undefined,
  };
}

export async function handlePollSource(deps: HandlerDeps, job: PollSourceJob): Promise<string> {
  const { db, boss } = deps;
  const source = await db
    .selectFrom("sources")
    .selectAll()
    .where("id", "=", job.sourceId)
    .executeTakeFirst();

  if (!source) {
    console.error(`[poll-source] источник ${job.sourceId} не найден — пропуск`);
    return "skipped: источник удалён";
  }

  const config = SourceConfig.parse(source.config);
  const adapter = getAdapter(source.adapter);
  const cursor = (source.cursor as Record<string, unknown>) ?? null;
  const sourceLabel = String(config.key ?? source.id);

  try {
    const discovered = await adapter.discover({
      sourceId: source.id,
      config,
      cursor,
    });

    const tuning = await loadChannelTuning(db);
    const now = new Date();
    const stage0Ctx = {
      channelId: tuning.channelId,
      allowedLangs: tuning.allowedLangs,
      domainBlacklist: tuning.domainBlacklist,
      maxAgeHours: tuning.halfLifeHours * 4,
      now,
    };

    const validRefs = [];
    for (const ref of discovered.refs) {
      const normalized = normalizeRef(ref, source.id);
      const decision = stage0Filter(
        {
          itemId: normalized.externalId,
          storyId: null,
          url: normalized.canonicalUrl,
          lang: "unknown",
          publishedAt: normalized.publishedAt,
        },
        stage0Ctx,
      );
      if (decision.pass) {
        validRefs.push(normalized);
      }
    }

    if (validRefs.length > 0) {
      await insertItemsIgnoreDuplicates(db, validRefs);
    }

    const health = onSuccess();
    await db
      .updateTable("sources")
      .set({
        status: health.status,
        error_count: health.errorCount,
        last_ok_at: now,
        cursor: discovered.cursor as never,
      })
      .where("id", "=", source.id)
      .execute();

    const urlHashes = validRefs.map((r) => r.urlHash);
    const pendingItems = await selectPendingIds(db, urlHashes);
    for (const item of pendingItems) {
      await boss.send(
        JobNames.fetchItem,
        { itemId: item.id } satisfies FetchItemJob,
        {
          singletonKey: `fetch-item:${item.id}`,
          singletonSeconds: 3600,
          retryLimit: 3,
          retryBackoff: true,
        },
      );
    }

    console.log(
      `[poll-source] ${source.adapter} «${sourceLabel}»: в ленте ${discovered.refs.length}, прошло stage0 ${validRefs.length}, на скачивание ${pendingItems.length}`,
    );

    return `refs=${discovered.refs.length}, inserted=${validRefs.length}, pending=${pendingItems.length}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const health = onError(source.status as any, source.error_count ?? 0);
    console.error(`[poll-source] ${source.adapter} «${sourceLabel}» упал: ${message} (ошибка №${health.errorCount})`);
    await db
      .updateTable("sources")
      .set({
        status: health.status,
        error_count: health.errorCount,
        last_error: message,
        last_error_at: new Date(),
      })
      .where("id", "=", source.id)
      .execute();
    if (health.notify) {
      await deps.notifyOwner(`⚠️ Источник ${source.id} перешёл в статус dead после ${health.errorCount} ошибок: ${message}`).catch(() => undefined);
    }
    // Джоба обязана числиться упавшей (openspec/specs/source-adapters/spec.md →
    // «Silent failures are prohibited»), поэтому пробрасываем. От накрутки
    // error_count теми же ошибками защищает retryLimit: 0 на стороне scheduler:
    // следующую попытку ставит tick по расписанию, а не ретрай pg-boss.
    throw err;
  }
}

export async function handleFetchItem(deps: HandlerDeps, job: FetchItemJob): Promise<string> {
  const { db } = deps;
  const row = await db
    .selectFrom("items")
    .innerJoin("sources", "sources.id", "items.source_id")
    .select([
      "items.id",
      "items.source_id",
      "items.external_id",
      "items.canonical_url",
      "items.title",
      "items.published_at",
      "items.discovered_at",
      "items.external_signals",
      "sources.adapter",
    ])
    .where("items.id", "=", job.itemId)
    .executeTakeFirstOrThrow(() => new Error(`Item ${job.itemId} не найден`));

  const adapter = getAdapter(row.adapter);
  console.log(`[fetch-item] качаю «${short(row.title)}» ${row.canonical_url}`);
  try {
    const fetched = await adapter.fetch({
      externalId: row.external_id,
      url: row.canonical_url,
      title: row.title,
    });
    const signals = row.external_signals as Record<string, number | string> | null;
    const raw = normalizeFetched(
      {
        sourceId: row.source_id,
        externalId: row.external_id,
        canonicalUrl: row.canonical_url,
        title: row.title,
        publishedAt: row.published_at ?? row.discovered_at,
        discoveredAt: row.discovered_at,
        ...(signals ? { externalSignals: signals } : {}),
      },
      fetched.bodyText,
      fetched.author,
    );

    // Семантический вектор для кластеризации и MMR (спека §6.3).
    // Не роняем материал, если провайдер недоступен: item сохранится без embedding.
    let embedding: number[] | null = null;
    const provider = getEmbeddingProvider(deps);
    if (provider) {
      try {
        const [vec] = await provider.embed([formatItemForEmbedding(row.title, fetched.bodyText)]);
        embedding = vec ?? null;
      } catch (err) {
        console.error(`[fetch-item] эмбеддинг не удался: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const result = await completeItem(db, row.id, raw, embedding);
    if (result === "discarded_duplicate") {
      console.log(`[fetch-item] дубль текста, отброшен: «${short(row.title)}»`);
    } else {
      console.log(`[fetch-item] готово: «${short(row.title)}» — ${raw.bodyText.length} символов, lang=${raw.lang}`);
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[fetch-item] ошибка: «${short(row.title)}» ${row.canonical_url} → ${message}`);
    await markItemFailed(db, row.id, "failed");
    throw err;
  }
}

/** build-batch (M2): Стадия 1 (скоринг) → Стадия 2 (триаж) → MMR → FactSheet → FactCheck → Draft. */
export async function handleBuildBatch(deps: HandlerDeps, job: BuildBatchJob): Promise<string> {
  const { db, boss, notifyOwner, openAiApiKey } = deps;
  const tuning = await loadChannelTuning(db);
  if (tuning.channelId !== job.channelId) return "skipped: другой канал";

  // Проверка бюджета и guard стадии 3
  const budgetGuard = await evaluateBudgetGuard(db, notifyOwner, 10);
  if (!budgetGuard.canRunStage3) {
    return "skipped: месячный бюджет LLM исчерпан на 100%";
  }

  // 1. Стадия 1: Скоринг без LLM
  const scorable = await selectScorableItems(db, tuning.halfLifeHours * 4, 100);
  const scoredStage1 = scoreBatch(
    scorable,
    tuning.halfLifeHours,
    parseStage1Weights(tuning.weights),
    { profileVector: tuning.profileVector },
  );

  if (scoredStage1.length === 0) return "no_candidates";

  const topStage1 = scoredStage1.slice(0, 8);

  // Получаем полные тексты для кандидатов
  const candidateItems = [];
  for (const c of topStage1) {
    const item = await db
      .selectFrom("items")
      .select(["id", "title", "body_text", "canonical_url", "embedding"])
      .where("story_id", "=", c.storyId)
      .where("fetch_status", "=", "ok")
      .orderBy("published_at", "asc")
      .executeTakeFirst();
    if (item) {
      candidateItems.push({
        candidate: c,
        item,
      });
    }
  }

  if (candidateItems.length === 0) return "no_candidates_with_text";

  console.log(
    `[build-batch] стадия 1: скоринг ${scoredStage1.length}, в топе ${topStage1.length}, с текстом ${candidateItems.length}:`,
  );
  for (const ci of candidateItems) {
    console.log(`  score=${Number(ci.candidate.scoreTotal ?? 0).toFixed(3)} «${short(ci.item.title)}»`);
  }

  const appConfig = deps.config;
  const llm = createLlmClient(db, {
    cheap: {
      provider: appConfig?.llmCheapProvider,
      model: appConfig?.llmCheapModel,
      baseUrl: appConfig?.llmCheapBaseUrl,
      apiKey: appConfig?.llmCheapApiKey || deps.openAiApiKey,
      inputPricePerMillion: appConfig?.llmCheapInputPrice,
      outputPricePerMillion: appConfig?.llmCheapOutputPrice,
    },
    strong: {
      provider: appConfig?.llmStrongProvider,
      model: appConfig?.llmStrongModel,
      baseUrl: appConfig?.llmStrongBaseUrl,
      apiKey: appConfig?.llmStrongApiKey || deps.openAiApiKey,
      inputPricePerMillion: appConfig?.llmStrongInputPrice,
      outputPricePerMillion: appConfig?.llmStrongOutputPrice,
    },
    defaultApiKey: appConfig?.openAiApiKey || deps.openAiApiKey,
  });
  const hasApiKey = Boolean(appConfig?.llmCheapApiKey || appConfig?.openAiApiKey || (deps.openAiApiKey && deps.openAiApiKey.length > 5));

  // 2. Стадия 2: LLM-триаж против selection_rules
  const triageInput = candidateItems.map((ci) => ({
    id: ci.item.id,
    title: ci.item.title,
    snippet: ci.item.body_text.slice(0, 300),
    storyId: ci.candidate.storyId,
    sourceTrust: ci.candidate.trustScore,
    scoreStage1: ci.candidate.scoreTotal,
  }));

  const triaged = await runStage2Triage(llm, triageInput, tuning.selectionRules, {
    channelId: tuning.channelId,
    maxOutput: 10,
  });

  const triagedMap = new Map(triaged.map((t) => [t.id, t]));

  console.log(`[build-batch] стадия 2 (триаж LLM): прошло ${triaged.length} из ${candidateItems.length}:`);
  for (const t of triaged) {
    const item = candidateItems.find((ci) => ci.item.id === t.id);
    if (item) console.log(`  ✓ «${short(item.item.title)}» — ${t.triageReason ?? "без причины"}`);
  }

  // 3. MMR-диверсификация
  const mmrInput = candidateItems
    .filter((ci) => triagedMap.has(ci.item.id))
    .map((ci) => {
      const tr = triagedMap.get(ci.item.id)!;
      return {
        id: ci.item.id,
        storyId: ci.candidate.storyId,
        title: ci.item.title,
        snippet: ci.item.body_text.slice(0, 300),
        embedding: ci.candidate.embedding ?? null,
        relevance: tr.tlevanceScore,
        novelty: tr.noveltyScore,
        importance: ci.candidate.components.importance,
        freshness: ci.candidate.components.freshness,
        trust: ci.candidate.components.trust,
        triageReason: tr.triageReason,
      };
    });

  const mmrSelected = selectDiversifiedCandidates(mmrInput, undefined, tuning.dailyCap);
  if (mmrSelected.length === 0) return "no_mmr_selected";
  console.log(`[build-batch] MMR: отобрано ${mmrSelected.length} (лимит ${tuning.dailyCap})`);

  // 4. Стадия 3: FactSheet + Fact-check + Draft
  const draftIds: string[] = [];

  for (const cand of mmrSelected) {
    const storyItem = candidateItems.find((ci) => ci.item.id === cand.id)?.item;
    if (!storyItem) continue;

    console.log(`[build-batch] генерирую: «${short(storyItem.title)}» ${storyItem.canonical_url}`);

    const candidateId = await db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto("channel_candidates")
        .values({
          channel_id: tuning.channelId,
          story_id: cand.storyId,
          score_total: cand.scoreTotal,
          score_components: cand.scoreComponents,
          triage_reason: cand.triageReason ?? null,
          stage: 3,
          status: "queued",
        })
        .onConflict((oc) => oc.doNothing())
        .returning("id")
        .executeTakeFirst();
      if (inserted) return inserted.id;

      const existing = await trx
        .selectFrom("channel_candidates")
        .select("id")
        .where("channel_id", "=", tuning.channelId)
        .where("story_id", "=", cand.storyId)
        .executeTakeFirstOrThrow();
      return existing.id;
    });

    let draftId: string;

    if (hasApiKey) {
      // 4a. FactSheet
      const { id: factSheetId, factSheet } = await generateFactSheet(
        llm,
        db,
        cand.storyId,
        [
          {
            id: storyItem.id,
            title: storyItem.title,
            bodyText: storyItem.body_text,
            canonicalUrl: storyItem.canonical_url,
          },
        ],
        { channelId: tuning.channelId },
      );

      // 4b. Fact-check
      const { factSheet: checkedFactSheet } = await verifyFactSheet(
        llm,
        db,
        factSheetId,
        factSheet,
        [
          {
            id: storyItem.id,
            title: storyItem.title,
            bodyText: storyItem.body_text,
            canonicalUrl: storyItem.canonical_url,
          },
        ],
        { channelId: tuning.channelId },
      );
      console.log(`[build-batch] FactSheet + fact-check: confidence=${Number(checkedFactSheet.confidence ?? 0).toFixed(2)}`);

      // 4c. LLM Draft
      const draftOpts: any = {
        candidateId,
        factSheetId,
        factSheet: checkedFactSheet,
        format: {
          id: tuning.formatId,
          slug: tuning.formatSlug,
          promptTemplate: tuning.promptTemplate,
          targetLength: tuning.targetLength,
        },
        profile: {
          version: tuning.profileVersion,
          styleGuide: tuning.styleGuide,
          taboos: tuning.taboos,
        },
        channelId: tuning.channelId,
        variantN: 1,
        modelRole: "cheap",
      };
      const draftResult = await generateLlmDraft(llm, db, draftOpts);

      draftId = draftResult.id;
    } else {
      // Шаблонный черновик
      const draftText = buildTemplateDraft({
        title: storyItem.title,
        snippet: storyItem.body_text.slice(0, 400),
        url: storyItem.canonical_url,
      });

      const draft = await db
        .insertInto("drafts")
        .values({
          candidate_id: candidateId,
          variant_n: 1,
          model: "template-m1",
          profile_version: tuning.profileVersion,
          text: draftText,
          lang: "ru",
          cost_usd: 0,
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      draftId = draft.id;
    }

    draftIds.push(draftId);
  }

  if (draftIds.length === 0) return "no_drafts";

  console.log(`[build-batch] готово черновиков: ${draftIds.length} — ставлю send-batch`);

  await boss.send(
    JobNames.sendBatch,
    { batchId: draftIds[0]!, draftIds } satisfies SendBatchJob,
    {
      singletonKey: `send-batch:${tuning.channelId}`,
      singletonSeconds: 300,
    },
  );

  return `m2_drafts=${draftIds.length}`;
}

/** Сокращение для логов: длинные заголовки не должны ломать читаемость строки. */
function short(text: string, max = 64): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Провайдер эмбеддингов для fetch-item: создаётся один раз на процесс.
 * null — ключ не задан, кластеризация выключена (материалы сохраняются без вектора).
 */
let cachedEmbeddingProvider: EmbeddingProvider | null | undefined;
function getEmbeddingProvider(deps: HandlerDeps): EmbeddingProvider | null {
  if (cachedEmbeddingProvider !== undefined) return cachedEmbeddingProvider;

  const cfg = deps.config;
  const apiKey = cfg?.embeddingApiKey;
  if (!apiKey) {
    console.error(
      '[fetch-item] ключ эмбеддингов не задан (COHERE_API_KEY/EMBEDDING_API_KEY) — семантическая кластеризация выключена',
    );
    cachedEmbeddingProvider = null;
    return null;
  }

  cachedEmbeddingProvider = createEmbeddingProvider({
    provider: cfg!.embeddingProvider,
    apiKey,
    model: cfg!.embeddingModel,
    dimensions: cfg!.embeddingDimensions,
  });
  return cachedEmbeddingProvider;
}
