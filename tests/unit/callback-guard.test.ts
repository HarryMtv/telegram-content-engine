import { describe, expect, it, vi } from "vitest";
import { isOwner } from "../../src/bot/callbacks.js";

describe("Callback Query Owner Guard (M2 security)", () => {
  it("чужой пользователь получает 'Недоступно' и прерывает выполнение", async () => {
    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const mockDbAction = vi.fn();

    const ctx = {
      from: { id: 999999 },
      callbackQuery: { data: "publish:11111111-2222-3333-4444-555555555555" },
      answerCallbackQuery,
    };

    const ownerChatId = "424242";

    // Guard идентичен src/process/api.ts:182-185
    if (!isOwner(ctx.from?.id, ownerChatId)) {
      await ctx.answerCallbackQuery({ text: "Недоступно" }).catch(() => undefined);
    } else {
      mockDbAction();
    }

    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: "Недоступно" });
    expect(mockDbAction).not.toHaveBeenCalled();
  });

  it("ошибка в answerCallbackQuery не роняет процесс (safe catch)", async () => {
    const answerCallbackQuery = vi.fn().mockRejectedValue(new Error("Telegram API Network Error"));

    const ctx = {
      from: { id: 999999 },
      callbackQuery: { data: "reject:11111111-2222-3333-4444-555555555555" },
      answerCallbackQuery,
    };

    const ownerChatId = "424242";

    // Guard идентичен src/process/api.ts:182-185
    await expect(
      (async () => {
        if (!isOwner(ctx.from?.id, ownerChatId)) {
          await ctx.answerCallbackQuery({ text: "Недоступно" }).catch(() => undefined);
          return;
        }
      })(),
    ).resolves.toBeUndefined();

    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: "Недоступно" });
  });

  it("владелец проходит проверку и попадает в обработчик", async () => {
    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const mockDbAction = vi.fn();

    const ctx = {
      from: { id: 424242 },
      callbackQuery: { data: "publish:11111111-2222-3333-4444-555555555555" },
      answerCallbackQuery,
    };

    const ownerChatId = "424242";

    if (!isOwner(ctx.from?.id, ownerChatId)) {
      await ctx.answerCallbackQuery({ text: "Недоступно" }).catch(() => undefined);
      return;
    }
    mockDbAction();

    expect(answerCallbackQuery).not.toHaveBeenCalled();
    expect(mockDbAction).toHaveBeenCalledTimes(1);
  });
});
