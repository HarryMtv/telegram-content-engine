# Specification: Telegram Content Engine

**Version 1.0 · Multichannel Autonomous Content System with Human-in-the-Loop**

---

## 1. Overview

### 1.1. Purpose

An enterprise-grade system that autonomously aggregates technical materials across diverse sources, normalizes them, performs semantic deduplication, ranks them for specific target channels, generates fact-checked drafts in the target language, and presents them to the channel owner for approval via Telegram. Content is published **exclusively upon explicit human confirmation**.

Over time, the system continuously learns from editorial decisions, text edit diffs, and channel engagement metrics to improve curation accuracy and writing style.

### 1.2. Key Architectural Principles

1. **Human-in-the-Loop by Default:** Zero content is broadcast without human review. Automated publishing is an earned privilege activated only after demonstrated high agreement over extended periods (see §14).
2. **Deterministic Core:** The curation and scoring pipeline is deterministic code. LLMs are invoked selectively for structured tasks. Autonomous agents operate on the perimeter, not as sequential pipeline steps (see §11).
3. **Single Intake Pathway:** Ingestion from background adapters, owner submissions, and audience suggestions traverses an identical normalization and scoring funnel.
4. **Multichannel Schema from Day 1:** The database schema natively models $N$ channels with independent profiles and bot tokens.
5. **Full Traceability:** Every score is decomposed into transparent components, and every decision retains audit traces.

### 1.3. Non-Goals (v1)

- Multi-tenancy and third-party billing isolation.
- Web dashboard UI (Telegram is the sole interface).
- Complex headless browser scrapers (replaced by fallback reader APIs and manual paste prompts).
- Automatic publishing prior to Phase M5.
- Multi-platform publishing beyond Telegram.

### 1.4. Target Channel Profile

- **Domain:** Artificial Intelligence, Machine Learning, Systems Engineering, IT Trends.
- **Publication Language:** Russian (`ru`).
- **Source Languages:** Primarily English (`en`), partially Russian (`ru`).
- **Positioning:** Curation depth, technical accuracy, and direct access to primary English sources rather than speed races.

---

## 2. Roles & Permissions

| Role | Entity | Capabilities |
| :--- | :--- | :--- |
| `owner` | Channel Owner / Editor | Full access: channel config, draft approvals, manual ingest, scoring overrides, kill switch. |
| `contributor` | Channel Subscriber / Reader | Suggestions via bot submission flow, submission status tracking. |

*Background workers and autonomous agents have zero publication privileges across all modes.*

---

## 3. Architecture & Infrastructure

### 3.1. Infrastructure Topology

- **Application:** Self-hosted on VPS via Coolify / Docker Compose.
- **Database:** Supabase Cloud (PostgreSQL 16 with `pgvector` 1024d, Frankfurt region).
- **Queue:** `pg-boss` v10 on the same PostgreSQL database.
- **Runtime:** TypeScript, Node.js 22 (ESM).
- **Key Libraries:** grammY (Bot API), GramJS (MTProto), Zod, Kysely (SQL builder), pg-boss.

### 3.2. Microservice Processes

| Process | Startup Entry Point | Purpose | Replicas |
| :--- | :--- | :--- | :--- |
| `api` | `src/process/api.ts` | Fastify HTTP server (`/health`, `/ingest`), Telegram Bot handler. | 1 |
| `scheduler` | `src/process/scheduler.ts` | 1-minute source polling ticks, daily batch schedules. | 1 |
| `worker-light` | `src/process/worker-light.ts` | Ingest, article extraction, embeddings, scoring, draft synthesis. | 1–2 |
| `worker-mtproto`| `src/process/worker-mtproto.ts`| GramJS Telegram channel reader and metric snapshot collector. | **Strictly 1** |
| `worker-agents` | `src/process/worker-agents.ts` | Sandboxed runtime for Resolver, Scout, and Analyst agents. | 1 |

### 3.3. Supabase Connection Architecture

- **Transaction Pooler (Port 6543):** Application processes connect via Supabase Transaction Pooler with $\le 5$ connections per process.
- **pg-boss v10 Active Polling:** Queue operates via active polling (no `LISTEN/NOTIFY`), ensuring 100% pooler compatibility.
- **Batched Ingestion:** Crawlers execute bulk multi-row inserts (100–500 rows per query).
- **Service Role Access:** Authenticates using `service_role` without RLS overhead.
- **MTProto Session Persistence:** GramJS session files reside on a mounted persistent volume.

### 3.4. 90-Day Vector Retention Policy

Embeddings are retained for items younger than **90 days**. Older items have their `embedding` column set to `NULL` while retaining URL hashes, content hashes, and Story metadata. Weekly cleanup job maintains database footprint.

---

## 4. Data Model Schema

### 4.1. Channels & Configuration

```sql
CREATE TABLE channels (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text UNIQUE NOT NULL,
  tg_chat_id      bigint,
  tg_bot_token    text,
  title           text NOT NULL,
  target_lang     text NOT NULL DEFAULT 'ru',
  source_langs    text[] NOT NULL DEFAULT '{"en","ru"}',
  status          text NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE channel_profiles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      uuid NOT NULL REFERENCES channels(id),
  version         int NOT NULL DEFAULT 1,
  manifesto       text NOT NULL,
  selection_rules text NOT NULL,
  style_guide     text NOT NULL,
  taboos          text[] NOT NULL DEFAULT '{}',
  profile_vector  vector(1024),
  score_weights   jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text NOT NULL DEFAULT 'owner',
  changelog       text
);

CREATE TABLE post_formats (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      uuid NOT NULL REFERENCES channels(id),
  slug            text NOT NULL,
  lane            text NOT NULL DEFAULT 'slow', -- fast | slow
  prompt_template text NOT NULL,
  target_length   int NOT NULL DEFAULT 600,
  freshness_half_life_hours int NOT NULL DEFAULT 120,
  cadence         jsonb,
  daily_cap       int NOT NULL DEFAULT 5
);
```

### 4.2. Ingestion Sources & Cursors

```sql
CREATE TABLE sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type            text NOT NULL, -- rss | api | search | telegram | manual
  adapter         text NOT NULL,
  config          jsonb NOT NULL DEFAULT '{}',
  channel_ids     uuid[],
  poll_interval_s int NOT NULL DEFAULT 3600,
  cursor          jsonb NOT NULL DEFAULT '{}',
  trust_score     numeric NOT NULL DEFAULT 0.5,
  status          text NOT NULL DEFAULT 'healthy',
  error_count     int NOT NULL DEFAULT 0,
  last_ok_at      timestamptz,
  last_error      text,
  last_error_at   timestamptz
);

CREATE TABLE source_stats (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid NOT NULL REFERENCES sources(id),
  window_start    date NOT NULL,
  items_found     int NOT NULL DEFAULT 0,
  items_approved  int NOT NULL DEFAULT 0,
  items_rejected  int NOT NULL DEFAULT 0,
  avg_edit_distance numeric,
  avg_post_err    numeric
);
```

### 4.3. Raw Items & Semantic Stories

```sql
CREATE TABLE items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid NOT NULL REFERENCES sources(id),
  external_id     text,
  canonical_url   text NOT NULL,
  url_hash        text NOT NULL,
  content_hash    text NOT NULL,
  title           text NOT NULL,
  body_text       text NOT NULL,
  lang            text NOT NULL,
  author          text,
  published_at    timestamptz,
  discovered_at   timestamptz NOT NULL DEFAULT now(),
  external_signals jsonb NOT NULL DEFAULT '{}',
  embedding       vector(1024),
  raw_payload     jsonb NOT NULL DEFAULT '{}',
  story_id        uuid,
  fetch_status    text NOT NULL DEFAULT 'pending'
);

CREATE TABLE stories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  centroid        vector(1024),
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  item_count      int NOT NULL DEFAULT 1,
  source_diversity int NOT NULL DEFAULT 1,
  velocity        numeric NOT NULL DEFAULT 0,
  peak_external_signal numeric NOT NULL DEFAULT 0
);
```

### 4.4. Candidates, FactSheets, Drafts & Decisions

```sql
CREATE TABLE channel_candidates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      uuid NOT NULL REFERENCES channels(id),
  story_id        uuid NOT NULL REFERENCES stories(id),
  format_id       uuid REFERENCES post_formats(id),
  profile_version int NOT NULL,
  score_total     numeric NOT NULL DEFAULT 0,
  score_components jsonb NOT NULL DEFAULT '{}',
  triage_reason   text,
  stage           int NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'pool',
  priority        text NOT NULL DEFAULT 'normal',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fact_sheets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id        uuid NOT NULL REFERENCES stories(id),
  what_happened   text NOT NULL,
  who             text[] NOT NULL DEFAULT '{}',
  numbers         jsonb NOT NULL DEFAULT '{}',
  key_quote       text,
  why_it_matters  text NOT NULL,
  primary_url     text NOT NULL,
  confidence      numeric NOT NULL DEFAULT 1.0,
  source_item_ids uuid[] NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE drafts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id    uuid NOT NULL REFERENCES channel_candidates(id),
  fact_sheet_id   uuid NOT NULL REFERENCES fact_sheets(id),
  variant_n       int NOT NULL DEFAULT 1,
  model           text NOT NULL,
  profile_version int NOT NULL,
  format_id       uuid REFERENCES post_formats(id),
  text            text NOT NULL,
  lang            text NOT NULL DEFAULT 'ru',
  cost_usd        numeric NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE editorial_decisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id        uuid NOT NULL REFERENCES drafts(id),
  action          text NOT NULL, -- publish | reject | regenerate | defer
  reject_reason   text,
  edited_text     text,
  edit_distance   numeric,
  forced          boolean NOT NULL DEFAULT false,
  decided_at      timestamptz NOT NULL DEFAULT now(),
  latency_s       int
);

CREATE TABLE posts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      uuid NOT NULL REFERENCES channels(id),
  draft_id        uuid NOT NULL REFERENCES drafts(id),
  tg_message_id   bigint,
  final_text      text NOT NULL,
  published_at    timestamptz NOT NULL DEFAULT now(),
  subscribers_at_publish int NOT NULL DEFAULT 0,
  autopublished   boolean NOT NULL DEFAULT false
);

CREATE TABLE metric_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id         uuid NOT NULL REFERENCES posts(id),
  captured_at     timestamptz NOT NULL DEFAULT now(),
  offset_hours    int NOT NULL, -- 1 | 6 | 24 | 72
  views           int NOT NULL DEFAULT 0,
  forwards        int NOT NULL DEFAULT 0,
  reactions       jsonb NOT NULL DEFAULT '{}',
  err             numeric NOT NULL DEFAULT 0
);
```

### 4.5. Ingest Submissions & Contributors

```sql
CREATE TABLE submissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submitted_by    bigint NOT NULL,
  role            text NOT NULL DEFAULT 'contributor',
  payload_type    text NOT NULL, -- url | text | forward | file
  raw             text NOT NULL,
  channel_hint    uuid REFERENCES channels(id),
  priority        text NOT NULL DEFAULT 'normal',
  status          text NOT NULL DEFAULT 'received',
  item_id         uuid REFERENCES items(id),
  feedback_sent   boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contributors (
  tg_user_id      bigint PRIMARY KEY,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  submissions_total int NOT NULL DEFAULT 0,
  submissions_published int NOT NULL DEFAULT 0,
  reputation      numeric NOT NULL DEFAULT 0.5,
  banned          boolean NOT NULL DEFAULT false
);
```

### 4.6. Observability & Agent Runs

```sql
CREATE TABLE llm_calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage           text NOT NULL,
  channel_id      uuid REFERENCES channels(id),
  model           text NOT NULL,
  input_tokens    int NOT NULL DEFAULT 0,
  output_tokens   int NOT NULL DEFAULT 0,
  cost_usd        numeric NOT NULL DEFAULT 0,
  latency_ms      int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent           text NOT NULL,
  idempotency_key text UNIQUE NOT NULL,
  input           jsonb NOT NULL DEFAULT '{}',
  trace           jsonb NOT NULL DEFAULT '[]',
  output          jsonb,
  steps           int NOT NULL DEFAULT 0,
  cost_usd        numeric NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'ok',
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

---

## 5. Ingestion Adapters

### 5.1. Two-Phase Contract

```ts
interface SourceAdapter {
  type: string;
  discover(source: Source): Promise<ItemRef[]>; // Inexpensive discovery
  fetch(ref: ItemRef): Promise<RawItem>;        // Selective full-text extraction
}
```

Discovery extracts lightweight headers without loading full payloads. Full-text extraction runs only for candidates passing Stage 0 filters, saving bandwidth and processing time.

### 5.2. Core Adapters

1. `hf_daily_papers`: Curated ArXiv AI papers, author metadata, community upvotes.
2. `github_trending`: High star velocity repositories with descriptions and language breakdown.
3. `hn_algolia`: HackerNews Front Page filtered by point threshold.
4. `reddit_json`: Technical subreddits (`r/LocalLLaMA`, `r/MachineLearning`).
5. `rss`: RSS/Atom feeds for research blogs and technology media.
6. `telegram`: MTProto read-only monitoring of Telegram channels.
7. `manual`: Direct user submission handling (links, forwards, notes, files).

### 5.3. Primary Source Rule for Telegram Leads

External Telegram posts serve as **leads, not direct content**. The Resolver agent identifies the original primary source, searching both ingested material and the open web (§11). Resolution is triggered by manual ingest whenever a forwarded post carries no URL of its own. If unresolved after $N$ attempts, candidates are retained with `no_primary_source` and a score penalty applied to the stage 1 total (§7). Direct uncredited paraphrasing is prohibited.

### 5.4. Text Extraction Fallback Ladder

1. Direct HTTP fetch + Mozilla Readability (~80% success).
2. Fallback to Reader APIs (Jina Reader / Firecrawl free tier).
3. If paywalled, set `fetch_status = manual_needed` and prompt the owner via Telegram bot for copy-pasted text.

---

## 6. Processing Pipeline & Identity

### 6.1. URL Canonicalization

Strips tracking query parameters (`utm_*`, `fbclid`), resolves redirection hops, unshortens link services, resolves AMP versions to canonical desktop pages, and normalizes hostnames.

### 6.2. 3-Layer Identity & Deduplication

1. **Layer 1 (`content_hash`):** Exact binary text deduplication.
2. **Layer 2 (`url_hash`):** Canonical URL hash deduplication.
3. **Layer 3 (Story Clustering):** Cosine similarity over multilingual embeddings (`embed-multilingual-v3.0`, 1024d) grouping cross-lingual articles into unified `Stories`.

---

## 7. 4-Stage Scoring Funnel

- **Stage 0 (Zero-Cost Filters):** Language validation, format age cutoffs, blacklisted domains, already-published Stories.
- **Stage 1 (Numerical Scoring):** Relevance to `profile_vector`, `source_trust`, exponential `freshness` decay, and `importance` derived from cluster dynamics.
- **Stage 2 (LLM Triage):** Batch evaluation by cheap model (`deepseek-v4-flash`) against `selection_rules`, returning structured relevance, novelty, and reasons.
- **MMR Batch Diversification:** Maximal Marginal Relevance penalty suppresses duplicate topics in top-5 candidate batches.
- **Stage 3 (Draft Generation):** Generates `FactSheet`, executes `FactCheck`, and synthesizes final `Draft`.

---

## 8. Content Generation & Fact Checking

1. **Two-Stage Generation:** `Item` $\to$ Language-agnostic `FactSheet` $\to$ Target-language `Draft`.
2. **FactCheck Verification:** Independent verification call compares `FactSheet` assertions with raw extracted text. Discrepancies reduce confidence and flag warning indicators.
3. **Mandatory Attribution:** Every published post contains an explicit link to the original primary source.
4. **Tiered Model Strategy:**
   - `cheap` (`deepseek-v4-flash`): Triage, FactSheet, FactCheck, initial drafts.
   - `strong` (`deepseek-v4-pro` in **Thinking Mode**): High-quality stylistic rewriting on-demand via bot button.

---

## 9. Manual Ingest & Contributor Loop

- **Zero-Command Bot Intake:** Automatically identifies bare URLs, multiline link lists, forwards, text notes, and attached `.txt`/`.md` files.
- **HTTP `/ingest` API:** Authenticated batch ingestion endpoint returning per-item deduplication status.
- **Instantaneous Feedback:** Real-time feedback in Telegram ("Already published N days ago", "Duplicate of Story X").
- **Ingest-to-RSS Detector:** Prompts to create automated RSS sources when 3+ manual links originate from the same domain.

---

## 10. Telegram Editorial Bot Interface

### 6 Core Editorial Actions:
- 🚀 **Publish:** Broadcasts draft immediately to the target channel.
- ✏️ **Edit & Publish:** Editor replies with modifications $\to$ bot computes `edit_distance` and publishes updated version.
- ⚡ **Rewrite Better:** Calls `deepseek-v4-pro` in **Thinking Mode** on the existing FactSheet.
- 🔄 **Another Variant:** Generates variant $N+1$.
- ❌ **Reject:** Prompts for reason from 7-point taxonomy (updates source trust, weights, or style guide).
- ⏳ **Defer:** Retains story in candidate pool with downgraded priority.

---

## 11. Autonomous Agents & MCP Layer

1. **Resolver Agent:** Multi-step exploration discovering primary sources behind Telegram forwards.
2. **Scout Agent:** Autonomous trend discovery for emerging unrepresented topics.
3. **Analyst Agent:** Weekly analysis of decisions, diffs, and metrics proposing versioned profile amendments.
4. **Web Search Tool:** Resolver and Scout additionally reach outside the database through a `web_search` tool behind a provider interface (Tavily / Brave, selected by `SEARCH_PROVIDER`). Without it Resolver can only match a lead against material already ingested, which cannot discover a primary source the system has never seen. The tool is read-only, is offered to agents only when a provider key is configured, and its calls are bounded by the agent's step and timeout caps and recorded in the `agent_runs` trace.
5. **Strict Guardrails:** All agents have **zero publication permissions**, return Zod-validated outputs, and operate under strict token, timeout, and cost ceilings.

---

## 12. Metrics & Closed-Loop Learning

- **Time Series Snapshots:** Captures views, forwards, emoji reactions (🔥/👍/😴), and ERR at +1h, +6h, +24h, and +72h offsets.
- **Metric Feedback Guard:** Reactions are recorded from Day 1 but isolated from algorithmic scoring adjustments until the channel reaches $\ge 200$ published posts.
- **Dynamic Source Trust:** Rolling adjustment of source reliability scores based on approval ratios and post ERR.

---

## 13. Budget Governance ($10/mo Cap)

- **Synchronous Auditing:** Every LLM call records tokens and USD cost in `llm_calls`.
- **Proactive Alerting:** Owner receives a Telegram alert upon reaching 80% ($8.00) of monthly budget.
- **Automated Stage 3 Cutoff:** Reaching 100% ($10.00) automatically pauses Stage 3 generation while zero-cost ingestion continues.

---

## 14. Milestones & Operational Verification Gates

- **M1:** Pipeline Skeleton — DB schema, pg-boss, `rss`+`hn_algolia`, template drafts, Telegram bot delivery.
- **M2:** Full Curation & Generation — Embeddings, Story clustering, 4-stage funnel, FactSheet, rejection taxonomy, `source_trust`.
- **M3:** Ingest & Metrics — Submissions, HTTP `/ingest`, MTProto worker, metric snapshots, cost tracking.
- **M4:** Autonomous Agents — MCP tools layer, Resolver, Scout, Analyst agents.
- **M5:** Multi-channel & Autopublish — Shadow mode agreement tracking ($\ge 85\%$ over 14 days), emergency kill switch.

---

## 15. Cold Start Strategy

During initial launch (0 subscribers):
1. Rely on external virality proxies (HackerNews points, GitHub star growth velocity).
2. Human-in-the-loop manual review ensures high curation density.
3. Metric feedback loop activates once initial subscriber and reaction benchmarks are achieved.

---

## 16. Calibration & Observability

- Offline clustering recomputation tool for cosine threshold calibration.
- Full trace inspection in `agent_runs` and `llm_calls`.
- Health check endpoints on all 5 microservices monitored by Coolify orchestrator.
