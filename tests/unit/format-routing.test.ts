import { describe, expect, it } from "vitest";
import { routeCandidateByFormat, type PostFormatConfig } from "../../src/pipeline/format-routing.js";

describe("Format Routing & Daily Cap (Task 2.11)", () => {
  const slowFormat: PostFormatConfig = {
    id: "fmt-1",
    channelId: "ch-1",
    slug: "digest",
    lane: "slow",
    promptTemplate: "",
    targetLength: 1024,
    freshnessHalfLifeHours: 120,
    cadence: { cron: "5 10 * * *" },
    dailyCap: 5,
  };

  const fastFormat: PostFormatConfig = {
    id: "fmt-2",
    channelId: "ch-1",
    slug: "breaking",
    lane: "fast",
    promptTemplate: "",
    targetLength: 500,
    freshnessHalfLifeHours: 6,
    cadence: {},
    dailyCap: 5,
  };

  it("маршрутизирует slow-формат в дневной батч", () => {
    const res = routeCandidateByFormat({ priority: "normal" }, slowFormat, 1);
    expect(res.route).toBe("scheduled_batch");
    expect(res.allowed).toBe(true);
  });

  it("маршрутизирует fast lane и high priority точечным уведомлением breaking", () => {
    const resFast = routeCandidateByFormat({ priority: "normal" }, fastFormat, 1);
    expect(resFast.route).toBe("immediate_breaking");
    expect(resFast.allowed).toBe(true);

    const resHigh = routeCandidateByFormat({ priority: "high" }, slowFormat, 1);
    expect(resHigh.route).toBe("immediate_breaking");
    expect(resHigh.allowed).toBe(true);
  });

  it("блокирует генерацию/публикацию при исчерпании daily_cap", () => {
    const res = routeCandidateByFormat({ priority: "normal" }, slowFormat, 5);
    expect(res.route).toBe("cap_reached");
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain("Суточный лимит постов (5) исчерпан");
  });
});
