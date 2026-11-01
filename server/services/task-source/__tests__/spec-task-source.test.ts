/**
 * The spec task source: the shared contract, plus pins that the reads and copy it wraps
 * are exactly what the readers used before they went through the interface.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { narrators, specFileRevisions } from "../../../db/schema";
import { eventBus, type NarraForkEvent } from "../../../lib/event-bus";
import { generateId } from "../../../lib/id";
import { getBlockedTaskActionInstruction } from "../../../lib/prompt-i18n";
import {
	buildBehaviorFenceBody,
	buildSpecCompactContext,
	buildSpecTaskDigestBody,
} from "../../spec-reminder";
import { specVfsService, writeSpecFile } from "../../spec-vfs-service";
import { buildSpecContinuationPrompt } from "../../turn-continuation-decisions";
import * as taskSourceIndex from "../index";
import { resolveTaskBackend, taskSourceForNarrator } from "../index";
import { describeTaskSourceContract, type SeedTask } from "./task-source-contract.harness";

async function createNarrator(): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
		model: "default",
		permissionMode: "default",
		status: "idle",
		createdAt: now,
		updatedAt: now,
	});
	return id;
}

async function seedTasks(narratorId: string, tasks: readonly SeedTask[]): Promise<void> {
	await writeSpecFile(
		narratorId,
		"spec://tasks.json",
		JSON.stringify({
			tasks: tasks.map((task) => ({
				text: task.text,
				status: task.status,
				...(task.protected ? { protected: true } : {}),
			})),
		}),
		{ allowProtectedTaskMutation: true },
	);
}

/**
 * Unreadable for one narrator: tasks.json comes back as broken JSON (so parsing fails, as
 * with a corrupted row) and the fence read rejects. Other narrators read normally.
 */
async function makeUnreadable(narratorId: string): Promise<() => void> {
	const realReadTasks = specVfsService.readTasksFileForNarrator;
	const realReadFile = specVfsService.readSpecFile;
	const readTasks = spyOn(specVfsService, "readTasksFileForNarrator").mockImplementation(
		async (id) =>
			id === narratorId
				? {
						path: "tasks.json",
						uri: "spec://tasks.json",
						content: "{ not json",
						readonly: false,
						uiEditable: true,
						builtin: true,
						revisionId: "broken",
						namespaceId: "broken",
					}
				: realReadTasks(id),
	);
	const readFile = spyOn(specVfsService, "readSpecFile").mockImplementation(async (id, uri) => {
		if (id === narratorId) throw new Error("spec file unreadable");
		return realReadFile(id, uri);
	});
	return () => {
		readTasks.mockRestore();
		readFile.mockRestore();
	};
}

describeTaskSourceContract({
	backend: "spec",
	createNarrator,
	seedTasks,
	seedBehaviorFence: async (narratorId, text) => {
		await writeSpecFile(narratorId, "spec://behavior_fence", text, { actor: "user" });
	},
	makeUnreadable,
});

describe("task source factory", () => {
	test("every narrator resolves to spec, even one with no narrator row", async () => {
		const unknownNarratorId = `missing-${generateId()}`;
		expect(await resolveTaskBackend(unknownNarratorId)).toBe("spec");
		const source = await taskSourceForNarrator(unknownNarratorId);
		expect(source.backend).toBe("spec");
		expect(source.narratorId).toBe(unknownNarratorId);
	});

	test("a backend that cannot be resolved falls back to spec instead of rejecting", async () => {
		const resolve = spyOn(taskSourceIndex, "resolveTaskBackend").mockRejectedValue(
			new Error("backend lookup failed"),
		);
		try {
			const source = await taskSourceForNarrator("any-narrator");
			expect(source.backend).toBe("spec");
			expect(source.narratorId).toBe("any-narrator");
			expect(resolve).toHaveBeenCalledTimes(1);
		} finally {
			resolve.mockRestore();
		}
	});
});

describe("spec task source keeps the readers' behavior", () => {
	const restores: Array<() => void> = [];
	afterEach(() => {
		for (const restore of restores.splice(0)) restore();
	});

	test("injection bodies are the spec-reminder bodies", async () => {
		const narratorId = await createNarrator();
		const source = await taskSourceForNarrator(narratorId);
		// Never created any task: the digest nudges, compact context is absent, fence empty.
		expect(await source.taskDigest()).toEqual(await buildSpecTaskDigestBody(narratorId));
		expect(await source.taskDigest()).toEqual({ kind: "tasks", variant: "emptyNever" });
		expect(await source.behaviorFence()).toBeNull();

		await seedTasks(narratorId, [
			{ text: "Done already", status: "done" },
			{ text: "Write the parser", status: "doing", protected: true },
			{ text: "Waiting on access", status: "blocked" },
			{ text: "Write the printer", status: "todo" },
		]);
		await writeSpecFile(narratorId, "spec://behavior_fence", "Never force-push.", {
			actor: "user",
		});
		expect(await source.taskDigest()).toEqual(await buildSpecTaskDigestBody(narratorId));
		expect(await source.behaviorFence()).toEqual(await buildBehaviorFenceBody(narratorId));
		for (const locale of ["en", "zh-CN"] as const) {
			expect(await source.compactContext(locale)).toBe(
				await buildSpecCompactContext(narratorId, locale),
			);
		}
		// The compact list still carries finished tasks and the protected marker.
		expect(await source.compactContext("en")).toBe(
			"Current Dynamic Spec tasks:\n- [done] Done already\n- [doing] Write the parser [protected]\n- [blocked] Waiting on access\n- [todo] Write the printer",
		);
	});

	test("bounded continuation copy is buildSpecContinuationPrompt", async () => {
		const source = await taskSourceForNarrator(await createNarrator());
		for (const status of ["doing", "blocked"] as const) {
			for (const locale of ["en", "zh-CN"] as const) {
				for (const canAskUserQuestion of [true, false]) {
					const input = {
						cause: "maxTurns" as const,
						task: { text: "Ship it", protected: true, status },
						passes: 3,
						maxPasses: 6,
						canAskUserQuestion,
						locale,
					};
					expect(source.continuationPrompt({ form: "bounded", ...input })).toBe(
						buildSpecContinuationPrompt(input),
					);
				}
			}
		}
		// The remaining-pass line, worded exactly (9 − 2 = 7 left).
		const remaining = (locale: "en" | "zh-CN") =>
			source.continuationPrompt({
				form: "bounded",
				task: { text: "Ship it", protected: false, status: "doing" },
				cause: "spec",
				passes: 2,
				maxPasses: 9,
				canAskUserQuestion: true,
				locale,
			});
		expect(remaining("en")).toEndWith(
			"\n\nSelf-continuations left: 7. When they run out this run ends, so do not save your summary for a later pass.",
		);
		expect(remaining("zh-CN")).toEndWith(
			"\n\n剩余自动续跑次数：7。用完后本次运行会结束，所以不要把总结留到最后一趟。",
		);
	});

	test("open continuation copy is unchanged", async () => {
		const source = await taskSourceForNarrator(await createNarrator());
		const doingEn = source.continuationPrompt({
			form: "open",
			task: { text: "Ship it", protected: true, status: "doing" },
			locale: "en",
		});
		expect(doingEn).toBe(
			"Dynamic Spec auto-continuation (system message, not the user speaking).\n\nThe system emits this whenever spec://tasks.json still has a `doing` entry. It only means the entry is not marked finished — not that the system judged your work incomplete, and its content may be out of date.\n\nCurrent task (this one only — not the full task list; your other tasks are still in spec://tasks.json): Ship it [protected]\n\nDecide what is actually true of this task, then take exactly one of these paths:\n- Already done: mark it done in spec://tasks.json. That is a valid result for this turn; do not rework a change that was already correct.\n- Unfinished and you can advance it: keep working.\n- Needs the user's information, permission, decision, or an action only they can perform: finish every unblocked part, then ask one precise question with AskUserQuestion and end the turn.\n- No longer matches reality: rewrite or remove the entry while preserving the user's original intent, and say why.\n\nWhen you change spec://tasks.json, read it first and edit in place; do not rewrite the file from this message.\n- Protected: mark it done only with concrete completion evidence; that change runs taskReflection.",
		);
		const doingZh = source.continuationPrompt({
			form: "open",
			task: { text: "发布", protected: false, status: "doing" },
			locale: "zh-CN",
		});
		expect(doingZh).toBe(
			"Dynamic Spec 自动续跑（系统消息，不是用户发言）。\n\n系统在 spec://tasks.json 仍有 doing 条目时自动发出这条消息。它只说明该条目尚未标记完成 —— 不代表系统判断你没做完，条目内容也可能已经过时。\n\n当前任务（仅这一条，不是完整任务列表；其余任务仍在 spec://tasks.json 中）：发布\n\n请先判断该任务的真实状态，再按实际情况选择其一：\n- 已经完成：在 spec://tasks.json 标记 done。这就是本回合的有效结果，不要因为这条提醒去返工已经正确的改动。\n- 未完成且能自主推进：继续执行。\n- 需要用户提供信息、权限、决策，或需要用户亲自操作：先做完不受阻的部分，再用 AskUserQuestion 提出一个精确问题并结束回合。\n- 已不符合当前实际：在保留用户原意图的前提下改写或删除该条目，并说明原因。\n\n改动 spec://tasks.json 时先读取再就地修改，不要按本消息重写整个文件。",
		);
		const blockedEn = source.continuationPrompt({
			form: "open",
			task: { text: "Needs a key", protected: false, status: "blocked" },
			locale: "en",
		});
		expect(blockedEn).toBe(
			`Dynamic Spec blocked-task continuation (system message, not the user speaking).\n\nThe system emits this whenever spec://tasks.json has a \`blocked\` entry.\n\nBlocked task (this one only — not the full task list; your other tasks are still in spec://tasks.json): Needs a key\n\n${getBlockedTaskActionInstruction("en")}\n\nWhen the blocker needs the user, ask with AskUserQuestion and end the turn; do not work around it by rewriting tasks.json or re-running the same investigation. If the entry no longer matches reality, rewrite or remove it while preserving the user's original intent, and say why. When you change tasks.json, read it first and edit in place; do not rewrite the file from this message.`,
		);
		const blockedZh = source.continuationPrompt({
			form: "open",
			task: { text: "缺密钥", protected: true, status: "blocked" },
			locale: "zh-CN",
		});
		expect(blockedZh).toBe(
			`Dynamic Spec blocked 任务续跑（系统消息，不是用户发言）。\n\n系统在 spec://tasks.json 有 blocked 条目时自动发出这条消息。\n\nblocked 任务（仅这一条，不是完整任务列表；其余任务仍在 spec://tasks.json 中）：缺密钥 [protected]\n\n${getBlockedTaskActionInstruction("zh-CN")}\n\n需要用户介入时，用 AskUserQuestion 提问并结束回合；不要靠反复改写 tasks.json 或重跑同样的调查来绕开。如果该条目已不符合当前实际，可在保留用户原意图的前提下改写或删除它，并说明原因。改动 tasks.json 时先读取再就地修改，不要按本消息重写整个文件。`,
		);
	});

	test("interrupt note copy and body are unchanged", async () => {
		const source = await taskSourceForNarrator(await createNarrator());
		const note = source.interruptGuardNote(
			[
				{ text: "Write the parser", status: "doing", protected: true },
				{ text: "Write the printer", status: "todo", protected: false },
			],
			"en",
		);
		expect(note).toEqual({
			content:
				"The run was just interrupted by the user, which usually means the direction changed. spec://tasks.json still has these open tasks:\n\n- [doing] Write the parser [protected]\n- [todo] Write the printer\n\nThey may be stale or no longer match the user's latest intent. When the user's next message arrives, treat it as the source of truth; update or remove outdated tasks first if the plan changed (protected task changes trigger taskReflection), then continue. Do not resume an old task over the user's new instruction.",
			body: {
				kind: "tasks",
				variant: "current",
				tasks: [
					{ role: "doing", text: "Write the parser", protected: true },
					{ role: "todo", text: "Write the printer" },
				],
			},
		});
		expect(
			source.interruptGuardNote([{ text: "缺密钥", status: "blocked", protected: false }], "zh-CN")
				.content,
		).toBe(
			"刚才的运行被用户中断，这通常意味着方向有变化。当前 spec://tasks.json 中仍有以下开放任务：\n\n- [blocked] 缺密钥\n\n这些任务可能已经过期或与用户最新意图不一致。回复用户的下一条消息时，以用户消息为准；如需调整计划，先更新/删除过期任务（protected 任务变更会触发 taskReflection），再继续执行。不要无视用户新指令而直接恢复旧任务。",
		);
	});

	test("open tasks carry the tasks.json revision as their revision key", async () => {
		const narratorId = await createNarrator();
		await seedTasks(narratorId, [{ text: "Alpha", status: "todo" }]);
		const file = await specVfsService.readTasksFileForNarrator(narratorId);
		const source = await taskSourceForNarrator(narratorId);
		expect((await source.openTasks()).revision).toBe(file.revisionId ?? null);
	});

	test("promotion writes a system revision, tab-indented, and emits spec:changed", async () => {
		const narratorId = await createNarrator();
		await seedTasks(narratorId, [
			{ text: "First step", status: "todo", protected: true },
			{ text: "Second step", status: "todo" },
		]);
		const events: NarraForkEvent[] = [];
		const listener = (event: NarraForkEvent) => {
			if (event.type === "spec:changed" && event.narratorId === narratorId) events.push(event);
		};
		eventBus.onAny(listener);
		restores.push(() => eventBus.offAny(listener));

		const source = await taskSourceForNarrator(narratorId);
		await source.prepareContinuation({ promoteTodo: true });

		const file = await specVfsService.readTasksFileForNarrator(narratorId);
		expect(file.content).toBe(
			`${JSON.stringify(
				{
					tasks: [
						{ text: "First step", status: "doing", protected: true },
						{ text: "Second step", status: "todo" },
					],
				},
				null,
				"\t",
			)}\n`,
		);
		const revision = await db.query.specFileRevisions.findFirst({
			where: eq(specFileRevisions.id, file.revisionId ?? ""),
			columns: { createdBy: true },
		});
		expect(revision?.createdBy).toBe("system");
		expect(events).toEqual([
			{
				type: "spec:changed",
				narratorId,
				path: "tasks.json",
				uri: "spec://tasks.json",
				revisionId: file.revisionId ?? null,
				updatedBy: "agent",
			},
		]);
	});
});
