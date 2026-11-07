/**
 * ExitPlanMode refuses an outline plan that is not laid out in levels (plan readability): the
 * refusal names the blocks to fix and how, in the session's language; nothing waits for a person
 * and nothing is written (the root's plan state, version and the space's commits stay as they
 * were); a fixed plan then submits. A call restored from what was persisted is not refused (a
 * person has it in front of them), the notes written for the agent under the root do not count,
 * and the root EnterPlanMode makes is a title the check accepts.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { OUTLINE_PLAN_STRUCTURE } from "@shared/outline-plan-structure";
import { db } from "../../db";
import { narrators, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import { getOutlinePlanReturnedNote, getOutlinePlanReviewTitle } from "../../lib/prompt-i18n";
import { settings } from "../../lib/settings";
import { resolveExitPlanModeInput } from "../narrator-permission";
import { pendingPermissions } from "../narrator-session-state";
import { findPlanningRoot, isPlanNoteBlock } from "../outline/plans";
import { ensureSessionSpace } from "../outline/spaces";
import { outlineStore } from "../outline/store";
import { type OutlineOp, writeOutline } from "../outline/write";
import { enterOutlinePlanMode, resolveOutlineExitPlanInput } from "../outline-plan-mode";

const NOW = "2026-11-07T00:00:00.000Z";
const { rootChars, blockChars, maxChildren } = OUTLINE_PLAN_STRUCTURE;

beforeEach(() => {
	settings.outline.enabled = true;
});

async function user(): Promise<string> {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `layout-${id}`, passwordHash: "x", role: "user", createdAt: NOW });
	return id;
}

async function session(owner: string): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
		model: "default",
		permissionMode: "default",
		status: "idle",
		taskBackend: "outline",
		ownerUserId: owner,
		autoContinuationOverride: "protectedOnly",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

async function agentWrite(narratorId: string, owner: string, ops: OutlineOp[]) {
	const space = await ensureSessionSpace(narratorId);
	return await writeOutline({
		spaceId: space.id,
		ops,
		actor: { kind: "agent", id: narratorId },
		responsibleUserId: owner,
		narratorId,
	});
}

/** A session in plan mode with a plan root, and what the state of the outline is. */
async function planning(planName = "历史读取改告警") {
	const owner = await user();
	const id = await session(owner);
	const entered = await enterOutlinePlanMode({
		narratorId: id,
		userId: owner,
		input: { plan_name: planName },
		locale: "zh-CN",
	});
	if (!entered || entered.isError) throw new Error(`not entered: ${entered?.output}`);
	const root = await findPlanningRoot(id);
	if (!root) throw new Error("no plan root");
	const space = await ensureSessionSpace(id);
	return { owner, id, root, space };
}

/** What a refusal must leave as it was: the root (state, version) and the space's commits. */
async function snapshot(spaceId: string, rootId: string) {
	const block = await outlineStore.getBlock(rootId);
	const space = await outlineStore.getSpace(spaceId);
	return {
		versionSeq: block?.versionSeq,
		plan: block?.taskJson?.plan,
		content: block?.content,
		nextSeq: space?.nextSeq,
		pending: pendingPermissions.size,
	};
}

/** The plan from the owner's screenshot: the goal and the acceptance in the root, long bullets. */
async function writeWallOfText(id: string, owner: string, rootId: string) {
	const long = `把历史读取的十秒固定拒绝改成告警，${"涉及模型历史链路、工具结果回放和压缩恢复，".repeat(14)}`;
	return await agentWrite(id, owner, [
		{
			op: "update",
			block: { id: rootId },
			content: "历史读取10秒改告警\n目标：读历史超过 10 秒只告警\n验收：慢读取照常返回",
		},
		{
			op: "insert",
			tempId: "bounds",
			sid: "BoundsAa",
			parent: { id: rootId },
			content: "已确定的边界与取舍",
		},
		{ op: "insert", sid: "LongTxt1", parent: { tempId: "bounds" }, content: long },
		{ op: "insert", parent: { tempId: "bounds" }, content: "不动压缩逻辑" },
	]);
}

describe("a plan not laid out in levels is refused", () => {
	test("the refusal names each block and how to fix it; nothing waits and nothing is written", async () => {
		const { id, owner, root, space } = await planning();
		await writeWallOfText(id, owner, root.blockId);
		const before = await snapshot(space.id, root.blockId);

		const resolved = await resolveOutlineExitPlanInput(id, { mode: "outline" }, "zh-CN");
		expect(resolved?.ok).toBe(false);
		const message = resolved && !resolved.ok ? resolved.message : "";
		expect(message).toContain(`计划 \`${root.address}\` 的层次还不清楚，这次没有提交给用户`);
		expect(message).toContain(`\`${root.address}\`（计划根）有 `);
		expect(message).toContain("、3 行：根只写一行短标题（不超过 80 字）");
		expect(message).toContain(`\`${space.key}/LongTxt1\` 有 311 字`);
		expect(message).toContain("一块只写一个要点（不超过 300 字），把说明拆成它下面的子块");
		expect(message).toContain("用 OutlineEdit 改好后再调用 ExitPlanMode");
		expect(message).toContain("阶段 → 任务 → 细节");
		// The input keeps no submission: no `_plan*` keys, no rendering.
		expect(resolved?.input).not.toHaveProperty("_planRoot");
		expect(resolved?.input).not.toHaveProperty("plan");

		expect(await snapshot(space.id, root.blockId)).toEqual(before);
		expect(before.plan).toMatchObject({ state: "planning", round: 0 });
	});

	test("the permission layer refuses it as well (what the review gate and the approval read)", async () => {
		const { id, owner, root, space } = await planning();
		await writeWallOfText(id, owner, root.blockId);
		const before = await snapshot(space.id, root.blockId);
		const resolved = await resolveExitPlanModeInput(id, "/", { mode: "outline" }, "en");
		expect(resolved.ok).toBe(false);
		if (resolved.ok) return;
		expect(resolved.message).toContain(
			`The plan \`${root.address}\` is not laid out in levels yet; nothing was submitted to the user`,
		);
		expect(resolved.message).toContain(
			`\`${root.address}\` (the plan root) has 36 characters on 3 lines`,
		);
		expect(resolved.message).toContain(`\`${space.key}/LongTxt1\` has `);
		expect(resolved.message).toContain(`at most ${blockChars} characters`);
		expect(resolved.message).toContain("call ExitPlanMode again");
		expect(await snapshot(space.id, root.blockId)).toEqual(before);
	});

	test("a flat level is refused by its block; fixed, the same plan submits", async () => {
		const { id, owner, root, space } = await planning();
		const steps: OutlineOp[] = Array.from({ length: maxChildren + 2 }, (_, i) => ({
			op: "insert",
			parent: { id: root.blockId },
			content: `步骤 ${i + 1}`,
			task: { status: "todo" },
		}));
		const written = await agentWrite(id, owner, steps);
		const refused = await resolveOutlineExitPlanInput(id, { mode: "outline" }, "zh-CN");
		expect(refused?.ok).toBe(false);
		expect(refused && !refused.ok && refused.message).toContain(
			`\`${root.address}\` 下面直接有 ${maxChildren + 2} 块：按阶段或主题分组，一层不超过 ${maxChildren} 块`,
		);

		// Grouped into two phases: accepted, and the submission is the plan as of now.
		const ids = written.results.map((r) => r.blockId);
		await agentWrite(id, owner, [
			{ op: "insert", tempId: "p1", parent: { id: root.blockId }, content: "阶段 1" },
			{ op: "insert", tempId: "p2", parent: { id: root.blockId }, content: "阶段 2" },
			...ids.map(
				(blockId, i): OutlineOp => ({
					op: "move",
					block: { id: blockId },
					parent: { tempId: i < 9 ? "p1" : "p2" },
				}),
			),
		]);
		const resolved = await resolveOutlineExitPlanInput(id, { mode: "outline" }, "zh-CN");
		expect(resolved?.ok).toBe(true);
		expect(resolved?.input).toMatchObject({
			mode: "outline",
			_planRoot: { address: root.address },
		});
		expect(space.key).toBeTruthy();
	});

	test("more problems than listed are counted", async () => {
		const { id, owner, root } = await planning();
		await agentWrite(
			id,
			owner,
			Array.from(
				{ length: 11 },
				(): OutlineOp => ({
					op: "insert",
					parent: { id: root.blockId },
					content: "x".repeat(blockChars + 1),
				}),
			),
		);
		const refused = await resolveOutlineExitPlanInput(id, { mode: "outline" }, "en");
		const message = refused && !refused.ok ? refused.message : "";
		expect(message.match(/has 301 characters/g)?.length).toBe(8);
		expect(message).toContain("- 3 more like these.");
	});
});

describe("what is not refused", () => {
	test("a call restored from what was persisted is not held to the layout", async () => {
		const { id, owner, root } = await planning();
		// A plan submitted before the rule existed, waiting for a person since.
		await agentWrite(id, owner, [
			{ op: "insert", parent: { id: root.blockId }, content: "说".repeat(blockChars + 10) },
		]);
		const fresh = await resolveOutlineExitPlanInput(id, { mode: "outline" }, "en");
		expect(fresh?.ok).toBe(false);
		const persisted = {
			mode: "outline",
			plan: "- [ ] old",
			_planRoot: {
				blockId: root.blockId,
				spaceId: root.spaceId,
				pageId: root.pageId,
				address: root.address,
				title: root.title,
				round: 1,
			},
			_planSeq: 1,
			_planBaseSeq: 0,
			_planDiff: { counts: { added: 2, removed: 0, text: 0, task: 0, moved: 0 } },
		};
		const restored = await resolveOutlineExitPlanInput(id, persisted, "en", { recovered: true });
		expect(restored?.ok).toBe(true);
	});

	test("notes for the agent under the root (returned feedback, reviews) do not count", async () => {
		const { id, owner, root } = await planning();
		const feedback = "请把阶段拆细。".repeat(80);
		await agentWrite(id, owner, [
			{
				op: "insert",
				parent: { id: root.blockId },
				content: getOutlinePlanReturnedNote("zh-CN", 1, feedback),
			},
			{
				op: "insert",
				tempId: "rv",
				parent: { id: root.blockId },
				content: getOutlinePlanReviewTitle("en", 1),
			},
			{ op: "insert", parent: { tempId: "rv" }, content: "c".repeat(900) },
			...Array.from(
				{ length: maxChildren },
				(_, i): OutlineOp => ({
					op: "insert",
					parent: { id: root.blockId },
					content: `Step ${i}`,
				}),
			),
		]);
		const resolved = await resolveOutlineExitPlanInput(id, { mode: "outline" }, "en");
		expect(resolved?.ok).toBe(true);
	});

	test("the root EnterPlanMode makes from a long plan_name is a title the layout accepts", async () => {
		const { id, root } = await planning(`${"很长的计划名".repeat(30)}`);
		expect(Array.from(root.title).length).toBe(rootChars);
		const resolved = await resolveOutlineExitPlanInput(id, { mode: "outline" }, "zh-CN");
		expect(resolved?.ok).toBe(true);
	});
});

describe("notes for the agent", () => {
	test("are recognized by their first words, in both languages and any version", () => {
		for (const locale of ["en", "zh-CN"] as const) {
			expect(isPlanNoteBlock({ content: getOutlinePlanReturnedNote(locale, 12, "x") })).toBe(true);
			expect(isPlanNoteBlock({ content: getOutlinePlanReviewTitle(locale, 3) })).toBe(true);
		}
		expect(isPlanNoteBlock({ content: "Returned the parcel" })).toBe(false);
		expect(isPlanNoteBlock({ content: "阶段 1：退回意见（第 1 版）" })).toBe(false);
		expect(isPlanNoteBlock({ content: null })).toBe(false);
	});
});
