/**
 * Agent-tool tests for KnowledgeCreate + KnowledgeEdit (the contributor-facing tools that
 * replaced KnowledgeDraft and absorbed KnowledgeReview's authoring actions).
 *
 * Verifies the tool-layer orchestration on top of the personal-library service:
 *  - KnowledgeCreate: default → personal entry; direct:true + write permission → global entry;
 *    direct:true WITHOUT permission → explicit error (nothing created) unless the caller also
 *    passes fallbackToPersonal:true, which downgrades to a personal entry and says so.
 *  - KnowledgeEdit: save (personal), set_target, publish, and the rebase sub-action.
 *
 * Runs against a real isolated DB under a temp NARRAFORK_HOME.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../../db";
import { users } from "../../db/schema";
import { knowledgeCreateTool, knowledgeEditTool } from "../../lib/agent/tools/knowledge-edit";
import type { ToolContext } from "../../lib/agent/types";
import { generateId } from "../../lib/id";
import { knowledgeBranchService } from "../knowledge-branch-service";
import { knowledgeService } from "../knowledge-service";

const TAG = Date.now();
let ownerId: string;
let plainId: string;
let collectionId: string;

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

beforeAll(async () => {
	const now = new Date().toISOString();
	ownerId = generateId();
	plainId = generateId();
	await db.insert(users).values([
		{ id: ownerId, username: `ke-owner-${TAG}`, passwordHash: "x", role: "user", createdAt: now },
		{ id: plainId, username: `ke-plain-${TAG}`, passwordHash: "x", role: "user", createdAt: now },
	]);
	// Collection owned by ownerId → ownerId can write to it; plainId cannot.
	const col = await knowledgeService.createCollection({
		name: `ke-${TAG}`,
		ownerUserId: ownerId,
	});
	collectionId = col.id;
});

describe("KnowledgeCreate", () => {
	test("default creates a personal entry (no global entry)", async () => {
		const res = await knowledgeCreateTool.execute(
			{ title: `Personal ${TAG}`, content: "note", collectionId },
			ctxFor(plainId),
		);
		expect(res.isError).toBeUndefined();
		expect(res.output).toContain("personal");
		const personalId = (res.metadata as { personalEntryId?: string }).personalEntryId;
		expect(personalId).toBeTruthy();
		const mine = await knowledgeBranchService.getMine(
			{ userId: plainId, role: "user" },
			personalId as string,
		);
		expect(mine.entryId).toBeNull();
		expect(mine.targetCollectionId).toBe(collectionId);
	});

	test("direct:true with write permission creates a global entry", async () => {
		const res = await knowledgeCreateTool.execute(
			{ title: `Global ${TAG}`, content: "global body", collectionId, direct: true },
			ctxFor(ownerId),
		);
		expect(res.isError).toBeUndefined();
		expect(res.output).toContain("global entry");
		const entryId = (res.metadata as { entryId?: string }).entryId;
		expect(entryId).toBeTruthy();
	});

	test("direct:true WITHOUT permission errors and creates nothing", async () => {
		const res = await knowledgeCreateTool.execute(
			{ title: `NoPerm ${TAG}`, content: "x", collectionId, direct: true },
			ctxFor(plainId),
		);
		// No silent downgrade: a requested global create that cannot happen is an error.
		expect(res.isError).toBe(true);
		expect(res.output).toContain("Direct global create FAILED");
		expect(res.metadata).toMatchObject({ created: false, downgraded: false });
		const drafts = await db.query.knowledgeDrafts.findMany({
			where: (d, { eq }) => eq(d.title, `NoPerm ${TAG}`),
			columns: { id: true },
		});
		expect(drafts.length).toBe(0);
	});

	test("direct:true + fallbackToPersonal:true downgrades and flags it", async () => {
		const res = await knowledgeCreateTool.execute(
			{
				title: `NoPermFallback ${TAG}`,
				content: "x",
				collectionId,
				direct: true,
				fallbackToPersonal: true,
			},
			ctxFor(plainId),
		);
		expect(res.isError).toBeUndefined();
		expect(res.output).toContain("DOWNGRADED");
		expect(res.metadata).toMatchObject({ direct: false, downgraded: true });
	});

	test("denied permission blocks creation", async () => {
		const res = await knowledgeCreateTool.execute(
			{ title: `Denied ${TAG}`, collectionId },
			ctxFor(plainId, async () => ({ behavior: "deny" })),
		);
		expect(res.isError).toBe(true);
	});
});

describe("KnowledgeEdit", () => {
	test("save to a standalone personal entry, then publish", async () => {
		const created = await knowledgeBranchService.createStandalone(
			{ userId: plainId, role: "user" },
			{ title: `Edit Me ${TAG}`, targetCollectionId: collectionId },
		);
		const saved = await knowledgeEditTool.execute(
			{ action: "save", personalEntryId: created.id, content: "edited content" },
			ctxFor(plainId),
		);
		expect(saved.isError).toBeUndefined();
		const mine = await knowledgeBranchService.getMine(
			{ userId: plainId, role: "user" },
			created.id,
		);
		expect(mine.content).toBe("edited content");

		const published = await knowledgeEditTool.execute(
			{ action: "publish", personalEntryId: created.id },
			ctxFor(plainId),
		);
		expect(published.isError).toBeUndefined();
		expect(published.output).toContain("Submitted");
	});

	test("save with entryId auto-creates a linked personal entry", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `Linked ${TAG}`,
			content: "global body\n",
		});
		const res = await knowledgeEditTool.execute(
			{ action: "save", entryId: entry.id, content: "global body\nmy addition\n" },
			ctxFor(plainId),
		);
		expect(res.isError).toBeUndefined();
		// A personal entry now shadows it for plainId.
		const mine = await knowledgeBranchService.getMyDraft(
			{ userId: plainId, role: "user" },
			entry.id,
		);
		expect(mine?.content).toContain("my addition");
	});

	test("set_target sets the publish target collection", async () => {
		const created = await knowledgeBranchService.createStandalone(
			{ userId: plainId, role: "user" },
			{ title: `Targetless ${TAG}` },
		);
		const res = await knowledgeEditTool.execute(
			{ action: "set_target", personalEntryId: created.id, collectionId },
			ctxFor(plainId),
		);
		expect(res.isError).toBeUndefined();
		const mine = await knowledgeBranchService.getMine(
			{ userId: plainId, role: "user" },
			created.id,
		);
		expect(mine.targetCollectionId).toBe(collectionId);
	});

	test("rebase a drifted linked personal entry via the tool", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `Rebase ${TAG}`,
			content: "L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\n",
		});
		// plainId forks a personal entry editing the tail.
		await knowledgeEditTool.execute(
			{ action: "save", entryId: entry.id, content: "L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8 edited\n" },
			ctxFor(plainId),
		);
		// Main advances on a far region (the head) → drift without overlap.
		await knowledgeService.addRevision(entry.id, {
			content: "L1 changed\nL2\nL3\nL4\nL5\nL6\nL7\nL8\n",
		});
		const res = await knowledgeEditTool.execute(
			{ action: "rebase", entryId: entry.id },
			ctxFor(plainId),
		);
		expect(res.isError).toBeUndefined();
		expect(res.output.toLowerCase()).toContain("rebas");
	});

	test("update_meta with personalEntryId edits a standalone entry's keywords", async () => {
		const created = await knowledgeBranchService.createStandalone(
			{ userId: plainId, role: "user" },
			{ title: `Kw Personal ${TAG}`, keywords: ["initialkw"] },
		);
		const res = await knowledgeEditTool.execute(
			{
				action: "update_meta",
				personalEntryId: created.id,
				title: `Kw Personal Renamed ${TAG}`,
				keywords: [`personalkw${TAG}`, "another"],
			},
			ctxFor(plainId),
		);
		expect(res.isError).toBeUndefined();
		expect((res.metadata as { personalEntryId?: string }).personalEntryId).toBe(created.id);
		const mine = await knowledgeBranchService.getMine(
			{ userId: plainId, role: "user" },
			created.id,
		);
		expect(mine.title).toBe(`Kw Personal Renamed ${TAG}`);
		expect(mine.keywordsJson).toEqual([`personalkw${TAG}`, "another"]);
	});

	test("update_meta with neither entryId nor personalEntryId is rejected", async () => {
		const res = await knowledgeEditTool.execute(
			{ action: "update_meta", keywords: ["x"] },
			ctxFor(plainId),
		);
		expect(res.isError).toBe(true);
	});

	test("update_meta with entryId edits a global entry's keywords (owner)", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `Kw Global ${TAG}`,
			content: "body",
			authorUserId: ownerId,
		});
		const res = await knowledgeEditTool.execute(
			{ action: "update_meta", entryId: entry.id, keywords: [`globalkw${TAG}`] },
			ctxFor(ownerId),
		);
		expect(res.isError).toBeUndefined();
		expect((res.metadata as { entryId?: string }).entryId).toBe(entry.id);
		const fresh = await knowledgeService.getEntry(entry.id, {
			withContent: true,
			principal: { userId: ownerId, role: "user" },
		});
		expect((fresh as { keywordsJson?: string[] }).keywordsJson).toEqual([`globalkw${TAG}`]);
	});

	test("anonymous user cannot edit", async () => {
		const res = await knowledgeEditTool.execute(
			{ action: "save", personalEntryId: "x", content: "y" },
			ctxFor(null),
		);
		expect(res.isError).toBe(true);
	});
});
