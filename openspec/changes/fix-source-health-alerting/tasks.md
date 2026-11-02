# Tasks: fix-source-health-alerting

- [x] 1. Migration `003_source_last_error_at.sql`: add `sources.last_error_at timestamptz`, backfill to `now()` for already-dead sources. Verification: `npm run migrate` runs cleanly and idempotently.
- [x] 2. Make the dead alert edge-triggered in `onError` (`src/sources/health.ts`). Verification: unit test asserting no alert on a source already in `dead`.
- [x] 3. Record `last_error_at` on every failed poll and keep re-throwing so the job is recorded as failed (`handlePollSource`). Verification: unit test asserting the error propagates and the health fields are written.
- [x] 4. Dispatch `poll-source` with `retryLimit: 0` (`src/process/scheduler.ts`). Verification: one dispatched job charges at most one error.
- [x] 5. Extract due-source selection into `selectDueSources` (`src/db/repo/sources.ts`), measuring the interval from the later of `last_ok_at` / `last_error_at` and retrying dead sources after `DEAD_RETRY_INTERVAL_S`. Verification: integration test over healthy / never-polled / recently-failed / stale-failed / recently-dead / stale-dead sources.
- [x] 6. Sync `docs/telegram-content-engine-spec.md` §4.2 DDL with the new column.
