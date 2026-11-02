import { describe, expect, it } from 'vitest';
import { ItemRef, RawItem, SourceConfig } from '../../src/domain/schemas.js';

describe('ItemRef', () => {
  it('принимает валидную ссылку с сигналами', () => {
    const ref = ItemRef.parse({
      externalId: '44000001',
      url: 'https://example.com/post',
      title: 'Заголовок',
      publishedAt: '2026-08-19T09:00:00Z',
      externalSignals: { hn_points: 120 },
    });
    expect(ref.externalSignals).toEqual({ hn_points: 120 });
    expect(ref.publishedAt).toBeInstanceOf(Date);
  });

  it('отвергает ссылку без url', () => {
    expect(() => ItemRef.parse({ externalId: '1', url: 'не-url', title: 'x', publishedAt: 0 })).toThrow();
  });
});

describe('RawItem', () => {
  it('проставляет дефолты discovered_at/fetch_status/body_text', () => {
    const item = RawItem.parse({
      sourceId: '00000000-0000-0000-0000-000000000001',
      externalId: 'ext-1',
      canonicalUrl: 'https://example.com/a',
      urlHash: 'a'.repeat(64),
      title: 'T',
      lang: 'en',
      publishedAt: '2026-08-19T00:00:00Z',
    });
    expect(item.fetchStatus).toBe('ok');
    expect(item.bodyText).toBe('');
    expect(item.discoveredAt).toBeInstanceOf(Date);
  });
});

describe('SourceConfig', () => {
  it('требует стабильный ключ', () => {
    expect(() => SourceConfig.parse({ url: 'https://x.com/feed' })).toThrow();
    expect(SourceConfig.parse({ key: 'rss:x', url: 'https://x.com/feed' }).key).toBe('rss:x');
  });
});
