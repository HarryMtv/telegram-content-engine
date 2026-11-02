import type { SourceStatus } from '../domain/schemas.js';

/**
 * Деградация здоровья источника (openspec/specs/source-adapters/spec.md →
 * «Source Health Degradation State Machine»): N неудач подряд → degraded,
 * дальше → dead. Молчаливая деградация недопустима: переход в dead
 * сопровождается уведомлением владельца (колбэк onDead).
 */
export const DEGRADED_AFTER_ERRORS = 3;
export const DEAD_AFTER_ERRORS = 10;

export interface HealthTransition {
  status: SourceStatus;
  errorCount: number;
  notify: boolean;
}

export function onError(current: SourceStatus, errorCount: number): HealthTransition {
  const next = errorCount + 1;
  // уведомляем только на переходе в dead: иначе каждая следующая ошибка
  // (ретраи, повторные опросы) шлёт владельцу дубль того же сообщения
  if (next >= DEAD_AFTER_ERRORS) {
    return { status: 'dead', errorCount: next, notify: current !== 'dead' };
  }
  if (next >= DEGRADED_AFTER_ERRORS) return { status: 'degraded', errorCount: next, notify: false };
  return { status: current === 'dead' ? 'degraded' : current, errorCount: next, notify: false };
}

export function onSuccess(): { status: 'healthy'; errorCount: 0 } {
  return { status: 'healthy', errorCount: 0 };
}
