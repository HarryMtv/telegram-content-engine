-- M4 (Task 4.6): предложения Analyst по конституции канала.
-- Джоба аналитика сохраняет диф сюда, кнопки в боте ссылаются на id предложения
-- (callback_data Telegram ограничена 64 байтами — сам диф туда не помещается).

CREATE TABLE profile_proposals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      uuid NOT NULL REFERENCES channels(id),
  proposed_diff   jsonb NOT NULL,
  summary         text NOT NULL DEFAULT '',
  justification   text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz
);

CREATE INDEX profile_proposals_channel_idx ON profile_proposals (channel_id, status);
