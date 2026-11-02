import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const VALID = {
  DATABASE_URL: 'postgresql://u:p@pooler.example.com:6543/postgres',
  DATABASE_URL_DIRECT: 'postgresql://u:p@db.example.com:5432/postgres',
  TELEGRAM_BOT_TOKEN: '1234567890:AA-test-token',
  TELEGRAM_CHANNEL_CHAT_ID: '-1001234567890',
  TELEGRAM_OWNER_CHAT_ID: '424242',
  TELEGRAM_WEBHOOK_SECRET: 'super-secret',
};

describe('loadConfig', () => {
  it('читает валидный env с дефолтами', () => {
    const cfg = loadConfig(VALID);
    expect(cfg.databaseUrl).toContain('pooler.example.com');
    expect(cfg.telegramChannelChatId).toBe('-1001234567890');
    expect(cfg.apiPort).toBe(8080);
    expect(cfg.appEnv).toBe('development');
  });

  it('отсутствие обязательного поля даёт осмысленную ошибку без значения', () => {
    const { TELEGRAM_BOT_TOKEN: _omit, ...noToken } = VALID;
    expect(() => loadConfig(noToken)).toThrow(/telegramBotToken/);
  });

  it('невалидный chat id отвергается', () => {
    expect(() => loadConfig({ ...VALID, TELEGRAM_CHANNEL_CHAT_ID: 'not-a-number' })).toThrow();
  });

  describe('production отвергает секреты-заглушки', () => {
    const PROD = { ...VALID, APP_ENV: 'production', INGEST_TOKEN: 'a'.repeat(64) };

    it('без INGEST_TOKEN (дефолт dev-ingest-token) — ошибка', () => {
      expect(() => loadConfig({ ...VALID, APP_ENV: 'production' })).toThrow(/ingestToken/);
    });

    it('INGEST_TOKEN=change-me — ошибка', () => {
      expect(() => loadConfig({ ...VALID, APP_ENV: 'production', INGEST_TOKEN: 'change-me' })).toThrow(/ingestToken/);
    });

    it('INGEST_TOKEN=dev-ingest-token — ошибка', () => {
      expect(() => loadConfig({ ...VALID, APP_ENV: 'production', INGEST_TOKEN: 'dev-ingest-token' })).toThrow(/ingestToken/);
    });

    it('валидный INGEST_TOKEN в production принимается', () => {
      const cfg = loadConfig(PROD);
      expect(cfg.ingestToken).toBe('a'.repeat(64));
    });

    it('TELEGRAM_WEBHOOK_SECRET=change-me-8-chars-min — ошибка', () => {
      expect(() => loadConfig({ ...PROD, TELEGRAM_WEBHOOK_SECRET: 'change-me-8-chars-min' })).toThrow(/telegramWebhookSecret/);
    });

    it('сообщение ошибки не содержит значение токена', () => {
      try {
        loadConfig({ ...VALID, APP_ENV: 'production', INGEST_TOKEN: 'change-me' });
        expect.unreachable('должна была быть ошибка конфигурации');
      } catch (err) {
        expect((err as Error).message).not.toContain('change-me');
      }
    });

    it('TELEGRAM_WEBHOOK_SECRET=change-me в production — ошибка', () => {
      expect(() => loadConfig({ ...PROD, TELEGRAM_WEBHOOK_SECRET: 'change-me' })).toThrow(/telegramWebhookSecret/);
    });

    it('TELEGRAM_WEBHOOK_SECRET=dev-ingest-token в production — ошибка', () => {
      expect(() => loadConfig({ ...PROD, TELEGRAM_WEBHOOK_SECRET: 'dev-ingest-token' })).toThrow(/telegramWebhookSecret/);
    });

    it('оба секрета-заглушки в production — ошибка содержит оба поля', () => {
      expect(() =>
        loadConfig({
          ...VALID,
          APP_ENV: 'production',
          INGEST_TOKEN: 'change-me',
          TELEGRAM_WEBHOOK_SECRET: 'change-me-8-chars-min',
        }),
      ).toThrow(/ingestToken.*telegramWebhookSecret|telegramWebhookSecret.*ingestToken/);
    });

    it('INGEST_TOKEN короче 8 символов в production — ошибка схемы min(8)', () => {
      expect(() => loadConfig({ ...PROD, INGEST_TOKEN: 'short' })).toThrow(/ingestToken/);
    });

    it('в development плейсхолдер TELEGRAM_WEBHOOK_SECRET принимается без ошибок', () => {
      const cfg = loadConfig({ ...VALID, TELEGRAM_WEBHOOK_SECRET: 'change-me-8-chars-min' });
      expect(cfg.telegramWebhookSecret).toBe('change-me-8-chars-min');
    });

    it('в development дефолт dev-ingest-token по-прежнему работает (регрессия)', () => {
      const cfg = loadConfig(VALID);
      expect(cfg.ingestToken).toBe('dev-ingest-token');
    });
  });
});
