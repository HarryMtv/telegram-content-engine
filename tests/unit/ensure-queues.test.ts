import { describe, expect, it, vi } from 'vitest';
import type PgBoss from 'pg-boss';
import { ensureQueues, JobNames, AgentJobNames } from '../../src/queue/index.js';

/** Фейковый boss: duck-typing вместо реального pg-подключения. */
function fakeBoss(createQueue: ReturnType<typeof vi.fn>): PgBoss {
  return { createQueue } as unknown as PgBoss;
}

const deadlockErr = () => Object.assign(new Error('deadlock detected'), { code: '40P01' });

const allQueues = [...Object.values(JobNames), ...Object.values(AgentJobNames)];

describe('ensureQueues: гонка создания очередей', () => {
  it('создаёт все очереди по порядку', async () => {
    const createQueue = vi.fn().mockResolvedValue(undefined);
    await expect(ensureQueues(fakeBoss(createQueue))).resolves.toBeUndefined();
    expect(createQueue).toHaveBeenCalledTimes(allQueues.length);
    expect(createQueue.mock.calls.map((c) => c[0])).toEqual(allQueues);
  });

  it('повторяет после deadlock и создаёт все очереди заново', async () => {
    vi.useFakeTimers();
    try {
      // первый вызов падает дедлоком, остальные проходят; повторный проход — полностью
      const createQueue = vi.fn().mockRejectedValueOnce(deadlockErr()).mockResolvedValue(undefined);
      const done = ensureQueues(fakeBoss(createQueue));
      await vi.runAllTimersAsync();
      await expect(done).resolves.toBeUndefined();
      expect(createQueue).toHaveBeenCalledTimes(allQueues.length + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('исчерпав попытки при повторяющемся deadlock, падает', async () => {
    vi.useFakeTimers();
    try {
      const createQueue = vi.fn().mockRejectedValue(deadlockErr());
      const done = ensureQueues(fakeBoss(createQueue));
      const expectation = expect(done).rejects.toThrow('deadlock detected');
      await vi.runAllTimersAsync();
      await expectation;
      // 5 попыток, на каждой — abort на первой очереди
      expect(createQueue).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('не ретраит посторонние ошибки pg', async () => {
    const createQueue = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    await expect(ensureQueues(fakeBoss(createQueue))).rejects.toThrow('relation does not exist');
    expect(createQueue).toHaveBeenCalledTimes(1);
  });
});
