import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import { Bot } from "grammy";
import { loadConfig } from "../config.js";
import { createDb, closeDb } from "../db/index.js";
import { decodeCallback, isOwner } from "../bot/callbacks.js";
import {
  publishDraft,
  rejectDraftWithReason,
  deferDraft,
  decideAnalystProposal,
  type TelegramSender,
} from "../bot/actions.js";
import { rejectReasonsKeyboard, candidateKeyboard } from "../bot/batch.js";
import { registerMessageHandlers } from "../bot/messages.js";
import { processIngest } from "../ingest/service.js";
import { LlmClient } from "../llm/client.js";
import { createLlmClient } from "../llm/factory.js";
import { createEmbeddingProvider } from "../embeddings/factory.js";
import { generateLlmDraft } from "../generation/llm-draft.js";
import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";
import { installProcessGuard } from "./guard.js";
import { createBoss, startBoss, ensureQueues, makeResolverEnqueuer } from "../queue/index.js";

/**
 * Процесс api: вебхук бота + health + HTTP /ingest.
 * Полная обработка всех 6 действий редактора (M2) и ручного ингеста (M3).
 */
async function main(): Promise<void> {
  installProcessGuard("api");
  const config = loadConfig();
  const { pool, db } = createDb(config.databaseUrl);
  const boss = createBoss(config.databaseUrlDirect);
  await startBoss(boss);
  await ensureQueues(boss);

  const bot = new Bot(config.telegramBotToken);
  bot.catch((err) => console.error("bot handler error:", err.error));
  await bot.init();

  const llm = createLlmClient(db, {
    cheap: {
      provider: config.llmCheapProvider,
      model: config.llmCheapModel,
      baseUrl: config.llmCheapBaseUrl,
      apiKey: config.llmCheapApiKey || config.openAiApiKey,
      inputPricePerMillion: config.llmCheapInputPrice,
      outputPricePerMillion: config.llmCheapOutputPrice,
    },
    strong: {
      provider: config.llmStrongProvider,
      model: config.llmStrongModel,
      baseUrl: config.llmStrongBaseUrl,
      apiKey: config.llmStrongApiKey || config.openAiApiKey,
      inputPricePerMillion: config.llmStrongInputPrice,
      outputPricePerMillion: config.llmStrongOutputPrice,
    },
    defaultApiKey: config.openAiApiKey,
  });

  const embeddingProvider = createEmbeddingProvider({
    provider: config.embeddingProvider,
    model: config.embeddingModel,
    apiKey: config.embeddingApiKey || config.cohereApiKey || config.openAiApiKey,
    baseUrl: config.embeddingBaseUrl,
    dimensions: config.embeddingDimensions,
  });

  registerCallbackHandlers(bot, db, llm, config);
  registerMessageHandlers(bot, db, config, boss);

  const app = Fastify({ logger: true });
  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { ok: true, process: "api" };
  });

  // HTTP /ingest эндпоинт для внешних интеграций (браузерное расширение, скрипты, Shortcuts)
  const ingestHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = req.headers.authorization ?? "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!token || token !== config.ingestToken) {
      return reply.code(401).send({ error: "Unauthorized: invalid INGEST_TOKEN" });
    }

    const body = (req.body ?? {}) as {
      urls?: string[];
      url?: string;
      text?: string;
      channel?: string;
      priority?: "normal" | "high";
      force?: boolean;
    };

    const urls = body.urls || (body.url ? [body.url] : undefined);
    const result = await processIngest(db, {
      submittedBy: 0,
      role: "api",
      urls,
      text: body.text,
      channelHint: body.channel,
      priority: body.priority,
      force: body.force,
      embeddingProvider,
      enqueueResolver: makeResolverEnqueuer(boss),
    });
    console.log(`[/ingest] получено ${result.total}, принято ${result.acceptedCount}, дублей ${result.duplicateCount}`);

    return reply.code(200).send({
      ok: result.success,
      total: result.total,
      acceptedCount: result.acceptedCount,
      duplicateCount: result.duplicateCount,
      results: result.results,
      feedback: result.feedbackText,
      suggestRss: result.suggestRss,
    });
  };

  app.post("/ingest", ingestHandler);
  app.post("/api/ingest", ingestHandler);

  if (config.telegramWebhookUrl) {
    app.post("/api/telegram/webhook", async (req, reply) => {
      const secret = req.headers["x-telegram-bot-api-secret-token"];
      if (secret !== config.telegramWebhookSecret) {
        return reply.code(401).send({ ok: false });
      }
      await bot.handleUpdate(req.body as never);
      return reply.code(200).send({ ok: true });
    });
    await bot.api.setWebhook(config.telegramWebhookUrl, {
      secret_token: config.telegramWebhookSecret,
      allowed_updates: ["callback_query", "message"],
    });
    console.log(`вебхук: ${config.telegramWebhookUrl}`);
  } else {
    await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => undefined);
    void bot.start({ allowed_updates: ["callback_query", "message"] }).catch((err) => {
      console.error("polling упал:", err);
    });
    console.log("telegram: long polling (вебхук не задан)");
  }

  await app.listen({ port: config.apiPort, host: "0.0.0.0" });
  console.log(`api слушает :${config.apiPort}`);

  const shutdown = async () => {
    await app.close();
    await closeDb({ pool, db });
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

function createBotTelegramSender(bot: Bot): TelegramSender {
  return {
    sendMessage: async (chatId, text) => {
      const msg = await bot.api.sendMessage(chatId, text);
      return { messageId: msg.message_id };
    },
    getChatMemberCount: async (chatId) => {
      try {
        return await bot.api.getChatMemberCount(chatId);
      } catch {
        return null;
      }
    },
  };
}

function registerCallbackHandlers(
  bot: Bot,
  db: Kysely<Database>,
  llm: LlmClient,
  config: ReturnType<typeof loadConfig>,
): void {
  const sender = createBotTelegramSender(bot);

  bot.on("callback_query", async (ctx) => {
    // Кнопки меняют состояние БД (публикация, отказ) — принимать их может только владелец.
    if (!isOwner(ctx.from?.id, config.telegramOwnerChatId)) {
      await ctx.answerCallbackQuery({ text: "Недоступно" }).catch(() => undefined);
      return;
    }

    const data = ctx.callbackQuery.data ?? "";

    if (data.startsWith("publish_edit:")) {
      const origDraftId = data.replace("publish_edit:", "");
      console.log(`[bot] публикация отредактированного текста (черновик ${origDraftId.slice(0, 8)})`);
      const editDraft = await db
        .selectFrom("drafts")
        .innerJoin("channel_candidates", "channel_candidates.id", "drafts.candidate_id")
        .select([
          "drafts.id",
          "drafts.text",
          "drafts.candidate_id",
          "channel_candidates.channel_id",
        ])
        .where("drafts.candidate_id", "=", (eb) =>
          eb.selectFrom("drafts").select("candidate_id").where("id", "=", origDraftId)
        )
        .where("drafts.variant_n", "=", 99)
        .orderBy("drafts.created_at", "desc")
        .executeTakeFirst();

      if (editDraft) {
        await publishDraft(
          db,
          sender,
          {
            draftId: editDraft.id,
            channelId: editDraft.channel_id,
            channelChatId: config.telegramChannelChatId,
            editedText: editDraft.text,
          },
          { latencyS: 0 },
        );
        await ctx.answerCallbackQuery({ text: "Отредактированный пост опубликован! ✅" });
        await ctx.editMessageReplyMarkup().catch(() => undefined);
        return;
      }
    }

    // Кнопки отчёта Analyst (M4): анализируем до decodeCallback — там другие префиксы
    if (data.startsWith("analyst_accept:") || data.startsWith("analyst_reject:")) {
      const [, proposalId] = data.split(":");
      if (!proposalId) {
        await ctx.answerCallbackQuery({ text: "Некорректные данные" });
        return;
      }
      const decision = data.startsWith("analyst_accept:") ? "accepted" : "rejected";
      console.log(`[bot] решение по предложению Analyst ${proposalId.slice(0, 8)}: ${decision}`);
      try {
        const result = await decideAnalystProposal(db, proposalId, decision);
        if (result.outcome === "not_found") {
          await ctx.answerCallbackQuery({ text: "Предложение не найдено" });
        } else if (result.outcome === "already_decided") {
          await ctx.answerCallbackQuery({ text: "Уже решено" });
        } else if (result.outcome === "rejected") {
          await ctx.answerCallbackQuery({ text: "Предложение отклонено ❌" });
        } else {
          await ctx.answerCallbackQuery({ text: `✅ Принято, конституция v${result.newVersion}` });
        }
        await ctx.editMessageReplyMarkup().catch(() => undefined);
      } catch (err) {
        console.error("analyst decision failed", err);
        await ctx.answerCallbackQuery({ text: "Ошибка, попробуй ещё раз" });
      }
      return;
    }

    const decoded = decodeCallback(data);
    if (!decoded) {
      await ctx.answerCallbackQuery({ text: "Неизвестное действие" });
      return;
    }

    console.log(`[bot] действие «${decoded.action}» по черновику ${decoded.draftId.slice(0, 8)}`);

    const draft = await db
      .selectFrom("drafts")
      .innerJoin("channel_candidates", "channel_candidates.id", "drafts.candidate_id")
      .select([
        "drafts.id",
        "drafts.candidate_id",
        "drafts.fact_sheet_id",
        "drafts.variant_n",
        "drafts.format_id",
        "drafts.created_at",
        "channel_candidates.channel_id",
        "channel_candidates.status",
      ])
      .where("drafts.id", "=", decoded.draftId)
      .executeTakeFirst();

    if (!draft) {
      await ctx.answerCallbackQuery({ text: "Черновик не найден" });
      return;
    }

    if (draft.status === "decided" && decoded.action !== "more") {
      await ctx.answerCallbackQuery({ text: "Уже решено" });
      return;
    }

    const latencyS = (Date.now() - new Date(draft.created_at as Date | string).getTime()) / 1000;

    try {
      if (decoded.action === "publish") {
        await publishDraft(
          db,
          sender,
          {
            draftId: decoded.draftId,
            channelId: draft.channel_id,
            channelChatId: config.telegramChannelChatId,
          },
          { latencyS },
        );
        await ctx.answerCallbackQuery({ text: "Опубликовано ✅" });
        await ctx.editMessageReplyMarkup().catch(() => undefined);
      } else if (decoded.action === "reject") {
        // Показать клавиатуру выбора причины отказа
        await ctx.editMessageReplyMarkup({
          reply_markup: { inline_keyboard: rejectReasonsKeyboard(decoded.draftId) },
        });
        await ctx.answerCallbackQuery({ text: "Укажи причину отклонения" });
      } else if (decoded.action === "rej_r" && decoded.reason) {
        // Отклонить с выбранной причиной
        await rejectDraftWithReason(db, decoded.draftId, decoded.reason, { latencyS });
        await ctx.answerCallbackQuery({ text: "Отклонено ❌" });
        await ctx.editMessageReplyMarkup().catch(() => undefined);
      } else if (decoded.action === "defer") {
        // Отложить в пул
        await deferDraft(db, decoded.draftId, { latencyS });
        await ctx.answerCallbackQuery({ text: "Отложено в пул ⏳" });
        await ctx.editMessageReplyMarkup().catch(() => undefined);
      } else if (decoded.action === "more" || decoded.action === "strong") {
        // Генерация ещё варианта или сильной моделью
        await ctx.answerCallbackQuery({
          text: decoded.action === "strong" ? "⚡ Переписываю сильной моделью..." : "🔄 Генерирую ещё вариант...",
        });

        const factSheet = draft.fact_sheet_id
          ? await db
              .selectFrom("fact_sheets")
              .selectAll()
              .where("id", "=", draft.fact_sheet_id)
              .executeTakeFirst()
          : null;

        if (!factSheet) {
          await ctx.reply("FactSheet не найден для перегенерации.");
          return;
        }

        const profile = await db
          .selectFrom("channel_profiles")
          .select(["version", "style_guide", "taboos"])
          .where("channel_id", "=", draft.channel_id)
          .orderBy("version", "desc")
          .executeTakeFirst();

        const format = draft.format_id
          ? await db
              .selectFrom("post_formats")
              .selectAll()
              .where("id", "=", draft.format_id)
              .executeTakeFirst()
          : null;

        const draftOptions: any = {
          candidateId: draft.candidate_id,
          factSheetId: factSheet.id,
          factSheet: {
            what_happened: factSheet.what_happened,
            who: (factSheet.who as string[]) || [],
            numbers: (factSheet.numbers as Record<string, string | number>) || {},
            key_quote: factSheet.key_quote,
            why_it_matters: factSheet.why_it_matters,
            primary_url: factSheet.primary_url,
            confidence: Number(factSheet.confidence),
            source_item_ids: (factSheet.source_item_ids as string[]) || [],
          },
          format: {
            id: format?.id,
            slug: format?.slug || "digest",
            targetLength: format?.target_length,
            promptTemplate: format?.prompt_template,
          },
          profile: {
            version: profile?.version,
            styleGuide: profile?.style_guide || undefined,
            taboos: (profile?.taboos as string[]) || undefined,
          },
          variantN: (draft.variant_n || 1) + 1,
          modelRole: decoded.action === "strong" ? "strong" : "cheap",
          channelId: draft.channel_id,
        };
        const newDraft = await generateLlmDraft(llm, db, draftOptions);

        await ctx.reply(
          `${decoded.action === "strong" ? "⚡ *Переписанный вариант (сильная модель)*" : `🔄 *Вариант ${newDraft.variantN}*`}\n\n${newDraft.text}`,
          {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: candidateKeyboard(newDraft.id) },
          },
        );
      } else if (decoded.action === "edit") {
        await ctx.answerCallbackQuery({ text: "Отправь отредактированный текст в ответ на это сообщение" });
      }
    } catch (err) {
      console.error("callback handling failed", err);
      await ctx.answerCallbackQuery({ text: "Ошибка, попробуй ещё раз" });
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
