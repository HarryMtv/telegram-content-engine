import type { AdapterContext, DiscoverResult, FetchTarget, FetchedContent, SourceAdapter } from "../types.js";
import { ItemRef } from "../../domain/schemas.js";

interface GithubRepo {
  id: number;
  full_name: string;
  html_url: string;
  description: string | null;
  created_at: string;
  stargazers_count: number;
  forks_count: number;
  owner?: { login: string };
}

export const githubTrendingAdapter: SourceAdapter = {
  type: "github",
  adapter: "github_trending",

  async discover(ctx: AdapterContext): Promise<DiscoverResult> {
    const rawConfig = ctx.config as Record<string, unknown>;
    const query = String(rawConfig.query || "topic:llm+topic:ai").replace(/\s+/g, "+");
    const threshold = Number(ctx.config.threshold ?? 50);

    const url =
      ctx.config.url ||
      `https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=20`;

    const res = await (ctx.fetchLike ?? fetch)(url, {
      headers: {
        "User-Agent": "telegram-content-engine/1.0",
        Accept: "application/vnd.github.v3+json",
      },
    });

    if (!res.ok) {
      throw new Error(`GitHub Search HTTP ${res.status}: ${res.statusText}`);
    }

    const data = (await res.json()) as { items: GithubRepo[] };

    const refs = [];
    for (const repo of data.items || []) {
      if (repo.stargazers_count < threshold) continue;

      refs.push(
        ItemRef.parse({
          externalId: String(repo.id),
          url: repo.html_url,
          title: `${repo.full_name}: ${repo.description || "GitHub Repository"}`,
          publishedAt: new Date(repo.created_at),
          snippet: repo.description ? repo.description.slice(0, 500) : undefined,
          externalSignals: {
            stars: repo.stargazers_count,
            forks: repo.forks_count,
          },
        }),
      );
    }

    return { refs, cursor: ctx.cursor ?? {} };
  },

  async fetch(target: FetchTarget): Promise<FetchedContent> {
    return {
      bodyText: target.title,
    };
  },
};
