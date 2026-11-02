## Context

Greenfield codebase implementation following the full architecture specification (`docs/telegram-content-engine-spec.md`). Core external constraints: Supabase Cloud Frankfurt (PostgreSQL 16+, pgvector, transaction pooler), Coolify VPS deployment, strict $10/month LLM spending cap, and a single editorial user interface via Telegram Bot. The specification defines milestones M1–M5 with verifiable readiness criteria; the architectural design ensures each milestone deploys smoothly into production without requiring refactors of previous stages.

## Goals / Non-Goals

**Goals:**
- Single package architecture where `api`, `scheduler`, `worker-light`, `worker-mtproto`, and `worker-agents` operate as distinct runtime entrypoints of the same compiled application.
- Unified ingestion pipeline where M1 runs without LLM/embeddings, while M2/M3/M4 iteratively introduce advanced stages without breaking `items`/`stories`/`candidates` contracts.
- Inherent budget discipline (token and USD cost tracking in `llm_calls` embedded directly within the LLM client layer).
- Full idempotency across all background jobs — safe retries and deduplication on repeated runs.

**Non-Goals:**
- Multi-tenancy, web dashboard UI, headless browser rendering, or unconstrained autopublication prior to M5.
- Speculative optimizations (self-hosted embedding models or premature microservices) unless proven necessary by budget or quality constraints.
- Heavy agent frameworks (LangChain, CrewAI) or non-Postgres message queues.

## Architecture Decisions

### D1. Single Package, Five Runtime Entrypoints

A single TypeScript package (Node 22, `"type": "module"`) built into a unified Docker image; processes differ solely by their startup command (`node dist/process/api.js`, etc.). In Coolify / Docker Compose, 5 container instances run from the single image with specialized commands.

Codebase layout:
```
src/
  domain/        Zod schemas and domain models (RawItem, Story, Candidate, FactSheet…)
  db/            Kysely database client, pure SQL migrations (db/migrations/NNN_*.sql)
  queue/         pg-boss v10 wrapper and job handler registry
  sources/       Adapters (rss, hn, reddit, hf, github, search, telegram, manual)
  pipeline/      Normalization, canonicalization, deduplication, clustering, scoring funnel
  generation/    FactSheet extraction, fact checking, post draft synthesis
  bot/           grammY: candidate batches, inline keyboards, manual ingest, notifications
  mtproto/       GramJS client (read-only monitoring, persistent session storage)
  agents/        Pure MCP tools, runtime loop, specialized agents (Scout, Resolver, Analyst)
  llm/           Cost-auditing LLM client (persisting records directly to llm_calls)
  process/       Process entrypoints: api.ts, scheduler.ts, worker-light.ts,
                 worker-mtproto.ts, worker-agents.ts
```

### D2. Kysely + Pure SQL Migrations

Database queries are executed via Kysely. Schema migrations are structured as numbered transactional SQL files (`db/migrations/NNN_*.sql`) executed via the `migrate` CLI command. Vector cosine queries and bulk multi-row upserts run directly in pure SQL without ORM type friction.

### D3. Unified Connection via Transaction Pooler

pg-boss v10 operates via active polling (without relying on `LISTEN/NOTIFY`), enabling 100% compatibility with the Supabase Transaction Pooler (port 6543):
- **All processes** (application, queue, migrations) connect via the Supabase Transaction Pooler (`pooler.supabase.com:6543`) with a pool limit $\le 5$ connections per process.
- `DATABASE_URL_DIRECT` is optional and reserved for environments supporting direct IPv6 connectivity.
- Multi-statement transactional migrations (`BEGIN ... COMMIT`) pin sessions cleanly within the pooler.

### D4. Multilingual Embeddings via Cohere API

Multilingual embeddings are mandatory for cross-lingual story deduplication. We use Cohere's `embed-multilingual-v3.0` (1024 dimensions, ~$0.10–0.50/mo across typical ingest volume). The provider is encapsulated behind the `EmbeddingProvider` interface.

### D5. Abstracted LLM Provider with Configurable Pricing

Two distinct model tiers:
- **`cheap`**: `deepseek-v4-flash` (Stage 2 triage, FactSheet extraction, initial drafts, fact checking).
- **`strong`**: `deepseek-v4-pro` in **Thinking Mode** (`thinking: { type: "enabled" }`, `reasoning_effort: "high"`) for deep rewrites and autonomous agents.
Token prices are declared in configuration (`.env`); the LLM client calculates costs and writes audit records to `llm_calls` synchronously before returning results.

### D6. Incremental Story Clustering

New items look up the nearest centroid among active Stories within a 14-day window via pgvector top-1 cosine search. If cosine similarity $\ge 0.82$, the item joins the existing Story and updates its running average centroid and dynamics (`item_count`, `source_diversity`, `velocity`, `peak_external_signal`). If below threshold, a new Story is initialized.

### D7. pg-boss Distributed Queue & Idempotency

The scheduler enqueues cron tasks using `singletonKey` (e.g. `poll-source:<id>`), preventing concurrent duplicate runs. Data layer idempotency is enforced via unique indexes `(source_id, external_id)` and `url_hash`, with content hash deduplication prior to insertion.

### D8. Telegram Bot Architecture (grammY)

The `api` service handles Telegram webhooks and long-polling. Candidate batches render inline keyboards carrying `candidate_id` and action metadata. Short-lived conversational states (editing text, selecting rejection taxonomy) reside in memory with timeouts. Post publication issues `sendMessage` to the target channel ID.

### D9. Dedicated MTProto Worker

GramJS runs in an isolated single-replica worker container with session storage mounted on a persistent volume. Responsibilities: read-only monitoring of external Telegram channels and periodic collection of post metric snapshots (`getMessages` for views, forwards, and emoji reactions).

### D10. Agent Runtime & MCP Layer

Agents are structured as a lightweight TypeScript loop (`while (steps < maxSteps)`) with tool calling and Zod validation. Tool functions (`search_sources`, `check_duplicate`, `get_published_history`, `get_channel_profile`, `submit_item`) execute pure database queries exposed via Model Context Protocol (MCP). Every execution is bounded by step limits, token budgets, wall-clock timeouts, and per-run USD caps.

### D11. LLM Cost Accounting Layer

Invocation costs are computed inside `src/llm/` upon every API call and committed to `llm_calls`. Calendar month spending is tracked against safety thresholds: 80% ($8.00) dispatches a warning notification, and 100% ($10.00) automatically suspends Stage 3 generation.

## Migration & Deployment Plan

Phased progression across milestones M1 $\to$ M5:
1. Apply SQL migrations (`npm run migrate`).
2. Deploy Docker image across container services: database migration $\to$ scheduler $\to$ workers $\to$ api.
3. Validate health endpoints and smoke tests.
