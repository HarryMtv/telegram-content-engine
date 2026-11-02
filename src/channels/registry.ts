import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

export interface ChannelInfo {
  id: string;
  slug: string;
  title: string;
  tgChatId: string | null;
  status: string;
  targetLang: string;
  sourceLangs: string[];
}

export interface CreateChannelInput {
  slug: string;
  title: string;
  tgChatId?: string | number | null | undefined;
  tgBotToken?: string | null | undefined;
  targetLang?: string | undefined;
  sourceLangs?: string[] | undefined;
  manifesto?: string | undefined;
  selectionRules?: string | undefined;
  styleGuide?: string | undefined;
}

export async function listChannels(
  db: Kysely<Database>,
): Promise<ChannelInfo[]> {
  const rows = await db
    .selectFrom('channels')
    .selectAll()
    .orderBy('created_at', 'asc')
    .execute();

  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    tgChatId: r.tg_chat_id ? String(r.tg_chat_id) : null,
    status: r.status,
    targetLang: r.target_lang,
    sourceLangs: (r.source_langs as string[]) ?? ['ru', 'en'],
  }));
}

export async function getChannelBySlug(
  db: Kysely<Database>,
  slug: string,
): Promise<ChannelInfo | null> {
  const row = await db
    .selectFrom('channels')
    .selectAll()
    .where('slug', '=', slug.trim().toLowerCase())
    .executeTakeFirst();

  if (!row) return null;

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    tgChatId: row.tg_chat_id ? String(row.tg_chat_id) : null,
    status: row.status,
    targetLang: row.target_lang,
    sourceLangs: (row.source_langs as string[]) ?? ['ru', 'en'],
  };
}

export async function createChannelWithProfile(
  db: Kysely<Database>,
  input: CreateChannelInput,
): Promise<{ channelId: string; version: number }> {
  return await db.transaction().execute(async (trx) => {
    const channel = await trx
      .insertInto('channels')
      .values({
        slug: input.slug.toLowerCase().trim(),
        title: input.title.trim(),
        tg_chat_id: input.tgChatId ? (BigInt(input.tgChatId) as never) : null,
        tg_bot_token: input.tgBotToken ?? null,
        target_lang: input.targetLang ?? 'ru',
        source_langs: (input.sourceLangs ?? ['ru', 'en']) as never,
        status: 'active',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('channel_profiles')
      .values({
        channel_id: channel.id,
        version: 1,
        manifesto: input.manifesto ?? `Канал ${input.title}`,
        selection_rules: input.selectionRules ?? 'Только проверенные технические новости',
        style_guide: input.styleGuide ?? 'Информативный тон, без кликбейта',
        taboos: ['кликбейт', 'непроверенные слухи'] as never,
        created_by: 'owner',
        changelog: 'Начальная конфигурация канала',
      })
      .execute();

    // Создаём базовый пост-формат по умолчанию
    await trx
      .insertInto('post_formats')
      .values({
        channel_id: channel.id,
        slug: 'single_post',
        lane: 'fast',
        prompt_template: 'Напиши краткий информативный пост по фактам',
        target_length: 800,
        freshness_half_life_hours: 48,
        cadence: { cron: '0 10,18 * * *' } as never,
        daily_cap: 5,
      })
      .execute();

    return { channelId: channel.id, version: 1 };
  });
}
