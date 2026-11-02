import type { Generated, ColumnType } from 'kysely';

/** timestamptz nullable: читаем Date|null, пишем Date|null. */
type NullableTimestamp = ColumnType<Date | null, Date | null, Date | null>;
/** numeric nullable: читаем строкой|null, пишем числом/строкой|null. */
type NullableNumeric = ColumnType<string | null, number | string | null, number | string | null>;
/** numeric NOT NULL: читаем строкой, пишем числом/строкой. */
type Numeric = ColumnType<string, number | string, number | string>;
/** bigint NOT NULL: node-postgres возвращает строкой, пишем строкой. */
type BigIntCol = ColumnType<string, string, string>;
/** bigint nullable: node-postgres возвращает строкой, пишем строкой. */
type NullableBigInt = ColumnType<string | null, string | null, string | null>;
/** vector(1024): вставляем/читаем как строку '[1,2,...]'. */
type Vector = ColumnType<string | null, string | null, string | null>;

export interface ChannelsTable {
  id: Generated<string>;
  slug: string;
  tg_chat_id: NullableBigInt;
  tg_bot_token: string | null;
  title: string;
  target_lang: Generated<string>;
  source_langs: Generated<string[] | null>;
  status: Generated<string>;
  created_at: Generated<Date>;
}

export interface ChannelProfilesTable {
  id: Generated<string>;
  channel_id: string;
  version: number;
  manifesto: string;
  selection_rules: string;
  style_guide: string;
  taboos: string[] | null;
  domain_blacklist: unknown;
  profile_vector: Vector;
  score_weights: unknown;
  created_at: Generated<Date>;
  created_by: string;
  changelog: string;
}

export interface PostFormatsTable {
  id: Generated<string>;
  channel_id: string;
  slug: string;
  lane: string;
  prompt_template: string;
  target_length: number;
  freshness_half_life_hours: number;
  cadence: unknown;
  daily_cap: number;
}

export interface SourcesTable {
  id: Generated<string>;
  type: string;
  adapter: string;
  config: unknown;
  channel_ids: string[] | null;
  poll_interval_s: Generated<number>;
  cursor: unknown;
  trust_score: Generated<string>;
  status: Generated<string>;
  error_count: Generated<number>;
  last_ok_at: NullableTimestamp;
  last_error: string | null;
  last_error_at: NullableTimestamp;
}

export interface SourceStatsTable {
  source_id: string;
  window_start: string;
  items_found: number;
  items_approved: number;
  items_rejected: number;
  avg_edit_distance: NullableNumeric;
  avg_post_err: NullableNumeric;
}

export interface StoriesTable {
  id: Generated<string>;
  centroid: Vector;
  first_seen_at: Generated<Date>;
  last_seen_at: Generated<Date>;
  item_count: Generated<number>;
  source_diversity: Generated<number>;
  velocity: Generated<number>;
  peak_external_signal: Generated<number>;
}

export interface ItemsTable {
  id: Generated<string>;
  source_id: string;
  external_id: string;
  canonical_url: string;
  url_hash: string;
  content_hash: string | null;
  title: string;
  body_text: string;
  lang: string;
  author: string | null;
  published_at: NullableTimestamp;
  discovered_at: Generated<Date>;
  external_signals: unknown;
  embedding: Vector;
  raw_payload: unknown;
  story_id: string | null;
  fetch_status: string;
}

export interface ChannelCandidatesTable {
  id: Generated<string>;
  channel_id: string;
  story_id: string;
  format_id: string | null;
  profile_version: Generated<number>;
  score_total: NullableNumeric;
  score_components: unknown;
  triage_reason: string | null;
  stage: Generated<number>;
  status: Generated<string>;
  priority: Generated<string>;
  created_at: Generated<Date>;
}

export interface FactSheetsTable {
  id: Generated<string>;
  story_id: string;
  what_happened: string;
  who: string[] | null;
  numbers: unknown;
  key_quote: string | null;
  why_it_matters: string | null;
  primary_url: string;
  confidence: NullableNumeric;
  source_item_ids: string[] | null;
  created_at: Generated<Date>;
}

export interface DraftsTable {
  id: Generated<string>;
  candidate_id: string;
  fact_sheet_id: string | null;
  variant_n: number;
  model: string;
  profile_version: number;
  format_id: string | null;
  text: string;
  lang: string;
  cost_usd: Numeric;
  created_at: Generated<Date>;
}

export interface EditorialDecisionsTable {
  id: Generated<string>;
  draft_id: string;
  action: string;
  reject_reason: string | null;
  edited_text: string | null;
  edit_distance: NullableNumeric;
  forced: Generated<boolean>;
  decided_at: Generated<Date>;
  latency_s: number | null;
}

export interface PostsTable {
  id: Generated<string>;
  channel_id: string;
  draft_id: string;
  tg_message_id: NullableBigInt;
  final_text: string;
  published_at: Generated<Date>;
  subscribers_at_publish: number | null;
  autopublished: Generated<boolean>;
}

export interface MetricSnapshotsTable {
  post_id: string;
  captured_at: Generated<Date>;
  offset_hours: number;
  views: number | null;
  forwards: number | null;
  reactions: unknown;
  err: NullableNumeric;
}

export interface SubmissionsTable {
  id: Generated<string>;
  submitted_by: BigIntCol;
  role: string;
  payload_type: string;
  raw: string;
  channel_hint: string | null;
  priority: Generated<string>;
  status: Generated<string>;
  item_id: string | null;
  feedback_sent: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface ContributorsTable {
  tg_user_id: BigIntCol;
  first_seen_at: Generated<Date>;
  submissions_total: number;
  submissions_published: number;
  reputation: Numeric;
  banned: boolean;
}

export interface LlmCallsTable {
  id: Generated<string>;
  stage: string;
  channel_id: string | null;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: NullableNumeric;
  latency_ms: number | null;
  created_at: Generated<Date>;
}

export interface AgentRunsTable {
  id: Generated<string>;
  agent: string;
  idempotency_key: string;
  input: unknown;
  trace: unknown;
  output: unknown;
  steps: number | null;
  cost_usd: NullableNumeric;
  status: string;
  created_at: Generated<Date>;
}

export interface ProfileProposalsTable {
  id: Generated<string>;
  channel_id: string;
  proposed_diff: unknown;
  summary: string;
  justification: string;
  status: Generated<'pending' | 'accepted' | 'rejected'>;
  created_at: Generated<Date>;
  decided_at: Date | null;
}

export interface Database {
  channels: ChannelsTable;
  channel_profiles: ChannelProfilesTable;
  post_formats: PostFormatsTable;
  sources: SourcesTable;
  source_stats: SourceStatsTable;
  stories: StoriesTable;
  items: ItemsTable;
  channel_candidates: ChannelCandidatesTable;
  fact_sheets: FactSheetsTable;
  drafts: DraftsTable;
  editorial_decisions: EditorialDecisionsTable;
  posts: PostsTable;
  metric_snapshots: MetricSnapshotsTable;
  submissions: SubmissionsTable;
  contributors: ContributorsTable;
  llm_calls: LlmCallsTable;
  agent_runs: AgentRunsTable;
  profile_proposals: ProfileProposalsTable;
}
