/**
 * Расчёт нормализованного расстояния Левенштейна [0.0, 1.0] между черновиком и финальным текстом.
 * 0.0 — тексты идентичны, 1.0 — полное несовпадение.
 */
export function calculateEditDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return 1;

  const maxLen = Math.max(a.length, b.length);
  const dp: number[] = new Array(b.length + 1);

  for (let j = 0; j <= b.length; j++) {
    dp[j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;

    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j]!;
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = 1 + Math.min(prev, dp[j]!, dp[j - 1]!);
      }
      prev = temp;
    }
  }

  const rawDistance = dp[b.length]!;
  return Number((rawDistance / maxLen).toFixed(4));
}
