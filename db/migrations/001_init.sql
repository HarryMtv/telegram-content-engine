-- Telegram Content Engine: полная схема v1 (спека §4).
-- Все дальнейшие изменения — только новыми миграциями (forward-only, additive-first).

CREATE EXTENSION IF NOT EXISTS vector;

-- === 4.1. Каналы и конфигурация ===

CREATE TABLE channels (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  tg_chat_id      bigint,
  tg_bot_token    text,
  title           text NOT NULL,
  target_lang     text NOT NULL DEFAULT 'ru',
  source_langs    text[] NOT NULL DEFAULT '{en,ru}',
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('active', 'paused', 'draft')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE channel_profiles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      uuid NOT NULL REFERENCES channels(id),
  version         int NOT NULL,
  manifesto       text NOT NULL DEFAULT '',
  selection_rules text NOT NULL DEFAULT '',
  style_guide     text NOT NULL DEFAULT '',
  taboos          text[] NOT NULL DEFAULT '{}',
  domain_blacklist jsonb NOT NULL DEFAULT '[]'::jsonb,
  profile_vector  vector(1024),
  score_weights   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text NOT NULL DEFAULT 'owner',
  changelog       text NOT NULL DEFAULT '',
  UNIQUE (channel_id, version)
);

CREATE TABLE post_formats (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id                uuid NOT NULL REFERENCES channels(id),
  slug                      text NOT NULL,
  lane                      text NOT NULL CHECK (lane IN ('fast', 'slow')),
  prompt_template           text NOT NULL DEFAULT '',
  target_length             int NOT NULL DEFAULT 1024,
  freshness_half_life_hours int NOT NULL DEFAULT 120,
  cadence                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  daily_cap                 int NOT NULL DEFAULT 5,
  UNIQUE (channel_id, slug)
);

-- === 4.2. Источники ===

CREATE TABLE sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type            text NOT NULL CHECK (type IN ('rss', 'api', 'search', 'telegram', 'manual')),
  adapter         text NOT NULL,
  config          jsonb NOT NULL,
  channel_ids     uuid[],
  poll_interval_s int NOT NULL DEFAULT 600,
  cursor          jsonb,
  trust_score     numeric NOT NULL DEFAULT 0.5 CHECK (trust_score >= 0 AND trust_score <= 1),
  status          text NOT NULL DEFAULT 'healthy'
                  CHECK (status IN ('healthy', 'degraded', 'dead')),
  error_count     int NOT NULL DEFAULT 0,
  last_ok_at      timestamptz,
  last_error      text
);

-- стабильный ключ в config для идемпотентного сида
CREATE UNIQUE INDEX sources_adapter_key_uidx
  ON sources (adapter, (config->>'key')) WHERE config->>'key' IS NOT NULL;

CREATE INDEX sources_status_idx ON sources (status);

CREATE TABLE source_stats (
  source_id       uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  window_start    date NOT NULL,
  items_found     int NOT NULL DEFAULT 0,
  items_approved  int NOT NULL DEFAULT 0,
  items_rejected  int NOT NULL DEFAULT 0,
  avg_edit_distance numeric,
  avg_post_err    numeric,
  PRIMARY KEY (source_id, window_start)
);

-- === 4.3. Материалы и сюжеты ===

CREATE TABLE stories (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  centroid              vector(1024),
  first_seen_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  item_count            int NOT NULL DEFAULT 0,
  source_diversity      int NOT NULL DEFAULT 0,
  velocity              numeric NOT NULL DEFAULT 0,
  peak_external_signal  numeric NOT NULL DEFAULT 0
);

CREATE INDEX stories_last_seen_idx ON stories (last_seen_at DESC);
CREATE INDEX stories_centroid_hnsw ON stories USING hnsw (centroid vector_cosine_ops);

CREATE TABLE items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id         uuid NOT NULL REFERENCES sources(id),
  external_id       text NOT NULL,
  canonical_url     text NOT NULL,
  url_hash          text NOT NULL,
  content_hash      text,
  title             text NOT NULL,
  body_text         text NOT NULL DEFAULT '',
  lang              text NOT NULL DEFAULT 'unknown',
  author            text,
  published_at      timestamptz,
  discovered_at     timestamptz NOT NULL DEFAULT now(),
  external_signals  jsonb,
  embedding         vector(1024),
  raw_payload       jsonb,
  story_id          uuid REFERENCES stories(id),
  fetch_status      text NOT NULL DEFAULT 'pending'
                    CHECK (fetch_status IN ('pending', 'ok', 'failed', 'manual_needed')),
  UNIQUE (source_id, external_id)
);

-- Слой 2 идентичности: один материал под разными ссылками
CREATE UNIQUE INDEX items_url_hash_uidx ON items (url_hash) WHERE url_hash IS NOT NULL;
-- Слой 1: точные дубли текста
CREATE UNIQUE INDEX items_content_hash_uidx ON items (content_hash) WHERE content_hash IS NOT NULL;

CREATE INDEX items_story_idx ON items (story_id);
CREATE INDEX items_published_idx ON items (published_at DESC);
CREATE INDEX items_embedding_hnsw ON items USING hnsw (embedding vector_cosine_ops);

-- === 4.4. Кандидаты, черновики, решения ===

CREATE TABLE channel_candidates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      uuid NOT NULL REFERENCES channels(id),
  story_id        uuid NOT NULL REFERENCES stories(id),
  format_id       uuid REFERENCES post_formats(id),
  profile_version int NOT NULL DEFAULT 1,
  score_total     numeric,
  score_components jsonb,
  triage_reason   text,
  stage           int NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'pool'
                  CHECK (status IN ('pool', 'queued', 'drafted', 'decided', 'expired')),
  priority        text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX candidates_channel_status_idx ON channel_candidates (channel_id, status);
CREATE INDEX candidates_story_idx ON channel_candidates (story_id);
CREATE UNIQUE INDEX candidates_channel_story_uidx ON channel_candidates (channel_id, story_id);

CREATE TABLE fact_sheets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id        uuid NOT NULL REFERENCES stories(id),
  what_happened   text NOT NULL,
  who             text[] NOT NULL DEFAULT '{}',
  numbers         jsonb NOT NULL DEFAULT '{}'::jsonb,
  key_quote       text,
  why_it_matters  text,
  primary_url     text NOT NULL,
  confidence      numeric,
  source_item_ids uuid[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX fact_sheets_story_idx ON fact_sheets (story_id);

CREATE TABLE drafts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id    uuid NOT NULL REFERENCES channel_candidates(id),
  fact_sheet_id   uuid REFERENCES fact_sheets(id),
  variant_n       int NOT NULL DEFAULT 1,
  model           text NOT NULL,
  profile_version int NOT NULL DEFAULT 1,
  format_id       uuid REFERENCES post_formats(id),
  text            text NOT NULL,
  lang            text NOT NULL,
  cost_usd        numeric NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX drafts_candidate_variant_uidx ON drafts (candidate_id, variant_n);

CREATE TABLE editorial_decisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id        uuid NOT NULL REFERENCES drafts(id),
  action          text NOT NULL
                  CHECK (action IN ('publish', 'reject', 'regenerate', 'defer')),
  reject_reason   text,
  edited_text     text,
  edit_distance   numeric,
  forced          boolean NOT NULL DEFAULT false,
  decided_at      timestamptz NOT NULL DEFAULT now(),
  latency_s       int
);

CREATE INDEX decisions_draft_idx ON editorial_decisions (draft_id);
CREATE INDEX decisions_decided_idx ON editorial_decisions (decided_at DESC);

CREATE TABLE posts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id              uuid NOT NULL REFERENCES channels(id),
  draft_id                uuid NOT NULL REFERENCES drafts(id),
  tg_message_id           bigint,
  final_text              text NOT NULL,
  published_at            timestamptz NOT NULL DEFAULT now(),
  subscribers_at_publish  int,
  autopublished           boolean NOT NULL DEFAULT false
);

CREATE INDEX posts_channel_idx ON posts (channel_id, published_at DESC);

CREATE TABLE metric_snapshots (
  post_id         uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  captured_at     timestamptz NOT NULL DEFAULT now(),
  offset_hours    int NOT NULL CHECK (offset_hours IN (1, 6, 24, 72)),
  views           int,
  forwards        int,
  reactions       jsonb,
  err             numeric,
  PRIMARY KEY (post_id, offset_hours)
);

-- === 4.5. Предложка и ручной ингест ===

CREATE TABLE submissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submitted_by    bigint NOT NULL,
  role            text NOT NULL CHECK (role IN ('owner', 'contributor')),
  payload_type    text NOT NULL CHECK (payload_type IN ('url', 'text', 'forward', 'file')),
  raw             text NOT NULL,
  channel_hint    uuid REFERENCES channels(id),
  priority        text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high')),
  status          text NOT NULL DEFAULT 'received'
                  CHECK (status IN ('received', 'duplicate', 'rejected', 'ingested', 'published')),
  item_id         uuid REFERENCES items(id),
  feedback_sent   boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX submissions_submitter_idx ON submissions (submitted_by, created_at DESC);

CREATE TABLE contributors (
  tg_user_id              bigint PRIMARY KEY,
  first_seen_at           timestamptz NOT NULL DEFAULT now(),
  submissions_total       int NOT NULL DEFAULT 0,
  submissions_published   int NOT NULL DEFAULT 0,
  reputation              numeric NOT NULL DEFAULT 0,
  banned                  boolean NOT NULL DEFAULT false
);

-- === 4.6. Наблюдаемость ===

CREATE TABLE llm_calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage           text NOT NULL,
  channel_id      uuid,
  model           text NOT NULL,
  input_tokens    int,
  output_tokens   int,
  cost_usd        numeric,
  latency_ms      int,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX llm_calls_created_idx ON llm_calls (created_at DESC);

CREATE TABLE agent_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent           text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  input           jsonb,
  trace           jsonb,
  output          jsonb,
  steps           int,
  cost_usd        numeric,
  status          text NOT NULL CHECK (status IN ('ok', 'timeout', 'budget_exceeded', 'failed')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_runs_created_idx ON agent_runs (created_at DESC);
