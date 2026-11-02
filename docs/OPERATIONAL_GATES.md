# 🎯 Operational Gates & Readiness Criteria (M0–M5)

This document defines the real-world operational milestones and verification gates for live production operation of **Telegram Content Engine** on an active Telegram channel.

All engineering and code components (M1–M5) are fully implemented, verified with 116 Vitest unit tests, and deployed in Docker. The following gates are performed by the human editor during continuous channel operations.

---

## 📋 Operational Gates Checklist

### 1. 🔍 M0 — Content Hypothesis Gate
- [ ] **0.1** Manually execute 3 days of exploratory search queries for the channel domain; record the fraction of viable articles in `docs/m0-results.md`.
  - *Gate:* If viable articles < 2 out of 10, recalibrate source feeds and keywords in `sources`. Automating a weak input stream cannot improve channel quality.

### 2. 📊 M2 — Autonomous Curation Readiness
- [ ] **2.20** One full week of pipeline operation without manual intervention in article curation.
  - *Gate:* Reliable daily delivery of candidate batches to the Telegram bot, logging editor decisions in `editorial_decisions`, and stable metric accumulation.

### 3. 📥 M3 — Manual Ingest & Metric Verification
- [ ] **3.11** End-to-end manual ingest run (Owner $\to$ Bot $\to$ Channel Post) and gap-free metric collection over 7 consecutive days.
  - *Gate:* 4 metric snapshots (+1h, +6h, +24h, +72h) successfully recorded in `metric_snapshots` for every published post, with accurate ERR calculation.

### 4. 🤖 M4 — Autonomous Agent Loop
- [ ] **4.8** First channel constitution amendment proposed by the **Analyst** agent and approved by the owner via Telegram bot on production data.
  - *Gate:* Analyst agent generates a concrete constitution diff based on rejection reasons and ERR analytics; owner confirms via inline button, incrementing profile to version $N+1$.

### 5. 🛡️ M5 — Second Channel & Shadow Mode Autopublish
- [ ] **5.5** Multi-channel production operation and accumulation of agreement data in **Shadow Mode**.
  - *Gate:* Rolling agreement percentage $\ge 85\%$ sustained across 14 consecutive days to qualify for automated publication of whitelisted sources.
