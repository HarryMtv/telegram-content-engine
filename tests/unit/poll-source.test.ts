import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/sources/registry.js', () => ({
  getAdapter: () => ({
    type: 'api',
    adapter: 'stub',
    discover: async () => {
      throw new Error('HN Algolia HTTP 500');
    },
    fetch: async () => ({ bodyText: '' }),
  }),
}));

const { handlePollSource } = await import('../../src/queue/handlers.js');
const { DEAD_AFTER_ERRORS } = await import('../../src/sources/health.js');

interface SourceRow {
  id: string;
  status: string;
  error_count: number;
}

/** Минимальная заглушка Kysely: чтение источника + перехват update. */
function makeDeps(source: SourceRow) {
  const updates: Record<string, unknown>[] = [];
  const notifications: string[] = [];
  const db = {
    selectFrom: () => ({
      selectAll: () => ({
        where: () => ({ executeTakeFirst: async () => ({ ...source, adapter: 'stub', config: { key: 'stub' }, cursor: null }) }),
      }),
    }),
    updateTable: () => ({
      set: (payload: Record<string, unknown>) => {
        updates.push(payload);
        return { where: () => ({ execute: async () => undefined }) };
      },
    }),
  };
  const deps = {
    db,
    boss: {},
    notifyOwner: async (text: string) => {
      notifications.push(text);
    },
  };
  return { deps: deps as never, updates, notifications };
}

describe('poll-source: обработка падения источника', () => {
  it('записывает ошибку, уведомляет владельца и пробрасывает исключение', async () => {
    const { deps, updates, notifications } = makeDeps({
      id: 'src-1',
      status: 'degraded',
      error_count: DEAD_AFTER_ERRORS - 1,
    });

    // молчаливая деградация запрещена: джоба обязана числиться упавшей
    await expect(handlePollSource(deps, { sourceId: 'src-1' })).rejects.toThrow('HN Algolia HTTP 500');

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      status: 'dead',
      error_count: DEAD_AFTER_ERRORS,
      last_error: 'HN Algolia HTTP 500',
    });
    expect(updates[0]?.last_error_at).toBeInstanceOf(Date);
    expect(notifications).toHaveLength(1);
  });

  it('не шлёт повторных уведомлений по уже мёртвому источнику', async () => {
    const { deps, updates, notifications } = makeDeps({
      id: 'src-1',
      status: 'dead',
      error_count: DEAD_AFTER_ERRORS + 10,
    });

    await expect(handlePollSource(deps, { sourceId: 'src-1' })).rejects.toThrow('HN Algolia HTTP 500');

    expect(updates[0]).toMatchObject({ status: 'dead', error_count: DEAD_AFTER_ERRORS + 11 });
    expect(notifications).toEqual([]);
  });
});
