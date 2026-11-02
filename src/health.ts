import Fastify from 'fastify';
import type { Pool } from 'pg';

/**
 * Health-эндпоинт для каждого процесса (спека pipeline-core): проверяет БД
 * и отдаёт 200/503. Coolify использует его для рестартов.
 */
export async function startHealthServer(port: number, pool: Pool, label: string): Promise<void> {
  const app = Fastify({ logger: false });
  app.get('/health', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { ok: true, process: label };
    } catch {
      return reply.status(503).send({ ok: false, process: label });
    }
  });
  await app.listen({ port, host: '0.0.0.0' });
}
