import { describe, expect, it, vi } from "vitest";
import { calculateEditDistance } from "../../src/bot/diff.js";
import { REJECT_REASONS } from "../../src/bot/taxonomy.js";
import { updateSourceTrustOnDecision } from "../../src/bot/source-trust.js";
import { encodeCallback, decodeCallback, isOwner } from "../../src/bot/callbacks.js";
import { candidateKeyboard, rejectReasonsKeyboard } from "../../src/bot/batch.js";

describe("Bot M2 Actions, Diff, Taxonomy & Source Trust (Tasks 2.12-2.15)", () => {
  it("рассчитывает нормализованный edit_distance (диф правок)", () => {
    expect(calculateEditDistance("identical text", "identical text")).toBe(0);
    expect(calculateEditDistance("", "abc")).toBe(1);

    const original = "Привет мир! Это черновик.";
    const edited = "Привет, мир! Это опубликованный пост.";
    const dist = calculateEditDistance(original, edited);
    expect(dist).toBeGreaterThan(0);
    expect(dist).toBeLessThan(1);
  });

  it("таксономия содержит 7 причин отказа и маппинг на подсистемы", () => {
    const keys = Object.keys(REJECT_REASONS);
    expect(keys).toHaveLength(7);
    expect(REJECT_REASONS.unreliable_source.subsystem).toBe("source_trust");
    expect(REJECT_REASONS.off_topic.subsystem).toBe("profile_vector / selection_rules");
  });

  it("updateSourceTrustOnDecision увеличивает trust при публикации и снижает при сомнительном источнике", async () => {
    let savedTrust: number | null = null;
    const mockDb: any = {
      selectFrom: vi.fn(() => ({
        select: vi.fn(() => ({
          where: vi.fn(() => ({
            executeTakeFirst: vi.fn(async () => ({ id: "src-1", trust_score: "0.50" })),
          })),
        })),
      })),
      updateTable: vi.fn(() => ({
        set: vi.fn((vals) => {
          savedTrust = vals.trust_score;
          return {
            where: vi.fn(() => ({
              execute: vi.fn(async () => []),
            })),
          };
        }),
      })),
    };

    // При публикации trust растёт: 0.50 -> 0.52
    const resPublish = await updateSourceTrustOnDecision(mockDb, "src-1", "publish");
    expect(resPublish.newTrust).toBe(0.52);
    expect(savedTrust).toBe(0.52);

    // При отказе по причине unreliable_source trust падает: 0.50 -> 0.40
    const resReject = await updateSourceTrustOnDecision(mockDb, "src-1", "reject", "unreliable_source");
    expect(resReject.newTrust).toBe(0.40);
  });

  it("кодирует и декодирует расширенные действия батча M2", () => {
    const draftId = "11111111-2222-3333-4444-555555555555";

    expect(decodeCallback(encodeCallback(draftId, "more"))).toEqual({ action: "more", draftId });
    expect(decodeCallback(encodeCallback(draftId, "strong"))).toEqual({ action: "strong", draftId });
    expect(decodeCallback(encodeCallback(draftId, "defer"))).toEqual({ action: "defer", draftId });
    expect(decodeCallback(encodeCallback(draftId, "rej_r", "unreliable_source"))).toEqual({
      action: "rej_r",
      reason: "unreliable_source",
      draftId,
    });
  });

  it("генерирует клавиатуру из 6 действий и клавиатуру причин отказа", () => {
    const draftId = "11111111-2222-3333-4444-555555555555";
    const kb = candidateKeyboard(draftId);
    expect(kb).toHaveLength(3); // 3 строки по 2 кнопки = 6 действий

    const reasonsKb = rejectReasonsKeyboard(draftId);
    expect(reasonsKb.length).toBeGreaterThanOrEqual(4);
  });

  describe("isOwner", () => {
    it("совпадение from.id с TELEGRAM_OWNER_CHAT_ID — владелец", () => {
      expect(isOwner(424242, "424242")).toBe(true);
    });

    it("чужой from.id — не владелец", () => {
      expect(isOwner(1, "424242")).toBe(false);
    });

    it("from.id отсутствует (undefined) — не владелец", () => {
      expect(isOwner(undefined, "424242")).toBe(false);
    });

    it("отрицательный ID (например, чат/супергруппа) проверяется корректно", () => {
      expect(isOwner(-1001234567890, "-1001234567890")).toBe(true);
      expect(isOwner(-1001234567890, "424242")).toBe(false);
    });

    it("0 как from.id — совпадение только с строкой '0'", () => {
      expect(isOwner(0, "0")).toBe(true);
      expect(isOwner(0, "424242")).toBe(false);
    });

    it("пробелы или нечисловые символы в ownerChatId не дают ложного совпадения", () => {
      expect(isOwner(424242, " 424242 ")).toBe(false);
      expect(isOwner(424242, "424242\n")).toBe(false);
    });
  });
});
