import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { redditJsonAdapter } from "../../src/sources/adapters/reddit-json.js";
import { hfDailyPapersAdapter } from "../../src/sources/adapters/hf-daily-papers.js";
import { githubTrendingAdapter } from "../../src/sources/adapters/github-trending.js";
import { getAdapter } from "../../src/sources/registry.js";

describe("M2 Source Adapters (Task 2.18)", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("адаптеры reddit_json, hf_daily_papers, github_trending зарегистрированы в реестре", () => {
    expect(getAdapter("reddit_json")).toBeDefined();
    expect(getAdapter("hf_daily_papers")).toBeDefined();
    expect(getAdapter("github_trending")).toBeDefined();
  });

  it("reddit_json: парсит горячие посты и фильтрует по порогу ups", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          children: [
            {
              data: {
                id: "post1",
                title: "New LoRA technique",
                url: "https://example.com/lora",
                created_utc: 1724500000,
                ups: 150,
                num_comments: 42,
                is_self: false,
                author: "user1",
              },
            },
            {
              data: {
                id: "post2",
                title: "Low upvote post",
                url: "https://example.com/low",
                created_utc: 1724500000,
                ups: 5, // Ниже порога 50
                num_comments: 1,
                is_self: false,
                author: "user2",
              },
            },
          ],
        },
      }),
    })) as any;

    const result = await redditJsonAdapter.discover({
      sourceId: "src-reddit",
      config: { key: "reddit-ml", threshold: 50, subreddit: "MachineLearning" },
      cursor: null,
    });

    expect(result.refs).toHaveLength(1);
    expect(result.refs[0]!.externalId).toBe("t3_post1");
    expect(result.refs[0]!.title).toBe("New LoRA technique");
    expect(result.refs[0]!.externalSignals).toEqual({ ups: 150, num_comments: 42 });
  });

  it("hf_daily_papers: парсит список статей HuggingFace", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => [
        {
          paper: {
            id: "2408.12345",
            title: "Scaling Laws for Reasoning Models",
            summary: "We study reasoning capability...",
            publishedAt: "2026-08-20T10:00:00Z",
            upvotes: 85,
          },
        },
      ],
    })) as any;

    const result = await hfDailyPapersAdapter.discover({
      sourceId: "src-hf",
      config: { key: "hf-papers", threshold: 10 },
      cursor: null,
    });

    expect(result.refs).toHaveLength(1);
    expect(result.refs[0]!.externalId).toBe("2408.12345");
    expect(result.refs[0]!.url).toBe("https://huggingface.co/papers/2408.12345");
    expect(result.refs[0]!.externalSignals?.upvotes).toBe(85);
  });

  it("github_trending: парсит репозитории и сохраняет звёзды в external_signals", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        items: [
          {
            id: 987654,
            full_name: "vllm-project/vllm",
            html_url: "https://github.com/vllm-project/vllm",
            description: "High-throughput LLM serving engine",
            created_at: "2026-08-01T00:00:00Z",
            stargazers_count: 35000,
            forks_count: 5000,
          },
        ],
      }),
    })) as any;

    const result = await githubTrendingAdapter.discover({
      sourceId: "src-gh",
      config: { key: "gh-ai", threshold: 1000 },
      cursor: null,
    });

    expect(result.refs).toHaveLength(1);
    expect(result.refs[0]!.externalId).toBe("987654");
    expect(result.refs[0]!.title).toContain("vllm-project/vllm");
    expect(result.refs[0]!.externalSignals?.stars).toBe(35000);
  });
});
