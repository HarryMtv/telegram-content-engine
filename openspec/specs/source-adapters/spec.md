## Purpose

Gathering material from external sources via a unified adapter contract featuring a two-phase architecture (inexpensive discovery $\to$ selective full-text extraction), watermark cursor tracking, health state machines, and a multi-tier fallback text extraction ladder.

## Requirements

### Requirement: Two-Phase Adapter Contract

Every source adapter MUST implement a strict two-phase contract: `discover` returns lightweight item references (`id`, `url`, `title`, `ts`, `snippet`) without downloading full text payloads; `fetch` extracts full article bodies exclusively for candidates surviving Stage 0 filters. This separation is MANDATORY.

#### Scenario: Expensive Fetch Confined to Surviving Candidates

- **WHEN** discovery returns 100 links and Stage 0 filters narrow them down to 30
- **THEN** full article extraction is performed solely for those 30 items rather than all 100

### Requirement: Watermark Cursor and Interval Tracking

Each source record MUST persist its cursor watermark (`last_id` / `last_ts`), polling interval (`poll_interval_s`), consecutive error count, and health status. Subsequent polling cycles MUST resume from the watermark rather than re-evaluating historical feeds.

#### Scenario: Polling Resumes from Watermark

- **WHEN** a source is polled following a previous successful cycle
- **THEN** only items newer than the stored watermark timestamp/ID are processed

### Requirement: Source Health Degradation State Machine

A source failing to return valid responses $N$ times consecutively MUST transition to `degraded`, and upon further failures to `dead`, triggering an alert to the owner via Telegram bot. Successful polling restores `healthy` status, resets errors, and updates `last_ok_at`. Silent failures are prohibited.

#### Scenario: Dead Source Alerting

- **WHEN** an RSS feed fails repeatedly beyond the configured error threshold
- **THEN** status transitions to `dead`, the underlying exception is logged in `last_error`, and the bot alerts the owner

#### Scenario: Automatic Health Recovery

- **WHEN** a previously dead source returns a valid 200 OK response on retry
- **THEN** status returns to `healthy`, error counters reset to zero, and `last_ok_at` is updated

### Requirement: Core Adapter Suite (v1)

The system MUST provide 7 standard ingestion adapters: `rss` (blogs and news outlets), `hn_algolia` (HackerNews Front Page with score thresholds), `reddit_json` (curated subreddits), `hf_daily_papers` (daily ArXiv AI papers), `github_trending` (repository star growth), `telegram` (MTProto channel monitoring), and `manual` (direct user submissions). Approximately 80% of volume MUST rely on deterministic sources (RSS + public APIs).

#### Scenario: Deterministic Intake Foundation

- **WHEN** only `rss` and `hn_algolia` are active
- **THEN** the pipeline maintains an automated, continuous stream of high-relevance candidates without manual data entry

### Requirement: Telegram Channels as Ingestion Leads

The MTProto worker MUST read external Telegram channels read-only via a dedicated account adhering to Telegram flood limits. Paraphrasing external Telegram posts without verification is strictly forbidden: Telegram leads MUST pass through the Resolver agent to discover original primary sources. If unresolved after $N$ attempts, items enter the pool marked `no_primary_source` with a reduced score.

#### Scenario: Telegram Lead Without Primary Source

- **WHEN** a forwarded post cannot be resolved to a primary article URL within $N$ search attempts
- **THEN** the candidate is retained in the pool marked `no_primary_source` with a penalty applied, preventing publication without explicit owner confirmation

### Requirement: Multi-Tier Text Extraction Ladder

Full-text article extraction MUST follow a progressive fallback ladder:
1. Direct HTTP fetch + Readability parsing.
2. If failed, fallback to Jina Reader / Firecrawl (free tier).
3. If failed (e.g. anti-scraping paywalls), set `fetch_status = manual_needed` and prompt the owner via bot to submit copy-pasted text. Step 3 is a standard workflow path, not an application crash.

#### Scenario: Paywalled Content Prompts Owner

- **WHEN** an article is protected behind a paywall and cannot be scraped by automated readers
- **THEN** the item is assigned `fetch_status = manual_needed`, and the bot prompts the owner to paste the text

#### Scenario: Direct Readability Zero-Cost Path

- **WHEN** an article is parsed successfully via standard fetch and Readability
- **THEN** external scraping services are bypassed, keeping execution cost at $0
