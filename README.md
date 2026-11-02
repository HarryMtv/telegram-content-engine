# 🚀 Telegram Content Engine

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22.x-green.svg)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16%2Bpgvector-336791.svg)](https://github.com/pgvector/pgvector)
[![pg-boss](https://img.shields.io/badge/Queue-pg--boss%20v10-orange.svg)](https://github.com/timgit/pg-boss)

**Telegram Content Engine** is an enterprise-grade, autonomous, multichannel content aggregation, curation, and drafting system with a **Human-in-the-Loop** editorial workflow. 

It continuously monitors primary tech sources (HuggingFace Papers, GitHub Trending, HackerNews, Reddit, RSS feeds, Telegram channels), performs cross-lingual semantic deduplication via `pgvector`, scores relevance against a channel's constitution, extracts verified `FactSheets`, drafts publication-ready posts using DeepSeek models, and delivers daily interactive editorial batches directly to the channel owner's Telegram bot.

---

## 📑 Table of Contents

- [Key Features](#-key-features)
- [System Architecture](#-system-architecture)
- [AI Model Stack](#-ai-model-stack)
- [Content Curation Funnel](#-content-curation-funnel)
- [Interactive Editorial Bot](#-interactive-editorial-bot)
- [Autonomous Agents](#-autonomous-agents)
- [Shadow Mode & Autopublish](#-shadow-mode--autopublish)
- [Getting Started](#-getting-started)
- [Configuration Reference](#-configuration-reference)
- [Docker & Coolify Deployment](#-docker--coolify-deployment)
- [Testing](#-testing)

---

## ✨ Key Features

- 🛡️ **Guaranteed Human-in-the-Loop:** Zero unauthorized publications by default. Every post requires explicit human review and approval.
- 🌐 **Cross-lingual Semantic Clustering:** Multilingual embeddings (Cohere `embed-multilingual-v3.0`, 1024d) group English and Russian articles into cohesive `Stories` using cosine similarity.
- 🎯 **4-Stage Quality Funnel:**
  - **Stage 0:** Hard filters (language, age cutoff, domain blacklist).
  - **Stage 1:** Numerical vector similarity scoring, source trust weight, freshness decay, and virality velocity.
  - **Stage 2:** LLM triage against channel constitution and taboo topics.
  - **Stage 3:** MMR (Maximal Marginal Relevance) diversification and draft synthesis.
- 🔍 **Fact-Checking & Anti-Hallucination:** Independent verification step comparing generated `FactSheets` against raw extracted source text.
- 📊 **MTProto Engagement Metrics:** Automated snapshots at +1h, +6h, +24h, and +72h (views, forwards, emoji reactions 🔥/👍/😴, ERR).
- 🤖 **Specialized Autonomous Agents:** 
  - **Resolver:** Searches for original primary sources behind Telegram leads.
  - **Scout:** Discovers unrepresented emerging trends.
  - **Analyst:** Proposes data-driven channel constitution amendments based on rejection reasons and ERR analytics.
- 💰 **Built-in Cost Auditor:** Real-time token and USD cost tracking in database with a strict monthly safety budget cap ($10/mo).

---

## 🏗️ System Architecture

The engine runs as a single compiled package partitioned into **5 lightweight microservice processes** coordinated via PostgreSQL 16 and `pg-boss`:

```
                           ┌──────────────────────────┐
                           │    Telegram Bot / HTTP    │
                           │   (content-engine-api)   │
                           └────────────┬─────────────┘
                                        │ Fast-Track Ingest
                                        ▼
       ┌──────────────────────────────────────────────────────────────┐
       │                Cloud Supabase (PostgreSQL 16)                │
       │               + pgvector (1024d) + pg-boss v10               │
       └───────▲───────────────────────▲──────────────────────▲───────┘
               │                       │                      │
       ┌───────┴───────────────┐ ┌─────┴────────────────┐ ┌───┴───────────────┐
       │   worker-light        │ │   scheduler (cron)   │ │   worker-agents   │
       │ • Item fetching       │ │ • 1-min poll tick    │ │ • Resolver Agent  │
       │ • Embedding & Stories │ │ • Scheduled batches  │ │ • Scout Agent     │
       │ • Stage 1-3 Funnel    │ └──────────────────────┘ │ • Analyst Agent   │
       │ • Batch generation    │                          └───────────────────┘
       └───────────────────────┘
               │
       ┌───────┴───────────────┐
       │   worker-mtproto      │
       │ • GramJS (read-only)  │
       │ • Metric snapshots    │
       │   (+1h/+6h/+24h/+72h) │
       └───────────────────────┘
```

| Service | Entry Point | Purpose |
| :--- | :--- | :--- |
| **`api`** | `src/process/api.ts` | Fastify HTTP server (`/health`, `/ingest`) and Telegram Bot long-polling/webhook handler. |
| **`worker-light`** | `src/process/worker-light.ts` | Main pipeline executor: URL fetching, Cohere embeddings, story clustering, LLM triage, FactSheet verification, draft synthesis, batch dispatch. |
| **`scheduler`** | `src/process/scheduler.ts` | Periodic cron scheduler: 1-minute source polling ticks and scheduled daily batch triggers. |
| **`worker-mtproto`** | `src/process/worker-mtproto.ts` | Dedicated GramJS worker for reading monitored Telegram channels and collecting engagement metric snapshots. |
| **`worker-agents`** | `src/process/worker-agents.ts` | Sandboxed autonomous agent runtime executing Resolver, Scout, and Analyst agent tasks. |

---

## 🧠 AI Model Stack

| Role | Model | Provider | Mode / Features | Usage |
| :--- | :--- | :--- | :--- | :--- |
| **`cheap`** | **`deepseek-v4-flash`** | DeepSeek API | Standard Completion | High-throughput Stage 2 triage, FactSheet extraction, FactCheck validation, initial post drafts. |
| **`strong`** | **`deepseek-v4-pro`** | DeepSeek API | **Thinking Mode** (`thinking: { type: "enabled" }`, `reasoning_effort: "high"`) | Deep post rewriting (**⚡ Rewrite Better** button), autonomous agent multi-step loops (Resolver, Scout, Analyst). |
| **`embeddings`** | **`embed-multilingual-v3.0`** | Cohere API | 1024d Vector Embeddings | Cross-lingual deduplication, vector similarity search, and incremental Story clustering. |

---

## 📡 Ingestion Adapters (7 Sources)

1. **`hf_daily_papers`** — Hugging Face Daily Papers (authors, abstracts, upvotes, ArXiv links).
2. **`github_trending`** — GitHub Trending repositories (stars, delta, description, primary language).
3. **`hn_algolia`** — HackerNews Front Page via Algolia API (points threshold, comments).
4. **`reddit_json`** — Curated AI/Tech Subreddits via JSON endpoint.
5. **`rss`** — RSS & Atom feeds for blogs and tech media.
6. **`telegram`** — External Telegram channel feed monitoring via MTProto (read-only).
7. **`manual`** — Direct submissions via bot/API (links, forwarded messages, raw text notes, attached `.txt`/`.md` files).

---

## 📱 Interactive Editorial Bot

The channel editor interacts with candidates via interactive inline Telegram messages:

- 🚀 **Publish** — Immediately publishes formatted post to the target Telegram channel.
- ✏️ **Edit** — Reply to draft message with new text. The bot computes Levenshtein `edit_distance` and presents an updated preview.
- ⚡ **Rewrite Better** — Dispatches prompt to `deepseek-v4-pro` in **Thinking Mode** for enhanced stylistic refinement.
- 🔄 **Another Variant** — Generates alternative draft variant $N+1$.
- ❌ **Reject** — Rejection with 7-point taxonomy (each reason automatically recalibrates its subsystem: source trust, score weights, blacklist, or style guide).
- ⏳ **Defer** — Returns story to the candidate pool with downgraded priority.

---

## 🛡️ Shadow Mode & Autopublish

- **Shadow Mode:** Runs alongside human curation, recording what the engine would have published independently and computing rolling 14-day agreement rate.
- **Autopublish Criteria:**
  1. Rolling agreement rate $\ge 85\%$ sustained for 14 consecutive days.
  2. Only sources from explicit whitelist.
  3. Only approved post formats.
  4. Daily post volume limits enforced.
  5. Publication confined to configured daily time window (UTC).
- **Emergency Kill Switch:** Instant command (`/kill_switch`) canceling all pending auto-posts and resetting agreement streaks to zero.

---

## 🚀 Getting Started

### Prerequisites
- **Node.js:** v22.x or later
- **Database:** PostgreSQL 16 with `pgvector` extension (e.g. Supabase)
- **API Keys:**
  - DeepSeek API key (`DEEPSEEK_API_KEY`)
  - Cohere API key (`COHERE_API_KEY`)
  - Telegram Bot Token (`TELEGRAM_BOT_TOKEN`)

### 1. Installation & Build

```bash
git clone https://github.com/HarryMtv/telegram-content-engine.git
cd telegram-content-engine
npm install
npm run build
```

### 2. Environment Setup

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

### 3. Database Migration & Seeding

```bash
npm run migrate    # Applies SQL migrations in transactions
npm run seed       # Seeds initial channel profile, formats, and sources
```

### 4. Running with Docker Compose

```bash
docker compose up -d --build
```

View cluster logs:
```bash
docker compose logs -f
```

---

## ⚙️ Configuration Reference

| Variable | Description | Default / Example |
| :--- | :--- | :--- |
| `DATABASE_URL` | Supabase Transaction Pooler URL | `postgresql://postgres:...@aws-1-eu-west-1.pooler.supabase.com:6543/postgres` |
| `DATABASE_URL_DIRECT` | Direct PostgreSQL connection string | Optional (for migrations/IPv6 VPS) |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token | `123456789:ABC...` |
| `TELEGRAM_CHANNEL_CHAT_ID` | Target publication channel ID | `-1001234567890` |
| `TELEGRAM_OWNER_CHAT_ID` | Channel owner / editor Telegram ID | `471600732` |
| `INGEST_TOKEN` | Bearer token for HTTP `/ingest` API | Generated 64-char hex string |
| `DEEPSEEK_API_KEY` | DeepSeek Platform API Key | `sk-...` |
| `COHERE_API_KEY` | Cohere Platform API Key | `...` |
| `LLM_CHEAP_PROVIDER` | Provider for cheap LLM tier | `deepseek` |
| `LLM_CHEAP_MODEL` | Model name for cheap LLM tier | `deepseek-v4-flash` |
| `LLM_STRONG_PROVIDER` | Provider for strong LLM tier | `deepseek` |
| `LLM_STRONG_MODEL` | Model name for strong LLM tier | `deepseek-v4-pro` |
| `EMBEDDING_PROVIDER` | Embedding provider | `cohere` |
| `EMBEDDING_MODEL` | Multilingual embedding model | `embed-multilingual-v3.0` |
| `EMBEDDING_DIMENSIONS` | Embedding dimension size | `1024` |

---

## 🧪 Testing

The repository maintains an extensive test suite covering unit tests, domain schemas, MMR algorithms, LLM budgeting, prompt generation, and agent loops:

```bash
npm test              # Run all 116 Vitest unit test suites
npm run typecheck     # TypeScript compiler check (tsc --noEmit)
npm run lint          # ESLint validation
```