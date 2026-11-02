import { describe, expect, it } from 'vitest';
import { onError, onSuccess, DEGRADED_AFTER_ERRORS, DEAD_AFTER_ERRORS } from '../../src/sources/health.js';

describe('переходы здоровья источника (спека §5.1)', () => {
  it('здоров до порога degraded', () => {
    for (let i = 1; i < DEGRADED_AFTER_ERRORS; i++) {
      expect(onError('healthy', i - 1).status).toBe('healthy');
    }
  });

  it('degraded после N неудач подряд', () => {
    const t = onError('healthy', DEGRADED_AFTER_ERRORS - 1);
    expect(t.status).toBe('degraded');
    expect(t.notify).toBe(false);
  });

  it('dead после M неудач с уведомлением', () => {
    const t = onError('degraded', DEAD_AFTER_ERRORS - 1);
    expect(t.status).toBe('dead');
    expect(t.notify).toBe(true);
  });

  it('повторные ошибки уже dead-источника не шлют новых уведомлений', () => {
    const t = onError('dead', DEAD_AFTER_ERRORS + 10);
    expect(t.status).toBe('dead');
    expect(t.notify).toBe(false);
  });

  it('успех сбрасывает счётчик и возвращает healthy', () => {
    expect(onSuccess()).toEqual({ status: 'healthy', errorCount: 0 });
  });
});
