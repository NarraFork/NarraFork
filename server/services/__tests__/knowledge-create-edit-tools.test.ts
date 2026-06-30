/**
 * Agent-tool tests for KnowledgeCreate + KnowledgeEdit (the contributor-facing tools that
 * replaced KnowledgeDraft and absorbed KnowledgeReview's authoring actions).
 *
 * Verifies the tool-layer orchestration on top of the personal-library service:
 *  - KnowledgeCreate: default → personal entry; direct:true + write permission → global entry;
 *    direct:true WITHOUT permission → falls back to a personal entry (no error).
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

	test("direct:true WITHOUT permission falls back to a personal entry (no error)", async () => {
		const res = await knowledgeCreateTool.execute(
			{ title: `NoPerm ${TAG}`, content: "x", collectionId, direct: true },
			ctxFor(plainId),
		);
		expect(res.isError).toBeUndefined();
		// Fell back to a personal entry rather than erroring.
		expect((res.metadata as { direct?: boolean }).direct).toBe(false);
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

	test("anonymous user cannot edit", async () => {
		const res = await knowledgeEditTool.execute(
			{ action: "save", personalEntryId: "x", content: "y" },
			ctxFor(null),
		);
		expect(res.isError).toBe(true);
	});
});
