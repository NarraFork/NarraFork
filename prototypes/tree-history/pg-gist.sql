-- Optional: a GiST index over (parent_id, seq range) on the version rows (needs btree_gist).
\set QUIET on
SET jit = off;
CREATE EXTENSION IF NOT EXISTS btree_gist;
\timing on
CREATE INDEX IF NOT EXISTS idx_v_parent_gist ON versions USING gist (parent_id, int4range(from_seq, to_seq));
\timing off
ANALYZE versions;
SELECT pg_size_pretty(pg_relation_size('idx_v_parent_gist')) AS gist_size;
DO $$
DECLARE q text := 'SELECT v.block_id, v.order_key, v.content FROM versions v
    WHERE v.parent_id = %L AND int4range(v.from_seq, v.to_seq) @> $1 AND v.deleted = 0 ORDER BY v.order_key LIMIT 50';
BEGIN
  SET LOCAL enable_seqscan = off;
  PERFORM bench('A  GiST (parent_id, seq range): hot parent', format(q, m('hot.parent')), m('hot.ready')::int, 100);
  PERFORM bench('A  GiST (parent_id, seq range): children of s2000', format(q, m('s2000')), m('s2000.ready')::int, 100);
  PERFORM bench('A  GiST (parent_id, seq range): children of s10000', format(q, m('s10000')), m('s10000.ready')::int, 100);
END $$;
EXPLAIN (COSTS OFF) SELECT v.block_id FROM versions v WHERE v.parent_id = 'x' AND int4range(v.from_seq, v.to_seq) @> 5 AND v.deleted = 0;
