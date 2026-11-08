/**
 * server/services/__tests__/knowledge-submission-outcome-read.test.ts
 * 作者已读（author_read_at）的行为契约
 *
 * 铃铛上的"知识库审核动态"曾无法消掉：裁决列表按 30 天窗口硬算，没有已读状态，
 * 作者看完仍计入徽标。这里固定修复后的语义：
 *  - 未读计数只算 author_read_at IS NULL 的裁决
 *  - 单条标记只作用于调用者自己的行，别人的 id 是 no-op 而不是报错
 *  - 重复标记不覆盖首次已读时间（幂等）
 *  - 30 天窗口外的裁决不参与计数
 *
 * 跑在临时 NARRAFORK_HOME 下的真实隔离库上，与 knowledge-review-lifecycle 一致。
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { knowledgeSubmissions, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import { knowledgeBranchService } from "../knowledge-branch-service";
import { knowledgeService } from "../knowledge-service";

const author = { userId: "", role: "user" as const };
const other = { userId: "", role: "user" as const };

let collectionId: string;
const TAG = Date.now();

beforeAll(async () => {
	const now = new Date().toISOString();
	const authorId = generateId();
	const otherId = generateId();
	await db.insert(users).values([
		{ id: authorId, username: `or-author-${TAG}`, passwordHash: "x", role: "user", createdAt: now },
		{ id: otherId, username: `or-other-${TAG}`, passwordHash: "x", role: "user", createdAt: now },
	]);
	author.userId = authorId;
	other.userId = otherId;

	const col = await knowledgeService.createCollection({ name: `outcome-read-${TAG}` });
	collectionId = col.id;
});

/** A standalone personal entry whose publish request the given principal submitted. */
async function submitAs(
	principal: { userId: string; role: "admin" | "user" },
	label: string,
): Promise<string> {
	const entry = await knowledgeBranchService.createStandalone(principal, {
		title: `${label} ${TAG}`,
		content: `${label} body\n`,
		targetCollectionId: collectionId,
	});
	const submission = await knowledgeBranchService.submitForReview(principal, entry.id, {
		changeNote: `${label} note`,
	});
	return submission?.id as string;
}

/**
 * Close a submission as `approved` without going through the merge path.
 *
 * The bell only reads status + reviewedAt, so a direct update pins the exact state under
 * test without dragging entry/revision merging into it.
 */
async function stampVerdict(submissionId: string, reviewedAt = new Date().toISOString()) {
	await db
		.update(knowledgeSubmissions)
		.set({ status: "approved", verdict: "approve", reviewedAt })
		.where(eq(knowledgeSubmissions.id, submissionId));
}

async function authorReadAtOf(submissionId: string): Promise<string | null> {
	const row = await db.query.knowledgeSubmissions.findFirst({
		where: eq(knowledgeSubmissions.id, submissionId),
		columns: { authorReadAt: true },
	});
	return row?.authorReadAt ?? null;
}

describe("author read state on verdicts", () => {
	test("a fresh verdict counts as unread until the author marks it", async () => {
		const before = await knowledgeBranchService.countUnreadSubmissionOutcomes(author);

		const submissionId = await submitAs(author, "unread-flow");
		await stampVerdict(submissionId);

		const unread = await knowledgeBranchService.countUnreadSubmissionOutcomes(author);
		expect(unread.count).toBe(before.count + 1);

		const result = await knowledgeBranchService.markSubmissionOutcomesRead(author, {
			ids: [submissionId],
		});
		expect(result.updated).toBe(1);

		const after = await knowledgeBranchService.countUnreadSubmissionOutcomes(author);
		expect(after.count).toBe(before.count);
		expect(await authorReadAtOf(submissionId)).not.toBeNull();
	});

	test("marking again keeps the first-read timestamp", async () => {
		const submissionId = await submitAs(author, "idempotent");
		await stampVerdict(submissionId);
		await knowledgeBranchService.markSubmissionOutcomesRead(author, { ids: [submissionId] });
		const first = await authorReadAtOf(submissionId);

		const again = await knowledgeBranchService.markSubmissionOutcomesRead(author, {
			ids: [submissionId],
		});
		expect(again.updated).toBe(0);
		expect(await authorReadAtOf(submissionId)).toBe(first);
	});

	test("another user's id is ignored, never an error and never a write", async () => {
		const submissionId = await submitAs(author, "foreign-id");
		await stampVerdict(submissionId);

		const result = await knowledgeBranchService.markSubmissionOutcomesRead(other, {
			ids: [submissionId],
		});
		expect(result.updated).toBe(0);
		expect(await authorReadAtOf(submissionId)).toBeNull();

		// The owner still sees it unread.
		const ownerCount = await knowledgeBranchService.countUnreadSubmissionOutcomes(author);
		expect(ownerCount.count).toBeGreaterThan(0);
	});

	test("verdicts older than the 30-day window never count", async () => {
		// Other tests share this database, so compare against the count taken just before
		// this submission — an absolute number would pin their leftovers too.
		const before = await knowledgeBranchService.countUnreadSubmissionOutcomes(author);

		const submissionId = await submitAs(author, "stale");
		const longAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
		await stampVerdict(submissionId, longAgo);

		const listed = await knowledgeBranchService.listMySubmissionOutcomes(author);
		expect(listed.some((row) => row.id === submissionId)).toBe(false);

		const after = await knowledgeBranchService.countUnreadSubmissionOutcomes(author);
		expect(after.count).toBe(before.count);
	});

	test("the list carries authorReadAt so the panel can show unread rows", async () => {
		const submissionId = await submitAs(author, "carries-flag");
		await stampVerdict(submissionId);

		const before = await knowledgeBranchService.listMySubmissionOutcomes(author);
		expect(before.find((row) => row.id === submissionId)?.authorReadAt).toBeNull();

		await knowledgeBranchService.markSubmissionOutcomesRead(author, { ids: [submissionId] });

		const after = await knowledgeBranchService.listMySubmissionOutcomes(author);
		expect(after.find((row) => row.id === submissionId)?.authorReadAt).not.toBeNull();
	});
});
