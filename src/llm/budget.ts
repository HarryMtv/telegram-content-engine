import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";

export interface BudgetStatus {
  spendUsd: number;
  limitUsd: number;
  percentUsed: number;
  isWarning80: boolean;
  isExceeded100: boolean;
  stageSpendBreakdown?: Record<string, number>;
}

/**
 * Подсчёт расходов за текущий календарный месяц с разбивкой по стадиям.
 */
export async function getMonthlySpend(
  db: Kysely<Database>,
): Promise<{ totalSpendUsd: number; breakdown: Record<string, number> }> {
  const rows = await db
    .selectFrom("llm_calls")
    .select([
      "stage",
      sql<string>`coalesce(sum(cost_usd), 0)`.as("stage_spend"),
    ])
    .where(
      "created_at",
      ">=",
      sql<Date>`date_trunc('month', now() at time zone 'utc')`,
    )
    .groupBy("stage")
    .execute();

  const breakdown: Record<string, number> = {};
  let totalSpendUsd = 0;

  for (const r of rows) {
    const cost = Number(r.stage_spend);
    breakdown[r.stage] = cost;
    totalSpendUsd += cost;
  }

  return {
    totalSpendUsd: Number(totalSpendUsd.toFixed(4)),
    breakdown,
  };
}

/**
 * Проверка бюджета против лимита ($10 по умолчанию).
 */
export async function checkBudget(
  db: Kysely<Database>,
  monthlyLimitUsd: number = 10,
): Promise<BudgetStatus> {
  const { totalSpendUsd, breakdown } = await getMonthlySpend(db);
  const percentUsed = monthlyLimitUsd > 0 ? (totalSpendUsd / monthlyLimitUsd) * 100 : 0;

  return {
    spendUsd: totalSpendUsd,
    limitUsd: monthlyLimitUsd,
    percentUsed: Number(percentUsed.toFixed(2)),
    isWarning80: percentUsed >= 80,
    isExceeded100: percentUsed >= 100,
    stageSpendBreakdown: breakdown,
  };
}

/**
 * Guard стадии 3: проверяет бюджет, отправляет алерты владельцу и блокирует стадию 3 при 100% расхода.
 */
export async function evaluateBudgetGuard(
  db: Kysely<Database>,
  notifyOwner?: (text: string) => Promise<void>,
  monthlyLimitUsd: number = 10,
): Promise<{ canRunStage3: boolean; status: BudgetStatus }> {
  const status = await checkBudget(db, monthlyLimitUsd);

  if (status.isExceeded100) {
    if (notifyOwner) {
      await notifyOwner(
        `🛑 АВТОСТОП ГЕНЕРАЦИИ: Месячный бюджет LLM исчерпан на 100% ($${status.spendUsd.toFixed(2)} / $${status.limitUsd}). Генерация новых черновиков приостановлена до следующего месяца.`,
      ).catch(() => undefined);
    }
    return { canRunStage3: false, status };
  }

  if (status.isWarning80 && notifyOwner) {
    const stagesText = Object.entries(status.stageSpendBreakdown || {})
      .map(([st, c]) => `• ${st}: $${c.toFixed(3)}`)
      .join("\n");

    await notifyOwner(
      `⚠️ Внимание: израсходовано ${status.percentUsed}% ($${status.spendUsd.toFixed(2)} / $${status.limitUsd}) месячного бюджета LLM.\n\nРазбивка по стадиям:\n${stagesText}`,
    ).catch(() => undefined);
  }

  return { canRunStage3: true, status };
}
