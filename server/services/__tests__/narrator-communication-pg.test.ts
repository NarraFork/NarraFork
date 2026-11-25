import { Database } from "bun:sqlite";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { PgDialect } from "drizzle-orm/pg-core";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	assertCommunicationSendAuthorizedPg,
	assertUserCommunicationAdmissionPg,
	type CommunicationPgTx,
	commitUserCommunicationAdmissionPg,
	communicationCandidateSearchGuardPg,
	withCommunicationPgTransaction,
} from "../narrator-communication/postgres";

// No live PostgreSQL is accessed. This executable adapter tests the production SQL against
// the real SQLite schema with explicit frozen-vs-live snapshots, and asserts the PG isolation config.
const { sqlite } = getTestDb();
const now = "2026-11-24T00:00:00.000Z";
const dialect = new PgDialect();
function seed() {
	sqlite.run(
		"INSERT INTO users(id,username,password_hash,role,created_at) VALUES ('writer','writer','unused','user',?)",
		[now],
	);
	sqlite.run(
		"INSERT INTO users(id,username,password_hash,role,created_at) VALUES ('other','other','unused','user',?)",
		[now],
	);
	for (const id of ["source", "target"]) {
		sqlite.run(
			"INSERT INTO narrators(id,owner_user_id,status,created_at,updated_at) VALUES (?,'other','idle',?,?)",
			[id, now, now],
		);
		sqlite.run(
			"INSERT INTO narrator_communication_nodes(narrator_id,parent_narrator_id,original_parent_narrator_id,version) VALUES (?,?,?,1)",
			[id, id === "source" ? null : "source", id === "source" ? null : "source"],
		);
	}
	sqlite.run("UPDATE narrators SET runtime_registration_json=? WHERE id='source'", [
		JSON.stringify({ version: 1, run: { logicalRunId: "run", principal: { userId: "writer" } } }),
	]);
	grant("source");
}
function grant(id: string) {
	sqlite.run(
		"INSERT INTO acl_grants(id,scope_type,scope_id,principal_type,principal_id,capability,created_at) VALUES (?, 'narrator',?,'user','writer','write',?)",
		[`grant-${id}`, id, now],
	);
}
function adapter(database: Database, after?: (query: string) => void): CommunicationPgTx {
	return {
		execute: async (statement: SQL) => {
			const query = dialect.sqlToQuery(statement);
			const values = database
				.query(query.sql.replace(/\$\d+/g, "?").replace(/\s+FOR SHARE\b/g, ""))
				.all(...(query.params as Array<string | number | null>));
			after?.(query.sql);
			return values;
		},
	} as unknown as CommunicationPgTx;
}
function snapshotDatabase(mutate: (query: string) => void) {
	const configs: unknown[] = [];
	const database = {
		transaction: async (
			body: (tx: CommunicationPgTx) => Promise<unknown>,
			config?: { isolationLevel?: string },
		) => {
			configs.push(config);
			const snapshot =
				config?.isolationLevel === "serializable"
					? Database.deserialize(sqlite.serialize())
					: sqlite;
			try {
				return await body(adapter(snapshot, mutate));
			} finally {
				if (snapshot !== sqlite) snapshot.close();
			}
		},
	} as unknown as BunSQLDatabase;
	return { database, configs };
}
beforeEach(() => {
	cleanDb(sqlite);
	seed();
});
afterAll(() => sqlite.close());
test.each([
	"acl",
	"authority",
])("serializable PG authorization cannot combine source %s revocation with a later target grant", async (kind) => {
	let changed = false;
	const mutate = (query: string) => {
		const atBoundary =
			kind === "acl"
				? query.startsWith("SELECT n.id FROM narrators n")
				: query.includes("AS project_traits");
		if (changed || !atBoundary) return;
		changed = true;
		if (kind === "acl") sqlite.run("DELETE FROM acl_grants WHERE scope_id='source'");
		else
			sqlite.run(
				"INSERT INTO integration_resource_bindings(id,resource_type,resource_id,source_type,source_id,authority_type,authority_id,state,created_at,updated_at) VALUES ('binding','narrator','source','plugin','plugin','plugin_installation','plugin','active',?,?)",
				[now, now],
			);
		grant("target");
	};
	const fixture = snapshotDatabase(mutate);
	await expect(
		withCommunicationPgTransaction(fixture.database, (tx) =>
			assertCommunicationSendAuthorizedPg(tx, "source", "target"),
		),
	).rejects.toMatchObject({ code: "COMMUNICATION_DENIED" });
	expect(changed).toBe(true);
	expect(fixture.configs).toEqual([{ isolationLevel: "serializable" }]);
	expect(sqlite.query("SELECT count(*) AS n FROM narrator_communication_peers").get()).toEqual({
		n: 0,
	});
});
test("the same controlled READ COMMITTED fixture demonstrates the forbidden mixed-ACL acceptance", async () => {
	let changed = false;
	const tx = adapter(sqlite, (query) => {
		if (changed || !query.startsWith("SELECT n.id FROM narrators n")) return;
		changed = true;
		sqlite.run("DELETE FROM acl_grants WHERE scope_id='source'");
		grant("target");
	});
	await expect(
		assertCommunicationSendAuthorizedPg(tx, "source", "target"),
	).resolves.toBeUndefined();
	expect(changed).toBe(true);
});
test("PG admission rechecks both endpoint permissions in the same consistent snapshot", async () => {
	let changed = false;
	const fixture = snapshotDatabase((query) => {
		if (changed || !query.startsWith("SELECT n.id FROM narrators n")) return;
		changed = true;
		sqlite.run("DELETE FROM acl_grants WHERE scope_id='source'");
		grant("target");
	});
	const prepared = { sourceNarratorId: "source", userId: "writer", targetNarratorIds: ["target"] };
	await expect(
		withCommunicationPgTransaction(fixture.database, (tx) =>
			commitUserCommunicationAdmissionPg(tx, prepared, { admissionId: "accepted" }),
		),
	).rejects.toMatchObject({ code: "COMMUNICATION_DENIED" });
	expect(fixture.configs).toEqual([{ isolationLevel: "serializable" }]);
});
test("PG peer admission writes a fresh relation ID when the same endpoints reconnect", async () => {
	grant("target");
	sqlite.run(
		"UPDATE narrator_communication_nodes SET parent_narrator_id = NULL WHERE narrator_id = 'target'",
	);
	const tx = adapter(sqlite);
	const prepared = { sourceNarratorId: "source", userId: "writer", targetNarratorIds: ["target"] };
	const peer = sqlite.query<{ id: string }, []>(
		"SELECT id FROM narrator_communication_peers WHERE endpoint_lo = 'source' AND endpoint_hi = 'target'",
	);
	expect(await commitUserCommunicationAdmissionPg(tx, prepared, { admissionId: "first" })).toEqual([
		"source",
		"target",
	]);
	const first = peer.get();
	expect(first).not.toBeNull();
	sqlite.run("DELETE FROM narrator_communication_peers");
	expect(await commitUserCommunicationAdmissionPg(tx, prepared, { admissionId: "second" })).toEqual(
		["source", "target"],
	);
	const second = peer.get();
	expect(second).not.toBeNull();
	expect(second?.id).not.toBe(first?.id);
});
test.each([
	["same", "source"],
	["same", "target"],
	["different", "source"],
	["different", "target"],
] as const)("PG SQL rejects a %s-group admission after %s archives, before examining topology", async (group, endpoint) => {
	grant("target");
	if (group === "different")
		sqlite.run(
			"UPDATE narrator_communication_nodes SET parent_narrator_id=NULL WHERE narrator_id='target'",
		);
	const prepared = { sourceNarratorId: "source", userId: "writer", targetNarratorIds: ["target"] };
	await assertUserCommunicationAdmissionPg(adapter(sqlite), prepared);
	sqlite.run("UPDATE narrators SET status='archived' WHERE id=?", [endpoint]);
	const queries: string[] = [];
	await expect(
		commitUserCommunicationAdmissionPg(
			adapter(sqlite, (sql) => queries.push(sql)),
			prepared,
			{ admissionId: "stale" },
		),
	).rejects.toMatchObject({ code: "COMMUNICATION_DENIED" });
	expect(queries.filter((sql) => sql.startsWith("SELECT n.id FROM narrators n"))).toHaveLength(
		endpoint === "source" ? 1 : 2,
	);
	expect(
		queries
			.filter((sql) => sql.startsWith("SELECT n.id FROM narrators n"))
			.every((sql) => sql.includes("n.status <> 'archived'") && sql.endsWith("FOR SHARE")),
	).toBe(true);
	expect(queries.some((sql) => sql.includes("narrator_communication_"))).toBe(false);
	expect(sqlite.query("SELECT id FROM narrator_communication_peers").all()).toEqual([]);
});

test.each([
	["source", undefined],
	["target", undefined],
	["source", "manual-connect"],
	["target", "manual-connect"],
] as const)("PG exact candidate guard rereads persisted status of %s (%s)", async (endpoint, purpose) => {
	grant("target");
	const tx = adapter(sqlite);
	const options = { liveTargetId: "target", purpose };
	await expect(
		communicationCandidateSearchGuardPg(tx, "source", "writer", options),
	).resolves.toMatchObject({ backend: "postgres" });
	sqlite.run("UPDATE narrators SET status='archived' WHERE id=?", [endpoint]);
	await expect(
		communicationCandidateSearchGuardPg(tx, "source", "writer", options),
	).rejects.toMatchObject({ code: "COMMUNICATION_DENIED" });
});

test("PG manual candidate SQL uses the viewer, without widening the default or Send authority", async () => {
	// Writer already has a grant to the other user's source and owns a private target.
	sqlite.run("UPDATE narrators SET runtime_registration_json=NULL WHERE id='source'");
	sqlite.run("UPDATE narrators SET owner_user_id='writer' WHERE id='target'");
	sqlite.run(
		"UPDATE narrator_communication_nodes SET parent_narrator_id=NULL WHERE narrator_id='target'",
	);
	const tx = adapter(sqlite);
	const [execution, manual] = await Promise.all([
		communicationCandidateSearchGuardPg(tx, "source", "writer"),
		communicationCandidateSearchGuardPg(tx, "source", "writer", {
			liveTargetId: "target",
			purpose: "manual-connect",
		}),
	]);
	const matches = ({ sql, params }: typeof manual) =>
		sqlite.query(`SELECT n.id FROM narrators n WHERE n.id='target' AND (${sql})`).all(...params);
	expect(matches(execution)).toEqual([]);
	expect(matches(manual)).toEqual([{ id: "target" }]);
	expect(execution.authorizationKey).not.toBe(manual.authorizationKey);
	await commitUserCommunicationAdmissionPg(
		tx,
		{ sourceNarratorId: "source", userId: "writer", targetNarratorIds: ["target"] },
		{ admissionId: "viewer" },
	);
	await expect(assertCommunicationSendAuthorizedPg(tx, "source", "target")).rejects.toMatchObject({
		code: "COMMUNICATION_DENIED",
	});
	sqlite.run("UPDATE narrators SET owner_user_id='other' WHERE id='target'");
	expect(matches(manual)).toEqual([]);
	sqlite.run("UPDATE acl_grants SET capability='read' WHERE scope_id='source'");
	await expect(
		communicationCandidateSearchGuardPg(tx, "source", "writer", { purpose: "manual-connect" }),
	).rejects.toMatchObject({ code: "COMMUNICATION_DENIED" });
});

test("PG serializable helper retries whole sections on 40001 with a bounded four attempts", async () => {
	let attempts = 0;
	const error = Object.assign(new Error("serialization failure"), { code: "40001" });
	const database = {
		transaction: async (_body: unknown, config: unknown) => {
			expect(config).toEqual({ isolationLevel: "serializable" });
			attempts++;
			throw error;
		},
	} as unknown as BunSQLDatabase;
	await expect(withCommunicationPgTransaction(database, async () => {})).rejects.toBe(error);
	expect(attempts).toBe(4);
});
test("PG source persistent principal and all narrow predicates use compatible production SQL", async () => {
	grant("target");
	await assertCommunicationSendAuthorizedPg(adapter(sqlite), "source", "target");
	await assertUserCommunicationAdmissionPg(adapter(sqlite), {
		sourceNarratorId: "source",
		userId: "writer",
		targetNarratorIds: ["target"],
	});
	sqlite.run("UPDATE narrators SET runtime_registration_json=? WHERE id='source'", [
		JSON.stringify({ version: 1, run: { logicalRunId: "run", principal: { userId: null } } }),
	]);
	await expect(
		assertCommunicationSendAuthorizedPg(adapter(sqlite), "source", "target"),
	).rejects.toMatchObject({ code: "COMMUNICATION_DENIED" });
});
test("all three runtime mailbox entrance paths select serializable and whole-section retry", () => {
	const source = readFileSync(
		new URL("../agent-runtime/postgres-runtime-queue.ts", import.meta.url),
		"utf8",
	);
	expect(source).toContain(
		'input.kind === "agent_message" ? { isolationLevel: "serializable" } : undefined',
	);
	for (const name of ["admitAgentMessage", "admitUserBuffered"]) {
		const start = source.indexOf(`async ${name}(`);
		expect(start).toBeGreaterThan(-1);
		const section = source.slice(start, start + 4500);
		expect(section).toContain("withPgRetry");
		expect(section).toContain('isolationLevel: "serializable"');
	}
});
