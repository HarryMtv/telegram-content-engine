## Why

An autonomous system is required to continuously aggregate tech materials from heterogeneous sources (RSS, APIs, Telegram channels), deduplicate and semantically cluster them, rank them against a specific channel's editorial profile, generate fact-checked post drafts, and deliver them to the owner via Telegram for final review — with publication occurring exclusively upon explicit human approval.

Full specification: `docs/telegram-content-engine-spec.md` (v1.0), built across milestones M1–M5 (§14).

## What Changes

- **Core Application** (TypeScript / Node 22): multi-process repository with distinct services: `api`, `scheduler`, `worker-light`, `worker-mtproto`, `worker-agents` (isolated containers in Coolify / Docker).
- **Supabase Database** (Postgres 16+, pgvector): schema covering channels, profiles, sources, items, stories, candidates, fact sheets, drafts, decisions, posts, metrics, submissions, and observability.
- **pg-boss Distributed Queue** on the same Postgres instance; all periodic and LLM stages execute as idempotent background jobs.
- **Ingestion Source Adapters**: `rss`, `hn_algolia`, `reddit_json`, `hf_daily_papers`, `github_trending`, `search`, `telegram` (MTProto), `manual`; two-phase discover/fetch contract; health status tracking and watermark cursors.
- **Pipeline**: normalization $\to$ 3-layer identity (hash $\to$ canonical URL $\to$ embeddings/Story) $\to$ 4-stage scoring funnel $\to$ FactSheet $\to$ FactCheck $\to$ Draft.
- **Editorial Bot**: daily top-5 candidate batches with inline buttons, rejection taxonomy, edit diff tracking, and channel publication.
- **Manual Ingest**: accepts bare links, text thoughts, forwards, attachments; HTTP `/ingest` API for batch imports with immediate deduplication feedback.
- **Metrics**: MTProto post metric snapshots (+1h/+6h/+24h/+72h) for views, forwards, and emoji reactions.
- **Continuous Learning**: dynamic `source_trust`, versioned channel profiles, few-shot generation from top posts.
- **Autonomous Agents** (M4): pure MCP tools layer with Resolver, Scout, and Analyst agents bounded by step, token, and cost limits.
- **Budget Control**: real-time logging of every LLM call, 80% spending warning, and automated stage 3 cutoff at $10/mo.
- **Shadow Mode & Autopublish** (M5): agreement percentage tracking over 14 days and emergency kill switch.

## Capabilities

### Capabilities Implemented
- `pipeline-core`: infrastructure — database schema, pg-boss queue, processes, health checks, Supabase pooler connection rules, retention cleanup.
- `source-adapters`: two-phase discover/fetch contract, watermark cursors, health state machines, adapter suite, text extraction ladder.
- `content-identity`: normalization to RawItem, URL canonicalization, 3-layer deduplication, multilingual embeddings, Story clustering.
- `scoring-funnel`: 4-stage curation funnel, transparent score components, MMR batch diversification, daily caps, virality signals.
- `content-generation`: two-stage FactSheet $\to$ Draft pipeline, fact-check verification, post formats, lazy variants, tiered model strategy.
- `editorial-bot`: Telegram bot batch interface, editorial actions, rejection taxonomy, edit distance diffs, channel publication.
- `manual-ingest`: intake for owner and contributors via bot and HTTP `/ingest`, priority decoupling, instant feedback, contributor reputation.
- `metrics-and-learning`: metric snapshots, reaction classification, dynamic `source_trust`, versioned constitutions, few-shot prompt injection.
- `agents`: MCP tools layer, Scout/Resolver/Analyst agents, output contracts, cost caps and traces, zero publication privileges.
- `budget-control`: per-call LLM auditing, monthly $10 cap, proactive alerts, Stage 3 auto-stop.
- `autopublish`: shadow mode, agreement measurement, activation constraints, emergency kill switch.

## Impact

- **Code**: modular codebase structured into `api`, `scheduler`, `worker-light`, `worker-mtproto`, `worker-agents` with shared domain libraries.
- **Dependencies**: grammY, GramJS (MTProto), Zod, Kysely, pg-boss, pgvector, Cohere, DeepSeek HTTP client, Readability.
- **Infrastructure**: Supabase Cloud (Frankfurt), Telegram Bot API, MTProto session storage, DeepSeek Platform, Coolify VPS.
- **Budget**: strict $10/month LLM spending cap enforced at the client layer.
