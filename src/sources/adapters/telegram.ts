import type { SourceAdapter, AdapterContext, DiscoverResult, FetchTarget, FetchedContent } from '../types.js';
import type { FetchLike } from '../../pipeline/canonicalize-url.js';
import { extractUrls } from '../../ingest/parser.js';

export interface TelegramAdapterConfig {
  channelUsername: string;
  limit?: number | undefined;
}

export class TelegramSourceAdapter implements SourceAdapter {
  readonly type = 'telegram';
  readonly adapter = 'telegram';

  async discover(ctx: AdapterContext): Promise<DiscoverResult> {
    const config = ctx.config as unknown as TelegramAdapterConfig;
    const channel = config.channelUsername?.replace(/^@/, '') || '';
    const lastMsgId = Number(ctx.cursor?.lastMsgId ?? 0);

    // В discover-фазе мы формируем ItemRef по каналу
    // Если передан внешний fetchLike или mock, считываем ленту
    const fetchLike = ctx.fetchLike ?? fetch;
    const rssBridgeUrl = `https://t.me/s/${channel}`;

    try {
      const res = await fetchLike(rssBridgeUrl);
      if (!res.ok) {
        return { refs: [], cursor: { lastMsgId } };
      }

      const html = await res.text();
      // Простой парсинг превью постов Telegram web-view
      const msgMatches = [...html.matchAll(/data-post="([^"]+)"/g)];
      const refs = [];
      let maxId = lastMsgId;

      for (const m of msgMatches) {
        const postPath = m[1]; // e.g. "durov/123"
        if (!postPath) continue;

        const idNum = Number(postPath.split('/')[1]);
        if (idNum <= lastMsgId) continue;
        if (idNum > maxId) maxId = idNum;

        const postUrl = `https://t.me/${postPath}`;
        refs.push({
          externalId: postPath,
          url: postUrl,
          title: `Telegram @${channel} #${idNum}`,
          publishedAt: new Date(),
          externalSignals: {
            is_telegram_channel: 1,
          },
        });
      }

      return {
        refs,
        cursor: { lastMsgId: maxId },
      };
    } catch {
      return { refs: [], cursor: { lastMsgId } };
    }
  }

  async fetch(target: FetchTarget, fetchLike?: FetchLike): Promise<FetchedContent> {
    const fetchFn = fetchLike ?? fetch;
    try {
      const res = await fetchFn(target.url);
      if (!res.ok) {
        return { bodyText: target.title };
      }

      const html = await res.text();
      // Извлечение текста поста из tg web view
      const textMatch = /<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/.exec(html);
      let bodyText = textMatch && textMatch[1] ? textMatch[1].replace(/<[^>]+>/g, ' ').trim() : target.title;

      const urls = extractUrls(bodyText);
      const hasPrimarySource = urls.length > 0;

      if (!hasPrimarySource) {
        bodyText = `[no_primary_source]\n${bodyText}`;
      }

      return {
        bodyText,
        author: target.url.split('/')[3] || 'telegram',
      };
    } catch {
      return { bodyText: target.title };
    }
  }
}

export const telegramAdapter = new TelegramSourceAdapter();
