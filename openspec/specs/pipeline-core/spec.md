## Purpose

The operational foundation of the system: PostgreSQL database schema with `pgvector`, distributed job queue via `pg-boss`, multi-process topology, health checks, Supabase pooler connection rules, and retention management.

## Requirements

### Requirement: Database Schema and Migrations

The system MUST define and maintain a PostgreSQL 15+ schema with the `pgvector` extension covering all 18 core entities: `channels`, `channel_profiles`, `post_formats`, `sources`, `source_stats`, `items`, `stories`, `channel_candidates`, `fact_sheets`, `drafts`, `editorial_decisions`, `posts`, `metric_snapshots`, `submissions`, `contributors`, `llm_calls`, and `agent_runs` matching specification schemas (§4). The schema MUST be version-controlled via pure transactional SQL migrations.

#### Scenario: Clean Database Deployment via Migrations

- **WHEN** the migration suite is applied to an empty Supabase schema
- **THEN** all tables, foreign keys, and indexes are created along with `vector(1024)` columns on `items`, `stories`, and `channel_profiles`

#### Scenario: Vector Index Search

- **WHEN** cosine distance search is performed over `items.embedding`
- **THEN** the query utilizes the pgvector index to return nearest neighbors without sequential full-table scans

### Requirement: Distributed Job Queue via pg-boss

All periodic and heavy background operations (source polling, article extraction, embeddings, LLM stages, clustering, batch delivery) MUST execute as `pg-boss` jobs backed by PostgreSQL. Handlers MUST be strictly idempotent: retries after network or host failure must never create duplicate items or corrupt state.

#### Scenario: Job Retry Deduplication

- **WHEN** a source poll job fails midway after partial item insertion and is retried
- **THEN** already inserted items are skipped via unique constraint checks (`external_id`, `url_hash`, `content_hash`)

### Requirement: Multi-Process Architecture

The system MUST run as 5 decoupled processes: `api` (bot webhooks/long-polling, HTTP `/ingest`, health), `scheduler` (cron job dispatch), `worker-light` (RSS, public APIs, article fetch, embeddings, LLM stages), `worker-mtproto` (Telegram channel monitoring, metric snapshots), and `worker-agents` (Resolver, Scout, Analyst agents). The `worker-mtproto` process MUST run as strictly one instance to prevent MTProto session concurrency conflicts.

#### Scenario: MTProto Single-Instance Invariant

- **WHEN** deployment configuration attempts to scale `worker-mtproto` beyond 1 replica
- **THEN** configuration validation rejects the deployment

### Requirement: Health Checks

Each process MUST expose an HTTP health check endpoint reporting readiness and liveness (Postgres reachability and queue connectivity) utilized by Docker / Coolify for container restarts.

#### Scenario: Unhealthy Database Triggers Restart

- **WHEN** a process loses connection to Postgres
- **THEN** the `/health` endpoint returns a non-200 status code, prompting orchestrator restart

### Requirement: Supabase Connection Governance

The application MUST connect to Supabase through the Transaction Pooler (port 6543) with a connection pool size $\le 5$ per process for standard queries. The `pg-boss` queue MUST operate in active polling mode to ensure complete pooler compatibility. Ingest batch insertions MUST use bulk queries of 100–500 rows. Authentication uses the `service_role` key without RLS overhead.

#### Scenario: Bulk Crawler Insertion

- **WHEN** a source polling cycle discovers 300 new items
- **THEN** items are inserted via batched bulk queries rather than sequential individual statements

### Requirement: MTProto Persistent Session Storage

The GramJS MTProto session storage MUST reside on a persistent volume, surviving container deployments and restarts without requiring SMS/2FA re-authentication.

#### Scenario: Deployment Preserves Session

- **WHEN** the `worker-mtproto` container restarts during a new version release
- **THEN** the active Telegram session loads directly from disk without re-login prompts

### Requirement: First-Class Multi-Channel Data Model

The database model and codebase MUST support multiple independent channels (each with its own bot token, channel profile, and format configuration) from Day 1.

#### Scenario: Second Channel Onboarding via Configuration

- **WHEN** a new channel row and bot token are configured
- **THEN** the pipeline ingests and generates candidate batches for both channels without code modifications

### Requirement: 90-Day Vector Retention Cleanup

A weekly maintenance job MUST nullify embedding vectors for items older than 90 days while preserving hashes and metadata.

#### Scenario: Aged Item Drops Embedding

- **WHEN** the weekly cleanup job processes items where `discovered_at` exceeds 90 days
- **THEN** the `embedding` column is cleared, `url_hash` and `content_hash` are preserved, and Story clustering continues referencing cluster metadata
