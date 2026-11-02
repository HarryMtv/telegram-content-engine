## Purpose

Three focused autonomous agents (Scout, Resolver, Analyst) built on a shared MCP tools layer for tasks with non-deterministic step sequences, while the core intake and scoring pipeline remains deterministic code.

## Requirements

### Requirement: Deterministic Core Without Agents

Material intake, aggregation/deduplication, and scoring MUST remain deterministic code without LLM agents: scores must be directly comparable on a stable scale, and job retries must be reproducible.

#### Scenario: Identical Input Yields Identical Score

- **WHEN** stage 1 scoring is re-run on identical data
- **THEN** score components are identical, preserving deduplication consistency and the learning feedback loop

### Requirement: Shared MCP Tools Layer

Tools MUST be isolated into a pure database/service layer exposed via MCP: `search_sources`, `check_duplicate`, `get_published_history`, `get_channel_profile`, `submit_item`. This same tool suite is shared by background agents on the server and local CLI agents used by the owner.

#### Scenario: Local CLI Reuses Tools

- **WHEN** the channel owner connects a local agent CLI to the system's MCP endpoint
- **THEN** the local agent operates using the exact same tool suite as the remote Scout worker, requiring no new adapters

### Requirement: Web Search Tool

Beyond the pure database tools, agents MUST be able to search the open web through a single `web_search` tool. The tool is read-only and MUST sit behind a provider interface so the concrete backend (Tavily, Brave) is an environment choice (`SEARCH_PROVIDER`) rather than an agent-visible detail. It MUST be offered to an agent only when a provider API key is configured, so a deployment without one degrades to database-only reasoning instead of failing. Search calls MUST be bounded by the calling agent's `max_steps` and wall-clock caps and recorded in the run's `agent_runs` trace like any other tool call.

Rationale: Resolver's task is to find a primary source the system has *not* ingested. Restricted to `search_sources`, it can only rediscover material already in the database, which cannot satisfy the Primary Source Discovered scenario below.

#### Scenario: Provider Key Absent

- **WHEN** no search provider key is configured for the deployment
- **THEN** `web_search` is not offered to the agent at all, and the agent completes its run using database tools only

#### Scenario: Search Backend Swapped

- **WHEN** the operator switches `SEARCH_PROVIDER` between supported backends
- **THEN** agent prompts, tool schemas, and stored traces are unchanged, because only the provider implementation differs

### Requirement: Scout Agent

The Scout agent MUST run weekly or on-demand via a bot button, performing multi-step exploration ("what is trending in topic X that we do not have yet") with autonomous search decisions. Discovered items MUST be inserted into `submissions` as standard contributor/owner materials without requiring custom wrappers.

#### Scenario: Scout Discoveries Enter Standard Pipeline

- **WHEN** Scout finishes an execution run with new discoveries
- **THEN** discovered items are inserted into `submissions` and traverse the standard scoring pipeline with unskewed scoring

### Requirement: Resolver Agent

The Resolver agent MUST execute on-demand for forwarded Telegram posts lacking a primary URL: search for the original source within $\le N$ steps, using both the ingested corpus and `web_search`, and return a `primary_url` or a structured rejection.

#### Scenario: Forward Triggers Resolution

- **WHEN** manual ingest accepts a forwarded Telegram post that carries no URL of its own
- **THEN** a Resolver run is enqueued for that item, keyed by item id so repeated ingestion of the same forward does not start a second run

#### Scenario: Primary Source Discovered

- **WHEN** Resolver locates the original technical article summarized in a Telegram post
- **THEN** `primary_url` is recorded into the `FactSheet`, and the draft is generated based on the primary source

#### Scenario: Primary Source Not Found

- **WHEN** $N$ search attempts are exhausted without finding a primary source
- **THEN** Resolver returns a rejection, and the item enters the pool marked with `no_primary_source` and a reduced score

#### Scenario: Marking Does Not Destroy Existing Signals

- **WHEN** Resolver records `no_primary_source` or `resolved_primary_source` on an item
- **THEN** the flag is merged into `external_signals` alongside existing virality proxies rather than replacing them, and the flag itself is never counted as a virality signal by scoring

### Requirement: Analyst Agent

The Analyst agent MUST run weekly to analyze editorial decisions, rejection reasons, edit diffs, and engagement metrics, producing proposed diffs to `channel_profiles` (constitution rules, score weights) for owner approval. Diffs MUST only be applied upon explicit owner confirmation.

#### Scenario: Constitution Diff Proposal

- **WHEN** weekly review identifies systematic rejections for "off-tone"
- **THEN** Analyst formulates a specific diff to `style_guide` with detailed rationale; owner approval creates a new profile version $N+1$

### Requirement: Uniform Agent Guardrails

Every agent MUST:
1. Return a strictly validated Zod output structure (free-form raw text output is forbidden).
2. Enforce hard caps on `max_steps`, `max_tokens`, wall-clock timeout, and per-run USD cost limits.
3. Have zero publication or broadcast permissions.
4. Record full tool call traces into `agent_runs`.
5. Be idempotent by execution key.
6. Communicate solely through the database and queue (no direct inter-agent RPC).
7. Execute as a standard `pg-boss` background job.

#### Scenario: Validated Output Contract

- **WHEN** an agent completes execution
- **THEN** output is validated against its Zod schema; invalid outputs mark the run as `failed` without corrupting domain state

#### Scenario: Budget or Timeout Cap Exceeded

- **WHEN** an agent exceeds its wall-clock timeout or USD cost limit
- **THEN** execution halts with status `timeout` or `budget_exceeded`, the trace is preserved, and state remains uncorrupted

### Requirement: Framework-Free TypeScript Runtime

Agents MUST be implemented as a clean TypeScript loop around the native tool-calling API (~150 lines of code) with Zod schemas, avoiding heavy agent frameworks (such as LangChain or CrewAI).

#### Scenario: Adding a New Agent

- **WHEN** a new specialized agent is introduced
- **THEN** it reuses the common runtime loop, MCP tool definitions, and a Zod schema without additional framework dependencies
