/**
 * Agent-tool tests for KnowledgeAdmin + KnowledgeReview and the danger
 * classification that makes their write actions trigger reflection under
 * bypassPermissions.
 *
 * Runs against an isolated DB under a temp NARRAFORK_HOME (same convention as the
 * other knowledge-*.test.ts files). Uses unique ids/names per run to avoid
 * collisions with seeded data.
 *
 * Run: NARRAFORK_ALLOW_MULTIPLE=1 NARRAFORK_HOME=$(mktemp -d) \
 *      bun test server/services/__tests__/knowledge-agent-tools.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { knowledgeGrantRows } from "../../../tests/fixtures/knowledge-grants";
import { db } from "../../db";
import {
	aclGrants,
	knowledgeCollections,
	knowledgeDrafts,
	knowledgeEntries,
	knowledgeRevisions,
	knowledgeSubmissions,
	knowledgeTags,
	users,
} from "../../db/schema";
import { knowledgeLibraryTool } from "../../lib/agent/tools/knowledge";
import { knowledgeAdminTool } from "../../lib/agent/tools/knowledge-admin";
import { knowledgeCreateTool, knowledgeEditTool } from "../../lib/agent/tools/knowledge-edit";
import { knowledgeReviewTool } from "../../lib/agent/tools/knowledge-review";
import type { ToolContext } from "../../lib/agent/types";
import { generateId } from "../../lib/id";
import { classifyDanger } from "../narrator-permission";

/**
 * Seed knowledge grants into the unified `acl_grants` table.
 *
 * Knowledge authorization no longer reads `knowledge_grants`, so a fixture writing
 * there would grant nothing. Input stays in the knowledge vocabulary; the shared
 * fixture translates it (a credential row, plus a separate write row for canWrite).
 */
async function seedKnowledgeGrants(
	seeds: Parameters<typeof knowledgeGrantRows>[0] | Parameters<typeof knowledgeGrantRows>[0][],
): Promise<void> {
	const list = Array.isArray(seeds) ? seeds : [seeds];
	for (const seed of list) {
		for (const row of knowledgeGrantRows(seed)) {
			await db.insert(aclGrants).values(row as never);
		}
	}
}

const TAG = Date.now();

let adminUserId: string;
let reviewerUserId: string;
let plainUserId: string;
/** Holds a global write grant but owns nothing — separates "may write" from "may classify". */
let writerUserId: string;
let collectionId: string;
let reviewTagId: string;

/** Build a minimal ToolContext. requestPermission defaults to allow. */
function ctxFor(
	userId: string | null,
	requestPermission: ToolContext["requestPermission"] = async () => ({ behavior: "allow" }),
): ToolContext {
	return {
		narratorId: `narr-${TAG}`,
		cwd: "/tmp",
		signal: new AbortController().signal,
		locale: "en",
		userId,
		currentToolUseId: `tu-${generateId(6)}`,
		requestPermission,
	};
}

function nowIso(): string {
	return new Date().toISOString();
}

async function makeUser(role: "admin" | "user", label: string): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `${label}-${TAG}-${generateId(4)}`,
		passwordHash: "x",
		role,
		createdAt: nowIso(),
	});
	return id;
}

/** Create an entry with a current revision and the given ACL attributes. */
async function makeEntry(opts: {
	title: string;
	ownerUserId?: string | null;
	reviewTags?: string[];
}): Promise<string> {
	const entryId = generateId();
	const revisionId = generateId();
	const now = nowIso();
	const content = `# ${opts.title}\n\noriginal body`;
	await db.insert(knowledgeEntries).values({
		id: entryId,
		collectionId,
		title: opts.title,
		slug: `${opts.title.toLowerCase().replace(/\s+/g, "-")}-${generateId(4)}`,
		currentRevisionId: revisionId,
		currentContent: content,
		tagsJson: [],
		ownerUserId: opts.ownerUserId ?? null,
		reviewTagsJson: opts.reviewTags ?? null,
		status: "active",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(knowledgeRevisions).values({
		id: revisionId,
		entryId,
		version: 1,
		format: "markdown",
		content,
		contentHash: "x",
		createdAt: now,
	});
	return entryId;
}

/** Create a submitted draft + pending submission by `submitter`, return submissionId. */
async function makeSubmission(entryId: string, submitterUserId: string): Promise<string> {
	const draftId = generateId();
	const submissionId = generateId();
	const now = nowIso();
	const baseRevId = (
		await db.query.knowledgeEntries.findFirst({
			where: (e, { eq }) => eq(e.id, entryId),
			columns: { currentRevisionId: true },
		})
	)?.currentRevisionId;
	const proposed = "# proposed\n\nnew body from reviewer test";
	await db.insert(knowledgeDrafts).values({
		id: draftId,
		entryId,
		authorUserId: submitterUserId,
		baseRevisionId: baseRevId ?? null,
		content: proposed,
		contentHash: "y",
		format: "markdown",
		status: "active",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(knowledgeSubmissions).values({
		id: submissionId,
		draftId,
		entryId,
		submitterUserId,
		baseRevisionId: baseRevId ?? null,
		proposedContent: proposed,
		status: "pending",
		createdAt: now,
	});
	return submissionId;
}

beforeAll(async () => {
	adminUserId = await makeUser("admin", "kadmin");
	reviewerUserId = await makeUser("user", "kreviewer");
	plainUserId = await makeUser("user", "kplain");
	writerUserId = await makeUser("user", "kwriter");

	const col = await db
		.insert(knowledgeCollections)
		.values({
			id: generateId(),
			name: `agent-tools-${TAG}`,
			slug: `agent-tools-${TAG}`,
			defaultLevel: "public",
			createdAt: nowIso(),
			updatedAt: nowIso(),
		})
		.returning();
	collectionId = col[0].id;

	// A controlled review tag, granted to the reviewer (review grant).
	reviewTagId = generateId();
	await db.insert(knowledgeTags).values({
		id: reviewTagId,
		collectionId,
		name: `review-tag-${TAG}`,
		controlled: true,
		createdAt: nowIso(),
	});
	// Grant the reviewer review authority over the review tag.
	await seedKnowledgeGrants({
		id: generateId(),
		principalType: "user",
		principalId: reviewerUserId,
		grantType: "review",
		tagId: reviewTagId,
		canWrite: false,
		createdAt: nowIso(),
	});
	// Give writerUserId a plain write grant (content authority, no ownership).
	await seedKnowledgeGrants({
		id: generateId(),
		principalType: "user",
		principalId: writerUserId,
		grantType: "clearance",
		clearanceLevel: "public",
		canWrite: true,
		createdAt: nowIso(),
	});
});

describe("KnowledgeAdmin tool", () => {
	test("non-admin principal is refused (defence beyond the load gate)", async () => {
		const res = await knowledgeAdminTool.execute({ action: "list_levels" }, ctxFor(plainUserId));
		expect(res.isError).toBe(true);
		expect(res.output).toContain("administrators");
	});

	test("anonymous principal is refused", async () => {
		const res = await knowledgeAdminTool.execute({ action: "list_levels" }, ctxFor(null));
		expect(res.isError).toBe(true);
	});

	test("admin can list levels (read, no approval)", async () => {
		const res = await knowledgeAdminTool.execute({ action: "list_levels" }, ctxFor(adminUserId));
		expect(res.isError).toBeUndefined();
		expect(res.output).toContain("public");
	});

	test("admin create_grant requires approval and lands when allowed", async () => {
		const res = await knowledgeAdminTool.execute(
			{
				action: "create_grant",
				principalType: "user",
				principalId: plainUserId,
				grantType: "clearance",
				clearanceLevel: "internal",
			},
			ctxFor(adminUserId),
		);
		expect(res.isError).toBeUndefined();
		// Grant now visible for that principal.
		const acl = await knowledgeAdminTool.execute(
			{ action: "get_user_acl", userId: plainUserId },
			ctxFor(adminUserId),
		);
		expect(acl.output).toContain("internal");
	});

	test("denied approval blocks the write", async () => {
		const res = await knowledgeAdminTool.execute(
			{ action: "create_level", name: `lvl${TAG}`, rank: 5 },
			ctxFor(adminUserId, async () => ({ behavior: "deny", message: "nope" })),
		);
		expect(res.isError).toBe(true);
		const levels = await knowledgeAdminTool.execute({ action: "list_levels" }, ctxFor(adminUserId));
		expect(levels.output).not.toContain(`lvl${TAG}`);
	});

	test("set_user_acl replaces a user's ACL", async () => {
		const res = await knowledgeAdminTool.execute(
			{ action: "set_user_acl", userId: plainUserId, clearanceLevel: "confidential" },
			ctxFor(adminUserId),
		);
		expect(res.isError).toBeUndefined();
		const acl = await knowledgeAdminTool.execute(
			{ action: "get_user_acl", userId: plainUserId },
			ctxFor(adminUserId),
		);
		expect(acl.output).toContain("confidential");
	});
});

describe("KnowledgeAdmin collections (build-from-zero entry point)", () => {
	test("admin can create a collection, list it, then create an entry into it", async () => {
		// 1. Create a brand-new collection (the missing first step for from-zero builds).
		const created = await knowledgeAdminTool.execute(
			{ action: "create_collection", name: `from-zero-${TAG}` },
			ctxFor(adminUserId),
		);
		expect(created.isError).toBeUndefined();
		const newCollectionId = JSON.parse(created.output).id as string;
		expect(newCollectionId).toBeTruthy();

		// 2. list_collections surfaces it (so an agent can reuse an existing id).
		const listed = await knowledgeAdminTool.execute(
			{ action: "list_collections" },
			ctxFor(adminUserId),
		);
		expect(listed.output).toContain(newCollectionId);

		// 3. KnowledgeCreate (direct) can now target that collection — full chain closed.
		const entry = await knowledgeCreateTool.execute(
			{
				collectionId: newCollectionId,
				title: `Imported doc ${TAG}`,
				content: "# Imported\n\nbody from md folder",
				direct: true,
			},
			ctxFor(adminUserId),
		);
		expect(entry.isError).toBeUndefined();
		expect(entry.output).toContain("Imported doc");
	});

	test("non-admin cannot create a collection", async () => {
		const res = await knowledgeAdminTool.execute(
			{ action: "create_collection", name: `denied-${TAG}` },
			ctxFor(plainUserId),
		);
		expect(res.isError).toBe(true);
		expect(res.output).toContain("administrators");
	});

	test("denied approval blocks collection creation", async () => {
		const res = await knowledgeAdminTool.execute(
			{ action: "create_collection", name: `blocked-${TAG}` },
			ctxFor(adminUserId, async () => ({ behavior: "deny" })),
		);
		expect(res.isError).toBe(true);
		const listed = await knowledgeAdminTool.execute(
			{ action: "list_collections" },
			ctxFor(adminUserId),
		);
		expect(listed.output).not.toContain(`blocked-${TAG}`);
	});

	test("update_collection requires an id", async () => {
		const res = await knowledgeAdminTool.execute(
			{ action: "update_collection", name: "x" },
			ctxFor(adminUserId),
		);
		expect(res.isError).toBe(true);
		expect(res.output).toContain("requires 'id'");
	});
});

describe("KnowledgeReview tool", () => {
	test("plain user cannot see submissions they may not review", async () => {
		const entryId = await makeEntry({ title: "Reviewable A", reviewTags: [reviewTagId] });
		await makeSubmission(entryId, plainUserId);
		const res = await knowledgeReviewTool.execute(
			{ action: "list_submissions", entryId },
			ctxFor(plainUserId),
		);
		// list_submissions filters to reviewable entries; plain user holds no review grant.
		expect(res.output).not.toContain(entryId);
	});

	test("reviewer (with review grant) can approve and merge a submission", async () => {
		const entryId = await makeEntry({ title: "Reviewable B", reviewTags: [reviewTagId] });
		const submissionId = await makeSubmission(entryId, plainUserId);
		const res = await knowledgeReviewTool.execute(
			{ action: "approve", submissionId },
			ctxFor(reviewerUserId),
		);
		expect(res.isError).toBeUndefined();
		expect(res.output).toContain("approved");
		// Main content updated to the proposed body.
		const entry = await db.query.knowledgeEntries.findFirst({
			where: (e, { eq }) => eq(e.id, entryId),
			columns: { currentContent: true },
		});
		expect(entry?.currentContent).toContain("new body from reviewer test");
	});

	test("plain user cannot approve (no review authority)", async () => {
		const entryId = await makeEntry({ title: "Reviewable C", reviewTags: [reviewTagId] });
		const submissionId = await makeSubmission(entryId, reviewerUserId);
		const res = await knowledgeReviewTool.execute(
			{ action: "approve", submissionId },
			ctxFor(plainUserId),
		);
		expect(res.isError).toBe(true);
	});

	test("a non-writer's direct save FAILS explicitly and writes nothing", async () => {
		const entryId = await makeEntry({ title: "Writable A", ownerUserId: adminUserId });
		const res = await knowledgeEditTool.execute(
			{ action: "save", entryId, content: "my proposed change", direct: true },
			ctxFor(plainUserId),
		);
		// No silent downgrade: the caller asked for a global write it may not perform, so the
		// tool errors out instead of quietly turning it into a personal edit.
		expect(res.isError).toBe(true);
		expect(res.output).toContain("Direct global save FAILED");
		expect(res.output).toContain("no write permission");
		expect(res.metadata).toMatchObject({ written: false, downgraded: false });
		// Global main is untouched...
		const entry = await db.query.knowledgeEntries.findFirst({
			where: (e, { eq }) => eq(e.id, entryId),
			columns: { currentContent: true },
		});
		expect(entry?.currentContent).not.toContain("my proposed change");
		// ...and no personal entry was created either (nothing happened at all).
		const drafts = await db.query.knowledgeDrafts.findMany({
			where: (d, { and, eq }) => and(eq(d.entryId, entryId), eq(d.authorUserId, plainUserId)),
		});
		expect(drafts.length).toBe(0);
	});

	test("a non-writer's direct save downgrades only with fallbackToPersonal:true", async () => {
		const entryId = await makeEntry({ title: "Writable A2", ownerUserId: adminUserId });
		const res = await knowledgeEditTool.execute(
			{
				action: "save",
				entryId,
				content: "my proposed change",
				direct: true,
				fallbackToPersonal: true,
			},
			ctxFor(plainUserId),
		);
		expect(res.isError).toBeUndefined();
		expect(res.output).toContain("DOWNGRADED");
		expect(res.output).toContain("personal entry");
		expect(res.metadata).toMatchObject({ downgraded: true });
		// Global main still untouched; the content landed in a personal entry.
		const entry = await db.query.knowledgeEntries.findFirst({
			where: (e, { eq }) => eq(e.id, entryId),
			columns: { currentContent: true },
		});
		expect(entry?.currentContent).not.toContain("my proposed change");
		const draft = await db.query.knowledgeDrafts.findFirst({
			where: (d, { and, eq }) => and(eq(d.entryId, entryId), eq(d.authorUserId, plainUserId)),
			columns: { content: true },
		});
		expect(draft?.content).toBe("my proposed change");
	});

	test("a non-writer's direct CREATE fails explicitly, and downgrades only when asked", async () => {
		const denied = await knowledgeCreateTool.execute(
			{ collectionId, title: `Direct denied ${TAG}`, content: "body", direct: true },
			ctxFor(plainUserId),
		);
		expect(denied.isError).toBe(true);
		expect(denied.output).toContain("Direct global create FAILED");
		expect(denied.metadata).toMatchObject({ created: false, downgraded: false });
		// Nothing was created on either side.
		const entries = await db.query.knowledgeEntries.findMany({
			where: (e, { eq }) => eq(e.title, `Direct denied ${TAG}`),
			columns: { id: true },
		});
		expect(entries.length).toBe(0);
		const drafts = await db.query.knowledgeDrafts.findMany({
			where: (d, { eq }) => eq(d.title, `Direct denied ${TAG}`),
			columns: { id: true },
		});
		expect(drafts.length).toBe(0);

		const downgraded = await knowledgeCreateTool.execute(
			{
				collectionId,
				title: `Direct downgraded ${TAG}`,
				content: "body",
				direct: true,
				fallbackToPersonal: true,
			},
			ctxFor(plainUserId),
		);
		expect(downgraded.isError).toBeUndefined();
		expect(downgraded.output).toContain("DOWNGRADED");
		expect(downgraded.metadata).toMatchObject({ downgraded: true });
		const personal = await db.query.knowledgeDrafts.findFirst({
			where: (d, { eq }) => eq(d.title, `Direct downgraded ${TAG}`),
			columns: { id: true, entryId: true },
		});
		expect(personal?.id).toBeTruthy();
		expect(personal?.entryId).toBeNull();
	});

	test("owner can save directly to global main", async () => {
		const entryId = await makeEntry({ title: "Writable B", ownerUserId: reviewerUserId });
		const res = await knowledgeEditTool.execute(
			{ action: "save", entryId, content: "owner update body", direct: true },
			ctxFor(reviewerUserId),
		);
		expect(res.isError).toBeUndefined();
		const entry = await db.query.knowledgeEntries.findFirst({
			where: (e, { eq }) => eq(e.id, entryId),
			columns: { currentContent: true },
		});
		expect(entry?.currentContent).toBe("owner update body");
	});

	test("anonymous user is refused write actions", async () => {
		const res = await knowledgeEditTool.execute(
			{ action: "save", entryId: "whatever", content: "x", direct: true },
			ctxFor(null),
		);
		expect(res.isError).toBe(true);
		expect(res.output).toContain("identified user");
	});

	test("denied approval blocks the merge", async () => {
		const entryId = await makeEntry({ title: "Reviewable D", reviewTags: [reviewTagId] });
		const submissionId = await makeSubmission(entryId, plainUserId);
		const res = await knowledgeReviewTool.execute(
			{ action: "approve", submissionId },
			ctxFor(reviewerUserId, async () => ({ behavior: "deny" })),
		);
		expect(res.isError).toBe(true);
		const entry = await db.query.knowledgeEntries.findFirst({
			where: (e, { eq }) => eq(e.id, entryId),
			columns: { currentContent: true },
		});
		// Main unchanged.
		expect(entry?.currentContent).toContain("original body");
	});
});

describe("KnowledgeLibrary tool (core, no admin required)", () => {
	test("a non-admin can list the collections they may read", async () => {
		const res = await knowledgeLibraryTool.execute(
			{ action: "list_collections" },
			ctxFor(plainUserId),
		);
		expect(res.isError).toBeUndefined();
		// The public test collection is readable by everyone.
		expect(res.output).toContain(collectionId);
		const meta = res.metadata as { collections?: { id: string; writable: boolean }[] };
		const found = meta.collections?.find((c) => c.id === collectionId);
		expect(found).toBeDefined();
		// A plain user holds no write grant on it → read-only.
		expect(found?.writable).toBe(false);
		// Summaries only — no entry bodies leak through this listing.
		expect(res.output).not.toContain("original body");
	});

	test("an admin sees collections marked writable", async () => {
		const res = await knowledgeLibraryTool.execute(
			{ action: "list_collections" },
			ctxFor(adminUserId),
		);
		expect(res.isError).toBeUndefined();
		const meta = res.metadata as { collections?: { id: string; writable: boolean }[] };
		expect(meta.collections?.find((c) => c.id === collectionId)?.writable).toBe(true);
	});

	test("a non-admin can list their own personal entries (scalars only)", async () => {
		const title = `My personal ${TAG}`;
		const created = await knowledgeCreateTool.execute(
			{ title, content: "secret personal body text", collectionId },
			ctxFor(plainUserId),
		);
		expect(created.isError).toBeUndefined();
		const personalEntryId = (created.metadata as { personalEntryId?: string }).personalEntryId;
		expect(personalEntryId).toBeTruthy();

		const res = await knowledgeLibraryTool.execute({ action: "list_mine" }, ctxFor(plainUserId));
		expect(res.isError).toBeUndefined();
		expect(res.output).toContain(personalEntryId as string);
		expect(res.output).toContain(title);
		// Bounded output: the body is never returned, only its length.
		expect(res.output).not.toContain("secret personal body text");
		const meta = res.metadata as {
			personalEntries?: { personalEntryId: string; standalone: boolean; contentLength: number }[];
		};
		const row = meta.personalEntries?.find((p) => p.personalEntryId === personalEntryId);
		expect(row?.standalone).toBe(true);
		expect(row?.contentLength).toBe("secret personal body text".length);
	});

	test("list_mine only shows the caller's own entries", async () => {
		const title = `Reviewer personal ${TAG}`;
		await knowledgeCreateTool.execute({ title, content: "x" }, ctxFor(reviewerUserId));
		const res = await knowledgeLibraryTool.execute({ action: "list_mine" }, ctxFor(plainUserId));
		expect(res.output).not.toContain(title);
	});

	test("anonymous list_mine is refused", async () => {
		const res = await knowledgeLibraryTool.execute({ action: "list_mine" }, ctxFor(null));
		expect(res.isError).toBe(true);
	});
});

describe("KnowledgeEdit update_meta classification", () => {
	test("a write-grant holder without ownership cannot set the classification level", async () => {
		const entryId = await makeEntry({ title: `Classify A ${TAG}`, ownerUserId: adminUserId });
		// writerUserId holds a global write grant but does NOT own the entry.
		const res = await knowledgeEditTool.execute(
			{ action: "update_meta", entryId, classificationLevel: "confidential" },
			ctxFor(writerUserId),
		);
		expect(res.isError).toBe(true);
		expect(res.output).toContain("requires admin or entry ownership");
		// Not silently ignored: the level really is unchanged.
		const entry = await db.query.knowledgeEntries.findFirst({
			where: (e, { eq }) => eq(e.id, entryId),
			columns: { classificationLevel: true },
		});
		expect(entry?.classificationLevel).toBeNull();
	});

	test("a plain user cannot set controlled/review tags", async () => {
		const entryId = await makeEntry({ title: `Classify B ${TAG}`, ownerUserId: adminUserId });
		const res = await knowledgeEditTool.execute(
			{ action: "update_meta", entryId, controlledTags: [reviewTagId], reviewTags: [reviewTagId] },
			ctxFor(plainUserId),
		);
		expect(res.isError).toBe(true);
		const entry = await db.query.knowledgeEntries.findFirst({
			where: (e, { eq }) => eq(e.id, entryId),
			columns: { controlledTagsJson: true, reviewTagsJson: true },
		});
		expect(entry?.controlledTagsJson).toBeNull();
	});

	test("the entry owner can classify their own entry", async () => {
		const entryId = await makeEntry({ title: `Classify C ${TAG}`, ownerUserId: reviewerUserId });
		const res = await knowledgeEditTool.execute(
			{
				action: "update_meta",
				entryId,
				title: `Classify C renamed ${TAG}`,
				classificationLevel: "confidential",
				controlledTags: [reviewTagId],
				reviewTags: [reviewTagId],
			},
			ctxFor(reviewerUserId),
		);
		expect(res.isError).toBeUndefined();
		const entry = await db.query.knowledgeEntries.findFirst({
			where: (e, { eq }) => eq(e.id, entryId),
			columns: {
				title: true,
				classificationLevel: true,
				controlledTagsJson: true,
				reviewTagsJson: true,
			},
		});
		expect(entry?.title).toBe(`Classify C renamed ${TAG}`);
		expect(entry?.classificationLevel).toBe("confidential");
		expect(entry?.controlledTagsJson).toEqual([reviewTagId]);
		expect(entry?.reviewTagsJson).toEqual([reviewTagId]);
	});

	test("an admin can classify any entry", async () => {
		const entryId = await makeEntry({ title: `Classify D ${TAG}` });
		const res = await knowledgeEditTool.execute(
			{ action: "update_meta", entryId, classificationLevel: "internal" },
			ctxFor(adminUserId),
		);
		expect(res.isError).toBeUndefined();
		const entry = await db.query.knowledgeEntries.findFirst({
			where: (e, { eq }) => eq(e.id, entryId),
			columns: { classificationLevel: true },
		});
		expect(entry?.classificationLevel).toBe("internal");
	});
});

describe("KnowledgeAdmin update_level", () => {
	test("admin can rename a level and its references follow", async () => {
		const created = await knowledgeAdminTool.execute(
			{ action: "create_level", name: `lvlup${TAG}`, rank: 41 },
			ctxFor(adminUserId),
		);
		expect(created.isError).toBeUndefined();
		const levelId = JSON.parse(created.output).id as string;

		const updated = await knowledgeAdminTool.execute(
			{ action: "update_level", id: levelId, name: `lvlren${TAG}`, rank: 42, label: "Renamed" },
			ctxFor(adminUserId),
		);
		expect(updated.isError).toBeUndefined();
		expect(updated.output).toContain(`lvlren${TAG}`);

		const listed = await knowledgeAdminTool.execute({ action: "list_levels" }, ctxFor(adminUserId));
		expect(listed.output).toContain(`lvlren${TAG}`);
		expect(listed.output).not.toContain(`lvlup${TAG}`);
	});

	test("update_level requires an id", async () => {
		const res = await knowledgeAdminTool.execute(
			{ action: "update_level", name: "x" },
			ctxFor(adminUserId),
		);
		expect(res.isError).toBe(true);
		expect(res.output).toContain("requires 'id'");
	});

	test("update_level is a write action (non-admin refused, denial blocks it)", async () => {
		const nonAdmin = await knowledgeAdminTool.execute(
			{ action: "update_level", id: "whatever", name: "x" },
			ctxFor(plainUserId),
		);
		expect(nonAdmin.isError).toBe(true);
		expect(nonAdmin.output).toContain("administrators");

		const created = await knowledgeAdminTool.execute(
			{ action: "create_level", name: `lvlblk${TAG}`, rank: 43 },
			ctxFor(adminUserId),
		);
		const levelId = JSON.parse(created.output).id as string;
		const denied = await knowledgeAdminTool.execute(
			{ action: "update_level", id: levelId, name: `lvlblkren${TAG}` },
			ctxFor(adminUserId, async () => ({ behavior: "deny" })),
		);
		expect(denied.isError).toBe(true);
		const listed = await knowledgeAdminTool.execute({ action: "list_levels" }, ctxFor(adminUserId));
		expect(listed.output).toContain(`lvlblk${TAG}`);
		expect(listed.output).not.toContain(`lvlblkren${TAG}`);
	});
});

describe("classifyDanger for knowledge tools (bypassPermissions reflection)", () => {
	const cwd = "/tmp";

	test("read actions are not dangerous", () => {
		expect(classifyDanger("KnowledgeAdmin", { action: "list_levels" }, cwd)).toBeNull();
		expect(classifyDanger("KnowledgeAdmin", { action: "list_collections" }, cwd)).toBeNull();
		expect(classifyDanger("KnowledgeReview", { action: "list_submissions" }, cwd)).toBeNull();
		expect(classifyDanger("KnowledgeAdmin", { action: "get_user_acl" }, cwd)).toBeNull();
	});

	test("missing action is treated as non-dangerous (null)", () => {
		expect(classifyDanger("KnowledgeAdmin", {}, cwd)).toBeNull();
	});

	test("ACL write actions are medium severity", () => {
		const d = classifyDanger("KnowledgeAdmin", { action: "create_grant" }, cwd);
		expect(d).not.toBeNull();
		expect(d?.severity).toBe("medium");
		// Collection writes are also medium (structure change, not a main merge).
		expect(classifyDanger("KnowledgeAdmin", { action: "create_collection" }, cwd)?.severity).toBe(
			"medium",
		);
	});

	test("merge/global-write actions are high severity", () => {
		expect(classifyDanger("KnowledgeReview", { action: "approve" }, cwd)?.severity).toBe("high");
		expect(classifyDanger("KnowledgeReview", { action: "resolve_conflict" }, cwd)?.severity).toBe(
			"high",
		);
		// KnowledgeEdit: publish and a direct global save are high.
		expect(classifyDanger("KnowledgeEdit", { action: "publish" }, cwd)?.severity).toBe("high");
		expect(classifyDanger("KnowledgeEdit", { action: "save", direct: true }, cwd)?.severity).toBe(
			"high",
		);
		// KnowledgeCreate: a direct global create is high.
		expect(classifyDanger("KnowledgeCreate", { direct: true }, cwd)?.severity).toBe("high");
	});

	test("personal-scope knowledge actions are medium severity", () => {
		// A non-direct save (personal entry) and a personal create are medium.
		expect(classifyDanger("KnowledgeEdit", { action: "save" }, cwd)?.severity).toBe("medium");
		expect(classifyDanger("KnowledgeCreate", {}, cwd)?.severity).toBe("medium");
	});

	test("non-merge review + non-global edit actions are medium severity", () => {
		expect(classifyDanger("KnowledgeReview", { action: "request_changes" }, cwd)?.severity).toBe(
			"medium",
		);
		expect(classifyDanger("KnowledgeReview", { action: "comment" }, cwd)?.severity).toBe("medium");
		// KnowledgeEdit metadata/ownership actions are medium (no global content write).
		expect(classifyDanger("KnowledgeEdit", { action: "update_meta" }, cwd)?.severity).toBe(
			"medium",
		);
		expect(classifyDanger("KnowledgeEdit", { action: "transfer_owner" }, cwd)?.severity).toBe(
			"medium",
		);
	});
});
