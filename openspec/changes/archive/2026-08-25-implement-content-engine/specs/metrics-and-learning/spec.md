## Purpose

Systematic post metric collection from Day 1 and continuous system learning from human editorial decisions without model fine-tuning: dynamic `source_trust`, versioned channel constitutions, few-shot generation from top-performing posts, and disciplined entry of engagement signals into the feedback loop.

## Requirements

### Requirement: Granular Post Metric Snapshots

The system MUST capture metric time series for every published post at offsets of approximately +1h, +6h, +24h, and +72h: `views`, `forwards`, `reactions` (structured by emoji type), and computed `err` (Engagement Rate by Reach) relative to `subscribers_at_publish`. Since retroactive metric extraction is unreliable, collection commences on post 1.

#### Scenario: Metric Snapshots Recorded on Schedule

- **WHEN** 24 hours elapse following post publication
- **THEN** the MTProto worker extracts views, forwards, and emoji reaction breakdowns at `offset_hours=24` and writes `err` to `metric_snapshots`

### Requirement: Semantic Reaction Classification

The channel reaction palette MUST differentiate content topic from presentation style: 🔥 (exceptional topic), 👍 (satisfactory), 😴 (boring). Generic unstructured likes are omitted.

#### Scenario: Style Issue Differentiated from Topic Selection

- **WHEN** a post receives multiple 😴 reactions with no 🔥 reactions
- **THEN** analytics identify a presentation/style deficiency rather than poor topic selection, targeting feedback directly to `style_guide`

### Requirement: Metric Feedback Guard (< 200 Posts)

While reaction breakdowns and forwards MUST be recorded from Day 1, they MUST NOT enter the decision-making loop until the channel has accumulated at least ~200 published posts with statistically sound ERR data. Prior to this threshold, reaction-driven weight updates are disabled.

#### Scenario: Early Stage Metric Isolation

- **WHEN** a channel has 50 subscribers and 2–5 reactions per post
- **THEN** metric snapshots persist into the database, but neither score weights nor profile vectors are altered

### Requirement: Dynamic Source Trust

The engine MUST maintain rolling source trust metrics computed from approval rates, average `edit_distance`, and downstream ERR in `source_stats`. High-quality sources automatically rise in priority while noisy feeds decline without manual intervention.

#### Scenario: Noisy Feed Deprioritized

- **WHEN** a feed generates high volume but its candidates are consistently rejected as off-topic
- **THEN** its `source_trust` decays, causing future items to lose ranking in Stage 1 numerical scoring

### Requirement: Versioned Channel Constitution

The channel profile (`manifesto`, `selection_rules`, `style_guide`, `taboos`, `profile_vector`, `score_weights`) MUST be versioned in `channel_profiles` with changelogs. Amendments apply exclusively via explicit owner confirmation. Every generated draft MUST record the exact `profile_version` under which it was generated.

#### Scenario: Constitution Version Bump

- **WHEN** the owner approves a constitution amendment proposed by the Analyst agent
- **THEN** a new row is created in `channel_profiles` with `version + 1` and changelog; subsequent drafts are authored per the updated version

### Requirement: Dynamic Few-Shot Prompt Injection

Draft generation prompts MUST dynamically inject the channel's 3–5 highest-performing historical posts by ERR as few-shot stylistic examples.

#### Scenario: Top Posts Injected into Prompt

- **WHEN** a new draft is generated
- **THEN** the generation prompt includes the channel's top-ERR posts as exemplar formatting references
