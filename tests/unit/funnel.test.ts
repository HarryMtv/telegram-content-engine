import { describe, expect, it } from "vitest";
import {
  stage0Filter,
  passesTitleSpam,
  isDomainBlacklisted,
} from "../../src/pipeline/stage0.js";
import {
  freshnessScore,
  calculateImportance,
  scoreBatch,
  parseStage1Weights,
  DEFAULT_STAGE1_WEIGHTS,
  NO_PRIMARY_SOURCE_PENALTY,
} from "../../src/pipeline/stage1.js";

const CTX = {
  channelId: "00000000-0000-0000-0000-000000000009",
  allowedLangs: ["en", "ru"],
  domainBlacklist: ["spammy.com"],
  maxAgeHours: 480,
  now: new Date("2026-08-20T12:00:00Z"),
};

describe("стадия 0 — жёсткие фильтры (спека §6.4)", () => {
  it("режет неразрешённый язык", () => {
    expect(
      stage0Filter({ itemId: "i", storyId: null, url: "https://ok.com/a", lang: "de", publishedAt: new Date() }, CTX),
    ).toMatchObject({ pass: false, reason: "lang=de" });
  });

  it("пропускает unknown-язык (короткий текст не детектится)", () => {
    expect(
      stage0Filter(
        { itemId: "i", storyId: null, url: "https://ok.com/a", lang: "unknown", publishedAt: new Date("2026-08-20T10:00:00Z") },
        CTX,
      ).pass,
    ).toBe(true);
  });

  it("режет возраст вне окна формата", () => {
    const old = new Date("2026-07-01T00:00:00Z"); // ~50 дней при окне 480ч
    expect(
      stage0Filter({ itemId: "i", storyId: null, url: "https://ok.com/a", lang: "en", publishedAt: old }, CTX).reason,
    ).toMatch(/^age=/);
  });

  it("чёрный список доменов включая поддомены", () => {
    expect(isDomainBlacklisted("https://spammy.com/x", CTX.domainBlacklist)).toBe(true);
    expect(isDomainBlacklisted("https://sub.spammy.com/x", CTX.domainBlacklist)).toBe(true);
    expect(isDomainBlacklisted("https://notspammy.com/x", CTX.domainBlacklist)).toBe(false);
  });

  it("спам-паттерны заголовков", () => {
    expect(passesTitleSpam("Normal technical post about Postgres")).toBe(true);
    expect(passesTitleSpam("Free Bitcoin giveaway!")).toBe(false);
    expect(passesTitleSpam("Best casino bonuses 2026")).toBe(false);
  });

  it("дата из будущего отбрасывается", () => {
    const future = new Date("2026-09-20T00:00:00Z");
    expect(
      stage0Filter({ itemId: "i", storyId: null, url: "https://ok.com/a", lang: "en", publishedAt: future }, CTX).reason,
    ).toBe("future_dated");
  });
});

describe("стадия 1 — числовые скоры и компоненты (спека §6.4, M2)", () => {
  it("freshness затухает с полураспадом", () => {
    const t0 = new Date("2026-08-20T12:00:00Z");
    const t6h = new Date("2026-08-20T06:00:00Z");
    expect(freshnessScore(t0, 120, t0)).toBeCloseTo(1);
    expect(freshnessScore(t6h, 120, t0)).toBeCloseTo(Math.pow(0.5, 6 / 120), 3);
  });

  it("быстрая деградация fast-формата", () => {
    const day = new Date("2026-08-19T12:00:00Z");
    const now = new Date("2026-08-20T12:00:00Z");
    expect(freshnessScore(day, 6, now)).toBeCloseTo(Math.pow(0.5, 4), 4);
  });

  it("calculateImportance рассчитывает важность от метрик сюжета и внешних сигналов", () => {
    const single = calculateImportance({ itemCount: 1, sourceDiversity: 1, velocity: 0, externalSignal: 0 });
    expect(single).toBe(0);

    const viral = calculateImportance({ itemCount: 6, sourceDiversity: 4, velocity: 5, externalSignal: 500 });
    expect(viral).toBeGreaterThan(0.7);
  });

  it("scoreBatch учитывает relevance к profile_vector и importance", () => {
    const now = new Date("2026-08-20T12:00:00Z");
    const profileVector = [1, 0, 0];

    const scored = scoreBatch(
      [
        {
          itemId: "high-rel",
          storyId: "s1",
          trustScore: 0.8,
          publishedAt: new Date("2026-08-20T10:00:00Z"),
          embedding: [0.95, 0.05, 0], // Высокая релевантность
          itemCount: 3,
          sourceDiversity: 2,
        },
        {
          itemId: "low-rel",
          storyId: "s2",
          trustScore: 0.8,
          publishedAt: new Date("2026-08-20T10:00:00Z"),
          embedding: [0, 1, 0], // Низкая релевантность
          itemCount: 1,
          sourceDiversity: 1,
        },
      ],
      120,
      DEFAULT_STAGE1_WEIGHTS,
      { profileVector, now },
    );

    expect(scored[0]!.itemId).toBe("high-rel");
    expect(scored[0]!.components.relevance).toBeGreaterThan(0.9);
    expect(scored[1]!.components.relevance).toBe(0);
  });

  it("наводка без первоисточника получает штраф и уступает атрибутированной (§5.3)", () => {
    const now = new Date("2026-08-20T12:00:00Z");
    const base = {
      storyId: "s1",
      trustScore: 0.8,
      publishedAt: new Date("2026-08-20T10:00:00Z"),
      itemCount: 2,
      sourceDiversity: 2,
    };

    const scored = scoreBatch(
      [
        { ...base, itemId: "unresolved", externalSignals: { no_primary_source: 1 } },
        { ...base, itemId: "attributed", storyId: "s2" },
      ],
      120,
      DEFAULT_STAGE1_WEIGHTS,
      { now },
    );

    const unresolved = scored.find((s) => s.itemId === "unresolved")!;
    const attributed = scored.find((s) => s.itemId === "attributed")!;

    // Всё кроме флага одинаково, поэтому разница — ровно множитель штрафа
    expect(attributed.components.primarySourcePenalty).toBe(1);
    expect(unresolved.components.primarySourcePenalty).toBe(NO_PRIMARY_SOURCE_PENALTY);
    expect(unresolved.scoreTotal).toBeCloseTo(attributed.scoreTotal * NO_PRIMARY_SOURCE_PENALTY, 4);

    // Кандидат остаётся в пуле, просто ранжируется ниже
    expect(scored[0]!.itemId).toBe("attributed");
    expect(unresolved.scoreTotal).toBeGreaterThan(0);
  });

  it("служебные флаги Resolver'а не считаются внешним сигналом виральности", () => {
    const now = new Date("2026-08-20T12:00:00Z");
    const base = {
      storyId: "s1",
      trustScore: 0.5,
      publishedAt: new Date("2026-08-20T10:00:00Z"),
      itemCount: 1,
      sourceDiversity: 1,
    };

    const [flagged] = scoreBatch(
      [{ ...base, itemId: "flagged", externalSignals: { resolved_primary_source: 1 } }],
      120,
      DEFAULT_STAGE1_WEIGHTS,
      { now },
    );
    const [clean] = scoreBatch([{ ...base, itemId: "clean" }], 120, DEFAULT_STAGE1_WEIGHTS, { now });

    // resolved_primary_source: 1 не должен работать как «1 очко на HN»
    expect(flagged!.components.importance).toBe(clean!.components.importance);
  });
});
