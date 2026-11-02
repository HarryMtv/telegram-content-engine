import type { AdapterContext, DiscoverResult, FetchTarget, FetchedContent, SourceAdapter } from "../types.js";
import { ItemRef } from "../../domain/schemas.js";

interface HfPaper {
  paper: {
    id: string;
    title: string;
    summary?: string;
    publishedAt?: string;
    upvotes?: number;
    authors?: Array<{ name: string }>;
  };
}

export const hfDailyPapersAdapter: SourceAdapter = {
  type: "huggingface",
  adapter: "hf_daily_papers",

  async discover(ctx: AdapterContext): Promise<DiscoverResult> {
    const url = ctx.config.url || "https://huggingface.co/api/daily_papers";

    const res = await (ctx.fetchLike ?? fetch)(url, {
      headers: {
        "User-Agent": "telegram-content-engine/1.0",
      },
    });

    if (!res.ok) {
      throw new Error(`HuggingFace Daily Papers HTTP ${res.status}: ${res.statusText}`);
    }

    const list = (await res.json()) as HfPaper[];
    const threshold = Number(ctx.config.threshold ?? 0);

    const refs = [];
    for (const item of list) {
      const p = item.paper;
      const upvotes = p.upvotes ?? 0;
      if (upvotes < threshold) continue;

      refs.push(
        ItemRef.parse({
          externalId: p.id,
          url: `https://huggingface.co/papers/${p.id}`,
          title: p.title,
          publishedAt: p.publishedAt ? new Date(p.publishedAt) : new Date(),
          snippet: p.summary ? p.summary.slice(0, 500) : undefined,
          externalSignals: {
            upvotes,
          },
        }),
      );
    }

    return { refs, cursor: ctx.cursor ?? {} };
  },

  async fetch(target: FetchTarget, fetchLike = fetch): Promise<FetchedContent> {
    const paperId = target.externalId;
    const url = `https://huggingface.co/api/papers/${paperId}`;

    try {
      const res = await fetchLike(url, {
        headers: { "User-Agent": "telegram-content-engine/1.0" },
      });
      if (res.ok) {
        const data = (await res.json()) as { summary?: string; authors?: Array<{ name: string }> };
        const author = data.authors?.map((a) => a.name).join(", ");
        return author
          ? { bodyText: data.summary || target.title, author }
          : { bodyText: data.summary || target.title };
      }
    } catch {
      // fallback
    }

    return {
      bodyText: target.title,
    };
  },
};
