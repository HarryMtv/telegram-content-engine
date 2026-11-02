# Fix Source Health Alerting and Dead-Source Recovery

## Why

A single upstream outage (HN Algolia returning HTTP 500 for the whole `api/v1` host) produced roughly twelve identical Telegram alerts for one source — `Источник … перешёл в статус dead после 21 ошибок` — and then left that source permanently dead after the upstream recovered.

Three defects combined:

1. **Alerting was level-triggered, not edge-triggered.** `onError` returned `notify: true` for *every* failure at or above the dead threshold, not only on the transition into `dead`, so each subsequent failure re-alerted the owner.
2. **Job retries amplified the error counter.** The `poll-source` handler re-threw after recording the failure while the job was sent with `retryLimit: 3`, so one dispatched job charged up to four consecutive errors against the source.
3. **The polling interval was measured from the last success.** `last_ok_at` is not updated on failure, so a failing source stayed overdue on every one-minute tick and burned through the degraded/dead thresholds in minutes rather than hours.

The existing spec already required "WHEN a previously dead source returns a valid 200 OK response **on retry** THEN status returns to `healthy`", but the scheduler filtered `status <> 'dead'` out of the due-source query, so that retry never happened — the recovery scenario was unreachable.

## What Changes

- **Edge-triggered alerting**: the owner is alerted once, on the transition into `dead`. Further failures of an already-dead source update `last_error`/`error_count` silently.
- **No retry amplification**: `poll-source` is dispatched with `retryLimit: 0`. The handler still throws on failure, so the job is recorded as failed rather than silently completed — the next attempt is scheduled by the regular tick, not by a queue retry.
- **Attempt-based scheduling**: a new `sources.last_error_at` column records the last failed attempt. Due-source selection measures the interval from the later of `last_ok_at` and `last_error_at`, so a failing source is retried on its own `poll_interval_s` instead of every tick.
- **Dead-source revival**: dead sources are no longer excluded from polling. They are retried on a fixed cooldown (`DEAD_RETRY_INTERVAL_S`, 6 hours); a successful poll restores `healthy` and resets the counter, which is what makes the pre-existing Automatic Health Recovery scenario reachable.

## Non-goals

- Falling back to the official HackerNews Firebase API when Algolia is unavailable. It carries no tag search and needs one request per item; it is a separate change.
- Closing the read-modify-write race in `onError`: two overlapping polls of the same source can still both observe the pre-transition row and both alert. Attempt-based scheduling narrows the window; an atomic `UPDATE … WHERE status <> 'dead' RETURNING` would close it.
- Bounding `error_count`, which still grows without limit for a permanently dead source.

## Impact

- **Specs**: `source-adapters` — Watermark Cursor and Interval Tracking, Source Health Degradation State Machine.
- **Schema**: `sources.last_error_at timestamptz` (migration `003_source_last_error_at.sql`, backfilled to `now()` for already-dead sources so they do not all retry at once on deploy).
- **Code**: `src/sources/health.ts`, `src/queue/handlers.ts` (`handlePollSource`), `src/process/scheduler.ts`, new `src/db/repo/sources.ts` (`selectDueSources`).
- **Docs**: `docs/telegram-content-engine-spec.md` §4.2 DDL.
