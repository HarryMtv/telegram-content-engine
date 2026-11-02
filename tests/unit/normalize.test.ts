import { describe, expect, it } from 'vitest';
import { normalizeRef, normalizeFetched, contentHashOf } from '../../src/pipeline/normalize.js';

const SOURCE_ID = '00000000-0000-0000-0000-000000000001';

describe('normalizeRef', () => {
  it('канонизирует url и считает url_hash', () => {
    const n = normalizeRef(
      {
        externalId: 'tc-1',
        url: 'https://Example.com/post/?utm_source=rss',
        title: 'Заголовок',
        publishedAt: new Date('2026-08-19T08:00:00Z'),
      },
      SOURCE_ID,
    );
    expect(n.canonicalUrl).toBe('https://example.com/post');
    expect(n.urlHash).toHaveLength(64);
    expect(n.fetchStatus).toBe('pending');
  });

  it('детектирует язык по тексту, а не по источнику', () => {
    const ru = normalizeRef(
      {
        externalId: 'tc-2',
        url: 'https://example.com/ru',
        title: 'Российские инженеры представили новый ускоритель нейросетей',
        publishedAt: new Date(),
        snippet: 'Компания заявляет о значительном приросте производительности в тестах.',
      },
      SOURCE_ID,
    );
    expect(ru.lang).toBe('ru');

    const en = normalizeRef(
      {
        externalId: 'tc-3',
        url: 'https://example.com/en',
        title: 'The company shipped a new compiler toolchain',
        publishedAt: new Date(),
        snippet:
          'The engineers wrote about the changes on the official engineering blog and shared the benchmark numbers.',
      },
      SOURCE_ID,
    );
    expect(en.lang).toBe('en');
  });
});

describe('normalizeFetched + contentHashOf', () => {
  it('полнотекстовая нормализация ставит ok и content_hash', () => {
    const base = {
      sourceId: SOURCE_ID,
      externalId: 'tc-1',
      canonicalUrl: 'https://example.com/post',
      title: 'Title',
      publishedAt: new Date('2026-08-19T08:00:00Z'),
      discoveredAt: new Date('2026-08-19T09:00:00Z'),
    };
    const raw = normalizeFetched(base, 'Full body text of the article about models.');
    expect(raw.fetchStatus).toBe('ok');
    expect(raw.contentHash).toBe(contentHashOf(base.title, 'Full body text of the article about models.'));
  });

  it('content_hash нечувствителен к пробелам', () => {
    expect(contentHashOf('A', 'hello  world')).toBe(contentHashOf('a', 'hello world'));
  });
});
