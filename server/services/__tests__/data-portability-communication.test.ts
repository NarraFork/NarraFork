import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

// Every database/file belongs to this disposable fixture, never the running instance.
const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-portability-communication-"));
process.env.NARRAFORK_HOME = testHome;
const { sqlite } = await import("../../db");
const { SNAPSHOT_TABLES } = await import("../../db/snapshot-protocol");
const { applyImport, clearData, exportData, previewImport } = await import("../data-portability");

const NOW = "2026-11-24T00:00:00Z";
const include = { sessions: true, requests: false, providers: false };
const count = (table: string) =>
	Number((sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
const node = (id: string) =>
	sqlite
		.query(
			"SELECT parent_narrator_id, original_parent_narrator_id, version FROM narrator_communication_nodes WHERE narrator_id = ?",
		)
		.get(id);

function narrator(id: string, owner = "writer", historicalParent: string | null = null) {
	sqlite.run(
		`INSERT INTO narrators (id, type, owner_user_id, visibility, write_audience,
		 parent_narrator_id, created_at, updated_at) VALUES (?, 'primary', ?, 'private', 'owner', ?, ?, ?)`,
		[id, owner, historicalParent, NOW, NOW],
	);
}
function communicationNode(
	id: string,
	parent: string | null,
	original: string | null = parent,
	version = 1,
) {
	sqlite.run("INSERT INTO narrator_communication_nodes VALUES (?, ?, ?, ?)", [
		id,
		parent,
		original,
		version,
	]);
}
function peer(lo: string, hi: string, id = `peer-${lo}-${hi}`) {
	sqlite.run(
		`INSERT INTO narrator_communication_peers
		 (id, endpoint_lo, endpoint_hi, created_by, source, created_at)
		 VALUES (?, ?, ?, 'writer', 'manual', ?)`,
		[id, lo, hi, NOW],
	);
}
async function archive() {
	const bytes = await readFile((await exportData(include)).zipPath);
	return previewImport(
		bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
		"communication.zip",
	);
}
function alterSnapshot(snapshotPath: string, change: (snapshot: Database) => void) {
	const snapshot = new Database(snapshotPath);
	try {
		change(snapshot);
	} finally {
		snapshot.close();
	}
}
function pairFixture() {
	narrator("a");
	narrator("b");
	communicationNode("a", null);
	communicationNode("b", "a");
	peer("a", "b");
}

beforeEach(() => {
	sqlite.run("DROP TRIGGER IF EXISTS temp.assert_communication_cleared");
	sqlite.run("DELETE FROM narrator_communication_peers");
	sqlite.run("DELETE FROM narrator_communication_nodes");
	sqlite.run("DELETE FROM api_requests");
	sqlite.run("DELETE FROM narrators");
	sqlite.run("DELETE FROM acl_grants");
	for (const [id, role] of [
		["importer", "admin"],
		["writer", "user"],
		["other", "user"],
	]) {
		sqlite.run(
			"INSERT OR IGNORE INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, 'x', ?, ?)",
			[id ?? "", id ?? "", role ?? "user", NOW],
		);
		sqlite.run("UPDATE users SET role = ? WHERE id = ?", [role ?? "user", id ?? ""]);
	}
});
afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

describe("data portability · communication forest", () => {
	test.each([
		"current",
		"legacy",
	])("%s snapshot preserves explicit NULL and restores exact peers with new IDs", async (format) => {
		pairFixture();
		narrator("c", "writer", "a");
		communicationNode("c", null, null, 4);
		const preview = await archive();
		expect(SNAPSHOT_TABLES.sessions).toContain("narrator_communication_nodes");
		expect(SNAPSHOT_TABLES.sessions).toContain("narrator_communication_peers");
		alterSnapshot(preview.snapshotPath, (snapshot) => {
			expect(
				snapshot
					.query(
						"SELECT name FROM pragma_table_info('narrator_communication_peers') WHERE name = 'generation'",
					)
					.get(),
			).toBeNull();
			if (format === "legacy") {
				snapshot.run(
					"ALTER TABLE narrator_communication_peers ADD COLUMN generation INTEGER NOT NULL DEFAULT 7 CHECK (generation >= 1)",
				);
			}
			expect(
				snapshot.query("SELECT COUNT(*) AS n FROM narrator_communication_peers").get(),
			).toEqual({ n: 1 });
			expect(
				snapshot
					.query(
						"SELECT original_parent_narrator_id FROM narrator_communication_nodes WHERE narrator_id = 'c'",
					)
					.get(),
			).toEqual({ original_parent_narrator_id: null });
		});
		await clearData("sessions");
		const { db } = await import("../../db");
		const { currentCommunicationPrincipalTx } = await import("../narrator-communication/access");
		expect(currentCommunicationPrincipalTx(db, "importer")).toEqual({
			userId: "importer",
			isAdmin: true,
		});
		const result = await applyImport(preview.token, { include, importingUserId: "importer" });
		expect(result.communication.nodesInserted).toBe(3);
		expect(node("b")).toEqual({
			parent_narrator_id: "a",
			original_parent_narrator_id: "a",
			version: 1,
		});
		expect(node("c")).toEqual({
			parent_narrator_id: null,
			original_parent_narrator_id: null,
			version: 4,
		});
		expect(result.communication.peersRestored).toBe(1);
		expect(
			sqlite
				.query("SELECT endpoint_lo, endpoint_hi, created_by FROM narrator_communication_peers")
				.all(),
		).toEqual([{ endpoint_lo: "a", endpoint_hi: "b", created_by: "importer" }]);
		expect(
			(sqlite.query("SELECT id FROM narrator_communication_peers").get() as { id: string }).id,
		).not.toBe("peer-a-b");
	});

	test("the disconnect route accepts newly allocated peer IDs even with a shadowed snapshot rowid", async () => {
		narrator("a");
		narrator("b");
		communicationNode("a", null);
		communicationNode("b", null);
		peer("a", "b");
		const preview = await archive();
		alterSnapshot(preview.snapshotPath, (snapshot) => {
			snapshot.run("ALTER TABLE narrator_communication_peers ADD COLUMN rowid TEXT");
			snapshot.run("UPDATE narrator_communication_peers SET rowid = 'archive supplied/rowid'");
		});
		await clearData("sessions");
		const result = await applyImport(preview.token, { include, importingUserId: "importer" });
		expect(result.communication.peersRestored).toBe(1);
		const imported = sqlite
			.query(
				"SELECT id FROM narrator_communication_peers WHERE endpoint_lo = 'a' AND endpoint_hi = 'b'",
			)
			.get() as { id: string } | null;
		expect(imported).not.toBeNull();
		if (!imported) throw new Error("Expected the archive's peer to be restored");
		expect(imported.id).not.toBe("peer-a-b");

		const { registerNarratorCommunicationRoutes } = await import(
			"../../routes/narrator-communication"
		);
		const app = new Hono();
		app.use("*", async (c, next) => {
			c.set("user", { sub: "importer", role: "admin", iat: 0, exp: Number.MAX_SAFE_INTEGER });
			await next();
		});
		// Only the authenticated context is supplied by the fixture: schema validation,
		// current ACL checks and the durable disconnect use the production route/service.
		registerNarratorCommunicationRoutes(app);
		const response = await app.request("/a/communication", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ kind: "disconnect", peerId: imported.id }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ changed: true });
		expect(
			sqlite.query("SELECT id FROM narrator_communication_peers WHERE id = ?").get(imported.id),
		).toBeNull();
		expect(count("narrator_communication_peers")).toBe(0);
	});

	test("a current snapshot recomputes archived aliases while preserving the communication forest", async () => {
		pairFixture();
		sqlite.run(
			`UPDATE narrators SET type = 'subagent', status = 'archived', parent_narrator_id = 'a',
			 acl_root_narrator_id = 'a', title = 'Archived Helper', traits = ?,
			 title_slug = 'stale-title', alias_selector = 'stale-alias' WHERE id = 'b'`,
			[JSON.stringify(["subagent-alias:helper-v2"])],
		);
		const preview = await archive();
		const aliasSql = "SELECT title_slug, alias_selector FROM narrators WHERE id = 'b'";
		alterSnapshot(preview.snapshotPath, (snapshot) => {
			expect(snapshot.query(aliasSql).get()).toEqual({
				title_slug: "stale-title",
				alias_selector: "stale-alias",
			});
		});
		await clearData("sessions");
		const result = await applyImport(preview.token, { include, importingUserId: "importer" });
		expect(sqlite.query(aliasSql).get()).toEqual({
			title_slug: "archived-helper",
			alias_selector: "helper-v2",
		});
		expect(node("b")).toMatchObject({ parent_narrator_id: "a" });
		expect(result.communication.peersRestored).toBe(1);
	});

	test("overwrite cannot resurrect an existing explicit split or replace immutable original NULL", async () => {
		pairFixture();
		const preview = await archive();
		sqlite.run(
			"UPDATE narrator_communication_nodes SET parent_narrator_id = NULL, original_parent_narrator_id = NULL, version = 9 WHERE narrator_id = 'b'",
		);
		const result = await applyImport(preview.token, {
			include,
			conflictDefault: "overwrite",
			importingUserId: "importer",
		});
		expect(node("b")).toEqual({
			parent_narrator_id: null,
			original_parent_narrator_id: null,
			version: 9,
		});
		expect(result.communication.nodesPreserved).toBe(2);
		expect(result.communication.peersAlreadyPresent).toBe(1);
	});

	test("a non-admin with write access to both endpoints can restore the forest and peer", async () => {
		pairFixture();
		const preview = await archive();
		await clearData("sessions");
		const result = await applyImport(preview.token, { include, importingUserId: "writer" });
		expect(node("b")).toMatchObject({ parent_narrator_id: "a" });
		expect(result.communication.peersRestored).toBe(1);
	});

	for (const importingUserId of [undefined, "missing-user", "other"]) {
		test(`missing/unauthorized caller ${importingUserId ?? "omitted"} imports independent roots and reports dropped links`, async () => {
			pairFixture();
			const preview = await archive();
			await clearData("sessions");
			const result = await applyImport(preview.token, { include, importingUserId });
			expect(result.sessionsInserted).toBe(2);
			expect(node("b")).toMatchObject({ parent_narrator_id: null });
			expect(result.communication.parentsDetachedUnauthorized).toBe(1);
			expect(result.communication.peersSkipped).toBe(1);
			expect(result.communication.peersUnauthorized).toBe(1);
			expect(count("narrator_communication_peers")).toBe(0);
		});
	}

	test("current target role is checked after preview, not trusted from a former administrator", async () => {
		pairFixture();
		const preview = await archive();
		await clearData("sessions");
		sqlite.run("UPDATE users SET role = 'user' WHERE id = 'importer'");
		const result = await applyImport(preview.token, { include, importingUserId: "importer" });
		expect(result.communication.peersUnauthorized).toBe(1);
		expect(node("b")).toMatchObject({ parent_narrator_id: null });
	});

	test("write access to just one endpoint does not restore either kind of edge", async () => {
		pairFixture();
		sqlite.run("UPDATE narrators SET owner_user_id = 'other' WHERE id = 'b'");
		const preview = await archive();
		await clearData("sessions");
		const result = await applyImport(preview.token, { include, importingUserId: "writer" });
		expect(result.communication.parentsDetachedUnauthorized).toBe(1);
		expect(result.communication.peersUnauthorized).toBe(1);
	});

	test("snapshot ownership cannot authorize overwrite or restore links to a private local endpoint", async () => {
		pairFixture();
		const preview = await archive();
		await clearData("sessions");
		narrator("a", "other");
		communicationNode("a", null, null, 7);
		const result = await applyImport(preview.token, {
			include,
			conflictDefault: "overwrite",
			importingUserId: "writer",
		});
		expect(result.sessionsSkipped).toBe(1);
		expect(result.sessionsOverwritten).toBe(0);
		expect(sqlite.query("SELECT owner_user_id FROM narrators WHERE id = 'a'").get()).toEqual({
			owner_user_id: "other",
		});
		expect(node("a")).toMatchObject({ version: 7 });
		expect(node("b")).toMatchObject({
			parent_narrator_id: null,
			original_parent_narrator_id: null,
		});
		expect(result.communication.parentsDetachedMissingEndpoints).toBe(1);
		expect(result.communication.peersMissingEndpoints).toBe(1);
		expect(count("narrator_communication_peers")).toBe(0);
	});

	test("read grants do not count as write access in the target environment", async () => {
		pairFixture();
		const preview = await archive();
		await clearData("sessions");
		for (const id of ["a", "b"]) {
			sqlite.run(
				`INSERT INTO acl_grants
			 (id, scope_type, scope_id, principal_type, principal_id, capability, created_at)
			 VALUES (?, 'narrator', ?, 'user', 'other', 'read', ?)`,
				[`read-${id}`, id, NOW],
			);
		}
		const result = await applyImport(preview.token, { include, importingUserId: "other" });
		expect(result.communication.parentsDetachedUnauthorized).toBe(1);
		expect(result.communication.peersUnauthorized).toBe(1);
	});

	test("a skipped colliding endpoint is not mapped even though it exists locally", async () => {
		pairFixture();
		const preview = await archive();
		await clearData("sessions");
		narrator("a");
		communicationNode("a", null, null, 6);
		const result = await applyImport(preview.token, {
			include,
			conflictDefault: "skip",
			importingUserId: "importer",
		});
		expect(result.sessionsSkipped).toBe(1);
		expect(node("a")).toMatchObject({ version: 6 });
		expect(node("b")).toMatchObject({
			parent_narrator_id: null,
			original_parent_narrator_id: null,
		});
		expect(result.communication.parentsDetachedMissingEndpoints).toBe(1);
		expect(result.communication.peersMissingEndpoints).toBe(1);
	});

	test("missing source endpoints split safely rather than binding to unrelated local ids", async () => {
		pairFixture();
		const preview = await archive();
		alterSnapshot(preview.snapshotPath, (snapshot) =>
			snapshot.run("DELETE FROM narrators WHERE id = 'a'"),
		);
		await clearData("sessions");
		narrator("a", "other");
		communicationNode("a", null);
		const result = await applyImport(preview.token, { include, importingUserId: "importer" });
		expect(node("b")).toMatchObject({
			parent_narrator_id: null,
			original_parent_narrator_id: null,
		});
		expect(result.communication.peersMissingEndpoints).toBe(1);
	});

	test("a mapped narrator without its source node is not silently treated as a valid forest endpoint", async () => {
		pairFixture();
		const preview = await archive();
		alterSnapshot(preview.snapshotPath, (snapshot) =>
			snapshot.run("DELETE FROM narrator_communication_nodes WHERE narrator_id = 'a'"),
		);
		await clearData("sessions");
		const result = await applyImport(preview.token, { include, importingUserId: "importer" });
		expect(node("a")).toMatchObject({ parent_narrator_id: null });
		expect(node("b")).toMatchObject({ parent_narrator_id: null });
		expect(result.communication.parentsDetachedMissingEndpoints).toBe(1);
		// The independent, exactly mapped peer remains separately authorized.
		expect(result.communication.peersRestored).toBe(1);
	});

	test("an explicit original-parent NULL stays NULL even when its active parent is restored", async () => {
		pairFixture();
		sqlite.run(
			"UPDATE narrator_communication_nodes SET original_parent_narrator_id = NULL WHERE narrator_id = 'b'",
		);
		const preview = await archive();
		await clearData("sessions");
		await applyImport(preview.token, { include, importingUserId: "importer" });
		expect(node("b")).toMatchObject({ parent_narrator_id: "a", original_parent_narrator_id: null });
	});

	test("legacy archives without either communication table create roots, never infer historical parents", async () => {
		pairFixture();
		sqlite.run("UPDATE narrators SET parent_narrator_id = 'a' WHERE id = 'b'");
		const preview = await archive();
		alterSnapshot(preview.snapshotPath, (snapshot) => {
			snapshot.run("DROP TABLE narrator_communication_nodes");
			snapshot.run("DROP TABLE narrator_communication_peers");
		});
		await clearData("sessions");
		await applyImport(preview.token, { include, importingUserId: "importer" });
		expect(node("b")).toEqual({
			parent_narrator_id: null,
			original_parent_narrator_id: null,
			version: 1,
		});
	});

	test("old node columns never invent originalParent from a present parent", async () => {
		pairFixture();
		const preview = await archive();
		alterSnapshot(preview.snapshotPath, (snapshot) =>
			snapshot.run(
				"ALTER TABLE narrator_communication_nodes DROP COLUMN original_parent_narrator_id",
			),
		);
		await clearData("sessions");
		await applyImport(preview.token, { include, importingUserId: "importer" });
		expect(node("b")).toMatchObject({ parent_narrator_id: "a", original_parent_narrator_id: null });
	});

	test("a cyclic forest rejects the whole import and preserves unrelated local data", async () => {
		pairFixture();
		const preview = await archive();
		alterSnapshot(preview.snapshotPath, (snapshot) =>
			snapshot.run(
				"UPDATE narrator_communication_nodes SET parent_narrator_id = 'b' WHERE narrator_id = 'a'",
			),
		);
		await clearData("sessions");
		narrator("local");
		communicationNode("local", null, null, 3);
		await expect(
			applyImport(preview.token, { include, importingUserId: "importer" }),
		).rejects.toMatchObject({ code: "IMPORT_COMMUNICATION_INVALID" });
		expect(count("narrators")).toBe(1);
		expect(node("local")).toMatchObject({ version: 3 });
		expect(count("narrator_communication_peers")).toBe(0);
	});

	for (const depth of [16, 17]) {
		test(`forest depth ${depth} ${depth === 16 ? "is accepted" : "rolls back"}`, async () => {
			for (let i = 0; i < depth; i++) {
				const id = `depth-${i}`;
				narrator(id);
				communicationNode(id, i === 0 ? null : `depth-${i - 1}`);
			}
			const preview = await archive();
			await clearData("sessions");
			const importing = applyImport(preview.token, { include, importingUserId: "importer" });
			if (depth === 16) expect((await importing).communication.nodesInserted).toBe(16);
			else {
				await expect(importing).rejects.toMatchObject({ code: "IMPORT_COMMUNICATION_INVALID" });
				expect(count("narrators")).toBe(0);
			}
		});
	}

	for (const invalid of ["version = 0", "version = NULL", "parent_narrator_id = narrator_id"]) {
		test(`invalid node ${invalid} fails atomically`, async () => {
			pairFixture();
			const preview = await archive();
			alterSnapshot(preview.snapshotPath, (snapshot) =>
				snapshot.run(`UPDATE narrator_communication_nodes SET ${invalid} WHERE narrator_id = 'b'`),
			);
			await clearData("sessions");
			await expect(
				applyImport(preview.token, { include, importingUserId: "importer" }),
			).rejects.toMatchObject({ code: "IMPORT_COMMUNICATION_INVALID" });
			expect(count("narrators")).toBe(0);
		});
	}

	test("duplicate source nodes reject instead of choosing an arbitrary parent", async () => {
		pairFixture();
		const preview = await archive();
		alterSnapshot(preview.snapshotPath, (snapshot) =>
			snapshot.run(
				"INSERT INTO narrator_communication_nodes SELECT * FROM narrator_communication_nodes WHERE narrator_id = 'b'",
			),
		);
		await clearData("sessions");
		await expect(
			applyImport(preview.token, { include, importingUserId: "importer" }),
		).rejects.toMatchObject({ code: "IMPORT_COMMUNICATION_INVALID" });
	});

	test("malformed peers are explicitly reported without activating them", async () => {
		pairFixture();
		const preview = await archive();
		alterSnapshot(preview.snapshotPath, (snapshot) => {
			snapshot.run("UPDATE narrator_communication_peers SET endpoint_hi = endpoint_lo");
			snapshot.run(
				"INSERT INTO narrator_communication_peers SELECT * FROM narrator_communication_peers",
			);
			snapshot.run(
				"UPDATE narrator_communication_peers SET endpoint_hi = 'b', source = 'forged' WHERE rowid = 2",
			);
		});
		await clearData("sessions");
		const result = await applyImport(preview.token, { include, importingUserId: "importer" });
		expect(result.communication.peersSkipped).toBe(2);
		expect(result.communication.peersInvalid).toBe(2);
		expect(count("narrator_communication_peers")).toBe(0);
	});

	test("duplicate snapshot peers merge once and report the remainder; local CAS ids stay stable", async () => {
		pairFixture();
		const preview = await archive();
		alterSnapshot(preview.snapshotPath, (snapshot) =>
			snapshot.run(
				"INSERT INTO narrator_communication_peers SELECT * FROM narrator_communication_peers",
			),
		);
		await clearData("sessions");
		const result = await applyImport(preview.token, { include, importingUserId: "importer" });
		expect(result.communication.peersRestored).toBe(1);
		expect(result.communication.peersAlreadyPresent).toBe(1);
		const relation = sqlite.query("SELECT id FROM narrator_communication_peers").get();
		const second = await archive();
		const repeated = await applyImport(second.token, {
			include,
			conflictDefault: "overwrite",
			importingUserId: "importer",
		});
		expect(repeated.communication.peersRestored).toBe(0);
		expect(repeated.communication.peersAlreadyPresent).toBe(1);
		expect(sqlite.query("SELECT id FROM narrator_communication_peers").get()).toEqual(relation);
	});

	for (const [table, limit] of [
		["nodes", 10_000],
		["peers", 20_000],
	] as const) {
		test(`oversized ${table} archives fail with an explicit budget error and roll back`, async () => {
			pairFixture();
			const preview = await archive();
			alterSnapshot(preview.snapshotPath, (snapshot) => {
				if (table === "nodes")
					snapshot.run(`WITH RECURSIVE ids(i) AS (
				 VALUES(1) UNION ALL SELECT i + 1 FROM ids WHERE i < ${limit}
				) INSERT INTO narrator_communication_nodes (narrator_id, version)
				 SELECT 'extra-' || i, 1 FROM ids`);
				else
					snapshot.run(`WITH RECURSIVE ids(i) AS (
				 VALUES(1) UNION ALL SELECT i + 1 FROM ids WHERE i < ${limit}
				) INSERT INTO narrator_communication_peers (id, endpoint_lo, endpoint_hi, source, created_at)
				 SELECT 'extra-' || i, 'a', 'b', 'manual', 'now' FROM ids`);
			});
			await clearData("sessions");
			await expect(
				applyImport(preview.token, { include, importingUserId: "importer" }),
			).rejects.toMatchObject({ code: "IMPORT_COMMUNICATION_TOO_LARGE" });
			expect(count("narrators")).toBe(0);
			expect(count("narrator_communication_nodes")).toBe(0);
			expect(count("narrator_communication_peers")).toBe(0);
		});
	}

	test("request-only import does not restore communications", async () => {
		pairFixture();
		const preview = await archive();
		await clearData("sessions");
		const result = await applyImport(preview.token, {
			include: { requests: true, sessions: false, providers: false },
			importingUserId: "importer",
		});
		expect(result.communication.nodesInserted).toBe(0);
		expect(count("narrator_communication_nodes")).toBe(0);
	});

	test("clear sessions removes peers and nodes before narrator deletion without touching users", async () => {
		pairFixture();
		sqlite.run(`CREATE TEMP TRIGGER assert_communication_cleared BEFORE DELETE ON main.narrators
		 WHEN EXISTS(SELECT 1 FROM narrator_communication_nodes) OR EXISTS(SELECT 1 FROM narrator_communication_peers)
		 BEGIN SELECT RAISE(ABORT, 'communication must be explicitly cleared first'); END`);
		expect((await clearData("sessions")).deleted.sessions).toBe(2);
		expect(count("narrator_communication_nodes")).toBe(0);
		expect(count("narrator_communication_peers")).toBe(0);
		expect(count("users")).toBe(3);
	});
});
