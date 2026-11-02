import { describe, it, expect } from 'vitest';
import { calculateErr } from '../../src/metrics/snapshots.js';
import { telegramAdapter } from '../../src/sources/adapters/telegram.js';
import { MockMtProtoService } from '../../src/mtproto/client.js';

describe('Metrics & Snapshots (M3, §12.1)', () => {
  it('calculates ERR accurately with reactions and forwards', () => {
    // 100 views, 5 forwards, 20 reactions, 1000 subscribers
    // Engagement = 100 + 2*5 + 20 = 130
    // ERR = (130 / 1000) * 100 = 13.0%
    const err = calculateErr(100, 1000, 5, { '🔥': 10, '👍': 10 });
    expect(err).toBe(13.0);
  });

  it('returns null ERR when subscriber count is zero', () => {
    const err = calculateErr(100, 0);
    expect(err).toBeNull();
  });
});

describe('Telegram Adapter & MTProto (M3, §5.1, §14.3)', () => {
  it('detects missing primary source in telegram text and marks [no_primary_source]', async () => {
    const mockFetch = async () => {
      return new Response(
        '<div class="tgme_widget_message_text">Интересная новость без внешних ссылок внутри</div>',
        { status: 200 },
      );
    };

    const fetched = await telegramAdapter.fetch(
      {
        externalId: 'test/123',
        url: 'https://t.me/test/123',
        title: 'Post title',
      },
      mockFetch as any,
    );

    expect(fetched.bodyText).toContain('[no_primary_source]');
  });

  it('preserves text when external URLs exist in telegram post', async () => {
    const mockFetch = async () => {
      return new Response(
        '<div class="tgme_widget_message_text">Подробнее по ссылке https://github.com/example/repo</div>',
        { status: 200 },
      );
    };

    const fetched = await telegramAdapter.fetch(
      {
        externalId: 'test/124',
        url: 'https://t.me/test/124',
        title: 'Post with link',
      },
      mockFetch as any,
    );

    expect(fetched.bodyText).not.toContain('[no_primary_source]');
    expect(fetched.bodyText).toContain('https://github.com/example/repo');
  });

  it('mock MTProto service returns structured stats and reactions', async () => {
    const mock = new MockMtProtoService();
    const stats = await mock.getPostStats('ai_channel', 42);
    expect(stats.views).toBeGreaterThan(0);
    expect(stats.reactions['🔥']).toBeDefined();
  });
});
