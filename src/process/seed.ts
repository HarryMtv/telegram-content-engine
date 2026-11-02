import { sql } from 'kysely';
import { createDb, closeDb } from '../db/index.js';

/**
 * Seed первого канала (M1): канал ai-tech, профиль-конституция v1,
 * slow-формат digest, источники — пара RSS-лент + HN front page.
 * Идемпотентен: повторный запуск не дублирует и не перезаписывает.
 * Требует DATABASE_URL; TELEGRAM_CHANNEL_CHAT_ID опционален (заполнится позже).
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Нужен env DATABASE_URL');
  const chatId = process.env.TELEGRAM_CHANNEL_CHAT_ID ?? null;
  const { pool, db } = createDb(url);

  const channel = await db
    .insertInto('channels')
    .values({
      slug: 'ai-tech',
      tg_chat_id: chatId,
      title: 'AI Tech',
      target_lang: 'ru',
      source_langs: ['en', 'ru'],
      status: 'active',
    })
    .onConflict((oc) => oc.column('slug').doNothing())
    .returning(['id', 'slug'])
    .executeTakeFirst();

  const channelId =
    channel?.id ??
    (await db.selectFrom('channels').select('id').where('slug', '=', 'ai-tech').executeTakeFirstOrThrow()).id;

  await db
    .insertInto('channel_profiles')
    .values({
      channel_id: channelId,
      version: 1,
      manifesto:
        'Канал о технике, AI-новостях и трендах в IT для русскоязычной аудитории. ' +
        'Не гонка за скоростью: отобранность и доступ к англоязычным первоисточникам. ' +
        'Ниша плотная — конкурируем качеством отбора, а не объёмом.',
      selection_rules:
        'Берём: существенные события и релизы в AI/ML, инженерные находки, значимые продукты, ' +
        'исследования с практическим следствием. Не берём: слухи, маркетинговые анонсы без содержания, ' +
        'дубли вчерашних новостей, скандалы без технической составляющей.',
      style_guide:
        'Пишем по-русски, точно и без воды. Факты из первоисточника, ссылка обязательна. ' +
        'Без кликбейта и восклицаний. Технические термины не переводим насильно.',
      taboos: ['слухи без источников', 'кликбейт', 'политика'],
      domain_blacklist: [],
      profile_vector: null,
      score_weights: { trust: 0.5, freshness: 0.5 },
      created_by: 'owner',
      changelog: 'Первоначальная версия (seed M1)',
    })
    .onConflict((oc) => oc.columns(['channel_id', 'version']).doNothing())
    .execute();

  await db
    .insertInto('post_formats')
    .values({
      channel_id: channelId,
      slug: 'digest',
      lane: 'slow',
      prompt_template: '',
      target_length: 1024,
      freshness_half_life_hours: 120,
      cadence: { cron: '5 10 * * *' },
      daily_cap: 5,
    })
    .onConflict((oc) => oc.columns(['channel_id', 'slug']).doNothing())
    .execute();

  const sources = [
    { type: 'rss', adapter: 'rss', config: { key: 'rss:openai-news', url: 'https://openai.com/news/rss.xml' }, pollIntervalS: 900 },
    { type: 'rss', adapter: 'rss', config: { key: 'rss:techcrunch', url: 'https://techcrunch.com/feed/' }, pollIntervalS: 900 },
    { type: 'api', adapter: 'hn_algolia', config: { key: 'hn-front-page', threshold: 50 }, pollIntervalS: 600 },
  ];
  for (const s of sources) {
    const exists = await db
      .selectFrom('sources')
      .select('id')
      .where('adapter', '=', s.adapter)
      .where(sql<boolean>`config->>'key' = ${s.config.key}`)
      .executeTakeFirst();
    if (!exists) {
      await db
        .insertInto('sources')
        .values({
          type: s.type,
          adapter: s.adapter,
          config: s.config as never,
          poll_interval_s: s.pollIntervalS,
        })
        .execute();
    }
  }

  console.log('Seed завершён: канал ai-tech, профиль v1, формат digest, 3 источника');
  await closeDb({ pool, db });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
