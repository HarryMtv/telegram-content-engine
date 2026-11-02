## Purpose

Normalizing all heterogeneous inputs into a canonical `RawItem` schema, robust URL canonicalization, and three-layer identity resolution (exact content hash $\to$ canonical URL hash $\to$ cross-lingual semantic Story cluster).

## Requirements

### Requirement: Uniform Normalization to RawItem

Every incoming material — whether originating from a background adapter, manual bot ingest, forwarded post, or HTTP API submission — MUST traverse an identical normalization pipeline into the `RawItem` structure: `canonical_url`, `external_id`, `source_id`, `title`, `body_text`, `lang`, `published_at`, `discovered_at`, `author`, `external_signals`, `raw_payload`, and `content_hash`. The language MUST be identified via automated text detection rather than trusting source declarations.

#### Scenario: Unified Intake Path

- **WHEN** a URL arrives via RSS adapter, Telegram bot forward, or HTTP `/ingest` API
- **THEN** all three undergo identical normalization and persist into `items` under the same schema

#### Scenario: Text-Based Language Detection

- **WHEN** a feed metadata declares English but the actual article body is in Russian
- **THEN** the `lang` field stores the detected language code (`ru`)

### Requirement: URL Canonicalization

Before persistence, URLs MUST be canonicalized: stripping `utm_*` and marketing tracking parameters, unshortening redirection links, resolving AMP variants to standard web pages, and normalizing protocol/hostname casing. The `url_hash` is computed from this canonical URL string.

#### Scenario: Tracking Parameters Deduplicated

- **WHEN** an article URL is submitted with `utm_source=twitter` and later without query parameters
- **THEN** both URLs normalize to the same `url_hash`, and the second insertion is safely discarded as a duplicate

### Requirement: Layer 1 — Exact Content Hash Deduplication

Exact binary text duplicates MUST be filtered out at insertion time via `content_hash`.

#### Scenario: Identical Text from Multiple Feeds

- **WHEN** two distinct feeds syndicate byte-for-byte identical article bodies
- **THEN** only the first ingested item is retained

### Requirement: Layer 2 — Canonical URL Hash Deduplication

Multiple links pointing to the same canonical article resource MUST be recognized via `url_hash` to prevent duplicate item creation.

#### Scenario: Shortlink and Direct Link Collide

- **WHEN** a shortened link (`t.co/...`) and its destination URL are ingested
- **THEN** following redirect resolution, their `url_hash` values match, preventing duplicate processing

### Requirement: Layer 3 — Semantic Story Clustering

Related items covering the same underlying technical event (across diverse sources and languages) MUST be clustered into a unified `Story` using cosine similarity over multilingual embeddings. Embeddings MUST be multilingual (`embed-multilingual-v3.0`, 1024d). The clustering threshold is configurable (starting at 0.82). Each `Story` MUST track cluster dynamics: `item_count`, `source_diversity`, `velocity`, and `peak_external_signal`.

#### Scenario: Cross-Lingual Story Clustering

- **WHEN** an English research paper and a Russian technical summary enter the pipeline
- **THEN** the cosine similarity between their embeddings exceeds the threshold, and both items join the same `Story` cluster

#### Scenario: Stories are Published, Not Items

- **WHEN** a Story has already been published and new syndicate items arrive for that story
- **THEN** duplicate candidate publication is prevented because editorial decisions operate on Stories

### Requirement: Cluster-Derived Importance Score

Story importance MUST be computed deterministically as a function of `item_count`, `source_diversity`, `velocity`, and `peak_external_signal` without requiring external trend prediction services.

#### Scenario: Velocity Triggers High Importance

- **WHEN** 7 independent sources cover a breakthrough within a 3-hour window
- **THEN** `velocity` and `source_diversity` generate a high importance score without requiring LLM calls
