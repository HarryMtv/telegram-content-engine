## Purpose

A unified ingestion pathway for owner discoveries and reader contributions (`submissions`): intake via Telegram bot and HTTP API, unskewed scoring with separate execution priority, instantaneous deduplication feedback, and contributor reputation tracking.

## Requirements

### Requirement: Unified Ingestion Architecture for Dual Roles

Owner discoveries and audience submissions MUST traverse the same `submissions` pipeline with differentiated trust levels: owner submissions proceed immediately, while contributor submissions undergo rate limiting, antispam filtering, and editorial moderation.

#### Scenario: Shared Schema with Tiered Trust

- **WHEN** a URL is submitted by the channel owner versus a community contributor
- **THEN** both entries are recorded in `submissions`; the owner's entry triggers instant queue processing, while the contributor's entry passes moderation checks

### Requirement: Zero-Command Intelligent Bot Intake

The bot MUST accept submissions without requiring explicit bot commands: bare URLs, line-delimited URL lists, forwarded posts, raw text thoughts, and file attachments are identified automatically. Slash commands are reserved for optional modifier flags (`/ingest --channel=<slug> --format=<slug> --force`). Submissions exceeding the 4096-character Telegram limit MUST be accepted via file attachments (`.txt`, `.md`) or the HTTP `/ingest` API.

#### Scenario: Line-Delimited URL Batch

- **WHEN** the owner sends a single message containing 12 links separated by newlines
- **THEN** each link is parsed into an individual URL item and enqueued into the pipeline

#### Scenario: Forwarded Message Intake

- **WHEN** the owner forwards a post from an external Telegram channel
- **THEN** a submission of type `forward` is recorded, and the content triggers the primary source resolution flow

### Requirement: Authenticated HTTP `/ingest` API

The engine MUST expose an authenticated HTTP `/ingest` endpoint protected by a Bearer token for batch ingestions originating from external scripts or local scrapers.

#### Scenario: Batch Submission via HTTP

- **WHEN** an external scraper POSTs 50 links to `/ingest` with a valid Bearer token
- **THEN** all links are ingested, returning a JSON response detailing the processing status for each item (`accepted`, `duplicate`, `error`)

### Requirement: Priority Decoupled from Algorithmic Score

`priority=high` MUST trigger immediate queue execution without waiting for the batch cycle, while `score` MUST remain strictly governed by standard scoring algorithms. The `--force` flag represents an explicit override recorded with `forced=true` in the database; manual inputs MUST NOT bypass quality scoring.

#### Scenario: Manual Input Evaluated Fairly

- **WHEN** the owner submits a link with high priority
- **THEN** it is processed immediately with standard scoring; if the relevance score is low, the bot prompts with an override confirmation dialog

### Requirement: Instantaneous Editorial Feedback

Within seconds of submission, the bot MUST return direct actionable feedback: "Already published N days ago", "Duplicate of Story X", or "Relevance score is 0.31 (below channel threshold) — enqueue anyway?" with an override button. Silent drops are strictly forbidden.

#### Scenario: Duplicate Link Warning

- **WHEN** the owner sends a link to an already published story
- **THEN** the bot responds within seconds stating when it was published and prevents duplicate candidate creation

### Requirement: Contributor Loop and Moderation

For community contributors, the system MUST enforce: rate limiting, spam protection, status lifecycle notifications (accepted, rejected, published), and contributor reputation tracking in the `contributors` table.

#### Scenario: Contributor Notification on Publication

- **WHEN** a contributor's suggested post is published to the channel
- **THEN** the bot delivers a notification to the author, and their `submissions_published` count and reputation score increase

### Requirement: Ingest-to-RSS Transition Detector

The system MUST track the proportion of manually submitted items by domain; upon the third manual submission from the same domain, the bot MUST suggest configuring an automated RSS feed in `sources`.

#### Scenario: Domain Promotion to Automated Source

- **WHEN** the owner manually submits articles from the same domain three times
- **THEN** the bot suggests adding that domain's RSS feed to `sources`; upon confirmation, the source is automatically registered
