import { defineConfig } from 'vitest/config';

// Интеграционные тесты ходят в Postgres из TEST_DATABASE_URL (docker compose).
// Без переменной они пропускаются, `npm test` остаётся зелёным локально.
const shared = {
  environment: 'node' as const,
  env: {
    TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
  },
  testTimeout: 30_000,
  hookTimeout: 30_000,
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          ...shared,
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          // Каждый файл чистит общие таблицы через TRUNCATE ... CASCADE, поэтому
          // в одной базе они обязаны идти строго по одному: параллельный запуск
          // сносит sources соседнего файла и роняет его на items_source_id_fkey.
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
});
