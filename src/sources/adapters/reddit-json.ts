import type { AdapterContext, DiscoverResult, FetchTarget, FetchedContent, SourceAdapter } from "../types.js";
import { extractArticle } from "../extract.js";
import { ItemRef } from "../../domain/schemas.js";

interface RedditPostData {
  id: string;
  title: string;
  url: string;
  selftext?: string;
  created_utc: number;
  ups: number;
  num_comments: number;
  is_self: boolean;
  author: string;
}

export const redditJsonAdapter: SourceAdapter = {
  type: "reddit",
  adapter: "reddit_json",

  async discover(ctx: AdapterContext): Promise<DiscoverResult> {
    const rawConfig = ctx.config as Record<string, unknown>;
    const subreddit = String(rawConfig.subreddit || "MachineLearning").replace(/^r\//, "");
    const threshold = Number(ctx.config.threshold ?? 50);

    const url = ctx.config.url || `https://www.reddit.com/r/${subreddit}/hot.json?limit=25`;

    const res = await (ctx.fetchLike ?? fetch)(url, {
      headers: {
        "User-Agent": "telegram-content-engine/1.0 (by /u/bot)",
      },
    });

    if (!res.ok) {
      throw new Error(`Reddit JSON HTTP ${res.status}: ${res.statusText}`);
    }

    const data = (await res.json()) as {
      data: { children: Array<{ data: RedditPostData }> };
    };

    const refs = [];
    for (const child of data.data.children) {
      const p = child.data;
      if (p.ups < threshold) continue;

      refs.push(
        ItemRef.parse({
          externalId: `t3_${p.id}`,
          url: p.is_self ? `https://reddit.com/r/${subreddit}/comments/${p.id}` : p.url,
          title: p.title,
          publishedAt: new Date(p.created_utc * 1000),
          snippet: p.selftext ? p.selftext.slice(0, 500) : undefined,
          externalSignals: {
            ups: p.ups,
            num_comments: p.num_comments,
          },
        }),
      );
    }

    return { refs, cursor: ctx.cursor ?? {} };
  },

  async fetch(target: FetchTarget, fetchLike = fetch): Promise<FetchedContent> {
    if (target.url.includes("reddit.com/r/")) {
      return {
        bodyText: target.title,
      };
    }
    const bodyText = await extractArticle(target.url, fetchLike);
    return { bodyText };
  },
};
