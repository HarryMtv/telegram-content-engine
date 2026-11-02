## Purpose

Two-stage post generation — language-agnostic `FactSheet` followed by target-language draft synthesis — with anti-hallucination fact checking, flexible post formats, and an efficient tiered model strategy.

## Requirements

### Requirement: Two-Stage Generation Pipeline

Content generation MUST proceed strictly in two isolated stages: `Item` (any source language) $\to$ `FactSheet` (language-agnostic structured claims) $\to$ `Draft` (target language rendered per channel style guide). Merging translation and stylization into a single monolithic prompt is strictly forbidden.

#### Scenario: One FactSheet Serves Multiple Channels

- **WHEN** a single technical event is relevant to multiple channels in different target languages
- **THEN** the FactSheet is extracted once, and each channel synthesizes its own localized draft from that shared structure

#### Scenario: Stylization Operates on Clean Structure

- **WHEN** generating a final draft
- **THEN** the style prompt operates over the clean structured FactSheet rather than translating raw English syntax directly

### Requirement: FactSheet Structure

Every FactSheet MUST contain: `what_happened`, `who`, `numbers`, `key_quote`, `why_it_matters`, `primary_url`, `confidence`, and `source_item_ids` — a structured, verifiable representation grounded in the source text.

#### Scenario: Numeric Metrics Preserved Accurately

- **WHEN** the raw source article quotes specific benchmarks, percentages, or metrics
- **THEN** they are placed into the `numbers` dictionary without rounding, loss, or distortion

### Requirement: Fact-Checking Verification Step

Following FactSheet extraction, an independent verification call MUST compare extracted claims against the raw source text. If discrepancies are detected, `confidence` is downgraded, and the candidate is flagged with a warning in the editorial batch.

#### Scenario: Discrepancy Flagged

- **WHEN** fact checking identifies a claim that contradicts or extrapolates beyond the original text
- **THEN** the FactSheet confidence score is reduced, and the candidate draft is highlighted with a warning badge for the editor

### Requirement: Mandatory Primary Source Attribution

Every single published post MUST contain a valid link to the original primary source. Zero exceptions.

#### Scenario: Missing Primary URL Blocks Release

- **WHEN** a Story lacks a verified `primary_url`
- **THEN** draft candidate delivery is held until primary source resolution is completed by the Resolver agent or owner

### Requirement: Single Initial Draft Default

The engine MUST synthesize exactly one draft per candidate by default. Additional variants are generated lazily upon clicking the "Another Variant" button only for candidates where the initial text was insufficient.

#### Scenario: Lazy Variant Generation

- **WHEN** the owner clicks "Another Variant"
- **THEN** a draft with `variant_n + 1` is generated from the same FactSheet; eager multi-variant generation is prohibited

### Requirement: Cheap Tier Writes, Strong Tier Polishes

Initial drafts MUST be authored by the cheap model tier (`deepseek-v4-flash`). The strong model tier (`deepseek-v4-pro` in Thinking Mode) is engaged strictly via the "Rewrite Better" button for candidates the editor has already decided to publish.

#### Scenario: Strong Model Rewrite

- **WHEN** the editor selects "Rewrite Better"
- **THEN** the FactSheet is forwarded to the strong model, and the refined draft is recorded with model provenance

### Requirement: Configurable Post Formats

The engine MUST support diverse post formats (`breaking`, `digest`, `explainer`, `ugc`) with distinct attributes: `lane` (`fast` / `slow`), `prompt_template`, `target_length`, `freshness_half_life_hours`, `cadence`, and `daily_cap`. Fast-lane breaking items trigger immediate notifications, while slow-lane items are grouped into scheduled batches.

#### Scenario: Breaking News Fast-Track

- **WHEN** a high-priority candidate marked with the `breaking` format passes the scoring funnel
- **THEN** the owner receives an immediate notification without waiting for the daily batch window

#### Scenario: Format Length Enforcement

- **WHEN** a synthesized draft exceeds the format's `target_length`
- **THEN** the generation is adjusted with strict length bounds to conform to Telegram readability standards
