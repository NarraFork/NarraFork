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
import { db } from "../../db";
import {
	knowledgeCollections,
	knowledgeDrafts,
	knowledgeEntries,
	knowledgeGrants,
	knowledgeRevisions,
	knowledgeSubmissions,
	knowledgeTags,
	users,
} from "../../db/schema";
import { knowledgeAdminTool } from "../../lib/agent/tools/knowledge-admin";
import { knowledgeCreateTool, knowledgeEditTool } from "../../lib/agent/tools/knowledge-edit";
import { knowledgeReviewTool } from "../../lib/agent/tools/knowledge-review";
import type { ToolContext } from "../../lib/agent/types";
import { generateId } from "../../lib/id";
import { classifyDanger } from "../narrator-permission";

const TAG = Date.now();

let adminUserId: string;
let reviewerUserId: string;
let plainUserId: string;
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
	await db.insert(knowledgeGrants).values({
		id: generateId(),
		principalType: "user",
		principalId: reviewerUserId,
		grantType: "review",
		tagId: reviewTagId,
		canWrite: false,
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

	test("a non-writer's direct save falls back to a personal entry (no error)", async () => {
		const entryId = await makeEntry({ title: "Writable A", ownerUserId: adminUserId });
		const res = await knowledgeEditTool.execute(
			{ action: "save", entryId, content: "my proposed change", direct: true },
			ctxFor(plainUserId),
		);
		// New model: a user without write authority does NOT error — the direct flag is ignored
		// and the edit becomes a private personal entry to be published later.
		expect(res.isError).toBeUndefined();
		expect(res.output).toContain("personal entry");
		// Global main is untouched.
		const entry = await db.query.knowledgeEntries.findFirst({
			where: (e, { eq }) => eq(e.id, entryId),
			columns: { currentContent: true },
		});
		expect(entry?.currentContent).not.toContain("my proposed change");
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
