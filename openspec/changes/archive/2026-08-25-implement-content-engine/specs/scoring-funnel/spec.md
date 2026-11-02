## Purpose

A 4-stage candidate curation funnel for channels: zero-cost hard filters $\to$ numerical vector and metadata scoring $\to$ cheap LLM triage $\to$ draft generation, with full traceability of score components.

## Requirements

### Requirement: Stage 0 — Zero-Cost Hard Filters

Stage 0 MUST filter out irrelevant content without incurring LLM or embedding expenses: filtering by detected language, age outside the format window, domain blacklists, already published Stories, and known spam patterns. Expected volume reduction is 60–80%.

#### Scenario: Published Story Filtered Out

- **WHEN** an incoming item belongs to a previously published Story
- **THEN** it is filtered at Stage 0 without scoring or LLM calls

#### Scenario: Blacklisted Domain Excluded

- **WHEN** an item's canonical URL resolves to a blacklisted domain for the channel
- **THEN** it is immediately discarded at Stage 0

### Requirement: Stage 1 — Numerical Scoring Without LLM

Stage 1 MUST compute numerical score components: cosine similarity to the channel's `profile_vector`, `source_trust`, `freshness` decay, and `importance`. Output is a prioritized pool of ~30 candidates forwarded to Stage 2.

#### Scenario: Cost-Efficient Pre-Selection

- **WHEN** 200 items pass Stage 0
- **THEN** Stage 1 selects the top ~30 candidates for Stage 2 queue without invoking LLMs

### Requirement: Stage 2 — LLM Triage

Stage 2 MUST execute via the cheap model tier (`deepseek-v4-flash`) in batches against the channel profile's `selection_rules`, returning structured Zod output (`{ relevance, novelty, reason }`). The explanation (`triage_reason`) MUST be saved in the candidate record.

#### Scenario: Batched Triage with Explanations

- **WHEN** 30 candidates enter Stage 2
- **THEN** each receives structured relevance and novelty scores along with a human-readable reason; top 5–8 items advance to Stage 3

### Requirement: Stage 3 — Strict Daily Throughput Ceiling

Stage 3 (FactSheet + Draft synthesis) MUST enforce a hard daily limit of 5–6 candidates per channel — acting both as a budget guardrail and a human attention cap.

#### Scenario: Daily Throughput Cap Reached

- **WHEN** Stage 3 has synthesized the maximum allotted candidate drafts for the day
- **THEN** remaining candidates wait in the pool for the next cycle, and further FactSheet generation halts

### Requirement: Granular Total Score Components

The overall `score_total` MUST be calculated as a weighted sum: $w_1 \cdot \text{relevance} + w_2 \cdot \text{novelty} + w_3 \cdot \text{importance} + w_4 \cdot \text{freshness} + w_5 \cdot \text{source\_trust} - w_6 \cdot \text{diversity\_penalty}$. All components and weights MUST be persisted into `score_components` for transparency and explainability.

#### Scenario: Explaining Top Ranking

- **WHEN** the owner asks why a particular candidate ranked first
- **THEN** the exact contribution of each component to `score_total` is retrieved from `channel_candidates`

### Requirement: Exponential Freshness Decay per Format

`freshness` MUST decay exponentially based on the half-life configured in `post_formats` (e.g. 6 hours for fast lane, 120 hours for slow lane).

#### Scenario: Fast Lane Item Decays Rapidly

- **WHEN** a breaking candidate reaches 24 hours of age with a 6-hour half-life
- **THEN** its freshness drops to $1/16$ of its initial value, moving it down in ranking

### Requirement: Batch Diversification via MMR

A `diversity_penalty` MUST be applied across the top batch candidates using Maximal Marginal Relevance (MMR): if multiple top candidates cover identical topics, secondary duplicates are demoted so the owner receives a diverse selection.

#### Scenario: Redundant Clones Demoted

- **WHEN** 4 of the top 5 candidates cover the same product announcement
- **THEN** the MMR penalty demotes duplicates, allowing diverse tech topics to enter the top 5 batch

### Requirement: External Engagement Signals

HackerNews points, Reddit upvotes, and GitHub star velocity MUST be stored in `external_signals` and incorporated into `importance` as a reliable cold-start quality proxy.

#### Scenario: Viral GitHub Repository

- **WHEN** the GitHub adapter detects an anomalous star growth velocity for a repository
- **THEN** `peak_external_signal` increases the importance score of the corresponding Story
