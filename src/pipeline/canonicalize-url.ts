import { createHash } from 'node:crypto';

/**
 * Канонизация URL (спека §6.1): убрать трекинг-параметры, развернуть
 * AMP, нормализовать протокол/хост/порт/слэш. Редиректы и шортлинки
 * разворачиваются отдельно (нужна сеть) — см. resolveRedirects.
 */

const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'fbclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'ref_url',
  'igshid',
  'si',
];

export function canonicalizeUrl(input: string, opts?: { stripHash?: boolean }): string {
  const url = new URL(input);
  url.protocol = url.protocol === 'http:' ? 'http:' : 'https:';
  url.hostname = url.hostname.toLowerCase();
  if (isDefaultPort(url)) url.port = '';
  stripTracking(url);
  ampToPlain(url);
  url.searchParams.sort();
  if (opts?.stripHash !== false) url.hash = '';
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

function isDefaultPort(url: URL): boolean {
  return (
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  );
}

function stripTracking(url: URL): void {
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.includes(key.toLowerCase())) url.searchParams.delete(key);
  }
}

/** amp.example.com/x → example.com/x; /x?amp=1 / /x/amp → /x */
function ampToPlain(url: URL): void {
  const host = url.hostname;
  if (host.startsWith('amp.') || host.startsWith('www.amp.')) {
    url.hostname = host.replace(/^(www\.)?amp\./, '');
  }
  url.searchParams.delete('amp');
  if (url.pathname.endsWith('/amp')) {
    url.pathname = url.pathname.slice(0, -'/amp'.length);
  }
}

export function textHash(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex');
}

export function urlHash(input: string): string {
  try {
    return createHash('sha256').update(canonicalizeUrl(input)).digest('hex');
  } catch {
    return createHash('sha256').update(input.trim()).digest('hex');
  }
}

const SHORT_HOSTS_RE =
  /^(t\.co|bit\.ly|tinyurl\.com|goo\.gl|buff\.ly|ow\.ly|is\.gd|cutt\.ly|rb\.gy|reut\.rs|cnb\.cx|axios\.co)$/;

export function isShortLink(input: string): boolean {
  try {
    return SHORT_HOSTS_RE.test(new URL(input).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const REDIRECT_LIMIT = 5;

/**
 * Разворачивает цепочку редиректов/шортлинков вручную (HEAD, при необходимости GET).
 * Ресурс без редиректа отдаётся как есть. Таймаут — 10с на прыжок.
 */
export async function resolveRedirects(
  input: string,
  fetchLike: FetchLike = fetch,
  limit = REDIRECT_LIMIT,
): Promise<string> {
  let current = input;
  for (let hop = 0; hop < limit; hop++) {
    const res = await fetchLike(current, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    const location = res.headers.get('location');
    if (!location || !(res.status >= 300 && res.status < 400)) return current;
    current = new URL(location, current).toString();
  }
  return current;
}

/** Полная канонизация с сетью: шортлинк → редиректы → канонизация. */
export async function canonicalizeWithRedirects(
  input: string,
  fetchLike: FetchLike = fetch,
): Promise<string> {
  const resolved = isShortLink(input) ? await resolveRedirects(input, fetchLike) : input;
  return canonicalizeUrl(resolved);
}
