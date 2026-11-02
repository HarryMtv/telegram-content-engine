# Tasks: implement-content-engine

Phases correspond to milestones M1–M5 from §14 of the specification. Each phase concludes with its readiness criterion.

## 0. M0 — Content Hypothesis Gate (Operational)

- [ ] 0.1 Manually execute 3 days of exploratory search queries for the channel domain; record the fraction of viable articles in `docs/m0-results.md`. Gate: if viable items < 2 out of 10, recalibrate sources before M1.

## 1. M1 — Pipeline Skeleton

Goal: First post published from the Telegram bot. No embeddings, no LLM, single channel, single format, sources `rss` + `hn_algolia`.

- [x] 1.1 Project initialization: `package.json` (Node 22, ESM), `tsconfig.json`, `vitest`, `eslint`, directory structure per design D1. Verification: `npm test` and `npm run lint` pass.
- [x] 1.2 Initial SQL migration: complete database schema (§4) across all core tables (`channels`, `channel_profiles`, `post_formats`, `sources`, `source_stats`, `items`, `stories`, `channel_candidates`, `fact_sheets`, `drafts`, `editorial_decisions`, `posts`, `metric_snapshots`, `submissions`, `contributors`, `llm_calls`, `agent_runs`) with vector columns and unique constraints (`source_id + external_id`, `url_hash`, `content_hash`). Verification: `npm run migrate` runs cleanly and idempotently.
- [x] 1.3 Database connectivity: Kysely via pooler ($\le 5$ connections) and pg-boss queue setup (design D3). Verification: unit test of config + queue enqueue/dequeue smoke test.
- [x] 1.4 Domain Zod schemas: `RawItem`, `ItemRef`, `SourceConfig`. Verification: unit tests validating sample inputs.
- [x] 1.5 URL canonicalization (`utm_*` strip, tracking cleanup, AMP resolution, shortlink unshortening, protocol/host normalization). Verification: unit tests mapping test pairs to expected `url_hash`.
- [x] 1.6 Normalization of `ItemRef`/`RawItem` $\to$ bulk-insert into `items` in batches of 100–500 (design D7). Verification: integration test confirming duplicate avoidance on repeat insertions.
- [x] 1.7 `rss` Adapter: watermark cursor discovery (`last_ts`/`last_id`) + full text extraction (fetch + readability). Verification: fixture-based unit test.
- [x] 1.8 `hn_algolia` Adapter: front page with points threshold and `external_signals.hn_points`. Verification: Algolia API fixture unit test.
- [x] 1.9 Source health state machine: cursor tracking, `poll_interval_s`, consecutive errors, health statuses (`healthy`/`degraded`/`dead`), `last_ok_at`/`last_error`. Verification: unit tests for status transitions.
- [x] 1.10 Scheduler: pg-boss cron jobs with `singletonKey` `poll-source:<id>` (design D7). Verification: integration test ensuring single job concurrency.
- [x] 1.11 Streamlined M1 funnel: Stage 0 hard filters (language, age, domain blacklists) + Stage 1 numerical scoring without embeddings (`source_trust`, `freshness`). Verification: unit tests for filters and sorting.
- [x] 1.12 Template-based draft synthesis (M1): assemble post from item (title, snippet, primary URL) without LLM. Verification: unit test verifying 4096-character limit and link inclusion.
- [x] 1.13 Telegram editorial bot (grammY, webhook/polling in `api`): daily top-5 batch with inline action buttons (Publish / Reject); channel publication recording `tg_message_id`, `final_text`, `published_at`, `subscribers_at_publish`; logging in `editorial_decisions`. Verification: manual run on test channel.
- [x] 1.14 Entrypoints and deployment topology: `process/api.ts`, `process/scheduler.ts`, `process/worker-light.ts`, `process/migrate.ts`; unified Dockerfile; health endpoints. Verification: container health checks passing.
- [x] 1.15 Seed data: `ai-tech` channel, `channel_profiles` v1 (`manifesto`, `selection_rules`, `style_guide`, `taboos`), `post_formats` (slow format), sources `rss` + `hn_algolia`. Verification: idempotent seed execution.
- [x] 1.16 M1 Milestone Gate: First post published to channel via Telegram bot on real data.

## 2. M2 — Full Curation & Generation Pipeline

Goal: One week of autonomous curation without manual intervention. Embeddings, Stories, 4-stage funnel, FactSheet $\to$ Draft, rejection taxonomy, diffs, `source_trust`.

- [x] 2.1 LLM client with cost accounting (design D5, D11): pricing config, per-call USD calculation, synchronous insertion to `llm_calls`, Zod response validation. Verification: unit test with mock LLM checking tokens and cost audit.
- [x] 2.2 EmbeddingProvider (Cohere `embed-multilingual-v3.0`, 1024d) + batched item embedding job. Verification: unit/integration test on mock provider.
- [x] 2.3 Incremental Story clustering (design D6): top-1 nearest centroid in window, configurable threshold (start 0.82), running average centroid, cluster metrics (`item_count`, `source_diversity`, `velocity`, `peak_external_signal`). Verification: unit tests for cross-lingual story grouping and velocity calculation.
- [x] 2.4 `profile_vector`: centroid over approved channel materials, recalculated upon profile version increments. Verification: unit test.
- [x] 2.5 Full Stage 0 + Stage 1: relevance (cosine to `profile_vector`), `source_trust`, `freshness` (exponential decay per format half-life), `importance` (story dynamics + external signals). Verification: unit tests for scoring components.
- [x] 2.6 Stage 2 — LLM Triage: batched evaluation via cheap model against `selection_rules`, Zod schema `{ relevance, novelty, reason }`, storing `triage_reason`. Verification: mock LLM test.
- [x] 2.7 Total score calculation: $w_1 \cdot \text{rel} + \dots - w_6 \cdot \text{diversity\_penalty}$; `score_components` transparency; MMR batch diversification; daily Stage 3 throughput cap. Verification: unit test for MMR duplicate suppression.
- [x] 2.8 FactSheet: structured claim extraction via cheap model (`what_happened`, `who`, `numbers`, `key_quote`, `why_it_matters`, `primary_url`, `confidence`, `source_item_ids`) with Zod validation. Verification: unit test and schema check.
- [x] 2.9 Fact-Checking: independent verification comparing FactSheet claims against raw source text; discrepancies lower confidence and flag candidate. Verification: test with injected numeric discrepancy.
- [x] 2.10 Draft synthesis: cheap model generation from FactSheet using format `prompt_template` (`target_length`, `taboos`, `style_guide`, top-ERR few-shot examples); single draft default. Verification: mock LLM test.
- [x] 2.11 Fast/Slow formats: `freshness_half_life_hours`, `cadence`, `daily_cap`; breaking candidates trigger immediate notification outside batch. Verification: format routing unit test.
- [x] 2.12 Full M2 Editorial Bot: 6 actions — Publish, Edit & Publish (conversational FSM), Another Variant (`variant_n + 1`), Rewrite Better (strong model), Reject with reason, Defer. Verification: manual review of all 6 actions.
- [x] 2.13 Rejection taxonomy: 7 structured reasons (§8.3), each mapped to an adjustable subsystem (`source_trust`, weights, `style_guide`). Verification: unit test for reason mapping.
- [x] 2.14 Edit diff tracking: storing original draft and edited text along with Levenshtein `edit_distance`. Verification: unit test for edit distance calculation.
- [x] 2.15 Dynamic `source_trust`: rolling score updates from approval decisions and edit distances in `source_stats`. Verification: unit test verifying penalty on unreliable sources.
- [x] 2.16 Vector retention cleanup: weekly job nullifying embeddings older than 90 days while preserving hashes. Verification: unit test.
- [x] 2.17 Budget governance: monthly spending tracker, 80% warning alert, 100% Stage 3 auto-stop. Verification: budget threshold unit tests.
- [x] 2.18 Adapters `reddit_json` and `hf_daily_papers` (fixture tests), plus `github_trending` (star velocity in `external_signals`). Verification: fixture unit tests.
- [x] 2.19 Offline re-clustering command for threshold calibration (design D6). Verification: unit test for re-cluster calibration.
- [ ] 2.20 M2 Milestone Gate: One week of real-world operation without manual curation intervention.

## 3. M3 — Ingestion & Metrics

Goal: Metrics accumulation and manual ingest routing through the standard pipeline.

- [x] 3.1 Submissions entity + zero-command bot intake: URLs, newline lists, forwards, text notes, file attachments; 4096-char threshold for file attachments. Verification: submission handling unit tests.
- [x] 3.2 HTTP `/ingest` API with Bearer token: accepts batch payloads and returns status per item. Verification: integration test.
- [x] 3.3 Priority decoupled from score: `priority=high` triggers immediate processing while preserving unskewed scoring; `/ingest --force` marks `forced=true`. Verification: test verifying override dialog for low-scoring manual items.
- [x] 3.4 Instantaneous feedback: bot responds within seconds on duplicates, past publication dates, and score thresholds. Verification: test for synchronous duplicate checks.
- [x] 3.5 Contributor loop: rate limits, spam prevention, moderation, status notifications, contributor reputation tracking in `contributors`. Verification: rate limit test.
- [x] 3.6 Ingest-to-RSS detector: tracking manual domain frequency; suggesting RSS creation upon 3rd submission from same domain. Verification: domain counter unit test.
- [x] 3.7 MTProto worker: GramJS, dedicated account, persistent session volume, single instance, dedicated `mtproto` queue. Verification: worker session persistence.
- [x] 3.8 `telegram` Adapter: read-only monitoring of external channels with flood limits; Telegram leads without primary source flagged `no_primary_source` with reduced score. Verification: primary source penalty test.
- [x] 3.9 Post metrics: time series snapshots at +1h, +6h, +24h, +72h (views, forwards, emoji reactions, ERR) via MTProto queue. Verification: metric extraction unit test.
- [x] 3.10 Semantic reaction palette (🔥/👍/😴) configured in channel; reactions recorded structurally from Day 1 but isolated from decision loop prior to ~200 posts. Verification: metric guard unit test.
- [ ] 3.11 M3 Milestone Gate: Manual ingest traverses standard pipeline end-to-end; metrics accumulate for one week without gaps.

## 4. M4 — Autonomous Agents

Goal: First channel profile amendment proposed by Analyst agent and approved by owner.

- [x] 4.1 MCP Tools Layer: pure database query tools (`search_sources`, `check_duplicate`, `get_published_history`, `get_channel_profile`, `submit_item`) exposed via MCP (design D10). Verification: MCP tools unit test.
- [x] 4.2 Agent runtime loop: `while (steps < maxSteps)`, system prompt, tool calling, Zod output validation; hard caps on steps, tokens, timeouts, and USD cost; trace logging in `agent_runs`. Verification: agent runtime test.
- [x] 4.3 `worker-agents` service: agent background job queue. Verification: worker initialization and health check.
- [x] 4.4 Resolver Agent: on-demand job resolving Telegram leads to primary sources within $\le N$ steps. Verification: Resolver agent test.
- [x] 4.5 Scout Agent: weekly multi-step exploration for emerging unrepresented topics, inserting discoveries into `submissions`. Verification: Scout agent test.
- [x] 4.6 Analyst Agent: weekly analysis of editorial decisions, rejections, diffs, source stats, and metrics $\to$ proposing diffs to `channel_profiles` (constitution rules, weights); approval creates `version + 1`. Verification: Analyst agent diff generation test.
- [x] 4.7 Publication permissions: all agents have zero publication privileges. Verification: permission layer rejection test.
- [ ] 4.8 M4 Milestone Gate: First profile amendment from Analyst accepted by owner in production.

## 5. M5 — Second Channel & Shadow Mode

Goal: Multichannel production operation and autopublication shadow mode.

- [x] 5.1 Shadow Mode: `would_publish` flag on candidates, rolling 14-day agreement percentage tracking, weekly bot report. Verification: agreement calculation test.
- [x] 5.2 Autopublication preconditions: agreement $\ge 85\%$ over 14 days, source whitelist, format restrictions, daily volume caps, UTC time window; activation requires explicit confirmation. Verification: eligibility check test.
- [x] 5.3 Emergency Kill Switch: instant deactivation command, canceling pending auto-drafts and resetting agreement counter on rejection. Verification: kill switch test.
- [x] 5.4 Multi-channel registry: configuring additional channels and bot tokens without code changes. Verification: multi-channel routing test.
- [ ] 5.5 M5 Milestone Gate: Second channel operational and Shadow Mode agreement accumulating.
