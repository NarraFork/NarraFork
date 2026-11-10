/**
 * ExitPlanMode refuses an outline plan that is not in the plan format (plan readability: a
 * one-line title, a background paragraph as the root's first block, big and small points one
 * idea each with their implementation details under them, the notable points last): the refusal
 * names the blocks to fix and how, in the session's language; nothing waits for a person and
 * nothing is written (the root's plan state, version and the space's commits stay as they were);
 * a fixed plan then submits. A call restored from what was persisted is not refused (a person
 * has it in front of them), the notes written for the agent under the root do not count, and the
 * root EnterPlanMode makes is a title the check accepts.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	isPlanNoteContent,
	NOTABLE_POINTS_TITLE,
	OUTLINE_PLAN_STRUCTURE,
} from "@shared/outline-plan-structure";
import { parsePlanTree } from "@shared/outline-plan-tree";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { narrators, narratorToolCalls, users } from "../../db/schema";
import { localBackend } from "../../lib/agent/execution/registry";
import { askTool, outlineEditTool } from "../../lib/agent/tools/outline";
import { enterPlanModeTool, exitPlanModeTool } from "../../lib/agent/tools/plan-mode";
import type { ToolContext } from "../../lib/agent/types";
import { generateId } from "../../lib/id";
import {
	getOutlinePlanEnterOutput,
	getOutlinePlanModeSystemReminder,
	getOutlinePlanReturnedNote,
	getOutlinePlanReviewPrompt,
	getOutlinePlanReviewTitle,
} from "../../lib/prompt-i18n";
import { settings } from "../../lib/settings";
import { handlePermission, resolveExitPlanModeInput } from "../narrator-permission";
import { narratorService } from "../narrator-service";
import { pendingPermissions } from "../narrator-session-state";
import { findPlanningRoot, isPlanNoteBlock } from "../outline/plans";
import { ensureSessionSpace } from "../outline/spaces";
import { outlineStore } from "../outline/store";
import { type OutlineOp, writeOutline } from "../outline/write";
import { enterOutlinePlanMode, resolveOutlineExitPlanInput } from "../outline-plan-mode";

const NOW = "2026-11-07T00:00:00.000Z";
const { rootChars, backgroundChars, pointChars, detailChars, maxChildren } = OUTLINE_PLAN_STRUCTURE;

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

/** The live blocks directly under a block, in order. */
async function findChildren(blockId: string) {
	const block = await outlineStore.getBlock(blockId);
	if (!block) return [];
	const children = await outlineStore.listChildren(block.spaceId, blockId, 100);
	return children.filter((b) => !b.deleted);
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

const BACKGROUND =
	"模型历史、工具结果回放和会话恢复读历史超过 10 秒就直接拒绝，慢磁盘上的会话会莫名失败。这次把固定时间拒绝改成告警，读取照常完成。";

function toolCtx(narratorId: string, userId: string): ToolContext {
	return {
		narratorId,
		cwd: "/",
		signal: new AbortController().signal,
		locale: "zh-CN",
		userId,
		requestPermission: async () => ({ behavior: "allow" }),
	} as unknown as ToolContext;
}

/** The background paragraph, first under the root. */
function backgroundOp(rootId: string): OutlineOp {
	return {
		op: "insert",
		parent: { id: rootId },
		position: { first: true },
		content: BACKGROUND,
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

describe("a plan not in the format is refused", () => {
	test("the refusal names each block and how to fix it; nothing waits and nothing is written", async () => {
		const { id, owner, root, space } = await planning();
		await writeWallOfText(id, owner, root.blockId);
		const before = await snapshot(space.id, root.blockId);

		const resolved = await resolveOutlineExitPlanInput(id, { mode: "outline" }, "zh-CN");
		expect(resolved?.ok).toBe(false);
		const message = resolved && !resolved.ok ? resolved.message : "";
		expect(message).toContain(`计划 \`${root.address}\` 还不符合计划格式，这次没有提交给用户`);
		expect(message).toContain(`\`${root.address}\`（计划根）有 `);
		expect(message).toContain("、3 行：根只写一行短标题（不超过 80 字）");
		expect(message).toContain(
			`\`${space.key}/BoundsAa\` 是根下第一块，但它下面挂着子块：背景只是一段话，不挂子块`,
		);
		expect(message).toContain(`\`${space.key}/LongTxt1\` 有 311 字`);
		expect(message).toContain(
			"大点、小点各只写一个要点（不超过 120 字），说明写成它下面的实施细节",
		);
		expect(message).toContain("计划格式：根是一行标题；根下第一块是背景（一段话）");
		expect(message).toContain(`最后一块是「${NOTABLE_POINTS_TITLE["zh-CN"]}」`);
		expect(message).toContain("用 OutlineEdit 改好后再调用 ExitPlanMode");
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
			`The plan \`${root.address}\` does not follow the plan format yet; nothing was submitted to the user`,
		);
		expect(resolved.message).toContain(
			`\`${root.address}\` (the plan root) has 36 characters on 3 lines`,
		);
		expect(resolved.message).toContain(
			`\`${space.key}/BoundsAa\` is the root's first block but has blocks under it`,
		);
		expect(resolved.message).toContain(`\`${space.key}/LongTxt1\` has `);
		expect(resolved.message).toContain(`a big or small point is one idea (at most ${pointChars}`);
		expect(resolved.message).toContain("call ExitPlanMode again");
		expect(await snapshot(space.id, root.blockId)).toEqual(before);
	});

	test("a plan with no background is refused by its root; with one, it submits", async () => {
		const { id, owner, root, space } = await planning();
		await agentWrite(id, owner, [
			{
				op: "insert",
				sid: "PhaseOne",
				parent: { id: root.blockId },
				content: "阶段 1",
				task: { status: "todo" },
			},
		]);
		const refused = await resolveOutlineExitPlanInput(id, { mode: "outline" }, "zh-CN");
		expect(refused && !refused.ok && refused.message).toContain(
			`\`${space.key}/PhaseOne\` 是根下第一块，但它是任务：根下第一块必须是背景——一段不带复选框的话（不超过 ${backgroundChars} 字）。在它前面插入背景：OutlineEdit 的 add 指向计划根，带 before: "${space.key}/PhaseOne"。`,
		);
		await agentWrite(id, owner, [backgroundOp(root.blockId)]);
		const resolved = await resolveOutlineExitPlanInput(id, { mode: "outline" }, "zh-CN");
		expect(resolved?.ok).toBe(true);
	});

	test("a background longer than its limit is refused as one", async () => {
		const { id, owner, root, space } = await planning();
		await agentWrite(id, owner, [
			{
				op: "insert",
				sid: "BackGrnd",
				parent: { id: root.blockId },
				content: "景".repeat(backgroundChars + 5),
			},
		]);
		const refused = await resolveOutlineExitPlanInput(id, { mode: "outline" }, "en");
		expect(refused && !refused.ok && refused.message).toContain(
			`\`${space.key}/BackGrnd\` (the background) has ${backgroundChars + 5} characters: keep it one concise paragraph (at most ${backgroundChars} characters)`,
		);
	});

	test("the notable points must come last; moved there, the plan submits", async () => {
		const { id, owner, root, space } = await planning();
		const written = await agentWrite(id, owner, [
			backgroundOp(root.blockId),
			{
				op: "insert",
				tempId: "n",
				sid: "Notable1",
				parent: { id: root.blockId },
				content: NOTABLE_POINTS_TITLE["zh-CN"],
			},
			{ op: "insert", parent: { tempId: "n" }, content: "错误码保留一个版本" },
			{ op: "insert", parent: { id: root.blockId }, content: "阶段 1", task: { status: "todo" } },
		]);
		const refused = await resolveOutlineExitPlanInput(id, { mode: "outline" }, "zh-CN");
		expect(refused && !refused.ok && refused.message).toContain(
			`\`${space.key}/Notable1\`（「${NOTABLE_POINTS_TITLE["zh-CN"]}」）不是根下最后一块：用 OutlineEdit 把它 move 到计划根`,
		);
		await agentWrite(id, owner, [
			{
				op: "move",
				block: { id: written.results[1]?.blockId as string },
				parent: { id: root.blockId },
			},
		]);
		const resolved = await resolveOutlineExitPlanInput(id, { mode: "outline" }, "zh-CN");
		expect(resolved?.ok).toBe(true);
	});

	test("a flat level is refused by its block; grouped, the same plan submits", async () => {
		const { id, owner, root } = await planning();
		const steps: OutlineOp[] = Array.from({ length: maxChildren + 2 }, (_, i) => ({
			op: "insert",
			parent: { id: root.blockId },
			content: `步骤 ${i + 1}`,
			task: { status: "todo" },
		}));
		const written = await agentWrite(id, owner, [backgroundOp(root.blockId), ...steps]);
		const refused = await resolveOutlineExitPlanInput(id, { mode: "outline" }, "zh-CN");
		expect(refused?.ok).toBe(false);
		expect(refused && !refused.ok && refused.message).toContain(
			`\`${root.address}\` 下面直接有 ${maxChildren + 3} 块：按阶段或主题分组，一层不超过 ${maxChildren} 块`,
		);

		// Grouped into two phases: accepted, and the submission is the plan as of now.
		const ids = written.results.slice(1).map((r) => r.blockId);
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
	});

	test("more problems than listed are counted", async () => {
		const { id, owner, root } = await planning();
		await agentWrite(id, owner, [
			backgroundOp(root.blockId),
			...Array.from(
				{ length: 11 },
				(): OutlineOp => ({
					op: "insert",
					parent: { id: root.blockId },
					content: "x".repeat(pointChars + 1),
				}),
			),
		]);
		const refused = await resolveOutlineExitPlanInput(id, { mode: "outline" }, "en");
		const message = refused && !refused.ok ? refused.message : "";
		expect(message.match(new RegExp(`has ${pointChars + 1} characters`, "g"))?.length).toBe(8);
		expect(message).toContain("- 3 more like these.");
	});
});

describe("a plan in the format", () => {
	test("title, background, points, long details, notable points: submits", async () => {
		const { id, owner, root } = await planning();
		await agentWrite(id, owner, [
			backgroundOp(root.blockId),
			{
				op: "insert",
				tempId: "p1",
				parent: { id: root.blockId },
				content: "阶段 1：去掉固定时间拒绝",
				task: { status: "todo" },
			},
			{
				op: "insert",
				tempId: "s1",
				parent: { tempId: "p1" },
				content: "清除模型历史链路的固定时间拒绝",
				task: { status: "todo" },
			},
			// A detail may be longer than a point: it is folded behind one line.
			{ op: "insert", parent: { tempId: "s1" }, content: "细".repeat(detailChars) },
			{
				op: "insert",
				tempId: "n",
				parent: { id: root.blockId },
				content: NOTABLE_POINTS_TITLE["zh-CN"],
			},
			{ op: "insert", parent: { tempId: "n" }, content: "错误码保留一个版本" },
		]);
		const resolved = await resolveOutlineExitPlanInput(id, { mode: "outline" }, "zh-CN");
		expect(resolved?.ok).toBe(true);
	});
});

describe("following a refusal with the agent's own tools", () => {
	test("a background inserted with OutlineEdit's before, the notable points moved last: it submits", async () => {
		const { id, owner, root, space } = await planning();
		const c = toolCtx(id, owner);
		const added = await outlineEditTool.execute(
			{
				edits: [
					{
						add: root.address,
						markdown: [
							`- ${NOTABLE_POINTS_TITLE["zh-CN"]}`,
							"  - 错误码保留一个版本",
							"- [ ] 阶段 1：去掉固定时间拒绝",
							"  - [ ] 清除模型历史链路的固定时间拒绝",
						].join("\n"),
					},
				],
			},
			c,
		);
		expect(added.isError).toBeFalsy();
		const refused = await resolveOutlineExitPlanInput(id, { mode: "outline" }, "zh-CN");
		const message = refused && !refused.ok ? refused.message : "";
		const first = (await findChildren(root.blockId))[0];
		const firstAddress = `${space.key}/${first?.sid}`;
		// It names the block to insert before, in the words OutlineEdit takes.
		expect(message).toContain(`before: "${firstAddress}"`);
		expect(message).toContain("不是根下最后一块：用 OutlineEdit 把它 move 到计划根");
		// The agent does as it says: insert before that block, move the section to the root.
		const fixed = await outlineEditTool.execute(
			{
				edits: [
					{ add: root.address, markdown: `- ${BACKGROUND}`, before: firstAddress },
					{ move: firstAddress, to: root.address },
				],
			},
			c,
		);
		expect(fixed.isError).toBeFalsy();
		const children = await findChildren(root.blockId);
		expect(children.map((b) => b.content)).toEqual([
			BACKGROUND,
			"阶段 1：去掉固定时间拒绝",
			NOTABLE_POINTS_TITLE["zh-CN"],
		]);
		const resolved = await resolveOutlineExitPlanInput(id, { mode: "outline" }, "zh-CN");
		expect(resolved?.ok).toBe(true);
	});

	test("OutlineEdit refuses after and before together, and a before that is not a child of the parent", async () => {
		const { id, owner, root } = await planning();
		const c = toolCtx(id, owner);
		await agentWrite(id, owner, [
			{ op: "insert", sid: "PhaseOne", parent: { id: root.blockId }, content: "阶段 1" },
		]);
		const space = await ensureSessionSpace(id);
		const both = await outlineEditTool.execute(
			{
				edits: [
					{
						add: root.address,
						markdown: "- x",
						after: `${space.key}/PhaseOne`,
						before: `${space.key}/PhaseOne`,
					},
				],
			},
			c,
		);
		expect(both.isError).toBe(true);
		expect(String(both.output)).toContain("give after or before, not both");
		const stranger = await outlineEditTool.execute(
			{ edits: [{ add: `${space.key}/PhaseOne`, markdown: "- x", before: root.address }] },
			c,
		);
		expect(stranger.isError).toBe(true);
	});
});

describe("questions put to a person: the check and the display agree", () => {
	test("an Ask on the root before the background is skipped by both", async () => {
		const { id, owner, root, space } = await planning();
		const asked = await askTool.execute(
			{
				under: root.address,
				// An option holding a `›` (review round 2): the question's note still reads as one.
				questions: [
					{ question: "要不要按会话限频？", options: ["keep › v1", "不要"], recommend: 2 },
				],
			},
			toolCtx(id, owner),
		);
		expect(asked.isError).toBeFalsy();
		// A background longer than a point: were the question taken for the background, this
		// paragraph would be checked as a point and refused.
		const background = `${BACKGROUND}${"读历史的固定超时在慢磁盘上会让会话莫名失败。".repeat(3)}`;
		await agentWrite(id, owner, [
			{ op: "insert", sid: "BackGrnd", parent: { id: root.blockId }, content: background },
			{ op: "insert", parent: { id: root.blockId }, content: "阶段 1", task: { status: "todo" } },
		]);
		const children = await findChildren(root.blockId);
		expect(children[0]?.askJson).toBeTruthy();
		const resolved = await resolveOutlineExitPlanInput(id, { mode: "outline" }, "zh-CN");
		expect(resolved?.ok).toBe(true);
		const tree = parsePlanTree(String(resolved?.input.plan));
		expect(tree?.root.children.map((c) => [c.role, !!c.question])).toEqual([
			["point", true],
			["background", false],
			["point", false],
		]);
		expect(space.key).toBeTruthy();
	});
});

describe("a plan has big points; the notable points have items", () => {
	test("a background alone, and an empty notable section, are refused", async () => {
		const { id, owner, root, space } = await planning();
		await agentWrite(id, owner, [
			backgroundOp(root.blockId),
			{
				op: "insert",
				sid: "Notable1",
				parent: { id: root.blockId },
				content: NOTABLE_POINTS_TITLE["zh-CN"],
			},
		]);
		const refused = await resolveOutlineExitPlanInput(id, { mode: "outline" }, "zh-CN");
		const message = refused && !refused.ok ? refused.message : "";
		expect(message).toContain(`\`${root.address}\`（计划根）下面除了背景还没有大点`);
		expect(message).toContain(
			`\`${space.key}/Notable1\`（「${NOTABLE_POINTS_TITLE["zh-CN"]}」）下面还没有条目`,
		);
	});
});

describe("the permission itself refuses (handlePermission)", () => {
	test("nothing waits for a person and nothing is written", async () => {
		const { id, owner, root, space } = await planning();
		await writeWallOfText(id, owner, root.blockId);
		const before = await snapshot(space.id, root.blockId);
		const toolUseId = `toolu_${generateId()}`;
		const msg = await narratorService.persistAssistantMessage(id, {
			uuid: randomUUID(),
			session_id: randomUUID(),
			parent_tool_use_id: null,
			message: {
				content: [
					{ type: "tool_use", id: toolUseId, name: "ExitPlanMode", input: { mode: "outline" } },
				],
			},
		});
		const row = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.messageId, msg.id),
				eq(narratorToolCalls.toolUseId, toolUseId),
			),
			columns: { id: true },
		});
		expect(row).toBeDefined();
		const cwd = process.cwd();
		const pendingBefore = pendingPermissions.size;
		const result = await handlePermission(
			id,
			new AbortController().signal,
			"ExitPlanMode",
			{ mode: "outline" },
			toolUseId,
			cwd,
			"zh-CN",
			undefined,
			{
				executionBackend: localBackend,
				executionTarget: {
					deviceId: localBackend.deviceId,
					backendKind: localBackend.kind,
					cwd,
					pathFlavor: localBackend.pathFlavor ?? localBackend.paths.flavor,
					runtimeGeneration: localBackend.runtimeGeneration ?? 0,
					selectionSource: "local_default",
				},
			},
		);
		expect(pendingPermissions.size).toBe(pendingBefore);
		expect(result.behavior).toBe("deny");
		expect(result.behavior === "deny" ? result.message : "").toContain(
			`计划 \`${root.address}\` 还不符合计划格式，这次没有提交给用户`,
		);
		expect(await snapshot(space.id, root.blockId)).toEqual(before);
	});
});

describe("what is not refused", () => {
	test("a call restored from what was persisted is not held to the format", async () => {
		const { id, owner, root } = await planning();
		// A plan submitted before the rule existed, waiting for a person since.
		await agentWrite(id, owner, [
			{ op: "insert", parent: { id: root.blockId }, content: "说".repeat(backgroundChars + 10) },
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
			backgroundOp(root.blockId),
			...Array.from(
				{ length: maxChildren - 1 },
				(_, i): OutlineOp => ({
					op: "insert",
					parent: { id: root.blockId },
					content: `Step ${i}`,
					task: { status: "todo" },
				}),
			),
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
		]);
		const resolved = await resolveOutlineExitPlanInput(id, { mode: "outline" }, "en");
		expect(resolved?.ok).toBe(true);
	});

	test("the root EnterPlanMode makes from a long plan_name is a title the format accepts", async () => {
		const { id, owner, root } = await planning(`${"很长的计划名".repeat(30)}`);
		expect(Array.from(root.title).length).toBe(rootChars);
		await agentWrite(id, owner, [
			backgroundOp(root.blockId),
			{ op: "insert", parent: { id: root.blockId }, content: "阶段 1", task: { status: "todo" } },
		]);
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

	test("the display's copy of the rule (shared) recognizes the same notes", () => {
		for (const locale of ["en", "zh-CN"] as const)
			for (const version of [1, 12]) {
				expect(isPlanNoteContent(getOutlinePlanReturnedNote(locale, version, "x"))).toBe(true);
				expect(isPlanNoteContent(getOutlinePlanReviewTitle(locale, version))).toBe(true);
			}
		expect(isPlanNoteContent("Returned the parcel")).toBe(false);
		expect(isPlanNoteContent("阶段 1：退回意见（第 1 版）")).toBe(false);
	});
});

describe("the prompts state the format with the check's numbers", () => {
	test("the plan-mode system prompt, in both languages, with an example; constant text", () => {
		const zh = getOutlinePlanModeSystemReminder("zh-CN", { address: "k/AbCdEfGh" }, false);
		for (const part of [
			`计划根：一行短标题（不超过 ${rootChars} 字）`,
			`根下第一块：背景。一段话（不超过 ${backgroundChars} 字），不是任务，下面不挂子块`,
			"用 OutlineEdit add 的 before 插到最前面",
			"审批人同时跟着很多任务，对这个项目只是大概了解",
			`大点、小点各只写一个要点（不超过 ${pointChars} 字）`,
			`每条一个子块（不超过 ${detailChars} 字）`,
			`根下最后一块：「${NOTABLE_POINTS_TITLE["zh-CN"]}」`,
			`     - ${NOTABLE_POINTS_TITLE["zh-CN"]}\n`,
			"不符合格式的计划，ExitPlanMode 会拒收",
		])
			expect([part, zh.includes(part)]).toEqual([part, true]);
		const en = getOutlinePlanModeSystemReminder("en", { address: "k/AbCdEfGh" }, false);
		for (const part of [
			`a short one-line title (at most ${rootChars} characters)`,
			`The root's first block: the background. One paragraph (at most ${backgroundChars} characters), not a task, with nothing under it`,
			"OutlineEdit add with before puts it first",
			"The approver tracks many tasks at once and knows this project only roughly",
			`A big or small point is one idea (at most ${pointChars} characters)`,
			`one child block each (at most ${detailChars} characters)`,
			`The root's last block: "${NOTABLE_POINTS_TITLE.en}"`,
			`     - ${NOTABLE_POINTS_TITLE.en}\n`,
		])
			expect([part, en.includes(part)]).toEqual([part, true]);
		// The v1 sections are gone; the text does not change between turns.
		expect(zh).not.toContain("边界与取舍");
		expect(en).not.toContain("Boundaries and trade-offs");
		expect(getOutlinePlanModeSystemReminder("zh-CN", { address: "k/AbCdEfGh" }, false)).toBe(zh);
	});

	test("the tools' text and EnterPlanMode's answer", () => {
		const exit = exitPlanModeTool.description;
		expect(exit).toContain(
			`The root's first block is the background: one concise paragraph (at most ${backgroundChars} characters`,
		);
		expect(exit).toContain(
			`"${NOTABLE_POINTS_TITLE.en}" (「${NOTABLE_POINTS_TITLE["zh-CN"]}」 in Chinese, not a task)`,
		);
		expect(exit).toContain(`at most ${pointChars} characters); a detail at most ${detailChars}`);
		expect(enterPlanModeTool.description).toContain(
			"the background paragraph goes in the first block under it",
		);
		const root = { address: "k/AbCdEfGh", title: "导入器", version: 1 };
		expect(getOutlinePlanEnterOutput("zh-CN", root, "created")).toContain(
			"第一块是背景（一段话；根下已有块时用 add 的 before 插到最前面）",
		);
		expect(getOutlinePlanEnterOutput("en", root, "created")).toContain(
			"the background paragraph first",
		);
		const review = getOutlinePlanReviewPrompt("zh-CN", {
			requestId: "r1",
			address: "k/AbCdEfGh",
			version: 1,
			summary: null,
			plan: "- [ ] 导入器",
			limits: { comments: 5, chars: 300 },
		});
		expect(review).toContain(`风险和不可逆的步骤是否写进了「${NOTABLE_POINTS_TITLE["zh-CN"]}」`);
	});
});
