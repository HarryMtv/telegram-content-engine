import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import type { FetchLike } from '../pipeline/canonicalize-url.js';

const USER_AGENT =
  'Mozilla/5.0 (compatible; TelegramContentEngine/0.1; +https://github.com/owner/tce)';

/**
 * Шаг 1 лесенки извлечения (спека §5.4): прямой fetch + readability.
 * Шаги 2–3 (Firecrawl/Jina, manual_needed) добавляются в M2/M1-followup.
 * Бросает исключение — вызывающий решает, как деградировать.
 */
export async function extractArticle(url: string, fetchLike: FetchLike = fetch): Promise<string> {
  const res = await fetchLike(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} для ${url}`);
  const html = await res.text();
  const dom = parseHTML(html);
  const article = new Readability(dom.document as unknown as Document).parse();
  const text = article?.textContent?.trim();
  if (!text || text.length < 80) throw new Error(`readability не извлёк текст из ${url}`);
  return text;
}
