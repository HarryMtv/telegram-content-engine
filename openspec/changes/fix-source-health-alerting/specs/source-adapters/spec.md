## MODIFIED Requirements

### Requirement: Watermark Cursor and Interval Tracking

Each source record MUST persist its cursor watermark (`last_id` / `last_ts`), polling interval (`poll_interval_s`), consecutive error count, health status, the timestamp of its last successful poll (`last_ok_at`), and the timestamp of its last failed attempt (`last_error_at`). Subsequent polling cycles MUST resume from the watermark rather than re-evaluating historical feeds.

Due-source selection MUST measure the polling interval from the last *attempt* — the later of `last_ok_at` and `last_error_at` — rather than from the last success. A source that has never been attempted (both timestamps null) is due immediately.

#### Scenario: Polling Resumes from Watermark

- **WHEN** a source is polled following a previous successful cycle
- **THEN** only items newer than the stored watermark timestamp/ID are processed

#### Scenario: Failing Source Respects Its Polling Interval

- **WHEN** a source fails a poll and the dispatcher tick runs again before `poll_interval_s` has elapsed since that failure
- **THEN** the source is not selected for polling, because the interval is measured from `last_error_at` and not from the older `last_ok_at`

### Requirement: Source Health Degradation State Machine

A source failing to return valid responses $N$ times consecutively MUST transition to `degraded`, and upon further failures to `dead`, triggering an alert to the owner via Telegram bot. Successful polling restores `healthy` status, resets errors, and updates `last_ok_at`. Silent failures are prohibited.

The owner alert MUST be edge-triggered: it fires on the transition into `dead` and MUST NOT repeat for subsequent failures of a source that is already `dead`. Every failure, alerted or not, MUST still record `last_error`, `last_error_at`, and the incremented error count, and MUST still surface the poll job as failed rather than completed.

A failed poll MUST NOT be retried by the job queue. One dispatched poll job therefore charges at most one error against the source; the next attempt is scheduled by the regular dispatcher tick.

Sources in `dead` state MUST remain eligible for polling on a fixed retry cooldown, so that recovery of the upstream service restores the source without operator intervention.

#### Scenario: Dead Source Alerting

- **WHEN** an RSS feed fails repeatedly beyond the configured error threshold
- **THEN** status transitions to `dead`, the underlying exception is logged in `last_error`, and the bot alerts the owner

#### Scenario: Dead Source Alerts Exactly Once

- **WHEN** a source that is already `dead` fails another poll
- **THEN** `error_count`, `last_error`, and `last_error_at` are updated and the job is recorded as failed, but no further owner alert is sent

#### Scenario: Automatic Health Recovery

- **WHEN** a previously dead source returns a valid 200 OK response on retry
- **THEN** status returns to `healthy`, error counters reset to zero, and `last_ok_at` is updated

#### Scenario: Dead Source Is Retried After Cooldown

- **WHEN** the retry cooldown has elapsed since a dead source's last failed attempt
- **THEN** the source is selected for polling again, making the Automatic Health Recovery scenario reachable without operator intervention
