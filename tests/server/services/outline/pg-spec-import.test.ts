/**
 * The Dynamic Spec import against a real PostgreSQL (outline P2 PR 12b): the read port's
 * statements, the import's commits through the PostgreSQL outline store, and the conditional
 * move of the session, on a database that has every `drizzle-postgres` migration applied
 * verbatim. Spec rows are seeded directly (the Dynamic Spec service reads through the SQLite
 * handle; rows a PostgreSQL deployment holds were written by its store).
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
	TEAM_SOP_CLOSE,
	TEAM_SOP_OPEN,
	TEAM_SOP_PLUGIN_ID,
} from "../../../../server/services/behavior-fence-sop";
import {
	createPostgresOutlineAccessExecutor,
	outlineAccessBackend,
	setOutlineAccessExecutor,
} from "../../../../server/services/outline/access-reads";
import { stopEditTextWorker } from "../../../../server/services/outline/edit-text-runner";
import {
	OUTLINE_BEHAVIOR_ALIAS,
	OUTLINE_TASKS_PAGE_ALIAS,
} from "../../../../server/services/outline/model";
import { invalidateSessionReadScopes } from "../../../../server/services/outline/session-scope";
import {
	importSpecSession,
	resetSpecImportRecords,
} from "../../../../server/services/outline/spec-import/importer";
import {
	readSpecFilePointers,
	readSpecImportSession,
	readSpecNamespacePage,
	readSpecProtectors,
} from "../../../../server/services/outline/spec-import/read-port";
import { runSpecImportPass } from "../../../../server/services/outline/spec-import/triggers";
import { outlineStore, setOutlineStore } from "../../../../server/services/outline/store";
import { createPostgresOutlineStore } from "../../../../server/services/outline/store/postgres-store";
import { specIndexSid } from "../../../../server/services/plugin-spec-compat";
import { taskTextHash } from "../../../../server/services/spec-task-service";
import { invalidateTaskBackend } from "../../../../server/services/task-source";
import { pluginRulesSid } from "../../../../server/services/task-source/outline-plugin-rules";
import { withPostgres } from "../../../db/pg-test-harness";
import { migrationSql } from "../read/pg-parity-matrix";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";
const RUN_TIMEOUT_MS = 600_000;
const NOW = "2026-11-10T00:00:00.000Z";

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

describe("PostgreSQL Dynamic Spec import", () => {
	if (!PG_ENABLED) {
		it("skipped: set PG_INTEGRATION=1 to run the real PostgreSQL verification", () => {
			// Explicitly a skip, not a pass: no PostgreSQL work happened here.
			expect(process.env.PG_INTEGRATION).not.toBe("1");
		});
		return;
	}

	it(
		"reads, imports and moves a session on a real server",
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
				settings.outline.specImport = "auto";
				try {
					const pg = client.db;
					const main = await seedSession(pg);
					const userRevision = await seedFile(
						pg,
						main.namespaceId,
						"tasks.json",
						JSON.stringify({ tasks: [{ text: "the goal", protected: true }] }),
						"user",
					);
					// The current tasks.json, written by the agent after the person's goal.
					await pg
						.delete(pgSchema.specNamespaceFiles)
						.where(eq(pgSchema.specNamespaceFiles.namespaceId, main.namespaceId));
					await seedFile(
						pg,
						main.namespaceId,
						"tasks.json",
						JSON.stringify({
							tasks: [
								{ text: "the goal", protected: true },
								{ text: "doing now", status: "doing" },
								{ text: "stuck", status: "blocked" },
								{ text: "finished", status: "done" },
							],
						}),
					);
					await pg.insert(pgSchema.specProtectedTasks).values({
						id: generateId(),
						namespaceId: main.namespaceId,
						textHash: taskTextHash("the goal"),
						text: "the goal",
						status: "todo",
						firstRevisionId: userRevision,
						lastRevisionId: userRevision,
						createdAt: NOW,
						updatedAt: NOW,
					});
					await seedFile(pg, main.namespaceId, "index.md", "# Plan\n\nA note\n", "user");
					await seedFile(pg, main.namespaceId, "data.json", '{"k": 1}\n');
					await seedFile(
						pg,
						main.namespaceId,
						"behavior_fence",
						`- Own rule\n\n${TEAM_SOP_OPEN}\nTeam SOP.\n${TEAM_SOP_CLOSE}`,
						"user",
					);
					const sub = await seedSession(pg, { type: "subagent" });
					await seedFile(
						pg,
						sub.namespaceId,
						"tasks.json",
						JSON.stringify({ tasks: [{ text: "own" }] }),
					);
					const archived = await seedSession(pg, { archived: true });
					await seedFile(
						pg,
						archived.namespaceId,
						"tasks.json",
						JSON.stringify({ tasks: [{ text: "was doing", status: "doing" }] }),
					);

					// The read port.
					const session = await readSpecImportSession(main.id);
					const pointers = await readSpecFilePointers(main.namespaceId);
					const protectors = await readSpecProtectors(main.namespaceId);
					const page = await readSpecNamespacePage(null);

					const imported = await importSpecSession(main.id, { trigger: "manual" });
					const again = await importSpecSession(main.id, { trigger: "manual" });
					const subOutcome = await importSpecSession(sub.id, { trigger: "manual" });
					const pass = await runSpecImportPass({ pauseMs: 0 });

					const backendOf = async (id: string) =>
						(
							await pg
								.select({ backend: pgSchema.narrators.taskBackend })
								.from(pgSchema.narrators)
								.where(eq(pgSchema.narrators.id, id))
						)[0]?.backend;
					const space = await outlineStore.findSpace({ kind: "session", narratorId: main.id });
					if (!space) return { error: "no session space" };
					const [tasksPage] = await outlineStore.findAliasOwners(space.id, [
						OUTLINE_TASKS_PAGE_ALIAS,
					]);
					const tasks = await outlineStore.listChildren(space.id, tasksPage?.id ?? "", 20);
					const claims = await outlineStore.getTaskClaims(tasks.map((t) => t.id));
					const [behavior] = await outlineStore.findAliasOwners(space.id, [OUTLINE_BEHAVIOR_ALIAS]);
					const rules = await outlineStore.listChildren(space.id, behavior?.id ?? "", 20);
					const [index] = await outlineStore.getBlockMetas(space.id, { sids: [specIndexSid()] });
					const archivedSpace = await outlineStore.findSpace({
						kind: "session",
						narratorId: archived.id,
					});
					const [archivedPage] = archivedSpace
						? await outlineStore.findAliasOwners(archivedSpace.id, [OUTLINE_TASKS_PAGE_ALIAS])
						: [];
					const archivedTasks = archivedSpace
						? await outlineStore.listChildren(archivedSpace.id, archivedPage?.id ?? "", 5)
						: [];
					return {
						backend: outlineAccessBackend(),
						session,
						pointers: pointers.map((p) => [
							p.path,
							p.revisionId !== null,
							p.deleted,
							p.chars !== null,
						]),
						protector: protectors.byHash.get(taskTextHash("the goal")),
						pageHasMain: page.sessions.some((s) => s.narratorId === main.id),
						imported,
						again,
						subOutcome,
						passImported: pass.imported,
						backends: [
							await backendOf(main.id),
							await backendOf(sub.id),
							await backendOf(archived.id),
						],
						tasks: tasks.map((t) => [
							t.content,
							t.taskJson?.status,
							t.taskJson?.humanCreated === true,
							t.taskJson?.lock?.by.id === main.owner,
						]),
						claimedBy: claims.filter((c) => c.holderNarratorId === main.id).length,
						rules: rules.map((r) => r.content),
						hasPluginBlock: rules.some((r) => r.sid === pluginRulesSid(TEAM_SOP_PLUGIN_ID)),
						indexIsPage: index?.parentId === null && index.deleted === false,
						archivedTasks: archivedTasks.map((t) => [t.content, t.taskJson?.status]),
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
					stopEditTextWorker();
					await client.close();
				}
			});
			if (!outcome || typeof outcome !== "object" || !("imported" in outcome)) {
				throw new Error(`PostgreSQL harness did not run: ${JSON.stringify(outcome)}`);
			}
			expect(outcome.backend).toBe("postgres");
			expect(outcome.session).toMatchObject({
				type: "primary",
				taskBackend: "spec",
				archived: false,
				external: false,
			});
			expect(outcome.pointers).toEqual([
				["behavior_fence", true, false, true],
				["data.json", true, false, true],
				["index.md", true, false, true],
				["tasks.json", true, false, true],
			]);
			expect(outcome.protector).toBe("user");
			expect(outcome.pageHasMain).toBe(true);
			expect(outcome.imported).toMatchObject({ status: "imported", tasks: 4, pages: 2 });
			expect(outcome.again).toEqual({ status: "skipped", reason: "outline" });
			expect(outcome.subOutcome).toEqual({ status: "skipped", reason: "subagent" });
			expect(outcome.passImported).toBe(1);
			expect(outcome.backends).toEqual(["outline", "spec", "outline"]);
			expect(outcome.tasks).toEqual([
				["the goal", "todo", true, true],
				["doing now", "doing", false, false],
				["stuck", "doing", false, false],
				["finished", "done", false, false],
			]);
			expect(outcome.claimedBy).toBe(2);
			expect(outcome.rules).toContain("Own rule");
			expect(outcome.hasPluginBlock).toBe(true);
			expect(outcome.indexIsPage).toBe(true);
			expect(outcome.archivedTasks).toEqual([["was doing", "todo"]]);
		},
		RUN_TIMEOUT_MS,
	);
});
