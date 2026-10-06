import { afterAll, describe, expect, mock, test } from "bun:test";
import { ensurePgFts, probePgFtsDrift } from "../../../../server/db/pg-fts";
import { createPostgresClient } from "../../../../server/db/postgres-client";
import { narrators, users } from "../../../../server/db/postgres-schema";
import { eventBus } from "../../../../server/lib/event-bus";
import { generateId } from "../../../../server/lib/id";
import { createPostgresKnowledgeReadStore } from "../../../../server/services/knowledge/postgres-read-store";
import { createPostgresKnowledgeWriteStore } from "../../../../server/services/knowledge/postgres-write-store";
import {
	bindPostgresSearchClient,
	createPostgresSearchStore,
	unbindPostgresSearchClientForTests,
} from "../../../../server/services/search/postgres-store";
import { withPostgres } from "../../../db/pg-test-harness";
import { migrationSql } from "../read/pg-parity-matrix";

// The test preload isolates the SQLite home. Poison the handle as production PG
// startup does: any accidental SQLite read OR write is a test failure, even if an
// audit/notify handler swallowed its exception.
const originalDb = { ...(await import("../../../../server/db")) };
let sqliteAccesses = 0;
const poison = new Proxy(
	{},
	{
		get() {
			sqliteAccesses++;
			throw new Error("P6 crossed to SQLite");
		},
	},
);
mock.module("../../../../server/db", () => ({ ...originalDb, db: poison, sqlite: poison }));
const { setKnowledgeReadStore, setKnowledgeWriteStore } = await import(
	"../../../../server/services/knowledge/store"
);
// Inject the actual registered PG search implementation, not a result double.
// Restore the module afterwards so running this test with SQLite suites cannot
// leave their service callers bound to the closed PG client.
const originalSearch = { ...(await import("../../../../server/services/search/backend")) };
mock.module("../../../../server/services/search/backend", () => ({
	...originalSearch,
	searchStore: originalSearch.resolveSearchStore("postgres"),
}));
const { knowledgeService: service } = await import("../../../../server/services/knowledge-service");
const { knowledgeAcl: acl } = await import("../../../../server/services/knowledge-acl");
const { resolveInjections } = await import("../../../../server/services/knowledge-injection");
const { knowledgeInjectionReads } = await import("../../../../server/services/knowledge-service");
const { knowledgeLinkService: links } = await import(
	"../../../../server/services/knowledge-link-service"
);
const { listKnowledgeAclEvents } = await import("../../../../server/services/knowledge-audit");
const { resolveReviewerUserIds } = await import("../../../../server/services/knowledge-notify");
afterAll(() => {
	setKnowledgeReadStore(undefined);
	setKnowledgeWriteStore(undefined);
	acl.invalidateLevelCache();
	mock.module("../../../../server/db", () => originalDb);
	mock.module("../../../../server/services/search/backend", () => originalSearch);
	mock.restore();
});

const enabled = process.env.PG_INTEGRATION === "1";
describe("P6 knowledge services on real PostgreSQL", () => {
	test.skipIf(!enabled)(
		"CRUD, ownership, links, dual-axis grants, audit, notify and FTS use one database",
		async () => {
			const statements = await migrationSql();
			const result = await withPostgres(async ({ port, credentials, exec }) => {
				for (const statement of statements) {
					const applied = await exec(statement);
					if (applied.code !== 0) throw new Error(applied.stderr.slice(0, 1000));
				}
				const client = createPostgresClient({
					driver: "bun-sql",
					url: `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@127.0.0.1:${port}/${credentials.database}`,
					max: 4,
				});
				try {
					await ensurePgFts(client.sql);
					const read = createPostgresKnowledgeReadStore(client.db);
					const write = createPostgresKnowledgeWriteStore(client.db);
					const search = createPostgresSearchStore(client.sql);
					bindPostgresSearchClient(client.sql);
					setKnowledgeReadStore(read);
					setKnowledgeWriteStore(write);
					acl.invalidateLevelCache();
					const now = new Date().toISOString();
					const admin = { userId: generateId(), role: "admin" as const };
					const owner = { userId: generateId(), role: "user" as const };
					const reader = { userId: generateId(), role: "user" as const };
					for (const p of [admin, owner, reader])
						await client.db.insert(users).values({
							id: p.userId,
							username: `p6-${p.userId}`,
							passwordHash: "test",
							role: p.role,
							createdAt: now,
						});
					const level = await acl.createLevel({ name: "p6-confidential", rank: 42 });
					const col = await service.createCollection({
						name: "P6 collection",
						ownerUserId: owner.userId,
					});
					expect((await service.updateCollection(col.id, { name: "P6 renamed" }, owner)).name).toBe(
						"P6 renamed",
					);
					const entry = await service.createEntry({
						collectionId: col.id,
						title: "P6 source",
						content: "quixotic p6 document",
						authorUserId: owner.userId,
						principal: owner,
					});
					const target = await service.createEntry({
						collectionId: col.id,
						title: "P6 target",
						content: "target",
						authorUserId: owner.userId,
						principal: owner,
					});
					const link = await links.addLink(owner, {
						fromEntryId: entry.id,
						toEntryId: target.id,
						linkType: "related",
						toRevisionId: target.currentRevisionId ?? undefined,
					});
					expect((await links.listLinks(reader, entry.id))[0]?.id).toBe(link.id);
					expect((await links.getGraph(reader, entry.id)).nodes).toHaveLength(2);
					await expect(
						links.addLink(owner, {
							fromEntryId: entry.id,
							toEntryId: target.id,
							linkType: "related",
						}),
					).rejects.toThrow("already exists");
					const duplicate = await write
						.createEntryLink({
							id: generateId(),
							fromEntryId: entry.id,
							toEntryId: target.id,
							linkType: "related",
							label: null,
							toRevisionId: null,
							createdByUserId: owner.userId,
							now,
						})
						.catch((error) => error);
					expect(duplicate.name).toBe("WriteConflictError");
					expect(duplicate.constraint).toContain("kelink");
					const type = await acl.createTagType({ name: "P6 tag type" });
					expect((await acl.updateTagType(type.id, { name: "P6 changed type" }))?.name).toBe(
						"P6 changed type",
					);
					const tag = await acl.createTag({
						name: "P6 compartment",
						controlled: true,
						typeId: type.id,
						collectionId: col.id,
					});
					expect((await acl.updateTag(tag.id, { name: "P6 renamed compartment" }))?.name).toBe(
						"P6 renamed compartment",
					);
					expect((await acl.listTags(col.id)).map((t) => t.id)).toContain(tag.id);
					await acl.updateCollectionAcl(
						col.id,
						{ classificationLevel: null, controlledTags: [] },
						admin,
					);
					await service.updateEntryAcl(
						entry.id,
						{ classificationLevel: level.name, controlledTags: [tag.id], reviewTags: [tag.id] },
						admin,
					);
					await expect(service.getEntry(entry.id, { principal: reader })).rejects.toThrow();
					await acl.createGrant(
						{
							principalType: "user",
							principalId: reader.userId,
							grantType: "clearance",
							clearanceLevel: level.name,
						},
						admin,
					);
					await expect(service.getEntry(entry.id, { principal: reader })).rejects.toThrow();
					const granted = await acl.createGrant(
						{ principalType: "user", principalId: reader.userId, grantType: "tag", tagId: tag.id },
						admin,
					);
					await acl.createGrant(
						{
							principalType: "user",
							principalId: reader.userId,
							grantType: "review",
							tagId: tag.id,
						},
						admin,
					);
					expect((await service.getEntry(entry.id, { principal: reader })).id).toBe(entry.id);
					expect((await service.filterReadable(reader, [{ id: entry.id }])).length).toBe(1);
					expect((await acl.getUserAcl(reader.userId)).tagIds).toContain(tag.id);
					expect(
						await resolveReviewerUserIds({
							entryId: entry.id,
							collectionId: col.id,
							submitterUserId: owner.userId,
						}),
					).toContain(reader.userId);
					await service.updateEntryMeta(
						entry.id,
						{ title: "renamed zephyr", keywords: ["zephyr"] },
						owner,
					);
					expect(
						(await resolveInjections(reader.userId, "zephyr", { collectionId: col.id })).map(
							(hit) => hit.entryId,
						),
					).toContain(entry.id);
					expect((await knowledgeInjectionReads.listInjectedEntryIds("missing", -1)).size).toBe(0);
					// Persist the actual PG ledger before rebuilding an empty in-memory cycle.
					// No narrator runtime is started; only this fixture narrator row is needed.
					const injectionNarrator = generateId();
					await client.db
						.insert(narrators)
						.values({ id: injectionNarrator, createdAt: now, updatedAt: now });
					const ledger = {
						narratorId: injectionNarrator,
						compactSeq: 9,
						source: "user_message",
						triggerMessageId: null,
						triggerToolCallId: null,
						now,
						hits: [
							{
								id: generateId(),
								entryId: entry.id,
								entryRevisionId: entry.currentRevisionId,
								summary: null,
							},
						],
					};
					await write.recordInjectionEvents(ledger);
					await write.recordInjectionEvents({
						...ledger,
						hits: [{ ...ledger.hits[0], id: generateId() }],
					});
					const currentCycleIds = await knowledgeInjectionReads.listInjectedEntryIds(
						injectionNarrator,
						9,
					);
					expect([...currentCycleIds]).toEqual([entry.id]);
					expect(
						await resolveInjections(reader.userId, "zephyr", {
							collectionId: col.id,
							already: currentCycleIds,
						}),
					).toHaveLength(0);
					const afterCompactIds = await knowledgeInjectionReads.listInjectedEntryIds(
						injectionNarrator,
						10,
					);
					expect(afterCompactIds.size).toBe(0);
					expect(
						(
							await resolveInjections(reader.userId, "zephyr", {
								collectionId: col.id,
								already: afterCompactIds,
							})
						).map((hit) => hit.entryId),
					).toContain(entry.id);
					await write.recordInjectionEvents({
						...ledger,
						compactSeq: 10,
						hits: [{ ...ledger.hits[0], id: generateId() }],
					});
					expect(
						await resolveInjections(reader.userId, "zephyr", {
							collectionId: col.id,
							already: await knowledgeInjectionReads.listInjectedEntryIds(injectionNarrator, 10),
						}),
					).toHaveLength(0);
					expect([
						...(await knowledgeInjectionReads.listInjectedEntryIds(injectionNarrator, 9)),
					]).toEqual([entry.id]);
					const draft = await write.getOrCreateActiveDraft({
						draftId: generateId(),
						entryId: entry.id,
						authorUserId: reader.userId,
						name: null,
						baseRevisionId: entry.currentRevisionId,
						content: "personal zephyr",
						contentHash: "d",
						now,
					});
					const submission = await write.createSubmissionGuarded({
						submissionId: generateId(),
						draftId: draft.id,
						entryId: entry.id,
						collectionId: col.id,
						title: null,
						submitterUserId: reader.userId,
						baseRevisionId: entry.currentRevisionId,
						proposedContent: "personal",
						keywordsJson: [],
						changeNote: null,
						previousSubmissionId: null,
						round: 1,
						now,
					});
					expect((await read.getSubmissionRoutingById(submission.id))?.submitterUserId).toBe(
						reader.userId,
					);
					const drifted = new Promise<string[]>((resolve, reject) => {
						const timer = setTimeout(() => {
							off();
							reject(new Error("drift notify timed out"));
						}, 3000);
						const handler = (e: { entryId: string; driftedUserIds: string[] }) => {
							if (e.entryId === entry.id) {
								clearTimeout(timer);
								off();
								resolve(e.driftedUserIds);
							}
						};
						const off = () => eventBus.off("knowledge:entry_drifted", handler);
						eventBus.on("knowledge:entry_drifted", handler);
					});
					await service.addRevision(entry.id, {
						content: "quixotic revised",
						authorUserId: owner.userId,
						principal: owner,
					});
					expect(await drifted).toContain(reader.userId);
					const query = {
						indexText: "quixotic",
						substringText: "quixotic",
						strategy: "index" as const,
						match: "and" as const,
						limit: 10,
					};
					expect((await search.searchKnowledgeEntries(query)).map((r) => r.id)).toContain(entry.id);
					expect((await service.search({ q: "quixotic" })).map((r) => r.id)).toContain(entry.id);
					expect(
						(
							await search.searchKnowledgeDrafts({
								...query,
								indexText: "zephyr",
								substringText: "zephyr",
								authorUserId: reader.userId,
								draftStatus: "active",
							})
						)[0]?.drifted,
					).toBe(true);
					expect((await service.listRevisions(entry.id, owner)).length).toBe(2);
					expect(await service.listEntries({ collectionId: col.id })).toHaveLength(2);
					await service.transferEntryOwner(entry.id, reader.userId, owner);
					await service.transferCollectionOwner(col.id, reader.userId, owner);
					expect((await acl.getCollectionAcl(col.id)).ownerUserId).toBe(reader.userId);
					await links.removeLink(reader, link.id);
					expect(await links.listLinks(reader, entry.id)).toHaveLength(0);
					await acl.deleteGrant(granted.id, admin);
					// Wait only for our async audit inserts, bounded, without assuming one timer tick.
					let auditCount = 0;
					for (let attempt = 0; attempt < 40; attempt++) {
						const page = await listKnowledgeAclEvents({ targetId: col.id });
						auditCount = page.events.length;
						if (page.events.some((e) => e.eventType === "collection_owner_transferred")) break;
						await new Promise((resolve) => setTimeout(resolve, 10));
					}
					expect(auditCount).toBeGreaterThan(0);
					expect(
						(await listKnowledgeAclEvents({ targetId: col.id })).events.some(
							(e) => e.eventType === "collection_owner_transferred",
						),
					).toBe(true);
					await service.deleteEntry(target.id, admin);
					await service.deleteCollection(col.id, reader);
					expect(await read.getEntryById(entry.id)).toBeNull();
					expect(await search.searchKnowledgeEntries(query)).toHaveLength(0);
					expect((await probePgFtsDrift(client.sql)).drifted).toBe(false);
					for (let attempt = 0; attempt < 40; attempt++) {
						if (
							(await listKnowledgeAclEvents({ targetId: col.id })).events.some(
								(e) => e.eventType === "collection_deleted",
							)
						)
							break;
						await new Promise((resolve) => setTimeout(resolve, 10));
					}
					expect(
						(await listKnowledgeAclEvents({ targetId: col.id })).events.some(
							(e) => e.eventType === "collection_deleted",
						),
					).toBe(true);
					await acl.deleteTagType(type.id);
					expect(await read.getKnowledgeTagTypeById(type.id)).toBeNull();
					await acl.purgeUserGrants(reader.userId);
					expect((await acl.getUserAcl(reader.userId)).tagIds).toHaveLength(0);
					expect(await acl.deleteLevel(level.id)).toEqual({ ok: true });
					expect(sqliteAccesses).toBe(0);
					return { ok: true, auditCount, sqliteAccesses };
				} finally {
					unbindPostgresSearchClientForTests();
					setKnowledgeReadStore(undefined);
					setKnowledgeWriteStore(undefined);
					await client.close();
				}
			});
			expect(result).toMatchObject({ ok: true, sqliteAccesses: 0 });
		},
		300_000,
	);
});
