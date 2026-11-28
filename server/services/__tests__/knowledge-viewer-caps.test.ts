/**
 * `viewerCaps` ⇔ write-path consistency.
 *
 * The knowledge UI shows/hides actions from `viewerCaps` (GET /entries/:id, GET /collections)
 * instead of re-deriving the ACL. That is only safe if every flag is true EXACTLY when the
 * corresponding endpoint/service accepts the call. This test pins that equivalence over a
 * principal matrix: admin, entry owner, collection owner, write-grant holder, review-tag holder,
 * plain reader.
 *
 * Every mutating probe runs against a FRESH fixture (collection + entry + scoped grants), so a
 * delete or transfer by one principal cannot change what the next one sees. Grants are
 * collection-scoped so nothing leaks into other test files sharing the process database.
 */
import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, sqlite } from "../../db";
import { knowledgeEntries, knowledgeTags, users } from "../../db/schema";
import { readKnowledgeEntryDetail } from "../../lib/db-worker/knowledge-entry-query";
import * as pool from "../../lib/db-worker/pool";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { knowledgeRoutes } from "../../routes/knowledge";
import { sqliteKnowledgeReadStore } from "../knowledge/sqlite-read-store";
import { knowledgeAcl, type Principal } from "../knowledge-acl";
import { knowledgeBranchService } from "../knowledge-branch-service";
import { knowledgeLinkService } from "../knowledge-link-service";
import { knowledgeService } from "../knowledge-service";
import { captureWorkerRejection, captureWorkerRejectionThrower } from "./narrator-worker-fixture";

const TAG = `vc-${Date.now()}`;

type Role = "admin" | "entryOwner" | "collectionOwner" | "writer" | "reviewer" | "reader";
const ROLES: Role[] = ["admin", "entryOwner", "collectionOwner", "writer", "reviewer", "reader"];

const ids = {} as Record<Role, string>;
let authorId: string; // submits the linked proposal used by the review probe
let transferTargetId: string;

function principalFor(role: Role): Principal {
	return { userId: ids[role], role: role === "admin" ? "admin" : "user" };
}

function nowIso(): string {
	return new Date().toISOString();
}

async function makeUser(role: "admin" | "user", label: string): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `${TAG}-${label}-${generateId(4)}`,
		passwordHash: "x",
		role,
		createdAt: nowIso(),
	});
	return id;
}

async function makeTag(label: string): Promise<string> {
	const id = generateId();
	await db.insert(knowledgeTags).values({
		id,
		name: `${TAG}-${label}-${generateId(4)}`,
		controlled: false,
		createdAt: nowIso(),
	});
	return id;
}

/** Fresh public collection (owned by collectionOwner) + entry (owned by entryOwner, one review
 *  tag), with the writer's write grant and the reviewer's review grant scoped to it. */
async function makeFixture(): Promise<{ collectionId: string; entryId: string }> {
	const reviewTagId = await makeTag("review");
	const col = await knowledgeService.createCollection({
		name: `${TAG}-col-${generateId()}`,
		ownerUserId: ids.collectionOwner,
	});
	const entry = await knowledgeService.createEntry({
		collectionId: col.id,
		title: `${TAG}-entry-${generateId(4)}`,
		content: "base body\n",
		ownerUserId: ids.entryOwner,
	});
	await knowledgeService.updateEntryAcl(entry.id, { reviewTags: [reviewTagId] });
	await knowledgeAcl.createGrant({
		collectionId: col.id,
		principalType: "user",
		principalId: ids.writer,
		grantType: "clearance",
		clearanceLevel: "public",
		canWrite: true,
	});
	await knowledgeAcl.createGrant({
		collectionId: col.id,
		principalType: "user",
		principalId: ids.reviewer,
		grantType: "review",
		tagId: reviewTagId,
	});
	return { collectionId: col.id, entryId: entry.id };
}

async function accepts(fn: () => Promise<unknown>): Promise<boolean> {
	try {
		await fn();
		return true;
	} catch {
		return false;
	}
}

/** The real knowledge router behind a fake session principal. */
function appFor(principal: Principal) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: principal.userId, role: principal.role, iat: 0, exp: 4102444800 });
		await next();
	});
	app.onError((error) => {
		if (error instanceof AppError) {
			return new Response(JSON.stringify({ error: error.message }), {
				status: error.statusCode,
			});
		}
		throw error;
	});
	app.route("/knowledge", knowledgeRoutes);
	return app;
}

async function httpAccepts(principal: Principal, method: string, path: string, body: unknown) {
	const res = await appFor(principal).request(`/knowledge${path}`, {
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return res.status < 400;
}

async function entryCapsVia(role: Role, entryId: string) {
	const res = await appFor(principalFor(role)).request(`/knowledge/entries/${entryId}`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		id: string;
		viewerCaps: {
			canWriteMain: boolean;
			canEditMeta: boolean;
			canManageAcl: boolean;
			canTransferOwner: boolean;
			canDelete: boolean;
			canReview: boolean;
			canManageLinks: boolean;
			myPersonalEntryId: string | null;
		};
	};
	expect(body.id).toBe(entryId);
	return body.viewerCaps;
}

async function collectionCapsVia(role: Role, collectionId: string) {
	const res = await appFor(principalFor(role)).request("/knowledge/collections");
	expect(res.status).toBe(200);
	const rows = (await res.json()) as Array<{
		id: string;
		viewerCaps: {
			canEdit: boolean;
			canManageAcl: boolean;
			canTransferOwner: boolean;
			canDelete: boolean;
			canCreateEntry: boolean;
		};
	}>;
	const row = rows.find((r) => r.id === collectionId);
	expect(row).toBeDefined();
	return (row as (typeof rows)[number]).viewerCaps;
}

beforeAll(async () => {
	ids.admin = await makeUser("admin", "admin");
	for (const role of ROLES.filter((r) => r !== "admin")) ids[role] = await makeUser("user", role);
	authorId = await makeUser("user", "author");
	transferTargetId = await makeUser("user", "target");
});

describe("entry detail Worker", () => {
	test("returns the entire committed row even when metadata exceeds generic SELECT limits", async () => {
		const { entryId } = await makeFixture();
		const payload = "测".repeat(1_500_000);
		await db
			.update(knowledgeEntries)
			.set({ metadataJson: { payload }, keywordsJson: ["测试"], tagsJson: ["read"] })
			.where(eq(knowledgeEntries.id, entryId));
		const dispatch = spyOn(pool, "runReadTask");
		try {
			const detail = await sqliteKnowledgeReadStore.getEntryDetailById(entryId);
			const legacy = await sqliteKnowledgeReadStore.getEntryById(entryId);
			expect(detail).toEqual(legacy);
			expect(dispatch).toHaveBeenCalledWith(
				sqlite.filename,
				{ kind: "knowledgeEntryDetail", entryId },
				expect.objectContaining({ timeoutMs: 10_000 }),
			);
			expect(() =>
				readKnowledgeEntryDetail(sqlite, entryId, new AbortController().signal, 1024),
			).toThrow("Knowledge entry exceeds its detail byte budget");
			const missing = await sqliteKnowledgeReadStore.getEntryDetailById(generateId());
			expect(missing).toBeNull();
		} finally {
			dispatch.mockRestore();
		}
	});

	test("does not dispatch unreadable entries or return a snapshot after access changes", async () => {
		const { entryId } = await makeFixture();
		const app = appFor(principalFor("reader"));
		const path = `/knowledge/entries/${entryId}`;
		const read = sqliteKnowledgeReadStore.getEntryDetailById.bind(sqliteKnowledgeReadStore);
		const detail = spyOn(sqliteKnowledgeReadStore, "getEntryDetailById");
		const classify = (classificationLevel: string | null) =>
			db
				.update(knowledgeEntries)
				.set({ classificationLevel })
				.where(eq(knowledgeEntries.id, entryId))
				.run();
		try {
			classify("confidential");
			expect((await app.request(path)).status).toBe(404);
			expect(detail).not.toHaveBeenCalled();
			classify(null);
			detail.mockImplementationOnce(async (...args) => {
				const snapshot = await read(...args);
				classify("confidential");
				return snapshot;
			});
			expect((await app.request(path)).status).toBe(404);
			expect(detail).toHaveBeenCalledWith(entryId, expect.any(AbortSignal));
		} finally {
			detail.mockRestore();
		}
	});

	test("cancellation and unavailable or failed Workers do not read the body inline", async () => {
		const { entryId } = await makeFixture();
		const inline = spyOn(sqliteKnowledgeReadStore, "getEntryById");
		const dispatch = spyOn(pool, "runReadTask");
		const previous = process.env.NARRAFORK_DB_WORKER;
		try {
			const abort = new AbortController();
			abort.abort(new Error("request gone"));
			expect(
				await captureWorkerRejectionThrower(
					sqliteKnowledgeReadStore.getEntryDetailById(entryId, abort.signal),
				),
			).toThrow("request gone");
			process.env.NARRAFORK_DB_WORKER = "off";
			expect(
				await captureWorkerRejection(sqliteKnowledgeReadStore.getEntryDetailById(entryId)),
			).toBeInstanceOf(pool.WorkersUnavailableError);
			const inTransaction = sqlite.transaction(() =>
				sqliteKnowledgeReadStore.getEntryDetailById(entryId),
			)();
			expect(await captureWorkerRejection(inTransaction)).toBeInstanceOf(
				pool.WorkersUnavailableError,
			);
			for (const error of [
				new pool.WorkersUnavailableError("worker_create_failed"),
				new pool.DbReadTaskExecutionError("worker exited"),
				new pool.DbReadTaskTimeoutError("timed out"),
			]) {
				dispatch.mockRejectedValueOnce(error);
				expect(
					await captureWorkerRejection(sqliteKnowledgeReadStore.getEntryDetailById(entryId)),
				).toBe(error);
			}
			expect(inline).not.toHaveBeenCalled();
		} finally {
			inline.mockRestore();
			dispatch.mockRestore();
			if (previous === undefined) delete process.env.NARRAFORK_DB_WORKER;
			else process.env.NARRAFORK_DB_WORKER = previous;
		}
	});
});

describe("entry viewerCaps ⇔ write paths", () => {
	for (const role of ROLES) {
		test(`${role}: every flag matches whether its endpoint accepts`, async () => {
			// Caps are read once per fixture; each mutating probe gets its own fixture so the
			// probes are independent (a delete cannot hide the entry from the next probe).
			const fWrite = await makeFixture();
			const caps = await entryCapsVia(role, fWrite.entryId);
			const p = principalFor(role);

			expect(caps.canWriteMain).toBe(
				await accepts(() =>
					knowledgeService.addRevision(fWrite.entryId, {
						content: `edit by ${role}\n`,
						authorUserId: p.userId,
						principal: p,
					}),
				),
			);

			const fMeta = await makeFixture();
			expect((await entryCapsVia(role, fMeta.entryId)).canEditMeta).toBe(
				await accepts(() =>
					knowledgeService.updateEntryMeta(fMeta.entryId, { title: `t-${role}` }, p),
				),
			);

			const fDelete = await makeFixture();
			expect((await entryCapsVia(role, fDelete.entryId)).canDelete).toBe(
				await accepts(() => knowledgeService.deleteEntry(fDelete.entryId, p)),
			);

			const fTransfer = await makeFixture();
			expect((await entryCapsVia(role, fTransfer.entryId)).canTransferOwner).toBe(
				await accepts(() =>
					knowledgeService.transferEntryOwner(fTransfer.entryId, transferTargetId, p),
				),
			);

			const fAcl = await makeFixture();
			expect((await entryCapsVia(role, fAcl.entryId)).canManageAcl).toBe(
				await httpAccepts(p, "PATCH", `/entries/${fAcl.entryId}/acl`, {
					classificationLevel: null,
				}),
			);

			// Review: a linked proposal from an unrelated author; `comment_only` leaves the
			// submission open, so the same probe is valid for every principal.
			const fReview = await makeFixture();
			const draft = await knowledgeBranchService.createDraft(
				{ userId: authorId, role: "user" },
				fReview.entryId,
				{},
			);
			await knowledgeBranchService.updateDraft({ userId: authorId, role: "user" }, draft.id, {
				content: "proposal\n",
			});
			const sub = await knowledgeBranchService.submitForReview(
				{ userId: authorId, role: "user" },
				draft.id,
				{},
			);
			expect((await entryCapsVia(role, fReview.entryId)).canReview).toBe(
				await accepts(() => knowledgeBranchService.review(p, sub.id, { verdict: "comment_only" })),
			);

			// Links: add from this entry to a readable sibling; remove a link whose source is this
			// entry (the per-link `canRemove` of GET /entries/:id/links must agree too).
			const fLink = await makeFixture();
			const target = await knowledgeService.createEntry({
				collectionId: fLink.collectionId,
				title: `${TAG}-target-${generateId(4)}`,
				content: "t\n",
			});
			expect((await entryCapsVia(role, fLink.entryId)).canManageLinks).toBe(
				await accepts(() =>
					knowledgeLinkService.addLink(p, {
						fromEntryId: fLink.entryId,
						toEntryId: target.id,
						linkType: "related",
					}),
				),
			);
			const fUnlink = await makeFixture();
			const target2 = await knowledgeService.createEntry({
				collectionId: fUnlink.collectionId,
				title: `${TAG}-target-${generateId(4)}`,
				content: "t\n",
			});
			const link = await knowledgeLinkService.addLink(principalFor("admin"), {
				fromEntryId: fUnlink.entryId,
				toEntryId: target2.id,
				linkType: "expands",
			});
			const listed = await knowledgeLinkService.listLinks(p, target2.id, "in");
			const canRemove = listed.find((l) => l.id === link.id)?.canRemove;
			const capsUnlink = await entryCapsVia(role, fUnlink.entryId);
			const removed = await accepts(() => knowledgeLinkService.removeLink(p, link.id));
			expect(capsUnlink.canManageLinks).toBe(removed);
			expect(canRemove).toBe(removed);
		});
	}

	test("myPersonalEntryId is the caller's active personal version, and only theirs", async () => {
		const f = await makeFixture();
		expect((await entryCapsVia("reader", f.entryId)).myPersonalEntryId).toBeNull();
		const reader = principalFor("reader");
		const draft = await knowledgeBranchService.createDraft(reader, f.entryId, {});
		const mine = await knowledgeBranchService.getMyDraft(reader, f.entryId);
		expect(mine?.id).toBe(draft.id);
		expect((await entryCapsVia("reader", f.entryId)).myPersonalEntryId).toBe(draft.id);
		// Someone else's draft is never reported — not even to an admin.
		expect((await entryCapsVia("admin", f.entryId)).myPersonalEntryId).toBeNull();
		// Archived (deleted) personal versions no longer count.
		await knowledgeBranchService.deletePersonalEntry(reader, draft.id);
		expect((await entryCapsVia("reader", f.entryId)).myPersonalEntryId).toBeNull();
	});

	test("the matrix actually discriminates (guards against an all-true or all-false bug)", async () => {
		const f = await makeFixture();
		const writer = await entryCapsVia("writer", f.entryId);
		const colOwner = await entryCapsVia("collectionOwner", f.entryId);
		const reader = await entryCapsVia("reader", f.entryId);
		const reviewer = await entryCapsVia("reviewer", f.entryId);
		// Write-grant holders may write main directly — the case the old client inference missed.
		expect(writer.canWriteMain).toBe(true);
		// The collection owner may append revisions but is NOT an entry-level writer.
		expect(colOwner.canWriteMain).toBe(true);
		expect(colOwner.canEditMeta).toBe(false);
		expect(reader).toMatchObject({
			canWriteMain: false,
			canEditMeta: false,
			canManageAcl: false,
			canTransferOwner: false,
			canDelete: false,
			canReview: false,
		});
		expect(reviewer.canReview).toBe(true);
		expect(reviewer.canWriteMain).toBe(false);
	});
});

describe("collection viewerCaps ⇔ write paths", () => {
	for (const role of ROLES) {
		test(`${role}: every flag matches whether its endpoint accepts`, async () => {
			const p = principalFor(role);

			const fEdit = await makeFixture();
			expect((await collectionCapsVia(role, fEdit.collectionId)).canEdit).toBe(
				await accepts(() =>
					knowledgeService.updateCollection(fEdit.collectionId, { name: `${TAG}-r-${role}` }, p),
				),
			);

			const fCreate = await makeFixture();
			expect((await collectionCapsVia(role, fCreate.collectionId)).canCreateEntry).toBe(
				await accepts(() =>
					knowledgeService.createEntry({
						collectionId: fCreate.collectionId,
						title: `${TAG}-new-${role}-${generateId(4)}`,
						authorUserId: p.userId,
						principal: p,
					}),
				),
			);

			const fTransfer = await makeFixture();
			expect((await collectionCapsVia(role, fTransfer.collectionId)).canTransferOwner).toBe(
				await accepts(() =>
					knowledgeService.transferCollectionOwner(fTransfer.collectionId, transferTargetId, p),
				),
			);

			const fAcl = await makeFixture();
			expect((await collectionCapsVia(role, fAcl.collectionId)).canManageAcl).toBe(
				await httpAccepts(p, "PATCH", `/collections/${fAcl.collectionId}/acl`, {
					classificationLevel: null,
				}),
			);

			const fDelete = await makeFixture();
			expect((await collectionCapsVia(role, fDelete.collectionId)).canDelete).toBe(
				await accepts(() => knowledgeService.deleteCollection(fDelete.collectionId, p)),
			);
		});
	}
});
