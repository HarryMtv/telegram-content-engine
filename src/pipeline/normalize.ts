import { createHash } from 'node:crypto';
import { franc } from 'franc-min';
import { canonicalizeUrl } from './canonicalize-url.js';
import type { ItemRef, RawItem } from '../domain/schemas.js';

/** ISO 639-3 → двухбуквенный код. Неизвестный язык не блокирует материал. */
function detectLang(text: string): string {
  const mapped: Record<string, string> = { eng: 'en', rus: 'ru', deu: 'de', fra: 'fr', ces: 'cs' };
  if (text.trim().length < 20) return 'unknown';
  return mapped[franc(text)] ?? 'unknown';
}

export function contentHashOf(title: string, bodyText: string): string {
  const normalized = `${title}\n${bodyText}`.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Нормализация дешёвой фазы: ItemRef → запись items с fetch_status=pending.
 * Канонизация здесь синхронная (без сети) — редиректы адаптер разворачивает сам.
 */
export function normalizeRef(ref: ItemRef, sourceId: string, now = new Date()): Omit<RawItem, 'bodyText' | 'contentHash'> & { bodyText: string; contentHash?: string } {
  return {
    sourceId,
    externalId: ref.externalId,
    canonicalUrl: canonicalizeUrl(ref.url),
    urlHash: createHash('sha256').update(canonicalizeUrl(ref.url)).digest('hex'),
    title: ref.title.trim(),
    bodyText: ref.snippet ?? '',
    lang: detectLang(`${ref.title} ${ref.snippet ?? ''}`),
    publishedAt: ref.publishedAt,
    discoveredAt: now,
    externalSignals: ref.externalSignals,
    fetchStatus: 'pending',
  };
}

/** Нормализация дорогой фазы: полный текст → финальный RawItem. */
export function normalizeFetched(item: {
  sourceId: string;
  externalId: string;
  canonicalUrl: string;
  title: string;
  publishedAt: Date;
  discoveredAt: Date;
  externalSignals?: Record<string, number | string>;
}, bodyText: string, author?: string): RawItem {
  return {
    sourceId: item.sourceId,
    externalId: item.externalId,
    canonicalUrl: item.canonicalUrl,
    urlHash: createHash('sha256').update(item.canonicalUrl).digest('hex'),
    contentHash: contentHashOf(item.title, bodyText),
    title: item.title.trim(),
    bodyText,
    lang: detectLang(`${item.title} ${bodyText}`),
    author,
    publishedAt: item.publishedAt,
    discoveredAt: item.discoveredAt,
    externalSignals: item.externalSignals,
    fetchStatus: 'ok',
  };
}
