## Purpose

Strict LLM expenditure governance under a firm $10/month cap: real-time accounting of every model invocation from Day 1, proactive threshold alerts, and automated suspension of the most token-intensive generation stage.

## Requirements

### Requirement: Granular LLM Invocation Accounting

Every single LLM call MUST be recorded into `llm_calls` with its pipeline stage (`triage`, `factsheet`, `factcheck`, `draft`, `analyst`), channel ID, model identifier, input/output token counts, computed USD cost, and latency.

#### Scenario: Triage Invocation Audited

- **WHEN** stage 2 performs an LLM batch triage call
- **THEN** a row is inserted into `llm_calls` capturing tokens, USD cost, stage label, and channel reference

### Requirement: Monthly Cap and Proactive Alerting

The system MUST track aggregated calendar month expenditures against the $10 budget ceiling and dispatch an alert to the channel owner's Telegram bot upon reaching 80% ($8.00).

#### Scenario: 80% Threshold Warning

- **WHEN** accumulated monthly spending crosses $8.00
- **THEN** the bot delivers a warning notification to the owner detailing spending breakdowns by stage

### Requirement: Stage 3 Automated Suspension

Upon reaching 100% ($10.00) of the monthly limit, Stage 3 (FactSheet + Draft synthesis) MUST automatically pause until the start of the next calendar month or an explicit manual override. Inexpensive ingestion and Stage 0-1 scoring continue operating.

#### Scenario: Budget Cap Reached

- **WHEN** monthly expenditures reach $10.00
- **THEN** new draft generations are suspended, pending candidates queue in the pool, and an auto-stop alert is delivered to the owner

### Requirement: Daily Candidate Throughput Limit

Stage 3 draft generation MUST be constrained by the channel's daily candidate limit (e.g. 5–6 candidates per day) as a structural component of budget discipline.

#### Scenario: Daily Cap Enforced

- **WHEN** monthly budget is well within bounds but the daily candidate cap is reached
- **THEN** further draft generation stops until the next scheduled batch window
