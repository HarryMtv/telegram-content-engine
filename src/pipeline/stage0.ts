import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

/**
 * Стадия 0 — жёсткие фильтры без затрат (спека §6.4).
 * M1: язык, возраст вне окна формата, чёрный список доменов,
 * уже опубликованный сюжет, спам-паттерны. Эмбеддингов/Story-логики ещё нет.
 */

export interface Stage0Input {
  itemId: string;
  storyId: string | null;
  url: string;
  lang: string;
  publishedAt: Date | null;
}

export interface Stage0Context {
  channelId: string;
  allowedLangs: string[];
  domainBlacklist: string[];
  /** окно формата в часах (freshness_half_life_hours * 4) */
  maxAgeHours: number;
  now?: Date;
}

const SPAM_TITLE_PATTERNS = [
  /\bcrypto\s*(giveaway|airdrop)\b/i,
  /\bfree\s+(bitcoin|btc|eth)\b/i,
  /\bclick\s+here\b/i,
  /casino|betting|букмекер/i,
  /\b(viagra|pharmacy)\b/i,
];

export function passesTitleSpam(title: string): boolean {
  return !SPAM_TITLE_PATTERNS.some((re) => re.test(title));
}

export function isDomainBlacklisted(url: string, blacklist: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true; // битый url — не пропускаем
  }
  return blacklist.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Синхронная часть фильтров; возвращает false с причиной (для трассировки). */
export function stage0Filter(input: Stage0Input, ctx: Stage0Context): { pass: boolean; reason?: string } {
  const now = ctx.now ?? new Date();
  if (input.lang !== 'unknown' && !ctx.allowedLangs.includes(input.lang)) {
    return { pass: false, reason: `lang=${input.lang}` };
  }
  if (isDomainBlacklisted(input.url, ctx.domainBlacklist)) {
    return { pass: false, reason: 'domain_blacklist' };
  }
  if (input.publishedAt) {
    const ageHours = (now.getTime() - input.publishedAt.getTime()) / 3_600_000;
    if (ageHours > ctx.maxAgeHours) return { pass: false, reason: `age=${Math.round(ageHours)}h` };
    if (ageHours < -24) return { pass: false, reason: 'future_dated' };
  }
  return { pass: true };
}

/** Уже опубликованный сюжет канала (Story один раз на канал — спека §6.3). */
export async function isStoryPublished(
  db: Kysely<Database>,
  channelId: string,
  storyId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('posts')
    .innerJoin('drafts', 'drafts.id', 'posts.draft_id')
    .innerJoin('channel_candidates', 'channel_candidates.id', 'drafts.candidate_id')
    .select('posts.id')
    .where('channel_candidates.story_id', '=', storyId)
    .where('posts.channel_id', '=', channelId)
    .executeTakeFirst();
  return row !== undefined;
}
