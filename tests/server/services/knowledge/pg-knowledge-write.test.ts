/**
 * The PostgreSQL knowledge write path, verified against a real PostgreSQL 17.
 *
 * The SQLite half of this capability is pinned by
 * `server/services/knowledge/__tests__/write-store-contract.test.ts`. This suite runs
 * the SAME business facts against the PostgreSQL adapter over a real network
 * connection to a throwaway container that has had every `drizzle-postgres`
 * migration applied verbatim, plus the pg_trgm FTS catalog (`ensurePgFts`):
 *
 *   - WRITE → FTS → SEARCH: entries and drafts written through the store are
 *     maintained in the trigger-owned shadow tables and found through the PG search
 *     store; an entry RENAME cascades to its drafts' de-normalized shadow title, so
 *     a draft search hits under the new title and misses under the old one;
 *   - VERSION ALLOCATION UNDER REAL CONCURRENCY: 8 concurrent `appendRevision`
 *     calls on pooled connections all succeed with unique, contiguous versions —
 *     the entry-row lock (`FOR UPDATE`) is the allocation authority. A scratch-table
 *     negative control proves the hazard is real (bare MAX+1 duplicates) and the
 *     scratch positive control proves the lock shape removes it;
 *   - CONFLICTS AS VOCABULARY: 23505 arrives as `WriteConflictError` naming the
 *     constraint, never a driver error and never a 500;
 *   - GUARDS: the submission/review state machine rejects a second reviewer with the
 *     same ValidationError the SQLite backend produces;
 *   - ACL DUAL-AXIS EQUIVALENCE: the same grant-replacement input executed on both
 *     backends produces row sets that project — through the ACL layer's own
 *     `toKnowledgeGrantRow` — to the same credentials (clearance + controlled tag +
 *     write), and non-knowledge scopes survive the replacement;
 *   - spec:// VFS and pack activation sections behave exactly as on SQLite.
 *
 * Rules, same as the other PG suites:
 *   - `PG_INTEGRATION=1` means PostgreSQL really has to run. A blocked harness is a
 *     failure in that mode, never a quiet pass;
 *   - migrations are applied EXACTLY as committed;
 *   - the container is the harness' own random name and only it is cleaned up.
 */

import { afterAll, describe, expect, it, mock } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { WriteConflictError } from "../../../../server/db/backend/write-port";
import { ensurePgFts } from "../../../../server/db/pg-fts";
import { createPostgresClient } from "../../../../server/db/postgres-client";
import * as pgSchema from "../../../../server/db/postgres-schema";
import * as sqliteSchema from "../../../../server/db/schema";
import { ValidationError } from "../../../../server/lib/errors";
import { generateId } from "../../../../server/lib/id";
import { createPostgresKnowledgeWriteStore } from "../../../../server/services/knowledge/postgres-write-store";
import { createPostgresSearchStore } from "../../../../server/services/search/postgres-store";
import { withPostgres } from "../../../db/pg-test-harness";
import { cleanDb, getTestDb } from "../../../setup";
import { migrationSql } from "../read/pg-parity-matrix";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";
const RUN_TIMEOUT_MS = 300_000;

// `toKnowledgeGrantRow` and the SQLite store pull in `server/db` at module level. It
// is mocked over the isolated in-memory database exactly as the SQLite suites do —
// the PostgreSQL path under test never touches it, and the mock guarantees that by
// making any accidental SQLite write land in a scratch database.
const { db: sqliteDb, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../../../server/db")) };
mock.module("../../../../server/db", () => ({ db: sqliteDb, sqlite }));

const { toKnowledgeGrantRow } = await import("../../../../server/services/knowledge-acl");
const { sqliteKnowledgeWriteStore } = await import(
	"../../../../server/services/knowledge/sqlite-write-store"
);

afterAll(() => {
	mock.module("../../../../server/db", () => realDbModule);
	mock.restore();
	sqlite.close();
});

const NOW = () => new Date().toISOString();

type PgStore = ReturnType<typeof createPostgresKnowledgeWriteStore>;

function urlFor(port: number, credentials: { user: string; password: string }): string {
	return `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(
		credentials.password,
	)}@127.0.0.1:${port}/nf_harness`;
}

describe("PostgreSQL knowledge write path", () => {
	if (!PG_ENABLED) {
		it("skipped: set PG_INTEGRATION=1 to run the real PostgreSQL verification", () => {
			// Explicitly a skip, not a pass: no PostgreSQL work happened here.
			expect(process.env.PG_INTEGRATION).not.toBe("1");
		});
		return;
	}

	it(
		"satisfies the write contract, the FTS sync and the concurrency semantics on a real server",
		async () => {
			const sqls = await migrationSql();
			const outcome = await withPostgres(async ({ exec, port, schema, credentials }) => {
				expect(port).toBeGreaterThan(0);
				for (const statement of sqls) {
					const applied = await exec(statement);
					if (applied.code !== 0) {
						return {
							migrationError: applied.stderr
								.split("\n")
								.filter((line) => !line.startsWith("NOTICE:"))
								.join("\n")
								.slice(0, 400),
						};
					}
				}

				const client = createPostgresClient({
					driver: "bun-sql",
					url: urlFor(port, credentials),
					// A real pool: the concurrency cases need sections genuinely in flight at
					// once, which a single-connection handle cannot produce.
					max: 8,
					connectTimeout: 10,
				});
				const pgDb: BunSQLDatabase = client.db;
				const store: PgStore = createPostgresKnowledgeWriteStore(pgDb);
				const search = createPostgresSearchStore(client.sql);
				const problems: string[] = [];
				const landmarks: Record<string, unknown> = {};

				// The FTS catalog is NOT part of the Drizzle migrations (pg_trgm, GIN
				// operator classes and trigger functions have no schema spelling) — the
				// startup path installs it, so the suite does the same.
				await ensurePgFts(client.sql);

				const userId = generateId();
				const seedUser = async (id: string, name: string): Promise<void> => {
					await pgDb.insert(pgSchema.users).values({
						id,
						username: name,
						passwordHash: "x",
						role: "user",
						createdAt: NOW(),
					});
				};

				/** Run one case; record failures as text, never throw past the harness. */
				const check = async (label: string, fn: () => Promise<void>): Promise<void> => {
					try {
						await fn();
					} catch (error) {
						problems.push(
							`${label}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`.slice(
								0,
								700,
							),
						);
					}
				};

				const makeCollection = (slug: string) =>
					store.createCollection({
						id: generateId(),
						name: `col-${slug}`,
						slug,
						description: null,
						projectId: null,
						ownerUserId: null,
						now: NOW(),
					});

				const makeEntry = async (collectionId: string, slug: string, content: string) => {
					const entryId = generateId();
					const revisionId = generateId();
					await store.createEntryWithFirstRevision({
						entryId,
						revisionId,
						collectionId,
						title: `entry-${slug}`,
						slug,
						content,
						format: "markdown",
						contentHash: `hash-${slug}`,
						currentKeywords: null,
						tagsJson: [],
						keywordsJson: [],
						metadataJson: null,
						ownerUserId: userId,
						changeNote: null,
						authorUserId: userId,
						now: NOW(),
					});
					return { entryId, revisionId };
				};

				const versionsOf = async (entryId: string): Promise<number[]> => {
					const rows = await pgDb
						.select({ v: pgSchema.knowledgeRevisions.version })
						.from(pgSchema.knowledgeRevisions)
						.where(eq(pgSchema.knowledgeRevisions.entryId, entryId))
						.orderBy(pgSchema.knowledgeRevisions.version);
					return rows.map((r) => r.v);
				};

				try {
					await seedUser(userId, `pg-kw-${generateId(6)}`);

					// ── A. Write → FTS shadow → search ─────────────────────────────
					let colAId = "";
					let entryAId = "";
					await check("entry writes are searchable, revision switches re-index", async () => {
						const col = await makeCollection(`a-${generateId(6)}`);
						colAId = col.id;
						const { entryId } = await makeEntry(col.id, "alpha", "the quixotic handbook body");
						entryAId = entryId;

						const hits = await search.searchKnowledgeEntries({
							indexText: "quixotic",
							substringText: "quixotic",
							strategy: "index",
							limit: 10,
							match: "and",
						});
						expect(hits.map((h) => h.id)).toContain(entryId);

						// The keyword column is its own field-restricted path (passive injection).
						await pgDb
							.update(pgSchema.knowledgeEntries)
							.set({ currentKeywords: "zanzibar", keywordsJson: ["zanzibar"] })
							.where(eq(pgSchema.knowledgeEntries.id, entryId));
						const kwHits = await search.searchKnowledgeEntries({
							indexText: "zanzibar",
							substringText: "zanzibar",
							strategy: "index",
							limit: 10,
							match: "and",
							field: "current_keywords",
						});
						expect(kwHits.map((h) => h.id)).toContain(entryId);

						// A revision switch re-indexes: new content hits, replaced content misses.
						await store.appendRevision({
							entryId,
							revisionId: generateId(),
							content: "revised zephyr content",
							format: "markdown",
							contentHash: "h2",
							changeNote: null,
							authorUserId: userId,
							now: NOW(),
						});
						const newHits = await search.searchKnowledgeEntries({
							indexText: "zephyr",
							substringText: "zephyr",
							strategy: "index",
							limit: 10,
							match: "and",
						});
						expect(newHits.map((h) => h.id)).toContain(entryId);
						const oldHits = await search.searchKnowledgeEntries({
							indexText: "handbook",
							substringText: "handbook",
							strategy: "index",
							limit: 10,
							match: "and",
						});
						expect(oldHits.map((h) => h.id)).not.toContain(entryId);
						landmarks.entryFts = "write→search + reindex ok";
					});

					// ── B. Drafts FTS + the rename cascade ─────────────────────────
					let draftBId = "";
					await check("entry rename cascades to the drafts' shadow title", async () => {
						expect(entryAId).not.toBe("");
						const draft = await store.getOrCreateActiveDraft({
							draftId: generateId(),
							entryId: entryAId,
							authorUserId: userId,
							name: null,
							baseRevisionId: null,
							content: "draft wobble text",
							contentHash: "hd",
							now: NOW(),
						});
						draftBId = draft.id;

						const draftQuery = {
							indexText: "wobble",
							substringText: "wobble",
							strategy: "index" as const,
							limit: 10,
							match: "and" as const,
							authorUserId: userId,
							draftStatus: "active",
						};
						const hits = await search.searchKnowledgeDrafts(draftQuery);
						expect(hits.map((h) => h.id)).toContain(entryAId);

						// The rename is a knowledge WRITE PATH operation (updateEntryMeta); the
						// trigger cascades it to the de-normalized draft shadow title, so the
						// draft now hits under the new title and misses under the old one.
						await store.updateEntryMeta({
							entryId: entryAId,
							title: "renamed compendium",
							now: NOW(),
						});
						const newTitleHits = await search.searchKnowledgeDrafts({
							...draftQuery,
							indexText: "compendium",
							substringText: "compendium",
						});
						expect(newTitleHits.map((h) => h.id)).toContain(entryAId);
						const oldTitleHits = await search.searchKnowledgeDrafts({
							...draftQuery,
							indexText: "entry-alpha",
							substringText: "entry-alpha",
						});
						expect(oldTitleHits.map((h) => h.id)).not.toContain(entryAId);

						// Draft content edits re-index too.
						await store.updateDraftContent({
							draftId: draftBId,
							content: "trundle revised draft",
							contentHash: "hd2",
							now: NOW(),
						});
						const editedHits = await search.searchKnowledgeDrafts({
							...draftQuery,
							indexText: "trundle",
							substringText: "trundle",
						});
						expect(editedHits.map((h) => h.id)).toContain(entryAId);

						// Archiving removes the draft from the active shadow set.
						expect(
							await search.listShadowedEntryIds({
								authorUserId: userId,
								draftStatus: "active",
								limit: 50,
							}),
						).toContain(entryAId);
						await store.archivePersonalEntry({ draftId: draftBId, now: NOW() });
						expect(
							await search.listShadowedEntryIds({
								authorUserId: userId,
								draftStatus: "active",
								limit: 50,
							}),
						).not.toContain(entryAId);
						landmarks.draftRenameCascade = "entry-alpha → renamed compendium";
					});

					// ── C. Submission → merge, and the second-reviewer guard ───────
					await check(
						"commitMergedRevision claims the version; second reviewer refused",
						async () => {
							expect(entryAId).not.toBe("");
							const baseVersion = (await versionsOf(entryAId)).at(-1) ?? 0;
							const draft = await store.getOrCreateActiveDraft({
								draftId: generateId(),
								entryId: entryAId,
								authorUserId: userId,
								name: null,
								baseRevisionId: null,
								content: "merged content",
								contentHash: "hm",
								now: NOW(),
							});
							const submission = await store.createSubmissionGuarded({
								submissionId: generateId(),
								draftId: draft.id,
								entryId: entryAId,
								collectionId: null,
								title: null,
								submitterUserId: userId,
								baseRevisionId: null,
								proposedContent: "merged content",
								keywordsJson: null,
								changeNote: null,
								previousSubmissionId: null,
								round: 1,
								now: NOW(),
							});
							const { version } = await store.commitMergedRevision({
								submissionId: submission.id,
								draftId: draft.id,
								entryId: entryAId,
								revisionId: generateId(),
								content: "merged content",
								contentHash: "hm",
								changeNote: null,
								baseRevisionId: null,
								submitterUserId: userId,
								reviewerUserId: userId,
								now: NOW(),
							});
							expect(version).toBe(baseVersion + 1);
							// The second reviewer loses to the in-section status re-check with the
							// same domain error the SQLite backend produces.
							const second = await store
								.commitMergedRevision({
									submissionId: submission.id,
									draftId: draft.id,
									entryId: entryAId,
									revisionId: generateId(),
									content: "other",
									contentHash: "ho",
									changeNote: null,
									baseRevisionId: null,
									submitterUserId: userId,
									reviewerUserId: userId,
									now: NOW(),
								})
								.catch((e: unknown) => e);
							expect(second).toBeInstanceOf(ValidationError);
							landmarks.reviewGuard = "ValidationError on second reviewer";
						},
					);

					// ── D. Version allocation under real concurrency ───────────────
					await check("8 concurrent appenders get unique contiguous versions", async () => {
						const col = await makeCollection(`race-${generateId(6)}`);
						const { entryId } = await makeEntry(col.id, "race", "race body");
						const attempts = await Promise.allSettled(
							Array.from({ length: 8 }, (_, i) =>
								store.appendRevision({
									entryId,
									revisionId: generateId(),
									content: `racer ${i}`,
									format: "markdown",
									contentHash: `hr${i}`,
									changeNote: null,
									authorUserId: userId,
									now: NOW(),
								}),
							),
						);
						const succeeded = attempts.filter((a) => a.status === "fulfilled");
						expect(succeeded).toHaveLength(8);
						const versions = (await versionsOf(entryAId)).length; // sanity: unrelated
						expect(versions).toBeGreaterThan(0);
						expect(await versionsOf(entryId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
						landmarks.versionRaceWinners = succeeded.length;
					});

					await check(
						"scratch control: bare MAX+1 duplicates, the row lock removes it",
						async () => {
							// The hazard and the remedy, proven on scratch tables in the harness
							// schema (no unique index — the duplicate must be VISIBLE, not
							// constraint-rejected, to prove the hazard exists).
							const ddl = await exec(`
							CREATE TABLE IF NOT EXISTS ${schema}.kv_entries (id text PRIMARY KEY);
							CREATE TABLE IF NOT EXISTS ${schema}.kv_revisions (id text PRIMARY KEY, entry_id text NOT NULL, version integer NOT NULL);
							INSERT INTO ${schema}.kv_entries (id) VALUES ('e1'), ('e2');
						`);
							if (ddl.code !== 0) throw new Error(`ddl:${ddl.stderr.slice(0, 200)}`);

							// Negative control: two connections read the same MAX and both insert.
							const b1 = createPostgresClient({
								driver: "bun-sql",
								url: urlFor(port, credentials),
								max: 1,
								connectTimeout: 10,
							});
							const b2 = createPostgresClient({
								driver: "bun-sql",
								url: urlFor(port, credentials),
								max: 1,
								connectTimeout: 10,
							});
							try {
								await b1.sql.unsafe("BEGIN");
								await b2.sql.unsafe("BEGIN");
								const readShape = `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM ${schema}.kv_revisions WHERE entry_id = 'e1'`;
								const maxA = await b1.sql.unsafe(readShape);
								const maxB = await b2.sql.unsafe(readShape);
								expect(Number(maxA[0].v)).toBe(1);
								expect(Number(maxB[0].v)).toBe(1);
								await b1.sql.unsafe(
									`INSERT INTO ${schema}.kv_revisions (id, entry_id, version) VALUES ('b-r1', 'e1', 1)`,
								);
								await b2.sql.unsafe(
									`INSERT INTO ${schema}.kv_revisions (id, entry_id, version) VALUES ('b-r2', 'e1', 1)`,
								);
								await b1.sql.unsafe("COMMIT");
								await b2.sql.unsafe("COMMIT");
								const dupes = await b1.sql.unsafe(
									`SELECT COUNT(*) AS n FROM ${schema}.kv_revisions WHERE entry_id = 'e1' AND version = 1`,
								);
								expect(Number(dupes[0].n)).toBe(2);
							} finally {
								await b1.close();
								await b2.close();
							}

							// Positive control: the store's shape (entry row lock, then MAX+1)
							// serializes the same interleaving into distinct contiguous versions.
							const c1 = createPostgresClient({
								driver: "bun-sql",
								url: urlFor(port, credentials),
								max: 1,
								connectTimeout: 10,
							});
							const c2 = createPostgresClient({
								driver: "bun-sql",
								url: urlFor(port, credentials),
								max: 1,
								connectTimeout: 10,
							});
							try {
								await c1.sql.unsafe("BEGIN");
								await c2.sql.unsafe("BEGIN");
								await c1.sql.unsafe(
									`SELECT id FROM ${schema}.kv_entries WHERE id = 'e2' FOR UPDATE`,
								);
								const c2Blocked = c2.sql.unsafe(
									`SELECT id FROM ${schema}.kv_entries WHERE id = 'e2' FOR UPDATE`,
								);
								const seqA = await c1.sql.unsafe(
									`SELECT COALESCE(MAX(version), 0) + 1 AS v FROM ${schema}.kv_revisions WHERE entry_id = 'e2'`,
								);
								await c1.sql.unsafe(
									`INSERT INTO ${schema}.kv_revisions (id, entry_id, version) VALUES ('c-r1', 'e2', ${Number(seqA[0].v)})`,
								);
								await c1.sql.unsafe("COMMIT");
								await c2Blocked; // unblocks only after c1 commits
								const seqB = await c2.sql.unsafe(
									`SELECT COALESCE(MAX(version), 0) + 1 AS v FROM ${schema}.kv_revisions WHERE entry_id = 'e2'`,
								);
								await c2.sql.unsafe(
									`INSERT INTO ${schema}.kv_revisions (id, entry_id, version) VALUES ('c-r2', 'e2', ${Number(seqB[0].v)})`,
								);
								await c2.sql.unsafe("COMMIT");
								expect(Number(seqA[0].v)).toBe(1);
								expect(Number(seqB[0].v)).toBe(2);
							} finally {
								await c1.close();
								await c2.close();
							}
							landmarks.scratchControl = "dup-without-lock / contiguous-with-lock";
						},
					);

					// ── E. Conflicts as vocabulary ─────────────────────────────────
					await check("23505 crosses as WriteConflictError naming the constraint", async () => {
						const projectId = generateId();
						await pgDb.insert(pgSchema.projects).values({
							id: projectId,
							name: `proj-${generateId(6)}`,
							createdAt: NOW(),
							updatedAt: NOW(),
						});
						const input = {
							name: "dup",
							slug: "dup",
							description: null,
							projectId,
							ownerUserId: null,
							now: NOW(),
						};
						await store.createCollection({ id: generateId(), ...input });
						const error = await store
							.createCollection({ id: generateId(), ...input })
							.catch((e: unknown) => e);
						expect(error).toBeInstanceOf(WriteConflictError);
						expect(typeof (error as WriteConflictError).constraint).toBe("string");
						landmarks.conflictConstraint = (error as WriteConflictError).constraint;

						// A conflicting entry write leaves nothing behind.
						const col = await makeCollection(`ce-${generateId(6)}`);
						await makeEntry(col.id, "taken", "first");
						const doomedRevisionId = generateId();
						const entryError = await store
							.createEntryWithFirstRevision({
								entryId: generateId(),
								revisionId: doomedRevisionId,
								collectionId: col.id,
								title: "second",
								slug: "taken",
								content: "x",
								format: "markdown",
								contentHash: "x",
								currentKeywords: null,
								tagsJson: [],
								keywordsJson: [],
								metadataJson: null,
								ownerUserId: null,
								changeNote: null,
								authorUserId: null,
								now: NOW(),
							})
							.catch((e: unknown) => e);
						expect(entryError).toBeInstanceOf(WriteConflictError);
						const orphan = await pgDb
							.select({ id: pgSchema.knowledgeRevisions.id })
							.from(pgSchema.knowledgeRevisions)
							.where(eq(pgSchema.knowledgeRevisions.id, doomedRevisionId));
						expect(orphan).toEqual([]);
					});

					// ── F. Injection events: ON CONFLICT DO NOTHING ────────────────
					await check("injection events dedupe on (narrator, compactSeq, entry)", async () => {
						const narratorId = generateId();
						await pgDb.insert(pgSchema.narrators).values({
							id: narratorId,
							createdAt: NOW(),
							updatedAt: NOW(),
						});
						const col = await makeCollection(`inj-${generateId(6)}`);
						const { entryId } = await makeEntry(col.id, "inj", "injection target");
						const input = {
							narratorId,
							compactSeq: 0,
							source: "tool_output",
							triggerMessageId: null,
							triggerToolCallId: null,
							now: NOW(),
						};
						const hit = { id: generateId(), entryId, entryRevisionId: null, summary: null };
						await store.recordInjectionEvents({ ...input, hits: [hit] });
						await store.recordInjectionEvents({
							...input,
							hits: [{ ...hit, id: generateId() }],
						});
						const rows = await pgDb
							.select({ id: pgSchema.knowledgeInjectionEvents.id })
							.from(pgSchema.knowledgeInjectionEvents)
							.where(eq(pgSchema.knowledgeInjectionEvents.narratorId, narratorId));
						expect(rows).toHaveLength(1);
					});

					// ── G. ACL dual-axis write equivalence ─────────────────────────
					await check(
						"grant replacement projects to the same credentials on both backends",
						async () => {
							const principal = generateId();
							const rowIds = [generateId(), generateId(), generateId()];
							const createdAt = NOW();
							// Dual axis + write: a clearance credential, its write capability row,
							// and a controlled-tag credential — the exact folding the ACL layer
							// consumes (see knowledgeGrantRowsFor).
							const rows = [
								{
									id: rowIds[0],
									scopeType: "global",
									scopeId: null,
									principalType: "user",
									principalId: principal,
									capability: "read",
									domainKind: "clearance",
									domainValue: "internal",
									grantedBy: null,
									createdAt,
								},
								{
									id: rowIds[1],
									scopeType: "global",
									scopeId: null,
									principalType: "user",
									principalId: principal,
									capability: "write",
									domainKind: null,
									domainValue: null,
									grantedBy: null,
									createdAt,
								},
								{
									id: rowIds[2],
									scopeType: "global",
									scopeId: null,
									principalType: "user",
									principalId: principal,
									capability: "read",
									domainKind: "tag",
									domainValue: `tag-${generateId(6)}`,
									grantedBy: null,
									createdAt,
								},
							];
							const input = { principalType: "user", principalId: principal, rows };
							await store.replaceUserKnowledgeGrants(input);
							await sqliteKnowledgeWriteStore.replaceUserKnowledgeGrants(input);

							const readRows = async (handle: BunSQLDatabase, table: typeof pgSchema.aclGrants) =>
								handle
									.select()
									.from(table)
									.where(and(eq(table.principalType, "user"), eq(table.principalId, principal)));
							const pgRows = await readRows(pgDb, pgSchema.aclGrants);
							const sqliteRows = await sqliteDb
								.select()
								.from(sqliteSchema.aclGrants)
								.where(
									and(
										eq(sqliteSchema.aclGrants.principalType, "user"),
										eq(sqliteSchema.aclGrants.principalId, principal),
									),
								);
							// The projection IS the read-side contract: both backends' rows must
							// fold to the same credentials, or read visibility would diverge.
							const project = (rs: typeof pgRows) =>
								rs
									.map((r) => toKnowledgeGrantRow(r))
									.map((g) => [g.grantType, g.clearanceLevel, g.tagId, g.canWrite])
									.sort();
							expect(project(pgRows)).toEqual(project(sqliteRows as unknown as typeof pgRows));
							// And the axes are actually present: clearance, tag, write.
							const flat = project(pgRows);
							expect(flat).toContainEqual(["clearance", "internal", null, false]);
							expect(flat).toContainEqual(["clearance", null, null, true]);
							expect(flat.some((g) => g[0] === "tag")).toBe(true);
							landmarks.aclEquivalence = "clearance+tag+write identical";
						},
					);

					// ── H. spec:// VFS sections ────────────────────────────────────
					await check("spec namespace write/fork/reset behave as on SQLite", async () => {
						const narratorId = generateId();
						await pgDb.insert(pgSchema.narrators).values({
							id: narratorId,
							createdAt: NOW(),
							updatedAt: NOW(),
						});
						const ns = await store.ensureSpecNamespace({
							namespaceId: generateId(),
							narratorId,
							now: NOW(),
						});
						const again = await store.ensureSpecNamespace({
							namespaceId: generateId(),
							narratorId,
							now: NOW(),
						});
						expect(again.id).toBe(ns.id);

						const hooks = (
							tasks: { text: string; status: string; protected: boolean }[],
							allow: boolean,
						) => ({
							tasks: tasks.map((task) => ({ ...task, textHash: `h:${task.text}` })),
							detectProtectedMutations: (
								locks: { text: string; status: string }[],
							): { kind: string; text: string; details: string }[] =>
								locks
									.filter(
										(lock) =>
											lock.status !== "done" &&
											lock.status !== "deleted" &&
											!tasks.some((task) => task.text === lock.text),
									)
									.map((lock) => ({ kind: "delete", text: lock.text, details: "removed" })),
							allowProtectedTaskMutation: allow,
						});
						const writeTasks = (
							content: string,
							specTasks: ReturnType<typeof hooks> | undefined,
							revisionId: string,
						) =>
							store.writeSpecFileRevision({
								namespaceId: ns.id,
								path: "tasks.json",
								content,
								contentHash: "c",
								revisionId,
								fileIdForCreate: generateId(),
								sourceToolUseId: null,
								sourceMessageId: null,
								createdBy: "assistant",
								now: NOW(),
								...(specTasks ? { specTasks } : {}),
							});
						const first = await writeTasks(
							JSON.stringify({ tasks: [{ text: "keep", status: "todo", protected: true }] }),
							hooks([{ text: "keep", status: "todo", protected: true }], true),
							generateId(),
						);
						expect(first.ok).toBe(true);
						const rejected = await writeTasks(
							JSON.stringify({ tasks: [] }),
							hooks([], false),
							generateId(),
						);
						expect(rejected.ok).toBe(false);
						// The refusal wrote nothing: still exactly one revision.
						const revisionCount = await pgDb
							.select({ id: pgSchema.specFileRevisions.id })
							.from(pgSchema.specFileRevisions)
							.where(eq(pgSchema.specFileRevisions.namespaceId, ns.id));
						expect(revisionCount).toHaveLength(1);

						const childNarrator = generateId();
						await pgDb.insert(pgSchema.narrators).values({
							id: childNarrator,
							createdAt: NOW(),
							updatedAt: NOW(),
						});
						const fork = await store.forkSpecNamespace({
							parentNamespaceId: ns.id,
							childNamespaceId: generateId(),
							childNarratorId: childNarrator,
							now: NOW(),
						});
						expect(fork.created).toBe(true);
						const childNs = await store.ensureSpecNamespace({
							namespaceId: generateId(),
							narratorId: childNarrator,
							now: NOW(),
						});
						const childLocks = await pgDb
							.select({ id: pgSchema.specProtectedTasks.id })
							.from(pgSchema.specProtectedTasks)
							.where(eq(pgSchema.specProtectedTasks.namespaceId, childNs.id));
						expect(childLocks).toHaveLength(1);

						await store.resetSpecNamespace({ namespaceId: ns.id, now: NOW() });
						const parentLocks = await pgDb
							.select({ status: pgSchema.specProtectedTasks.status })
							.from(pgSchema.specProtectedTasks)
							.where(eq(pgSchema.specProtectedTasks.namespaceId, ns.id));
						expect(parentLocks.every((lock) => lock.status === "deleted")).toBe(true);
					});

					// ── I. Pack activation ─────────────────────────────────────────
					await check("pack activation record + release stay paired", async () => {
						const narratorId = generateId();
						await pgDb.insert(pgSchema.narrators).values({
							id: narratorId,
							createdAt: NOW(),
							updatedAt: NOW(),
						});
						const packId = generateId();
						await pgDb.insert(pgSchema.knowledgePacks).values({
							id: packId,
							name: `pack-${generateId(6)}`,
							slug: `pack-${generateId(6)}`,
							archiveFormat: "zip",
							archiveSize: 1,
							archiveHash: "hash",
							status: "active",
							createdAt: NOW(),
							updatedAt: NOW(),
						});
						const activationId = generateId();
						const whitelistDirId = generateId();
						await store.recordPackActivation({
							activationId,
							whitelistDirId,
							packId,
							narratorId,
							extractDir: `/tmp/extract-${generateId(6)}`,
							archiveHash: "hash",
							now: NOW(),
						});
						const whitelist = await pgDb
							.select({ id: pgSchema.narratorWhitelistDirs.id })
							.from(pgSchema.narratorWhitelistDirs)
							.where(eq(pgSchema.narratorWhitelistDirs.id, whitelistDirId));
						expect(whitelist).toHaveLength(1);
						await store.releasePackActivation({ activationId, whitelistDirId, now: NOW() });
						const released = await pgDb
							.select({ id: pgSchema.narratorWhitelistDirs.id })
							.from(pgSchema.narratorWhitelistDirs)
							.where(eq(pgSchema.narratorWhitelistDirs.id, whitelistDirId));
						expect(released).toHaveLength(0);
						const activation = await pgDb
							.select({ status: pgSchema.knowledgePackActivations.status })
							.from(pgSchema.knowledgePackActivations)
							.where(eq(pgSchema.knowledgePackActivations.id, activationId));
						expect(activation[0]?.status).toBe("released");
					});

					// ── J. Entry links storage equivalence ─────────────────────────
					await check("entry link rows round-trip with revision pinning", async () => {
						// knowledge-link-service's own port conversion is a follow-up batch;
						// what THIS suite pins is that the links table (entry-level relations +
						// the inline to_revision_id pin) accepts and returns the same shape
						// the SQLite side writes.
						expect(colAId).not.toBe("");
						const source = await makeEntry(colAId, "link-src", "source body");
						const target = await makeEntry(colAId, "link-dst", "target body");
						const linkId = generateId();
						await pgDb.insert(pgSchema.knowledgeEntryLinks).values({
							id: linkId,
							fromEntryId: source.entryId,
							toEntryId: target.entryId,
							linkType: "related",
							toRevisionId: target.revisionId,
							createdByUserId: userId,
							createdAt: NOW(),
						});
						const rows = await pgDb
							.select()
							.from(pgSchema.knowledgeEntryLinks)
							.where(eq(pgSchema.knowledgeEntryLinks.id, linkId));
						expect(rows).toHaveLength(1);
						expect(rows[0]?.toRevisionId).toBe(target.revisionId);
						expect(rows[0]?.linkType).toBe("related");
					});

					landmarks.casesCompleted = "A-J";
				} finally {
					await client.close();
					cleanDb(sqlite);
				}

				return { problems, landmarks };
			});

			// A harness status here means PostgreSQL did not actually run the suite. With
			// PG_INTEGRATION=1 that is a failure, never a skip.
			if ("status" in (outcome as Record<string, unknown>)) {
				throw new Error(
					`PostgreSQL integration required but harness returned ${JSON.stringify(outcome)}`,
				);
			}
			const result = outcome as {
				problems?: string[];
				landmarks?: Record<string, unknown>;
				migrationError?: string;
			};
			if (result.migrationError) {
				throw new Error(`PostgreSQL migration failed: ${result.migrationError}`);
			}
			// Problems first: a failing case's own diff is more useful than a missing landmark.
			expect(result.problems ?? ["suite did not run"]).toEqual([]);
			// Landmarks, not just absence of failure: the evidence really happened.
			expect(result.landmarks?.casesCompleted).toBe("A-J");
			expect(result.landmarks?.entryFts).toBe("write→search + reindex ok");
			expect(result.landmarks?.draftRenameCascade).toBe("entry-alpha → renamed compendium");
			expect(result.landmarks?.versionRaceWinners).toBe(8);
			expect(result.landmarks?.scratchControl).toBe("dup-without-lock / contiguous-with-lock");
			expect(result.landmarks?.aclEquivalence).toBe("clearance+tag+write identical");
		},
		RUN_TIMEOUT_MS,
	);
});
