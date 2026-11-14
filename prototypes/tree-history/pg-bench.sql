-- Server-side timings (no client, no tree building): each statement is run at random seqs of the
-- second half of history and its rows counted. Usage: psql -f pg-bench.sql
\set QUIET on
SET client_min_messages = notice;
SET jit = off;
CREATE OR REPLACE FUNCTION bench(label text, q text, ready int, runs int) RETURNS void AS $$
DECLARE
  last int := (SELECT v::int FROM meta WHERE k = 'lastSeq');
  lo int := greatest(ready, last / 2);
  t int; t0 timestamptz; ms float8[] := '{}'; n bigint; i int;
BEGIN
  PERFORM setseed(0.42);
  FOR i IN -2..runs LOOP
    t := lo + floor(random() * (last - lo))::int;
    t0 := clock_timestamp();
    EXECUTE 'SELECT count(*) FROM (' || q || ') x' INTO n USING t, greatest(t - 1000, 1);
    IF i > 0 THEN ms := ms || (extract(epoch FROM clock_timestamp() - t0) * 1000)::float8; END IF;
  END LOOP;
  RAISE NOTICE '% p50 % p95 % max % ms  n=%  (% rows)', rpad(label, 62),
    to_char((SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x) FROM unnest(ms) x), '9990.00'),
    to_char((SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY x) FROM unnest(ms) x), '9990.00'),
    to_char((SELECT max(x) FROM unnest(ms) x), '9990.00'), runs, n;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION m(key text) RETURNS text AS $$ SELECT v FROM meta WHERE k = key $$ LANGUAGE sql STABLE;

DO $$
DECLARE name text; root text; ready int; size int;
  p_struct text := 'SELECT v.block_id, b.sid, v.parent_id, v.order_key, v.alias, v.task_json, v.from_seq, v.ask_json
    FROM versions v JOIN blocks b ON b.id = v.block_id
    WHERE v.page_id = %L AND v.from_seq <= $1 AND (v.to_seq IS NULL OR v.to_seq > $1) AND v.deleted = 0';
  a_children text := 'SELECT v.block_id, v.order_key, v.content FROM versions v
    WHERE v.parent_id = %L AND v.from_seq <= $1 AND (v.to_seq IS NULL OR v.to_seq > $1) AND v.deleted = 0 ORDER BY v.order_key LIMIT 50';
  e_children text := 'SELECT e.block_id, e.order_key, v.content FROM
    (SELECT block_id, order_key FROM edges WHERE parent_key = %L AND from_seq <= $1 AND (to_seq IS NULL OR to_seq > $1) ORDER BY order_key LIMIT 50) e
    JOIN LATERAL (SELECT content FROM versions v WHERE v.block_id = e.block_id AND v.from_seq <= $1 ORDER BY v.from_seq DESC LIMIT 1) v ON true';
  a_sub text := 'WITH RECURSIVE sub AS (
      SELECT v.block_id, v.parent_id, v.order_key, v.alias, v.task_json, v.from_seq FROM versions v
      WHERE v.block_id = %L AND v.from_seq <= $1 AND (v.to_seq IS NULL OR v.to_seq > $1) AND v.deleted = 0
      UNION ALL
      SELECT v.block_id, v.parent_id, v.order_key, v.alias, v.task_json, v.from_seq FROM sub JOIN versions v
        ON v.parent_id = sub.block_id AND v.from_seq <= $1 AND (v.to_seq IS NULL OR v.to_seq > $1) AND v.deleted = 0)
    SELECT * FROM sub';
  e_sub text := 'WITH RECURSIVE sub AS (
      SELECT %L::text AS id, NULL::text AS parent_id, ''''::text COLLATE "C" AS order_key
      UNION ALL
      SELECT e.block_id, e.parent_key, e.order_key FROM sub JOIN edges e
        ON e.parent_key = sub.id AND e.from_seq <= $1 AND (e.to_seq IS NULL OR e.to_seq > $1))
    SELECT * FROM sub';
  e_sub_meta text := 'WITH RECURSIVE sub AS (
      SELECT %L::text AS id, NULL::text AS parent_id, ''''::text COLLATE "C" AS order_key
      UNION ALL
      SELECT e.block_id, e.parent_key, e.order_key FROM sub JOIN edges e
        ON e.parent_key = sub.id AND e.from_seq <= $1 AND (e.to_seq IS NULL OR e.to_seq > $1))
    SELECT sub.*, v.* FROM sub JOIN LATERAL (SELECT alias, task_json, from_seq FROM versions v
      WHERE v.block_id = sub.id AND v.from_seq <= $1 ORDER BY v.from_seq DESC LIMIT 1) v ON true';
  cur_page text := 'SELECT id, sid, parent_id, order_key, alias, task_json, version_seq FROM blocks WHERE page_id = %L AND deleted = 0';
  cur_sub text := 'WITH RECURSIVE sub AS (
      SELECT id, sid, parent_id, order_key, alias, task_json, version_seq FROM blocks WHERE id = %L
      UNION ALL
      SELECT b.id, b.sid, b.parent_id, b.order_key, b.alias, b.task_json, b.version_seq FROM sub JOIN blocks b
        ON b.space_id = ' || quote_literal(m('space')) || ' AND b.parent_id = sub.id AND b.deleted = 0)
    SELECT * FROM sub';
  p_time text := 'SELECT DISTINCT from_seq FROM versions WHERE page_id = %L AND from_seq < $1 ORDER BY from_seq DESC LIMIT 51';
  b_time text := 'SELECT seq FROM touch WHERE ancestor_id = %L AND seq < $1 ORDER BY seq DESC LIMIT 51';
BEGIN
  FOREACH name IN ARRAY ARRAY['typical', 's2000', 's10000'] LOOP
    root := m(name); ready := m(name || '.ready')::int;
    RAISE NOTICE '-- 50-block window of %', name;
    PERFORM bench('P  whole page structure as of T (contents not included)', format(p_struct, root), ready, 40);
    PERFORM bench('A  children by (parent_id, from_seq, to_seq), with content', format(a_children, root), ready, 200);
    PERFORM bench('A'' edges + version seek per block, with content', format(e_children, root), ready, 200);
  END LOOP;
  root := m('hot.parent'); ready := m('hot.ready')::int;
  RAISE NOTICE '-- hot parent';
  PERFORM bench('P  page structure as of T', format(p_struct, m('hot')), ready, 40);
  PERFORM bench('A  children by (parent_id, from_seq, to_seq)', format(a_children, root), ready, 40);
  PERFORM bench('A'' edges + version seek per block', format(e_children, root), ready, 200);
  FOREACH name IN ARRAY ARRAY['s2000', 's10000', 's20000'] LOOP
    root := m(name); ready := m(name || '.ready')::int;
    RAISE NOTICE '-- subtree %', name;
    PERFORM bench('P  current rows by page_id', format(cur_page, root), ready, 20);
    PERFORM bench('-  current rows, recursive over the children index', format(cur_sub, root), ready, 20);
    PERFORM bench('P  as of T by (page_id, from_seq, to_seq)', format(p_struct, root), ready, 20);
    PERFORM bench('A  as of T, recursive by (parent_id, from_seq, to_seq)', format(a_sub, root), ready, 20);
    PERFORM bench('A'' as of T, recursive over edges', format(e_sub, root), ready, 20);
    PERFORM bench('A'' as of T, edges + version seek per block', format(e_sub_meta, root), ready, 20);
    PERFORM bench('P  timeline by (page_id, from_seq)', format(p_time, root), ready, 100);
    PERFORM bench('B  timeline by touch(ancestor, seq)', format(b_time, root), ready, 100);
  END LOOP;
END $$;
