## Purpose

Autopublication as a privilege earned through measurable alignment with the channel owner's editorial decisions: shadow mode, agreement thresholds, strict operational constraints, and an immediate kill switch. By default, zero content is published without human approval.

## Requirements

### Requirement: Zero Autopublication by Default

The system MUST NOT publish any content without explicit human editorial approval. Agents and background workers have zero publication privileges across all default modes. Autopublication can only be enabled after a period of Shadow Mode evaluation when all preconditions are met.

#### Scenario: Agent Cannot Publish

- **WHEN** any agent or worker process attempts to initiate publication
- **THEN** the operation is rejected at the permission/service layer; publications can only be triggered by an owner action in the bot or an explicitly enabled autopublish service

### Requirement: Shadow Mode

In Shadow Mode, the system MUST record whether it would have published a given candidate, while maintaining standard manual editorial review, and accumulate the rolling agreement percentage with the owner's decisions.

#### Scenario: Disagreement Recorded

- **WHEN** the engine marks a candidate as `would_publish` and the owner rejects it
- **THEN** the divergence is recorded and incorporated into the rolling agreement rate

### Requirement: Autopublication Activation Preconditions

Autopublication MUST only be enabled when all 5 conditions are satisfied simultaneously:
1. Rolling agreement rate $\ge 85\%$ maintained consistently over 14 consecutive days.
2. Only sources from an explicit whitelist.
3. Only approved post formats.
4. Daily post volume limits strictly enforced.
5. Publication confined to configured daily time window (UTC).
6. Emergency kill switch operational.

#### Scenario: Activation Proposal After Two Weeks of Agreement

- **WHEN** agreement remains above 85% for two consecutive weeks
- **THEN** the system presents an autopublication enablement proposal in the bot with the full list of constraints, requiring explicit owner confirmation

### Requirement: Trust Reset on Auto-Post Rejection

Upon any owner rejection or cancellation of an autopublished post, the agreement counter MUST be reset to zero, and the journey toward autopublication restarts in Shadow Mode.

#### Scenario: Owner Rejects Auto-Post

- **WHEN** an autopublished post is rejected or manually revoked by the owner
- **THEN** the agreement streak resets to zero, and autopublication is demoted back to Shadow Mode

### Requirement: Emergency Kill Switch

The owner MUST have the ability to instantly deactivate autopublication with a single command (`/kill_switch`); upon activation, the system immediately returns to a 100% manual workflow.

#### Scenario: Emergency Deactivation

- **WHEN** the owner sends the kill switch command
- **THEN** all scheduled auto-drafts are cancelled, the channel reverts to manual mode, and a confirmation is sent to the owner
