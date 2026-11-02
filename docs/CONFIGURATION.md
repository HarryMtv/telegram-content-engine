# Configuration & Environment Variables Guide

This document provides a comprehensive reference for all configuration options and environment variables in **Telegram Content Engine**.

---

## Quick Reference (.env Template)

```dotenv
# ==============================================================================
# 1. CORE & DATABASE
# ==============================================================================
APP_ENV=development
DATABASE_URL=postgresql://postgres.xxx:password@aws-1-eu-central-1.pooler.supabase.com:6543/postgres
# DATABASE_URL_DIRECT=postgresql://postgres:password@db.xxx.supabase.co:5432/postgres
API_PORT=8080
HEALTH_PORT=8081
INGEST_TOKEN=dev-ingest-token

# ==============================================================================
# 2. TELEGRAM BOT & CHANNEL
# ==============================================================================
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ
TELEGRAM_CHANNEL_CHAT_ID=-1001234567890
TELEGRAM_OWNER_CHAT_ID=123456789
TELEGRAM_WEBHOOK_SECRET=your-secret-token-min-8-chars
# Leave empty for local Long Polling; set URL for production webhook
# TELEGRAM_WEBHOOK_URL=https://tce.example.com/api/telegram/webhook

# ==============================================================================
# 3. GLOBAL PROVIDER API KEYS (Fallbacks)
# ==============================================================================
OPENAI_API_KEY=sk-...
COHERE_API_KEY=...
OPENROUTER_API_KEY=sk-or-...
DEEPSEEK_API_KEY=sk-...

# ==============================================================================
# 4. LLM CONFIGURATION (Cheap Role: Triage, FactSheet, Fact-check, Fast Draft)
# ==============================================================================
# Provider: openai | openrouter | deepseek | groq | custom | mock
LLM_CHEAP_PROVIDER=openai
LLM_CHEAP_MODEL=gpt-4o-mini
# LLM_CHEAP_BASE_URL=https://api.openai.com/v1
# LLM_CHEAP_API_KEY=
# LLM_CHEAP_INPUT_PRICE=0.15
# LLM_CHEAP_OUTPUT_PRICE=0.60

# ==============================================================================
# 5. LLM CONFIGURATION (Strong Role: "⚡ Rewrite Better")
# ==============================================================================
# Provider: openai | openrouter | deepseek | groq | custom | mock
LLM_STRONG_PROVIDER=openai
LLM_STRONG_MODEL=gpt-4o
# LLM_STRONG_BASE_URL=https://api.openai.com/v1
# LLM_STRONG_API_KEY=
# LLM_STRONG_INPUT_PRICE=2.50
# LLM_STRONG_OUTPUT_PRICE=10.00

# ==============================================================================
# 6. VECTOR EMBEDDINGS (Story Clustering & Channel Profile Alignment)
# ==============================================================================
# Provider: cohere | openai | custom | mock
EMBEDDING_PROVIDER=cohere
EMBEDDING_MODEL=embed-multilingual-v3.0
# EMBEDDING_API_KEY=
# EMBEDDING_BASE_URL=
EMBEDDING_DIMENSIONS=1024

# ==============================================================================
# 7. AGENT WEB SEARCH (Resolver primary-source lookup, Scout trend discovery)
# ==============================================================================
# Provider: tavily | brave | mock
SEARCH_PROVIDER=tavily
TAVILY_API_KEY=
# BRAVE_SEARCH_API_KEY=
```

---

## Detailed Variable Reference

### 1. Core & Database

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `APP_ENV` | `string` | `development` | Application environment (`development` or `production`). |
| `DATABASE_URL` | `url` | *Required* | PostgreSQL connection string (Supabase Transaction Pooler recommended). |
| `DATABASE_URL_DIRECT` | `url` | `DATABASE_URL` | Direct PostgreSQL connection string (optional; used when IPv6 is available). |
| `API_PORT` | `number` | `8080` | HTTP port for the Fastify API / Telegram webhook server. |
| `HEALTH_PORT` | `number` | `8081` | HTTP port for the internal health check server (`/health`). |
| `INGEST_TOKEN` | `string` | `dev-ingest-token` | Bearer token for authenticating HTTP `/ingest` API submissions. **Required in production**: unset, `dev-ingest-token` and `change-me` values are rejected when `APP_ENV=production`. |

---

### 2. Telegram Bot & Channel

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `TELEGRAM_BOT_TOKEN` | `string` | *Required* | Bot token obtained from `@BotFather`. |
| `TELEGRAM_CHANNEL_CHAT_ID` | `string` | *Required* | Numeric ID of the target Telegram channel (e.g. `-1001234567890`). Bot must be an administrator with post privileges. |
| `TELEGRAM_OWNER_CHAT_ID` | `string` | *Required* | Numeric Telegram User ID of the owner/editor receiving candidate review batches and alerts. |
| `TELEGRAM_WEBHOOK_SECRET` | `string` | *Required* | Secret token (`X-Telegram-Bot-Api-Secret-Token`) used to authenticate incoming webhook requests. |
| `TELEGRAM_WEBHOOK_URL` | `url` | *Empty* | Public HTTPS URL for Telegram webhook. When omitted or empty, the bot automatically runs in **Long Polling mode** (ideal for local development). |

---

### 3. LLM Models & Providers

The system uses a 2-tier LLM architecture:
- **`cheap` role**: Stage 2 LLM triage, structured `FactSheet` extraction, automated `Fact-check`, and default draft generation.
- **`strong` role**: Used exclusively on-demand when the editor clicks the **"⚡ Rewrite Better"** button in Telegram.

#### Cheap Model Settings

| Variable | Default | Options | Description |
| :--- | :--- | :--- | :--- |
| `LLM_CHEAP_PROVIDER` | `openai` | `openai`, `openrouter`, `deepseek`, `groq`, `custom`, `mock` | LLM provider for fast/cheap pipeline stages. |
| `LLM_CHEAP_MODEL` | `gpt-4o-mini` | `gpt-4o-mini`, `deepseek-chat`, `anthropic/claude-3.5-haiku`, `llama-3.3-70b-versatile`, etc. | Model name to invoke. |
| `LLM_CHEAP_BASE_URL` | Auto | e.g. `https://api.openai.com/v1`, `https://openrouter.ai/api/v1` | Base URL for the OpenAI-compatible API endpoint. |
| `LLM_CHEAP_API_KEY` | `OPENAI_API_KEY` | API Key string | Specific API key for cheap model (falls back to provider default). |
| `LLM_CHEAP_INPUT_PRICE` | Auto ($0.15) | USD per 1M tokens | Cost per 1,000,000 input tokens for tracking in `llm_calls`. |
| `LLM_CHEAP_OUTPUT_PRICE`| Auto ($0.60) | USD per 1M tokens | Cost per 1,000,000 output tokens for tracking in `llm_calls`. |

#### Strong Model Settings

| Variable | Default | Options | Description |
| :--- | :--- | :--- | :--- |
| `LLM_STRONG_PROVIDER` | `openai` | `openai`, `openrouter`, `deepseek`, `groq`, `custom`, `mock` | LLM provider for strong rewriting. |
| `LLM_STRONG_MODEL` | `gpt-4o` | `gpt-4o`, `deepseek-reasoner`, `anthropic/claude-3.5-sonnet`, `o3-mini`, etc. | Model name to invoke. |
| `LLM_STRONG_BASE_URL` | Auto | e.g. `https://api.openai.com/v1`, `https://openrouter.ai/api/v1` | Base URL for the OpenAI-compatible API endpoint. |
| `LLM_STRONG_API_KEY` | `OPENAI_API_KEY` | API Key string | Specific API key for strong model. |
| `LLM_STRONG_INPUT_PRICE` | Auto ($2.50) | USD per 1M tokens | Cost per 1,000,000 input tokens. |
| `LLM_STRONG_OUTPUT_PRICE`| Auto ($10.00)| USD per 1M tokens | Cost per 1,000,000 output tokens. |

---

### 4. Vector Embeddings

Used for story clustering (cross-lingual story deduplication across EN/RU) and channel profile vector alignment.

| Variable | Default | Options | Description |
| :--- | :--- | :--- | :--- |
| `EMBEDDING_PROVIDER` | `cohere` | `cohere`, `openai`, `custom`, `mock` | Vector embedding provider. |
| `EMBEDDING_MODEL` | `embed-multilingual-v3.0` | `embed-multilingual-v3.0`, `text-embedding-3-small`, `text-embedding-3-large` | Embedding model identifier. |
| `EMBEDDING_API_KEY` | `COHERE_API_KEY` | API Key string | API key for the embedding provider. |
| `EMBEDDING_BASE_URL` | Auto | e.g. `https://api.openai.com/v1` | Base URL for embedding API (if using OpenAI / custom endpoint). |
| `EMBEDDING_DIMENSIONS` | `1024` | `1024` (or matching DB `vector(1024)`) | Vector dimension count. Must match pgvector column specifications. |

### 5. Agent Web Search

Backs the `web_search` tool used by the Resolver and Scout agents (spec §11). Resolver needs it to find a primary
source the system has never ingested; `search_sources` alone can only rediscover material already in the database.

| Variable | Default | Options | Description |
| :--- | :--- | :--- | :--- |
| `SEARCH_PROVIDER` | `tavily` | `tavily`, `brave`, `mock` | Web search backend for agents. |
| `TAVILY_API_KEY` | — | API Key string | Key for Tavily; required when `SEARCH_PROVIDER=tavily`. |
| `BRAVE_SEARCH_API_KEY` | — | API Key string | Key for Brave Search; required when `SEARCH_PROVIDER=brave`. |

With no key configured the `web_search` tool is not offered to agents at all: they fall back to database-only
reasoning rather than failing. Search calls are bounded by the calling agent's step and timeout caps; unlike LLM
calls they are not individually costed into `llm_calls`, so pick a provider tier whose own quota is acceptable.

---

## Provider Setup Examples

### Option 1: OpenAI (Default Standard)

High reliability and performance.

```dotenv
OPENAI_API_KEY=sk-proj-...
COHERE_API_KEY=your-cohere-api-key

LLM_CHEAP_PROVIDER=openai
LLM_CHEAP_MODEL=gpt-4o-mini

LLM_STRONG_PROVIDER=openai
LLM_STRONG_MODEL=gpt-4o

EMBEDDING_PROVIDER=cohere
EMBEDDING_MODEL=embed-multilingual-v3.0
```

---

### Option 2: OpenRouter (Multi-Vendor Access)

Allows mixing Anthropic Claude, Meta Llama, and OpenAI models through a single API key.

```dotenv
OPENROUTER_API_KEY=sk-or-v1-...
COHERE_API_KEY=your-cohere-api-key

# Fast triage & drafts with Claude 3.5 Haiku
LLM_CHEAP_PROVIDER=openrouter
LLM_CHEAP_MODEL=anthropic/claude-3.5-haiku

# High quality rewriting with Claude 3.5 Sonnet
LLM_STRONG_PROVIDER=openrouter
LLM_STRONG_MODEL=anthropic/claude-3.5-sonnet

EMBEDDING_PROVIDER=cohere
EMBEDDING_MODEL=embed-multilingual-v3.0
```

---

### Option 3: DeepSeek (Cost Optimized)

Extremely economical for large volumes.

```dotenv
DEEPSEEK_API_KEY=sk-...
COHERE_API_KEY=your-cohere-api-key

# Fast triage & drafts with DeepSeek-V3
LLM_CHEAP_PROVIDER=deepseek
LLM_CHEAP_MODEL=deepseek-chat

# Deep reasoning rewriting with DeepSeek-R1
LLM_STRONG_PROVIDER=deepseek
LLM_STRONG_MODEL=deepseek-reasoner

EMBEDDING_PROVIDER=cohere
EMBEDDING_MODEL=embed-multilingual-v3.0
```

---

### Option 4: Pure OpenAI (OpenAI LLMs + OpenAI Embeddings)

All operations using OpenAI services.

```dotenv
OPENAI_API_KEY=sk-proj-...

LLM_CHEAP_PROVIDER=openai
LLM_CHEAP_MODEL=gpt-4o-mini

LLM_STRONG_PROVIDER=openai
LLM_STRONG_MODEL=gpt-4o

EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1024
```

---

### Option 5: Local Models (Ollama / vLLM / LM Studio)

Run locally without external API costs.

```dotenv
# Local Ollama endpoint
LLM_CHEAP_PROVIDER=custom
LLM_CHEAP_BASE_URL=http://localhost:11434/v1
LLM_CHEAP_MODEL=llama3.2
LLM_CHEAP_API_KEY=ollama
LLM_CHEAP_INPUT_PRICE=0.00
LLM_CHEAP_OUTPUT_PRICE=0.00

# Strong model on local vLLM / Ollama
LLM_STRONG_PROVIDER=custom
LLM_STRONG_BASE_URL=http://localhost:11434/v1
LLM_STRONG_MODEL=qwen2.5-coder:14b
LLM_STRONG_API_KEY=ollama
LLM_STRONG_INPUT_PRICE=0.00
LLM_STRONG_OUTPUT_PRICE=0.00

# Mock or OpenAI local embeddings
EMBEDDING_PROVIDER=mock
```

---

## Cost Tracking & Audit

All LLM calls are logged in the `llm_calls` PostgreSQL table:
- `stage`: (`triage`, `factsheet`, `fact_check`, `draft`, `strong_draft`)
- `model`: Exact model string (e.g. `gpt-4o-mini`, `deepseek-chat`, `claude-3.5-haiku`)
- `input_tokens` & `output_tokens`
- `cost_usd`: Calculated based on the configured pricing
- `latency_ms`: Execution time in milliseconds

To review current monthly spend:
```sql
SELECT 
  model, 
  stage, 
  count(*) as call_count, 
  sum(input_tokens) as total_in_tokens, 
  sum(output_tokens) as total_out_tokens, 
  round(sum(cost_usd)::numeric, 4) as total_spend_usd,
  round(avg(latency_ms)::numeric, 0) as avg_latency_ms
FROM llm_calls
WHERE created_at >= date_trunc('month', now())
GROUP BY model, stage
ORDER BY total_spend_usd DESC;
```

---

## Local Development: Supabase MCP

The repository ships a `.mcp.json` template for the hosted Supabase MCP server (used by Claude Code and other MCP clients). It references the `SUPABASE_ACCESS_TOKEN` environment variable instead of a literal token:

```json
{
  "mcpServers": {
    "supabase": {
      "type": "http",
      "url": "https://mcp.supabase.com/mcp",
      "headers": {
        "Authorization": "Bearer ${SUPABASE_ACCESS_TOKEN}"
      }
    }
  }
}
```

Create a Personal Access Token in the Supabase Dashboard (*Account → Access Tokens*) and export it locally:

```bash
export SUPABASE_ACCESS_TOKEN=<your-access-token>
```

This variable is **not** read by the application itself — it is only substituted into `.mcp.json` by the MCP client. Keep it out of `.env` files that end up in CI or production environments.
