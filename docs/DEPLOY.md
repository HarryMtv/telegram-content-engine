# Production Deployment Guide (Coolify & Docker Compose)

This document outlines the deployment topology, environment configuration, and execution instructions for **Telegram Content Engine** on a production VPS using **Coolify** or **Docker Compose**.

---

## 🏗️ Architecture Overview

The system runs as a **single multi-stage Docker image** partitioned into **5 distinct services** (design D1):

```
┌─────────────────────────────────────────────────────────────┐
│                 Cloud Supabase (PostgreSQL 16)              │
│                + pgvector (1024d) + pg-boss v10             │
│            (aws-1-eu-west-1.pooler.supabase.com)            │
└───────▲───────────────────────▲─────────────────────▲───────┘
        │                       │                     │
┌───────┴───────────────┐ ┌─────┴───────────────┐ ┌───┴───────────────┐
│   content-engine-api  │ │ content-engine-     │ │ content-engine-   │
│ • Fastify HTTP :8080  │ │ scheduler           │ │ worker-light      │
│ • Telegram Bot API    │ │ • 1-min cron tick   │ │ • Ingest/Embed    │
│ • Webhook / Long-poll │ │ • Daily batches     │ │ • Scoring/Drafts  │
└───────────────────────┘ └─────────────────────┘ └───────────────────┘
                                                  ┌───────────────────┐
                                                  │ content-engine-   │
                                                  │ worker-mtproto    │
                                                  │ • GramJS (read)   │
                                                  │ • Metric snapshot │
                                                  └───────────────────┘
                                                  ┌───────────────────┐
                                                  │ content-engine-   │
                                                  │ worker-agents     │
                                                  │ • Resolver/Scout  │
                                                  │ • Analyst         │
                                                  └───────────────────┘
```

---

## 📦 Container Services & Commands

| Service Name | Startup Command | Ports / Healthcheck | Replica Count | Description |
| :--- | :--- | :--- | :--- | :--- |
| **`content-engine-api`** | `node --enable-source-maps dist/process/api.js` | `8080:8080`<br>`GET /health` | 1 | Fastify API server (`/health`, `/ingest`) + Telegram Bot handler. |
| **`content-engine-scheduler`** | `node --enable-source-maps dist/process/scheduler.js` | `GET /health` (:8081) | 1 | Periodic cron scheduler (1-min ticks + batch schedule). |
| **`content-engine-worker-light`** | `node --enable-source-maps dist/process/worker-light.js` | `GET /health` (:8082) | 1–2 | Ingestion, article extraction, embeddings, scoring, draft synthesis. |
| **`content-engine-worker-mtproto`** | `node --enable-source-maps dist/process/worker-mtproto.js` | `GET /health` (:8083) | **Strictly 1** | GramJS MTProto client for channel monitoring and metric collection. |
| **`content-engine-worker-agents`** | `node --enable-source-maps dist/process/worker-agents.js` | `GET /health` (:8084) | 1 | Sandboxed execution runtime for Resolver, Scout, and Analyst agents. |

---

## 🚀 Coolify Deployment Steps

### Step 1: Create a Docker Compose Project in Coolify
1. In your Coolify dashboard, select **New Resource** $\to$ **Docker Compose**.
2. Connect your GitHub repository (`HarryMtv/telegram-content-engine`) and track the `main` branch.
3. Select `docker-compose.yml` as the compose configuration.

### Step 2: Configure Environment Variables in Coolify
Add the required production environment variables:

```dotenv
# Core & Database
APP_ENV=production
DATABASE_URL=postgresql://postgres.xxx:PASSWORD@aws-1-<region>.pooler.supabase.com:6543/postgres
API_PORT=8080
INGEST_TOKEN=your-secure-64-character-hex-token

# Telegram
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ
TELEGRAM_CHANNEL_CHAT_ID=-1001234567890
TELEGRAM_OWNER_CHAT_ID=123456789
TELEGRAM_WEBHOOK_SECRET=your-secret-token-min-8-chars
# Leave TELEGRAM_WEBHOOK_URL empty for Long Polling, or set public URL for Webhook:
TELEGRAM_WEBHOOK_URL=https://tce.yourdomain.com/api/telegram/webhook

# AI Platform Keys
DEEPSEEK_API_KEY=sk-...
COHERE_API_KEY=...

# Model Selection
LLM_CHEAP_PROVIDER=deepseek
LLM_CHEAP_MODEL=deepseek-v4-flash
LLM_CHEAP_INPUT_PRICE=0.10
LLM_CHEAP_OUTPUT_PRICE=0.20

LLM_STRONG_PROVIDER=deepseek
LLM_STRONG_MODEL=deepseek-v4-pro
LLM_STRONG_INPUT_PRICE=0.55
LLM_STRONG_OUTPUT_PRICE=2.19

EMBEDDING_PROVIDER=cohere
EMBEDDING_MODEL=embed-multilingual-v3.0
EMBEDDING_DIMENSIONS=1024
```

### Step 3: Run Database Migrations and Seed
Before or during initial deployment, execute the migration and seed scripts:

```bash
# Inside the container or locally pointing to DATABASE_URL:
npm run migrate
npm run seed
```

### Step 4: Deploy Cluster
Trigger deployment in Coolify. All 5 services will build from the multi-stage Dockerfile and report healthy status via their `/health` checks.

---

## 🛠️ CLI Operations & Health Diagnostics

```bash
# View live container status
docker compose ps

# View aggregated real-time logs
docker compose logs -f

# Check API health
curl http://localhost:8080/health

# Trigger manual rebuild
docker compose up -d --build
```
