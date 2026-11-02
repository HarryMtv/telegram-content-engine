import { describe, expect, it, vi } from "vitest";
import { checkBudget, evaluateBudgetGuard } from "../../src/llm/budget.js";

describe("Budget Control & Auto-stop (Task 2.17)", () => {
  it("рассчитывает процент расходов и флаг 80% warning", async () => {
    const mockDb: any = {
      selectFrom: vi.fn(() => ({
        select: vi.fn(() => ({
          where: vi.fn(() => ({
            groupBy: vi.fn(() => ({
              execute: vi.fn(async () => [
                { stage: "triage", stage_spend: "3.50" },
                { stage: "draft", stage_spend: "4.60" },
              ]),
            })),
          })),
        })),
      })),
    };

    const status = await checkBudget(mockDb, 10);
    expect(status.spendUsd).toBe(8.1);
    expect(status.percentUsed).toBe(81.0);
    expect(status.isWarning80).toBe(true);
    expect(status.isExceeded100).toBe(false);
  });

  it("evaluateBudgetGuard отправляет алерт при 80% и разрешает стадию 3", async () => {
    const mockDb: any = {
      selectFrom: vi.fn(() => ({
        select: vi.fn(() => ({
          where: vi.fn(() => ({
            groupBy: vi.fn(() => ({
              execute: vi.fn(async () => [{ stage: "triage", stage_spend: "8.20" }]),
            })),
          })),
        })),
      })),
    };

    const notifications: string[] = [];
    const notifyOwner = async (msg: string) => {
      notifications.push(msg);
    };

    const guard = await evaluateBudgetGuard(mockDb, notifyOwner, 10);
    expect(guard.canRunStage3).toBe(true);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("82%");
  });

  it("evaluateBudgetGuard блокирует стадию 3 при 100% расходе и шлет автостоп", async () => {
    const mockDb: any = {
      selectFrom: vi.fn(() => ({
        select: vi.fn(() => ({
          where: vi.fn(() => ({
            groupBy: vi.fn(() => ({
              execute: vi.fn(async () => [{ stage: "draft", stage_spend: "10.05" }]),
            })),
          })),
        })),
      })),
    };

    const notifications: string[] = [];
    const notifyOwner = async (msg: string) => {
      notifications.push(msg);
    };

    const guard = await evaluateBudgetGuard(mockDb, notifyOwner, 10);
    expect(guard.canRunStage3).toBe(false);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("АВТОСТОП ГЕНЕРАЦИИ");
  });
});
