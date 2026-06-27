/**
 * Self-contained smoke test for the knowledge base MVP.
 *
 * Uses an isolated temp HOME so it never touches the real ~/.narrafork DB.
 * Run: bun run server/services/__tests__/knowledge-smoke.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempHome = mkdtempSync(join(tmpdir(), "nf-kb-smoke-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function main() {
	// Import after HOME is set so the DB opens under the temp dir.
	const { Database } = await import("bun:sqlite");
	const { resolve } = await import("node:path");
	const { mkdirSync } = await import("node:fs");

	const dir = resolve(tempHome, ".narrafork");
	mkdirSync(dir, { recursive: true });
	const sqlite = new Database(resolve(dir, "narrafork.db"));
	sqlite.run("PRAGMA journal_mode = WAL");
	sqlite.run("PRAGMA foreign_keys = ON");

	// Create just the tables we need + a stub users/projects for FK targets.
	sqlite.run("CREATE TABLE users (id TEXT PRIMARY KEY)");
	sqlite.run("CREATE TABLE projects (id TEXT PRIMARY KEY)");
	sqlite.run(`CREATE TABLE knowledge_collections (
		id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT,
		project_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
	)`);
	sqlite.run(`CREATE TABLE knowledge_entries (
		id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, title TEXT NOT NULL, slug TEXT NOT NULL,
		current_revision_id TEXT, current_content TEXT, tags_json TEXT, metadata_json TEXT,
		status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
	)`);
	sqlite.run(`CREATE TABLE knowledge_revisions (
		id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, version INTEGER NOT NULL,
		format TEXT NOT NULL DEFAULT 'markdown', content TEXT NOT NULL, content_hash TEXT NOT NULL,
		change_note TEXT, author_user_id TEXT, created_at TEXT NOT NULL
	)`);
	sqlite.run(
		"CREATE VIRTUAL TABLE knowledge_entries_fts USING fts5(title, content, content='knowledge_entries', content_rowid=rowid, tokenize='trigram')",
	);
	sqlite.run(`CREATE TRIGGER kefi AFTER INSERT ON knowledge_entries BEGIN
		INSERT INTO knowledge_entries_fts(rowid, title, content) VALUES (NEW.rowid, NEW.title, NEW.current_content);
	END`);
	sqlite.run(`CREATE TRIGGER kefu AFTER UPDATE ON knowledge_entries BEGIN
		INSERT INTO knowledge_entries_fts(knowledge_entries_fts, rowid, title, content) VALUES ('delete', OLD.rowid, OLD.title, OLD.current_content);
		INSERT INTO knowledge_entries_fts(rowid, title, content) VALUES (NEW.rowid, NEW.title, NEW.current_content);
	END`);

	// Minimal hand-rolled equivalents of the service flow (validates SQL + FTS wiring).
	const now = () => new Date().toISOString();

	// create collection
	sqlite
		.prepare(
			"INSERT INTO knowledge_collections (id,name,slug,created_at,updated_at) VALUES (?,?,?,?,?)",
		)
		.run("c1", "诊断经验", "diag", now(), now());

	// create entry + rev1
	sqlite
		.prepare(
			"INSERT INTO knowledge_revisions (id,entry_id,version,format,content,content_hash,created_at) VALUES (?,?,?,?,?,?,?)",
		)
		.run("r1", "e1", 1, "markdown", "充电流程 A to C 没有 B 阶段", "h1", now());
	sqlite
		.prepare(
			"INSERT INTO knowledge_entries (id,collection_id,title,slug,current_revision_id,current_content,tags_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
		)
		.run(
			"e1",
			"c1",
			"充电故障",
			"charge-fault",
			"r1",
			"充电流程 A to C 没有 B 阶段",
			JSON.stringify(["charge", "M20"]),
			"active",
			now(),
			now(),
		);

	// add rev2 (copy-on-write): version increments, current switches
	sqlite
		.prepare(
			"INSERT INTO knowledge_revisions (id,entry_id,version,format,content,content_hash,created_at) VALUES (?,?,?,?,?,?,?)",
		)
		.run("r2", "e1", 2, "markdown", "充电流程 A to B to C 三阶段", "h2", now());
	sqlite
		.prepare(
			"UPDATE knowledge_entries SET current_revision_id=?, current_content=?, updated_at=? WHERE id=?",
		)
		.run("r2", "充电流程 A to B to C 三阶段", now(), "e1");

	// assert version history
	const revs = sqlite
		.prepare("SELECT version FROM knowledge_revisions WHERE entry_id=? ORDER BY version DESC")
		.all("e1") as { version: number }[];
	assert(revs.length === 2 && revs[0].version === 2, "two revisions, latest version=2");

	const entry = sqlite.prepare("SELECT * FROM knowledge_entries WHERE id=?").get("e1") as {
		current_revision_id: string;
		current_content: string;
	};
	assert(entry.current_revision_id === "r2", "currentRevisionId switched to r2");
	assert(entry.current_content.includes("三阶段"), "currentContent updated to rev2 body");

	// FTS search: should find the entry by current content (trigram, >=3 chars)
	const hits = sqlite
		.prepare(
			`SELECT e.id FROM knowledge_entries_fts JOIN knowledge_entries e ON e.rowid=knowledge_entries_fts.rowid WHERE knowledge_entries_fts MATCH ?`,
		)
		.all('"三阶段"*') as { id: string }[];
	assert(
		hits.some((h) => h.id === "e1"),
		"FTS finds entry by updated (rev2) content",
	);

	// FTS should NOT find the old rev1-only phrase any more (current_content replaced)
	const stale = sqlite
		.prepare(
			`SELECT e.id FROM knowledge_entries_fts JOIN knowledge_entries e ON e.rowid=knowledge_entries_fts.rowid WHERE knowledge_entries_fts MATCH ?`,
		)
		.all('"没有"*') as { id: string }[];
	assert(stale.length === 0, "FTS no longer matches replaced rev1 content");

	// tag filter
	const tagged = sqlite.prepare("SELECT tags_json FROM knowledge_entries WHERE id=?").get("e1") as {
		tags_json: string;
	};
	assert(JSON.parse(tagged.tags_json).includes("M20"), "tag M20 present");

	sqlite.close();
	console.log("✅ knowledge MVP smoke test passed (collection→entry→rev2→FTS→tag)");
}

main()
	.catch((err) => {
		console.error("❌ smoke test failed:", err);
		process.exitCode = 1;
	})
	.finally(() => {
		rmSync(tempHome, { recursive: true, force: true });
	});
