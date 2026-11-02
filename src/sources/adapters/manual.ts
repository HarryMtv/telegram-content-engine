import type { SourceAdapter, DiscoverResult, FetchTarget, FetchedContent } from '../types.js';

export class ManualSourceAdapter implements SourceAdapter {
  readonly type = 'manual';
  readonly adapter = 'manual';

  async discover(): Promise<DiscoverResult> {
    return { refs: [], cursor: {} };
  }

  async fetch(target: FetchTarget): Promise<FetchedContent> {
    return {
      bodyText: target.title,
    };
  }
}

export const manualAdapter = new ManualSourceAdapter();
