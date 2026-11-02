import type { FetchLike } from '../pipeline/canonicalize-url.js';
import type { ItemRef, SourceConfig } from '../domain/schemas.js';

/**
 * Контракт адаптера источника (спека §5.1): две фазы обязательны.
 * discover — дёшево (список ссылок), fetch — дорого (полный текст).
 */
export interface AdapterContext {
  sourceId: string;
  config: SourceConfig;
  cursor: Record<string, unknown> | null;
  /** инъекция для тестов; по умолчанию глобальный fetch */
  fetchLike?: FetchLike;
}

export interface DiscoverResult {
  refs: ItemRef[];
  cursor: Record<string, unknown>;
}

export interface FetchTarget {
  externalId: string;
  url: string;
  title: string;
}

export interface FetchedContent {
  bodyText: string;
  author?: string;
}

export interface SourceAdapter {
  readonly type: string;
  readonly adapter: string;
  discover(ctx: AdapterContext): Promise<DiscoverResult>;
  fetch(target: FetchTarget, fetchLike?: FetchLike): Promise<FetchedContent>;
}
