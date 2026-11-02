import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import PgBoss from 'pg-boss';

const DB_URL = process.env.TEST_DATABASE_URL ?? '';
const d = describe.skipIf(!DB_URL);

/**
 * Smoke очереди (задача 1.3): pg-boss на прямом подключении,
 * джоба доходит до воркера, singletonKey не дублирует (задача 1.10).
 * Доменные миграции здесь не нужны: pg-boss управляет своей схемой сам,
 * а параллельный запуск с db.test.ts не должен гоняться за CREATE EXTENSION.
 */
let pool: Pool;
let boss: PgBoss;

beforeAll(async () => {
  pool = new Pool({ connectionString: DB_URL, max: 5 });
  boss = new PgBoss({ connectionString: DB_URL, max: 2 });
  await boss.start();
  // в v10 send возвращает null, если очередь не создана заранее
  await boss.createQueue('smoke-test');
  await boss.createQueue('singleton-test');
});

afterAll(async () => {
  await boss.stop({ graceful: true, timeout: 3000 }).catch(() => undefined);
  await pool.end();
});

function waitFor<T>(poll: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = async () => {
      try {
        const value = await poll();
        if (value !== undefined) return resolve(value);
      } catch (err) {
        return reject(err);
      }
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 200);
    };
    void tick();
  });
}

d('pg-boss smoke (задачи 1.3, 1.10)', () => {
  it('джоба доходит до воркера и выполняется', async () => {
    let received = '';
    await boss.work('smoke-test', async ([job]) => {
      received = job.data.value;
      return 'done';
    });
    await boss.send('smoke-test', { value: 'hello-queue' });
    await waitFor(async () => (received ? received : undefined));
    expect(received).toBe('hello-queue');
  });

  it('singletonKey + singletonSeconds не даёт задвоить работу в одном слоте', async () => {
    let executions = 0;
    await boss.work('singleton-test', async () => {
      executions++;
      return 'ok';
    });
    // уникальный ключ на прогон: слот дедупа живёт 60с и переживает перезапуск тестов
    const key = `poll-source:${crypto.randomUUID()}`;
    // дедуп в пределах временного слота — тот же механизм, что у poll-source в scheduler
    const first = await boss.send('singleton-test', { n: 1 }, { singletonKey: key, singletonSeconds: 60 });
    const second = await boss.send('singleton-test', { n: 1 }, { singletonKey: key, singletonSeconds: 60 });
    expect(first).toBeTruthy();
    expect(second).toBeFalsy();

    await waitFor(async () => (executions >= 1 ? executions : undefined));
    await new Promise((r) => setTimeout(r, 500));
    expect(executions).toBe(1);
  });
});
