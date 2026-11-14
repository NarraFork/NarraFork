CREATE UNIQUE INDEX uq_commits_space_seq ON commits (space_id, seq);
CREATE INDEX idx_blocks_page ON blocks (page_id);
CREATE INDEX idx_blocks_children ON blocks (space_id, parent_id, order_key);
ALTER TABLE versions ADD PRIMARY KEY (block_id, from_seq);
CREATE INDEX idx_v_page ON versions (page_id, from_seq, to_seq);
CREATE INDEX idx_v_commit ON versions (commit_id);
CREATE INDEX idx_v_parent ON versions (parent_id, from_seq, to_seq);
ALTER TABLE edges ADD PRIMARY KEY (parent_key, block_id, from_seq);
CREATE INDEX idx_e_block ON edges (block_id, from_seq);
-- Covering variant of the children read (index-only scan).
CREATE INDEX idx_e_cover ON edges (parent_key, from_seq) INCLUDE (to_seq, block_id, order_key);
ALTER TABLE touch ADD PRIMARY KEY (ancestor_id, seq);
VACUUM ANALYZE;
