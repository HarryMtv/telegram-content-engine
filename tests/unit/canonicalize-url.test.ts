import { describe, expect, it } from 'vitest';
import {
  canonicalizeUrl,
  urlHash,
  isShortLink,
  resolveRedirects,
  canonicalizeWithRedirects,
  type FetchLike,
} from '../../src/pipeline/canonicalize-url.js';

describe('canonicalizeUrl', () => {
  it('убирает utm и трекинг-параметры', () => {
    expect(
      canonicalizeUrl('https://example.com/post?utm_source=twitter&utm_campaign=x&id=5'),
    ).toBe('https://example.com/post?id=5');
  });

  it('одинаковый url_hash для материала с utm и без', () => {
    expect(urlHash('https://example.com/post?utm_medium=social')).toBe(
      urlHash('https://example.com/post'),
    );
  });

  it('приводит AMP к обычной версии', () => {
    expect(canonicalizeUrl('https://amp.example.com/news/1')).toBe('https://example.com/news/1');
    expect(canonicalizeUrl('https://example.com/news/1/amp')).toBe('https://example.com/news/1');
    expect(canonicalizeUrl('https://example.com/news/1?amp=1')).toBe('https://example.com/news/1');
  });

  it('нормализует хост, порт и слэш', () => {
    expect(canonicalizeUrl('HTTPS://EXAMPLE.COM:443/post/')).toBe('https://example.com/post');
  });

  it('сортирует параметры: порядок не влияет на хэш', () => {
    expect(urlHash('https://example.com/p?a=1&b=2')).toBe(urlHash('https://example.com/p?b=2&a=1'));
  });

  it('сбрасывает якорь', () => {
    expect(canonicalizeUrl('https://example.com/post#section')).toBe('https://example.com/post');
  });
});

describe('isShortLink', () => {
  it('узнаёт шортлинки', () => {
    expect(isShortLink('https://t.co/abc123')).toBe(true);
    expect(isShortLink('https://bit.ly/x')).toBe(true);
    expect(isShortLink('https://example.com/x')).toBe(false);
  });
});

function fakeRedirect(from: string, to: string): FetchLike {
  return async (url: string) => {
    if (url === from) {
      return new Response(null, { status: 301, headers: { location: to } });
    }
    return new Response('<html></html>', { status: 200 });
  };
}

describe('resolveRedirects', () => {
  it('разворачивает цепочку редиректов', async () => {
    const fetchLike = fakeRedirect('https://t.co/abc', 'https://example.com/final');
    await expect(resolveRedirects('https://t.co/abc', fetchLike)).resolves.toBe(
      'https://example.com/final',
    );
  });

  it('останавливается на ресурсе без редиректа', async () => {
    const fetchLike = fakeRedirect('https://t.co/abc', 'https://example.com/final');
    await expect(resolveRedirects('https://example.com/direct', fetchLike)).resolves.toBe(
      'https://example.com/direct',
    );
  });
});

describe('canonicalizeWithRedirects', () => {
  it('шортлинк → редирект → канонизация', async () => {
    const fetchLike = fakeRedirect('https://t.co/abc', 'https://example.com/final?utm_source=x');
    await expect(canonicalizeWithRedirects('https://t.co/abc', fetchLike)).resolves.toBe(
      'https://example.com/final',
    );
  });
});
