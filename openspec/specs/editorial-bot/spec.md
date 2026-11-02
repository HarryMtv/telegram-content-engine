## Purpose

The primary user interface of the system — the channel owner's Telegram Bot: daily candidate batches with interactive inline keyboards, draft manipulation actions, structured rejection taxonomy, edit diff recording, and automated channel publication.

## Requirements

### Requirement: Daily Channel Batch Delivery

The bot MUST deliver one consolidated batch per day per channel: top 5 candidates containing draft previews, computed score components, triage reasons, and inline action buttons. Fast-lane breaking candidates trigger immediate isolated notifications. The interface MUST support swift keyboard navigation with minimal screen transitions.

#### Scenario: Morning Batch Arrival

- **WHEN** the scheduled channel batch time arrives
- **THEN** the bot delivers the top 5 candidates displaying draft text, primary source URLs, `score_components`, and action buttons under each candidate

### Requirement: Editorial Candidate Actions

The bot MUST support 6 core editorial actions:
1. **Publish** — posts formatted draft directly to the Telegram channel as-is.
2. **Edit & Publish** — editor replies with modified text $\to$ diff and `edit_distance` recorded.
3. **Another Variant** — lazily synthesizes draft `variant_n + 1`.
4. **Rewrite Better** — dispatches prompt to `deepseek-v4-pro` in **Thinking Mode**.
5. **Reject** — requires selecting a reason from the 7-point taxonomy.
6. **Defer** — returns story to candidate pool with downgraded priority.

#### Scenario: Edit and Publish Flow

- **WHEN** the owner clicks "Edit & Publish" and submits modified text
- **THEN** the bot publishes the final text to the channel and persists both versions along with computed Levenshtein `edit_distance` in `editorial_decisions`

#### Scenario: Defer Candidate

- **WHEN** the owner selects "Defer"
- **THEN** the candidate is returned to the active pool with reduced priority, remaining available for future batches until format window expiration

### Requirement: Rejection Taxonomy

Rejection MUST require selecting an explicit reason from the 7-point taxonomy: `off_topic`, `duplicate`, `not_news_boring`, `poor_style`, `unreliable_source`, `too_long`, `wrong_tone`. Each reason is mapped to a tunable subsystem (`profile_vector`/`selection_rules`, deduplication window, `importance` weight, `style_guide`, `source_trust`, `target_length`).

#### Scenario: Source Trust Feedback

- **WHEN** the owner rejects a candidate selecting `unreliable_source`
- **THEN** `reject_reason=unreliable_source` is saved in `editorial_decisions`, automatically penalizing future `source_trust` for that source

### Requirement: Edit Diff Tracking

When publishing an edited draft, the system MUST record both versions (original draft and final text) alongside computed `edit_distance` to serve as high-signal stylistic training data from Day 1.

#### Scenario: Style Diffs Available for Analysis

- **WHEN** the Analyst agent examines weekly editorial decisions
- **THEN** every edited post includes the original draft, final published text, and edit distance metric

### Requirement: Telegram Channel Publication

Upon executing "Publish", the bot MUST post the formatted text to the configured Telegram channel and record `tg_message_id`, `final_text`, `published_at`, and `subscribers_at_publish`.

#### Scenario: Post Recorded in History

- **WHEN** the owner confirms publication
- **THEN** the post appears in the Telegram channel, a row is created in `posts`, and the story is marked as published and removed from candidate pools

### Requirement: Explicit Recommendation Override

Actions taken contrary to algorithmic recommendations (publishing a low-scoring candidate or rejecting a top-scored candidate) MUST be recorded with the `forced=true` flag.

#### Scenario: Publishing Contrary to Score

- **WHEN** the owner overrides the scoring funnel to publish a low-relevance item
- **THEN** the decision records `forced=true` to provide training counter-examples

### Requirement: Operational Bot Notifications

The bot MUST proactively alert the owner regarding: source degradation or dead status, items requiring manual text input (`fetch_status=manual_needed`), fact-checking discrepancy warnings, and budget thresholds.

#### Scenario: Manual Text Input Prompt

- **WHEN** an item enters `manual_needed` due to anti-scraping paywalls
- **THEN** the bot sends the URL requesting manual text paste; owner reply resumes the pipeline seamlessly
