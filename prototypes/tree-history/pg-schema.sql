-- The application's shapes (drizzle-postgres: text ids, the same indexes), plus edges and touch.
CREATE TABLE commits (id text PRIMARY KEY, space_id text NOT NULL, seq integer NOT NULL, kind text NOT NULL,
  actor_kind text NOT NULL, actor_id text NOT NULL, responsible_user_id text, narrator_id text, message_id text,
  tool_call_id text, created_at text NOT NULL, summary text NOT NULL);
CREATE TABLE blocks (id text PRIMARY KEY, space_id text NOT NULL, sid text NOT NULL, parent_id text, page_id text NOT NULL,
  order_key text COLLATE "C" NOT NULL, content text NOT NULL, content_hash text NOT NULL, alias text, task_json jsonb, ask_json jsonb,
  author_kind text NOT NULL, author_id text NOT NULL, version_seq integer NOT NULL, deleted integer NOT NULL DEFAULT 0,
  in_process integer NOT NULL DEFAULT 0);
CREATE TABLE versions (block_id text NOT NULL, from_seq integer NOT NULL, to_seq integer, commit_id text NOT NULL,
  page_id text NOT NULL, parent_id text, order_key text COLLATE "C" NOT NULL, content text, task_json jsonb, ask_json jsonb,
  alias text, content_hash text NOT NULL, change_flags integer NOT NULL, deleted integer NOT NULL);
CREATE TABLE edges (parent_key text NOT NULL, block_id text NOT NULL, from_seq integer NOT NULL, to_seq integer,
  order_key text COLLATE "C" NOT NULL);
CREATE TABLE touch (ancestor_id text NOT NULL, seq integer NOT NULL);
CREATE TABLE meta (k text PRIMARY KEY, v text NOT NULL);
