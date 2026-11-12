/**
 * The Dynamic Spec import's persisted state on a real PostgreSQL (outline P2 PR 12b2):
 * `outline_spec_imports` through the dual-dialect store (`spec-import/state.ts`), on a database
 * with every `drizzle-postgres` migration applied verbatim: an import's row, the cache dropped (a
 * restart) and read back, a failure counted and needing attention, the admin page's page and
 * counts, a move back (no session runtime on PostgreSQL: no admission, the fence untouched) and
 * the re-import that moves the unchanged session forward again.
 *
 * Rules, same as the other PostgreSQL suites:
 *   - `PG_INTEGRATION=1` means PostgreSQL really has to run; a blocked harness fails;
 *   - migrations are applied exactly as committed;
 *   - the harness owns and removes its database.
 */
import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { ensurePgFts } from "../../../../server/db/pg-fts";
import { createPostgresClient } from "../../../../server/db/postgres-client";
import * as pgSchema from "../../../../server/db/postgres-schema";
import { generateId } from "../../../../server/lib/id";
import { settings } from "../../../../server/lib/settings";
import {
	createPostgresOutlineAccessExecutor,
	outlineAccessBackend,
	setOutlineAccessExecutor,
} from "../../../../server/services/outline/access-reads";
import { stopEditTextWorker } from "../../../../server/services/outline/edit-text-runner";
import { invalidateSessionReadScopes } from "../../../../server/services/outline/session-scope";
import {
	reimportSpecSession,
	revertSpecImport,
	specImportAdminPage,
} from "../../../../server/services/outline/spec-import/admin";
import {
	importSpecSession,
	resetSpecImportRecords,
} from "../../../../server/services/outline/spec-import/importer";
import {
	countSpecImportStates,
	readSpecImportState,
	writeSpecImportState,
} from "../../../../server/services/outline/spec-import/state";
import { settleSpecImportRequests } from "../../../../server/services/outline/spec-import/triggers";
import { setOutlineStore } from "../../../../server/services/outline/store";
import { createPostgresOutlineStore } from "../../../../server/services/outline/store/postgres-store";
import { invalidateTaskBackend } from "../../../../server/services/task-source";
import { withPostgres } from "../../../db/pg-test-harness";
import { migrationSql } from "../read/pg-parity-matrix";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";
const RUN_TIMEOUT_MS = 600_000;
const NOW = "2026-11-12T00:00:00.000Z";

function urlFor(port: number, credentials: { user: string; password: string }): string {
	return `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(
		credentials.password,
	)}@127.0.0.1:${port}/nf_harness`;
}

async function seedSession(
	pg: BunSQLDatabase,
	options: { type?: "primary" | "subagent"; archived?: boolean } = {},
): Promise<{ id: string; owner: string; namespaceId: string }> {
	const owner = generateId();
	await pg.insert(pgSchema.users).values({
		id: owner,
		username: `pgsi-${owner}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	const id = generateId();
	await pg.insert(pgSchema.narrators).values({
		id,
		title: "spec import",
		ownerUserId: owner,
		visibility: "private",
		type: options.type ?? "primary",
		status: options.archived ? "archived" : "idle",
		taskBackend: "spec",
		createdAt: NOW,
		updatedAt: NOW,
	});
	const namespaceId = generateId();
	await pg
		.insert(pgSchema.specNamespaces)
		.values({ id: namespaceId, narratorId: id, createdAt: NOW, updatedAt: NOW });
	return { id, owner, namespaceId };
}

async function seedFile(
	pg: BunSQLDatabase,
	namespaceId: string,
	path: string,
	content: string,
	createdBy: "user" | "assistant" = "assistant",
): Promise<string> {
	const revisionId = generateId();
	await pg.insert(pgSchema.specFileRevisions).values({
		id: revisionId,
		namespaceId,
		path,
		content,
		contentHash: "h",
		createdBy,
		createdAt: NOW,
	});
	await pg.insert(pgSchema.specNamespaceFiles).values({
		id: generateId(),
		namespaceId,
		path,
		revisionId,
		deleted: false,
		updatedAt: NOW,
	});
	return revisionId;
}

describe("PostgreSQL Dynamic Spec import state", () => {
	if (!PG_ENABLED) {
		it("skipped: set PG_INTEGRATION=1 to run the real PostgreSQL verification", () => {
			// Explicitly a skip, not a pass: no PostgreSQL work happened here.
			expect(process.env.PG_INTEGRATION).not.toBe("1");
		});
		return;
	}

	it(
		"records, reads back, lists, moves back and forward on a real server",
		async () => {
			const sqls = await migrationSql();
			const outcome = await withPostgres(async ({ exec, port, credentials }) => {
				for (const statement of sqls) {
					const applied = await exec(statement);
					if (applied.code !== 0) return { migrationError: applied.stderr.slice(0, 400) };
				}
				const client = createPostgresClient({
					driver: "bun-sql",
					url: urlFor(port, credentials),
					max: 4,
					connectTimeout: 10,
				});
				await ensurePgFts(client.sql);
				setOutlineStore(createPostgresOutlineStore(client.db));
				setOutlineAccessExecutor(createPostgresOutlineAccessExecutor(client.db));
				invalidateSessionReadScopes();
				invalidateTaskBackend();
				resetSpecImportRecords();
				const wasEnabled = settings.outline.enabled;
				settings.outline.enabled = true;
				settings.outline.specImport = "manual";
				try {
					const pg = client.db;
					const backendOf = async (id: string) =>
						(
							await pg
								.select({ backend: pgSchema.narrators.taskBackend })
								.from(pgSchema.narrators)
								.where(eq(pgSchema.narrators.id, id))
						)[0]?.backend;
					const rowOf = async (id: string) =>
						(
							await pg
								.select()
								.from(pgSchema.outlineSpecImports)
								.where(eq(pgSchema.outlineSpecImports.narratorId, id))
						)[0];

					const main = await seedSession(pg);
					await seedFile(
						pg,
						main.namespaceId,
						"tasks.json",
						JSON.stringify({ tasks: [{ text: "a" }, { text: "b", status: "doing" }] }),
					);
					await seedFile(pg, main.namespaceId, "design.md", "# D\n\ntext\n", "user");
					const imported = await importSpecSession(main.id, { trigger: "manual" });
					const afterImport = await rowOf(main.id);
					resetSpecImportRecords(); // a restart
					const readBack = await readSpecImportState(main.id);

					const broken = await seedSession(pg);
					await seedFile(pg, broken.namespaceId, "tasks.json", "not json");
					const failed = await importSpecSession(broken.id, { trigger: "sweep" });
					resetSpecImportRecords();
					const brokenState = await readSpecImportState(broken.id);

					// Serialized writes of one session, and the detail bound.
					await Promise.all(
						Array.from({ length: 5 }, () =>
							writeSpecImportState(broken.id, (current) => ({
								attempts: (current?.attempts ?? 0) + 1,
							})),
						),
					);
					await writeSpecImportState(broken.id, { error: "x".repeat(2000) });
					const brokenRow = await rowOf(broken.id);

					const counts = await countSpecImportStates();
					const page = await specImportAdminPage({ state: "imported", limit: 5 });

					const admin = generateId();
					const reverted = await revertSpecImport(main.id, admin);
					const afterRevert = { backend: await backendOf(main.id), row: await rowOf(main.id) };
					await reimportSpecSession(main.id, admin);
					await settleSpecImportRequests();
					const afterForward = { backend: await backendOf(main.id), row: await rowOf(main.id) };
					return {
						backend: outlineAccessBackend(),
						imported,
						afterImport,
						readBack,
						failed,
						brokenState,
						brokenRow,
						counts,
						page: page.items.map((item) => [item.narratorId, item.title, item.canRevert]),
						reverted,
						afterRevert,
						afterForward,
						main: main.id,
					};
				} catch (error) {
					return {
						error: error instanceof Error ? (error.stack ?? error.message) : String(error),
					};
				} finally {
					settings.outline.enabled = wasEnabled;
					setOutlineStore(undefined);
					setOutlineAccessExecutor(undefined);
					invalidateSessionReadScopes();
					invalidateTaskBackend();
					resetSpecImportRecords();
					stopEditTextWorker();
					await client.close();
				}
			});
			if (!outcome || typeof outcome !== "object" || !("imported" in outcome)) {
				throw new Error(`PostgreSQL harness did not run: ${JSON.stringify(outcome)}`);
			}
			expect(outcome.backend).toBe("postgres");
			expect(outcome.imported).toMatchObject({ status: "imported", tasks: 2, pages: 1 });
			expect(outcome.afterImport).toMatchObject({
				status: "imported",
				trigger: "manual",
				attempts: 0,
				switchCount: 1,
				noticeSwitch: 0,
				tasks: 2,
				pages: 1,
			});
			expect(outcome.afterImport?.spaceId).toBeString();
			expect(outcome.afterImport?.taskPageId).toBeString();
			expect(outcome.readBack).toMatchObject({ status: "imported", switchCount: 1 });
			expect(outcome.failed).toMatchObject({ status: "failed", attention: true });
			expect(outcome.brokenState).toMatchObject({
				status: "attention",
				attempts: 1,
				reason: { code: "broken_tasks" },
				attentionReason: "broken_tasks",
			});
			expect(outcome.brokenRow?.attempts).toBe(6);
			expect(outcome.brokenRow?.lastErrorDetail?.length).toBe(300);
			expect(outcome.counts).toMatchObject({ imported: 1, attention: 1, reverted: 0 });
			expect(outcome.page as unknown[]).toEqual([[outcome.main, "spec import", true]]);
			// PostgreSQL: no session runtime, the old fence never emptied there; the claim let go.
			expect(outcome.reverted).toEqual({
				reverted: true,
				marked: true,
				fenceRestored: true,
				released: 1,
			});
			expect(outcome.afterRevert?.backend).toBe("spec");
			expect(outcome.afterRevert?.row).toMatchObject({ status: "reverted", revertCount: 1 });
			expect(outcome.afterRevert?.row?.revertSourceKey).toMatch(/^[0-9a-f]{64}$/);
			expect(JSON.parse(outcome.afterRevert?.row?.revertNoteIds ?? "[]")).toHaveLength(1);
			expect(outcome.afterForward?.backend).toBe("outline");
			expect(outcome.afterForward?.row).toMatchObject({
				status: "imported",
				trigger: "admin",
				switchCount: 2,
				revertSourceKey: null,
				revertNoteIds: null,
			});
		},
		RUN_TIMEOUT_MS,
	);
});
