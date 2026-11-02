/**
 * Предохранитель процесса: смерть активного pg-клиента (обрыв сети, сон машины,
 * смена Wi-Fi) прилетает как uncaught 'error' даже при pool.on('error').
 * Процессы — I/O-демоны: логируем и живём дальше, пулы переподключатся сами.
 */
export function installProcessGuard(label: string): void {
  process.on('uncaughtException', (err) => {
    console.error(`[${label}] uncaughtException:`, err.message);
  });
  process.on('unhandledRejection', (err) => {
    console.error(`[${label}] unhandledRejection:`, String(err));
  });
}
