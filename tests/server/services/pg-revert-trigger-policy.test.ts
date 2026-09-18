/**
 * The PG trigger-retention DECISION for history revert, pinned on a real
 * PostgreSQL 17.
 *
 * THE DECISION (定案, batch E — also stated in `revert-history-commit.ts`)
 * ----------------------------------------------------------------------
 * A PostgreSQL history revert applies the same row-level UPDATE/DELETE/INSERT
 * program the SQLite one prepares. It does NOT rebuild content tables, and it
 * does NOT detach, re-create, disable or otherwise manage triggers: the FTS
 * shadow tables on PG are owned by the `ensurePgFts` catalog
 * (`server/db/pg-fts.ts`), whose triggers maintain the shadows automatically for
 * ordinary DML. That automatic maintenance is exactly the behavior the SQLite
 * `INDEX_TRIGGERS` whitelist exists to protect, and the whitelist's fail-closed
 * rule carries over: no NON-catalog trigger may exist on the mutated tables.
 *
 * WHAT THIS TEST PROVES
 * ---------------------
 *   1. A revert-shaped transaction — an UPDATE of `narrators.title`, a DELETE of
 *      one `narrator_messages` row and an INSERT of its replacement, in one
 *      transaction with ZERO trigger-management statements — leaves the shadow
 *      tables exactly in sync (old content gone, new content present, updated
 *      title indexed). If any step needed trigger handling, the shadow would
 *      drift here.
 *   2. The trigger set on the revert-mutated tables is exactly the catalog set
 *      and nothing else: the PG form of the whitelist's fact.
 *
 * Rules, same as the other PG suites: `PG_INTEGRATION=1` really runs a throwaway
 * container; migrations are applied exactly as committed; only the harness' own
 * container is touched.
 */
import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { ensurePgFts } from "../../../server/db/pg-fts";
import { createPostgresClient } from "../../../server/db/postgres-client";
import * as pgSchema from "../../../server/db/postgres-schema";
import { generateId } from "../../../server/lib/id";
import { withPostgres } from "../../db/pg-test-harness";
import { migrationSql } from "./read/pg-parity-matrix";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";
const RUN_TIMEOUT_MS = 300_000;

const NOW = new Date().toISOString();

function urlFor(port: number, credentials: { user: string; password: string }): string {
	return `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(
		credentials.password,
	)}@127.0.0.1:${port}/nf_harness`;
}

/** The revert-mutated tables the SQLite whitelist enumerates. */
const MUTATED_TABLES = [
	"narrator_messages",
	"narrator_tool_calls",
	"narrator_message_refs",
	"narrators",
];

/** Every trigger the ensurePgFts catalog installs on the mutated tables. */
const CATALOG_TRIGGERS = new Set([
	"narrator_messages_fts_insert",
	"narrator_messages_fts_update",
	"narrator_messages_fts_delete",
	"narrators_fts_insert",
	"narrators_fts_update",
	"narrators_fts_delete",
]);

type ShadowState = {
	narratorTitles: { id: string; title: string }[];
	keptMessage: { id: string; content_text: string }[];
	replacedMessage: { id: string; content_text: string }[];
};

type ScenarioResult = {
	migrationError?: string;
	before: ShadowState;
	after: ShadowState;
	replacement: { id: string; content_text: string }[];
	census: { table_name: string; trigger_name: string }[];
};

/** The whole scenario, named so the harness callback can surface its real error. */
async function runPolicyScenario(
	exec: (sql: string) => Promise<{ code: number; stderr: string }>,
	port: number,
	credentials: { user: string; password: string },
	sqls: string[],
): Promise<ScenarioResult> {
	for (const statement of sqls) {
		const applied = await exec(statement);
		if (applied.code !== 0) {
			return {
				migrationError: applied.stderr
					.split("\n")
					.filter((line) => !line.startsWith("NOTICE:"))
					.join("\n")
					.slice(0, 400),
				before: { narratorTitles: [], keptMessage: [], replacedMessage: [] },
				after: { narratorTitles: [], keptMessage: [], replacedMessage: [] },
				replacement: [],
				census: [],
			};
		}
	}

	const client = createPostgresClient({
		driver: "bun-sql",
		url: urlFor(port, credentials),
		max: 4,
		connectTimeout: 10,
	});
	try {
		const pgDb: BunSQLDatabase = client.db;
		// The FTS catalog is NOT part of the Drizzle migrations — the startup
		// path installs it, so the suite does the same.
		await ensurePgFts(client.sql);

		// Seed: project → chapter → narrator → two messages.
		const projectId = generateId();
		const chapterId = generateId();
		const narratorId = generateId();
		const keptMessageId = generateId();
		const replacedMessageId = generateId();
		await pgDb.insert(pgSchema.projects).values({
			id: projectId,
			name: "pg-trigger-policy",
			gitPath: "/tmp/pg-trigger-policy",
			defaultBranch: "main",
			createdAt: NOW,
			updatedAt: NOW,
		});
		await pgDb.insert(pgSchema.chapters).values({
			id: chapterId,
			projectId,
			title: "policy chapter",
			branch: "chapter/policy",
			baseBranch: "main",
			status: "active",
			role: "branch",
			createdAt: NOW,
			updatedAt: NOW,
		});
		await pgDb.insert(pgSchema.narrators).values({
			id: narratorId,
			chapterId,
			title: "original title",
			createdAt: NOW,
			updatedAt: NOW,
		});
		await pgDb.insert(pgSchema.narratorMessages).values([
			{
				id: keptMessageId,
				narratorId,
				role: "user",
				contentJson: [{ type: "text", text: "kept" }],
				contentText: "kept message",
				createdAt: NOW,
			},
			{
				id: replacedMessageId,
				narratorId,
				role: "assistant",
				contentJson: [{ type: "text", text: "old body" }],
				contentText: "obsolete revert body",
				createdAt: NOW,
			},
		]);

		const shadows = async (): Promise<ShadowState> => ({
			narratorTitles: await client.sql`
				SELECT id, title FROM search_narrators WHERE id = ${narratorId}
			`,
			keptMessage: await client.sql`
				SELECT id, content_text FROM search_narrator_messages WHERE id = ${keptMessageId}
			`,
			replacedMessage: await client.sql`
				SELECT id, content_text FROM search_narrator_messages WHERE id = ${replacedMessageId}
			`,
		});

		const before = await shadows();

		// THE REVERT-SHAPED TRANSACTION: one UPDATE, one DELETE, one INSERT —
		// and deliberately NOTHING ELSE. No SET session_replication_role, no
		// DROP TRIGGER, no catalog reinstall. If the shadow needed any of
		// those, it drifts below.
		const replacementMessageId = generateId();
		await pgDb.transaction(async (tx) => {
			await tx
				.update(pgSchema.narrators)
				.set({ title: "reverted title", updatedAt: NOW })
				.where(eq(pgSchema.narrators.id, narratorId));
			await tx
				.delete(pgSchema.narratorMessages)
				.where(eq(pgSchema.narratorMessages.id, replacedMessageId));
			await tx.insert(pgSchema.narratorMessages).values({
				id: replacementMessageId,
				narratorId,
				role: "assistant",
				contentJson: [{ type: "text", text: "restored body" }],
				contentText: "restored revert body",
				createdAt: NOW,
			});
		});

		const after = await shadows();
		const replacement = (await client.sql`
			SELECT id, content_text FROM search_narrator_messages WHERE id = ${replacementMessageId}
		`) as { id: string; content_text: string }[];

		// The trigger census on the mutated tables: catalog set, nothing else.
		const census = (await client.sql`
			SELECT event_object_table AS table_name, trigger_name
			FROM information_schema.triggers
			WHERE event_object_table = ANY(${client.sql.array(MUTATED_TABLES, "text")})
			ORDER BY event_object_table, trigger_name
		`) as { table_name: string; trigger_name: string }[];

		return { before, after, replacement, census };
	} finally {
		await client.close();
	}
}

describe("PostgreSQL revert trigger-retention policy", () => {
	if (!PG_ENABLED) {
		it("skipped: set PG_INTEGRATION=1 to run the real PostgreSQL verification", () => {
			expect(process.env.PG_INTEGRATION).not.toBe("1");
		});
		return;
	}

	it(
		"keeps the FTS shadows in sync across revert-shaped DML with zero trigger management",
		async () => {
			const sqls = await migrationSql();
			const outcome = await withPostgres(async ({ exec, port, credentials }) => {
				try {
					return await runPolicyScenario(exec, port, credentials, sqls);
				} catch (error) {
					const chain: string[] = [];
					let current: unknown = error;
					for (let depth = 0; depth < 6 && current; depth++) {
						chain.push(current instanceof Error ? current.message : String(current));
						current = (current as { cause?: unknown }).cause;
					}
					return { callbackError: chain.join(" ← ") };
				}
			});

			if ("status" in outcome && outcome.status !== "ready") {
				throw new Error(`PostgreSQL harness ${outcome.status}: ${outcome.reason}`);
			}
			const result = outcome as ScenarioResult & { callbackError?: string };
			if (result.callbackError) {
				throw new Error(`scenario failed: ${result.callbackError.slice(0, 1500)}`);
			}
			if (result.migrationError) {
				throw new Error(`PostgreSQL migration failed: ${result.migrationError}`);
			}

			// Before: everything indexed.
			expect(result.before.narratorTitles).toEqual([
				{ id: expect.any(String), title: "original title" },
			]);
			expect(result.before.replacedMessage).toEqual([
				{ id: expect.any(String), content_text: "obsolete revert body" },
			]);

			// After the revert-shaped DML: the shadow moved WITH the base table, with
			// zero trigger management — updated title indexed, deleted row purged,
			// replacement indexed. The kept row is untouched.
			expect(result.after.narratorTitles).toEqual([
				{ id: expect.any(String), title: "reverted title" },
			]);
			expect(result.after.replacedMessage).toEqual([]);
			expect(result.after.keptMessage).toEqual([
				{ id: expect.any(String), content_text: "kept message" },
			]);
			expect(result.replacement).toEqual([
				{ id: expect.any(String), content_text: "restored revert body" },
			]);

			// The whitelist fact: the ONLY triggers on the mutated tables are the
			// ensurePgFts catalog's. A non-catalog trigger here is what the fail-closed
			// rule exists to refuse.
			const triggerNames = new Set(result.census.map((row) => row.trigger_name));
			for (const name of triggerNames) {
				expect(
					CATALOG_TRIGGERS.has(name),
					`non-catalog trigger ${name} on a revert-mutated table`,
				).toBe(true);
			}
		},
		RUN_TIMEOUT_MS,
	);
});
