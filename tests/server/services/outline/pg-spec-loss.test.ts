/**
 * The swallowed-content scan on a real PostgreSQL (outline P2 PR 12c): the dual-dialect reads and
 * writes of `spec-import/loss-store.ts` (a revision's ancestors through the recursive query, the
 * findings and scans tables), the scan itself, and a person's decisions, on a database with every
 * `drizzle-postgres` migration applied verbatim.
 *
 * Rules, same as the other PostgreSQL suites:
 *   - `PG_INTEGRATION=1` means PostgreSQL really has to run; a blocked harness fails;
 *   - migrations are applied exactly as committed;
 *   - the harness owns and removes its database.
 */
import { describe, expect, it } from "bun:test";
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
	importSpecSession,
	resetSpecImportRecords,
} from "../../../../server/services/outline/spec-import/importer";
import {
	decideSpecLossFinding,
	specLossDetail,
	specLossPage,
} from "../../../../server/services/outline/spec-import/loss-findings";
import {
	resetSpecLossScanState,
	runSpecLossPass,
	scanSpecSessionLossById,
} from "../../../../server/services/outline/spec-import/loss-scan";
import {
	countSpecLossFindings,
	listSpecLossAttached,
	noteSpecLossAttachFailure,
	readSpecLossScan,
	readSpecRevisionChain,
} from "../../../../server/services/outline/spec-import/loss-store";
import { outlineStore, setOutlineStore } from "../../../../server/services/outline/store";
import { createPostgresOutlineStore } from "../../../../server/services/outline/store/postgres-store";
import { invalidateTaskBackend } from "../../../../server/services/task-source";
import { withPostgres } from "../../../db/pg-test-harness";
import { migrationSql } from "../read/pg-parity-matrix";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";
const RUN_TIMEOUT_MS = 600_000;
const NOW = "2026-11-13T00:00:00.000Z";
const TABLE = "| name | value |\n| --- | --- |\n| alpha | 1 |";

function urlFor(port: number, credentials: { user: string; password: string }): string {
	return `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(
		credentials.password,
	)}@127.0.0.1:${port}/nf_harness`;
}

async function seedSession(
	pg: BunSQLDatabase,
): Promise<{ id: string; owner: string; namespaceId: string }> {
	const owner = generateId();
	await pg.insert(pgSchema.users).values({
		id: owner,
		username: `pgsl-${owner}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	const id = generateId();
	await pg.insert(pgSchema.narrators).values({
		id,
		title: "spec loss",
		ownerUserId: owner,
		visibility: "private",
		type: "primary",
		status: "idle",
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

/** The file's revisions in order, each the parent of the next; the pointer names the last. */
async function seedHistory(
	pg: BunSQLDatabase,
	namespaceId: string,
	path: string,
	revisions: ReadonlyArray<{ content: string; by: "user" | "assistant" }>,
): Promise<string[]> {
	const ids: string[] = [];
	for (const [n, revision] of revisions.entries()) {
		const id = generateId();
		await pg.insert(pgSchema.specFileRevisions).values({
			id,
			namespaceId,
			path,
			content: revision.content,
			contentHash: `h${n}`,
			parentRevisionId: ids[n - 1] ?? null,
			createdBy: revision.by,
			createdAt: `2026-10-2${n}T00:00:00.000Z`,
		});
		ids.push(id);
	}
	await pg.insert(pgSchema.specNamespaceFiles).values({
		id: generateId(),
		namespaceId,
		path,
		revisionId: ids[ids.length - 1] as string,
		deleted: false,
		updatedAt: NOW,
	});
	return ids;
}

describe("PostgreSQL swallowed-content scan", () => {
	if (!PG_ENABLED) {
		it("skipped: set PG_INTEGRATION=1 to run the real PostgreSQL verification", () => {
			// Explicitly a skip, not a pass: no PostgreSQL work happened here.
			expect(process.env.PG_INTEGRATION).not.toBe("1");
		});
		return;
	}

	it(
		"reads the chain, records findings once, lists them and takes a person's decisions",
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
				resetSpecLossScanState();
				const wasEnabled = settings.outline.enabled;
				settings.outline.enabled = true;
				settings.outline.specImport = "manual";
				// The seeded saves count as made with the old editor.
				settings.outline.specLossCutoff = "2999-01-01T00:00:00.000Z";
				try {
					const pg = client.db;
					const main = await seedSession(pg);
					await seedHistory(pg, main.namespaceId, "tasks.json", [
						{ content: JSON.stringify({ tasks: [{ text: "a" }] }), by: "assistant" },
					]);
					const design = await seedHistory(pg, main.namespaceId, "design.md", [
						{ content: `# D\n\n${TABLE}\n\ntext\n`, by: "assistant" },
						{ content: "# D\n\ntext\n", by: "user" },
						{ content: "# D\n\ntext, more\n", by: "assistant" },
					]);
					const chain = await readSpecRevisionChain(design[2] as string);
					const missing = await readSpecRevisionChain("missing");

					const scan = await scanSpecSessionLossById(main.id);
					const again = await scanSpecSessionLossById(main.id);
					const forced = await scanSpecSessionLossById(main.id, { force: true });
					const scanRow = await readSpecLossScan(main.id);
					const page = await specLossPage({ status: "open", narratorId: main.id, canAct: true });
					const findingId = page.items[0]?.id as string;
					const detail = await specLossDetail(findingId, main.id);
					const dismissed = await decideSpecLossFinding({
						id: findingId,
						narratorId: main.id,
						action: "dismiss",
						userId: main.owner,
					});
					const countsDismissed = await countSpecLossFindings(main.id);
					const reopened = await decideSpecLossFinding({
						id: findingId,
						narratorId: null,
						action: "reopen",
						userId: main.owner,
					});

					// A second session, found by a pass.
					const other = await seedSession(pg);
					await seedHistory(pg, other.namespaceId, "notes.md", [
						{ content: `${TABLE}\n`, by: "assistant" },
						{ content: "gone\n", by: "user" },
					]);
					// It also lost task items (listed only), and a save after the cutoff is not looked at.
					await seedHistory(pg, other.namespaceId, "todo.md", [
						{ content: "- [ ] one\n- [ ] two\n", by: "assistant" },
						{ content: "- one\n- two\n", by: "user" },
					]);
					const late = await seedHistory(pg, other.namespaceId, "late.md", [
						{ content: `${TABLE}\n`, by: "assistant" },
						{ content: "gone\n", by: "user" },
					]);
					await client.sql`update spec_file_revisions set created_at = '2999-06-01T00:00:00.000Z' where id = ${late[1] as string}`;
					const pass = await runSpecLossPass({ pauseMs: 0 });
					const all = await specLossPage({ status: "open", narratorId: null, canAct: true });
					const otherOpen = (
						await specLossPage({ status: "open", narratorId: other.id, canAct: true })
					).items;
					const listed = otherOpen.find((item) => item.path === "todo.md");
					// An attach that keeps failing: counted, then given up.
					const failing = otherOpen.find((item) => item.path === "notes.md")?.id as string;
					const failures = [
						await noteSpecLossAttachFailure(failing, 3),
						await noteSpecLossAttachFailure(failing, 3),
						await noteSpecLossAttachFailure(failing, 3),
					];

					// Imported: the next pass attaches the finding to the file's page, once.
					const imported = await importSpecSession(main.id, { trigger: "manual" });
					const attachPass = await runSpecLossPass({ pauseMs: 0 });
					const idlePass = await runSpecLossPass({ pauseMs: 0 });
					const attached = (
						await specLossPage({ status: "attached", narratorId: main.id, canAct: true })
					).items[0];
					const attachedRows = await listSpecLossAttached(main.id, 5);
					const attachedAfter = await listSpecLossAttached(main.id, 5, {
						createdAt: attachedRows[0]?.createdAt as string,
						id: attachedRows[0]?.id as string,
					});
					const under = attached?.blockId
						? await outlineStore.listChildren(attached.spaceId as string, attached.blockId, 10)
						: [];
					// Dismissed (only the attach wrote the block: it goes), then reopened (attached anew).
					const dismissedAttached = await decideSpecLossFinding({
						id: findingId,
						narratorId: main.id,
						action: "dismiss",
						userId: main.owner,
					});
					const goneBlock = attached?.blockId
						? (
								await outlineStore.getBlockMetas(attached.spaceId as string, {
									ids: [attached.blockId],
								})
							)[0]?.deleted
						: null;
					const reattached = await decideSpecLossFinding({
						id: findingId,
						narratorId: main.id,
						action: "reopen",
						userId: main.owner,
					});
					return {
						backend: outlineAccessBackend(),
						chain,
						design,
						missing,
						scan,
						again,
						forced,
						scanRow,
						page,
						detail,
						dismissed,
						countsDismissed,
						reopened,
						pass,
						all: all.items.map((item) => [item.narratorId, item.path, item.title]),
						allScan: all.scan,
						imported,
						attachPass,
						idlePass,
						attached,
						dismissedAttached,
						goneBlock,
						reattached,
						listed,
						failures,
						attachedRows,
						attachedAfter,
						under: under.map((block) => block.content),
						main: main.id,
						other: other.id,
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
					resetSpecLossScanState();
					stopEditTextWorker();
					await client.close();
				}
			});
			if (!outcome || typeof outcome !== "object" || !("scan" in outcome)) {
				throw new Error(`PostgreSQL harness did not run: ${JSON.stringify(outcome)}`);
			}
			const ran = outcome as Extract<typeof outcome, { main: string }>;
			expect(ran.backend).toBe("postgres");
			expect(ran.chain.map((r) => [r.id, r.createdBy, r.chars])).toEqual([
				[ran.design[2] as string, "assistant", 16],
				[ran.design[1] as string, "user", 10],
				[ran.design[0] as string, "assistant", 10 + TABLE.length + 2],
			]);
			expect(ran.chain[2]?.parentRevisionId).toBeNull();
			expect(ran.chain[0]?.createdAt).toBe("2026-10-22T00:00:00.000Z");
			expect(ran.missing).toEqual([]);
			expect(ran.scan).toEqual({ saves: 1, findings: 1, added: 1, note: null });
			expect(ran.again).toBe("skipped");
			expect(ran.forced).toEqual({ saves: 1, findings: 1, added: 0, note: null });
			expect(ran.scanRow).toMatchObject({ saves: 1, findings: 1, note: null });
			expect(ran.page.counts).toEqual({ open: 1, attached: 0, dismissed: 0 });
			expect(ran.page.items[0]).toMatchObject({
				narratorId: ran.main,
				title: "spec loss",
				path: "design.md",
				kinds: { table: 1 },
				savedAt: "2026-10-21T00:00:00.000Z",
				status: "open",
				truncated: false,
				attachable: false,
			});
			expect(ran.detail.parts).toEqual([{ kind: "table", text: TABLE }]);
			expect(ran.dismissed).toMatchObject({ status: "dismissed" });
			expect(ran.countsDismissed).toEqual({ open: 0, attached: 0, dismissed: 1 });
			expect(ran.reopened).toMatchObject({ status: "open", resolvedAt: null });
			expect(ran.pass).toEqual({ sessions: 2, scanned: 1, found: 2, attached: 0, left: 0 });
			expect(new Set(ran.all.map((row) => row.join("|")))).toEqual(
				new Set([
					`${ran.main}|design.md|spec loss`,
					`${ran.other}|notes.md|spec loss`,
					`${ran.other}|todo.md|spec loss`,
				]),
			);
			expect(ran.listed).toMatchObject({ kinds: { taskItem: 2 }, attachNote: "list_only" });
			expect(ran.failures).toEqual(["failed", "failed", "gave_up"]);
			expect(ran.attachedRows).toMatchObject([{ blockId: ran.attached?.blockId, attachSeq: 0 }]);
			expect(ran.attachedAfter).toEqual([]);
			expect(ran.allScan).toMatchObject({ running: false });
			expect(ran.imported).toMatchObject({ status: "imported" });
			expect(ran.attachPass).toMatchObject({ attached: 1, left: 0 });
			expect(ran.idlePass).toMatchObject({ attached: 0, left: 0 });
			expect(ran.attached).toMatchObject({ status: "attached", attachNote: null });
			expect(ran.attached?.blockId).toBeString();
			expect(ran.dismissedAttached).toMatchObject({ status: "dismissed", blockId: null });
			expect(ran.goneBlock).toBe(true);
			expect(ran.reattached).toMatchObject({ status: "attached" });
			expect(ran.reattached.blockId).not.toBe(ran.attached?.blockId as string);
			expect(ran.under).toEqual([TABLE]);
		},
		RUN_TIMEOUT_MS,
	);
});
