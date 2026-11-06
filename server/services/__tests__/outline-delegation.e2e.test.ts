/**
 * Delegation as a task (outline P2 PR 9a), end to end: `Agent({ task })` through the real tool,
 * subagent runner, run service, lease keeper, write path and report attachment. Only the model
 * pass is scripted (each one may wait on a gate, so a test can change the outline while the
 * subagent works).
 *
 * The acceptance (plan §7 row 9): a subagent whose task is taken over by someone else meanwhile
 * hands back a result recorded as late; the report is attached all the same, the task stays with
 * whoever took it, and the delegating session cannot tick it done on its strength.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 */
import { describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { db } from "../../db";
import { narrators, narratorToolCalls, outlineCommits } from "../../db/schema";
import { readRuntimeRegistrationColumn } from "../../lib/validators/runtime-registration";
import { getRuntimePublicationService } from "../agent-runtime/publication";
import { startNarratorRun } from "../agent-runtime/run";
import {
	attachDelegatedReport,
	OUTLINE_DELEGATION_ACTOR,
	OUTLINE_REPORT_ACTOR,
	reportBlockId,
} from "../outline/delegation";
import { OutlineTaskClaimedError } from "../outline/errors";
import { outlineStore } from "../outline/store";
import { findContinuationCandidates } from "../outline/tasks";
import { writeOutline } from "../outline/write";
import {
	agent,
	blockOf,
	children,
	claimOf,
	expireLease,
	firstUserMessage,
	gate,
	installDelegationHarness,
	model,
	REPORT,
	registrationRun,
	rootSession,
	runEnded,
	seedTask,
	taskResult,
	treeUnder,
	until,
	user,
	write,
} from "./outline-delegation.fixture";

installDelegationHarness();

describe("Agent({ task }): the acceptance", () => {
	test("a task taken over by another session meanwhile: the result is late, the report attached, the task stays with the taker", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const other = await rootSession(owner, { title: "Other session" });
		const { space, task, step } = await seedTask(root, owner);
		const open = gate();
		model.script = [{ text: REPORT, gate: open.promise }];

		const { result, childId, call } = await agent(root, owner, {
			task: task.address,
			run_in_background: true,
		});
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("<background_task_id>");
		expect(result.output).toContain(
			`Delegated [[${task.address}|Fix the refresh race]] to this agent (claim generation 1)`,
		);
		if (!childId) throw new Error("no subagent");
		await until(() => model.passes.includes(childId), "the subagent's first pass");

		// Its instructions are written from the task tree: no addresses, no outline syntax.
		const brief = await firstUserMessage(childId);
		expect(brief).toContain("# Task: Fix the refresh race");
		expect(brief).toContain("Part of: Auth work");
		expect(brief).toContain("Acceptance: two refreshes never both succeed");
		expect(brief).toContain("- Plan: carry the version, reject older ones");
		expect(brief).toContain("- [ ] Add a regression test");
		expect(brief).not.toContain(task.sid);
		expect(brief).not.toContain("[[");

		// The task is the subagent's, with the next claim generation, and its tree is not the
		// root's to continue meanwhile.
		expect((await blockOf(task.blockId)).taskJson?.status).toBe("doing");
		const delegated = await claimOf(task.blockId);
		expect(delegated).toMatchObject({ holderNarratorId: childId, epoch: 1 });
		const registration = readRuntimeRegistrationColumn(
			(await db.query.narrators.findFirst({ where: eq(narrators.id, childId) }))
				?.runtimeRegistrationJson,
		);
		expect(registration?.delegatedTask).toEqual({
			spaceId: space.id,
			blockId: task.blockId,
			epoch: 1,
			delegatorNarratorId: root,
			toolCallId: call.binding.toolCallId,
			locale: "en",
		});
		const candidates = await findContinuationCandidates({
			narratorId: root,
			sessionSpaceId: space.id,
		});
		expect(candidates.ordered.map((c) => c.blockId)).not.toContain(task.blockId);
		expect(candidates.ordered.map((c) => c.blockId)).not.toContain(step.blockId);

		// The server is down a while: the lease runs out, and another session takes the task.
		await expireLease(task.blockId);
		await write(space.id, other, owner, [
			{ op: "setTask", block: { id: task.blockId }, task: { status: "doing" } },
		]);
		expect(await claimOf(task.blockId)).toMatchObject({ holderNarratorId: other, epoch: 2 });

		open.resolve();
		const output = await taskResult(childId);
		await until(() => runEnded(childId), "the subagent's run to end");

		// The result reaches the root with the note: late, who has the task, do not tick it done.
		expect(output.startsWith(REPORT.trim())).toBe(true);
		expect(output).toContain('status="late"');
		expect(output).toContain('reason="taken_over"');
		expect(output).toContain('the session "Other session"');
		expect(output).toContain("claim generation 2");
		expect(output).toContain("Do not tick the task done on the strength of this report");

		// The report is attached under the task, marked late; nothing in it became a task or link.
		const under = await treeUnder(space.id, task.blockId);
		const container = under.at(-1) as { content: string; children: unknown[] };
		expect(container.content).toMatch(
			/^Late report \(generation 1 · .* UTC; the task changed hands/,
		);
		expect(container.children).toEqual([
			{
				content: "# Findings",
				children: [
					{
						content: "The race is in refresh():",
						children: [
							"it reuses the token it read before the lock \\[[Kx81mPqa/Ab3dEf9Q]]",
							"[ ] a regression test is still missing @agent:w-auth",
						],
					},
					{
						content: "## Evidence",
						children: [
							"| case | result |\n| --- | --- |\n| two refreshes | second one rejected |",
							"```ts\nawait refresh(); // auth.ts:42\n```",
						],
					},
				],
			},
		]);
		const report = await blockOf(reportBlockId(childId, registrationRun(childId)));
		expect(report.taskJson).toBeNull();
		expect(await outlineStore.listOpenLinks([report.id], 10)).toEqual([]);

		// The task did not move: still the other session's, still in progress.
		expect(await claimOf(task.blockId)).toMatchObject({ holderNarratorId: other, epoch: 2 });
		expect((await blockOf(task.blockId)).taskJson?.status).toBe("doing");
		// And the root cannot tick it done.
		await expect(
			write(space.id, root, owner, [
				{ op: "setTask", block: { id: task.blockId }, task: { status: "done" } },
			]),
		).rejects.toBeInstanceOf(OutlineTaskClaimedError);
	});

	test("without a takeover the report is current: the task comes back to the root, which ticks it done", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { space, task } = await seedTask(root, owner);
		model.script = [{ text: "Fixed in auth.ts:42; tests pass." }];
		const { result, childId, call } = await agent(root, owner, { task: task.address });
		if (!childId) throw new Error("no subagent");
		// Foreground: the tool result is the subagent's result with the note.
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("Fixed in auth.ts:42; tests pass.");
		expect(result.output).toContain('status="current"');
		expect(result.output).toContain(`task="${task.address}"`);
		expect(result.output).toContain("The task is still in progress and yours");
		const under = await treeUnder(space.id, task.blockId);
		expect(under.at(-1)).toMatchObject({
			content: expect.stringMatching(/^Report \(generation 1 · \d{4}-\d\d-\d\d \d\d:\d\d UTC\)$/),
			children: ["Fixed in auth.ts:42; tests pass."],
		});

		// The run's end hands the claim back to the root, same generation.
		await until(
			async () => (await claimOf(task.blockId))?.holderNarratorId === root,
			"the claim to come back",
		);
		expect((await claimOf(task.blockId))?.epoch).toBe(1);
		// The system never ticked it: the root does.
		expect((await blockOf(task.blockId)).taskJson?.status).toBe("doing");
		await write(space.id, root, owner, [
			{ op: "setTask", block: { id: task.blockId }, task: { status: "done" } },
		]);

		// The commits PR 11 reads: who delegated, who reported, for which Agent call.
		const commits = await db
			.select()
			.from(outlineCommits)
			.where(eq(outlineCommits.spaceId, space.id))
			.orderBy(asc(outlineCommits.seq));
		const delegation = commits.find((c) => c.actorId === OUTLINE_DELEGATION_ACTOR);
		const report = commits.find((c) => c.actorId === OUTLINE_REPORT_ACTOR);
		expect(delegation).toMatchObject({
			kind: "edit",
			actorKind: "system",
			narratorId: root,
			toolCallId: call.binding.toolCallId,
			messageId: call.messageId,
			responsibleUserId: owner,
		});
		expect(delegation?.summary).toContain(`delegated ${task.address} to subagent ${childId}`);
		expect(report).toMatchObject({
			kind: "edit",
			actorKind: "system",
			narratorId: childId,
			toolCallId: call.binding.toolCallId,
			responsibleUserId: owner,
		});
	});

	test("a person who takes the task over: late, and the root is told not to tick it done", async () => {
		const owner = await user("bob");
		const root = await rootSession(owner);
		const { space, task } = await seedTask(root, owner);
		const open = gate();
		model.script = [{ text: "half done", gate: open.promise }];
		const { childId } = await agent(root, owner, { task: task.address, run_in_background: true });
		if (!childId) throw new Error("no subagent");
		await until(() => model.passes.includes(childId), "the subagent's pass");
		// On the board: back to do, then started by the person themselves.
		const asPerson = (status: "todo" | "doing") =>
			writeOutline({
				spaceId: space.id,
				ops: [{ op: "setTask", block: { id: task.blockId }, task: { status } }],
				actor: { kind: "human", id: owner },
				responsibleUserId: owner,
			});
		await asPerson("todo");
		await asPerson("doing");
		expect(await claimOf(task.blockId)).toMatchObject({ holderUserId: owner, epoch: 2 });
		open.resolve();
		const output = await taskResult(childId);
		expect(output).toContain('status="late"');
		expect(output).toContain("taken over by bob-");
		expect(output).toContain("Do not tick the task done");
		const under = await treeUnder(space.id, task.blockId);
		expect(String((under.at(-1) as { content: string }).content)).toMatch(/^Late report/);
	});
});

describe("Agent({ task }): delegating again, ending and recovery", () => {
	test("delegated again: refused while the first runs; a later Send continuation of the first is late", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { space, task } = await seedTask(root, owner);
		model.script = [{ text: "first pass report" }];
		const first = await agent(root, owner, { task: task.address });
		const sub1 = first.childId as string;
		await until(
			async () => (await claimOf(task.blockId))?.holderNarratorId === root,
			"the claim to come back",
		);
		// Delegated again: the next generation, to a second agent.
		const open = gate();
		model.script = [{ text: "second agent report", gate: open.promise }];
		const second = await agent(root, owner, { task: task.address, run_in_background: true });
		const sub2 = second.childId as string;
		await until(() => model.passes.includes(sub2), "the second agent's pass");
		expect(await claimOf(task.blockId)).toMatchObject({ holderNarratorId: sub2, epoch: 2 });
		// A third delegation while the second runs is refused, and creates nothing.
		const before = await children(root);
		const third = await agent(root, owner, { task: task.address, run_in_background: true });
		expect(third.result.isError).toBe(true);
		expect(third.result.output).toContain("is already handed to");
		expect(third.result.output).toContain("which is still running");
		expect(await children(root)).toEqual(before);

		// The first agent continued (a Send wake): its result is late, a report of its own.
		model.script.unshift({ text: "an afterthought" });
		const handle = await startNarratorRun({ narratorId: sub1, locale: "en", text: "one more" });
		expect(handle.started).toBe(true);
		await handle.terminal;
		await until(() => runEnded(sub1), "the continuation to end");
		const conclusion = (
			await db.query.narratorToolCalls.findFirst({
				where: eq(narratorToolCalls.id, first.call.binding.toolCallId),
			})
		)?.outputJson as string;
		expect(conclusion).toContain("an afterthought");
		expect(conclusion).toContain('status="late"');
		expect(conclusion).toContain('reason="redelegated"');
		expect(conclusion).toContain("delegated again (claim generation 2)");

		open.resolve();
		const output = await taskResult(sub2);
		expect(output).toContain('status="current"');
		const under = (await treeUnder(space.id, task.blockId)) as Array<{ content: string } | string>;
		const reports = under
			.map((node) => (typeof node === "string" ? node : node.content))
			.filter((text) => /Report|report/.test(text));
		expect(reports).toHaveLength(3);
		expect(reports[0]).toMatch(/^Report \(generation 1/);
		expect(reports[1]).toMatch(/^Late report \(generation 1/);
		expect(reports[2]).toMatch(/^Report \(generation 2/);
	});

	test("the task deleted meanwhile: nothing is attached, the root is told", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { space, task } = await seedTask(root, owner);
		const open = gate();
		model.script = [{ text: "work for nothing", gate: open.promise }];
		const { childId } = await agent(root, owner, { task: task.address, run_in_background: true });
		if (!childId) throw new Error("no subagent");
		await until(() => model.passes.includes(childId), "the pass");
		await write(space.id, root, owner, [{ op: "delete", block: { id: task.blockId } }]);
		open.resolve();
		const output = await taskResult(childId);
		expect(output).toContain('status="late"');
		expect(output).toContain('reason="gone"');
		expect(output).toContain("The report was not attached; this result is its full text.");
		expect(
			await outlineStore.getBlock(reportBlockId(childId, registrationRun(childId))),
		).toBeNull();
	});

	test("the task reopened (back to do) meanwhile: late, attached, and to be started again before ticking it", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { space, task } = await seedTask(root, owner);
		const open = gate();
		model.script = [{ text: "done, actually", gate: open.promise }];
		const { childId } = await agent(root, owner, { task: task.address, run_in_background: true });
		if (!childId) throw new Error("no subagent");
		await until(() => model.passes.includes(childId), "the pass");
		await write(space.id, root, owner, [
			{ op: "setTask", block: { id: task.blockId }, task: { status: "todo" } },
		]);
		open.resolve();
		const output = await taskResult(childId);
		expect(output).toContain('reason="reopened"');
		expect(output).toContain("start the task again (set it in progress) before ticking it done");
		const under = await treeUnder(space.id, task.blockId);
		expect((under.at(-1) as { content: string }).content).toMatch(
			/^Late report \(generation 1 · .*; the task went back to do after it was sent\)$/,
		);
		expect((await blockOf(task.blockId)).taskJson?.status).toBe("todo");
	});

	test("the root ticks it done meanwhile: late (ended)", async () => {
		const owner = await user();
		const root = await rootSession(owner, { title: "Root session" });
		const { space, task } = await seedTask(root, owner);
		const open = gate();
		model.script = [{ text: "late news", gate: open.promise }];
		const { childId } = await agent(root, owner, { task: task.address, run_in_background: true });
		if (!childId) throw new Error("no subagent");
		await until(() => model.passes.includes(childId), "the pass");
		await write(space.id, root, owner, [
			{ op: "setTask", block: { id: task.blockId }, task: { status: "done" } },
		]);
		open.resolve();
		const output = await taskResult(childId);
		expect(output).toContain('reason="ended"');
		expect(output).toContain('ticked done by the session "Root session"');
	});

	test("recovery after a restart: the run's result attaches once, and a takeover during the downtime makes it late", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const other = await rootSession(owner, { title: "Night shift" });
		const { space, task } = await seedTask(root, owner);
		model.script = [{ text: "first report" }];
		const first = await agent(root, owner, { task: task.address });
		const sub = first.childId as string;
		await until(
			async () => (await claimOf(task.blockId))?.holderNarratorId === root,
			"the claim to come back",
		);
		// A later run committed its terminal, and the server stopped before delivering it.
		const pub = getRuntimePublicationService();
		const run = (
			await pub.startRun({
				narratorId: sub,
				binding: {
					deliverTo: {
						narratorId: root,
						toolUseId: first.call.toolUseId,
						toolCallId: first.call.binding.toolCallId,
						attempt: 1,
					},
					principal: { userId: owner },
				},
			})
		).publication;
		if (!run) throw new Error("no publication run");
		await pub.commitAgentTerminal({
			run,
			eventKind: "completed",
			text: "report written before the restart",
			summary: "restart fixture",
		});
		await db.update(narrators).set({ status: "working" }).where(eq(narrators.id, sub));
		// While it was down, the root's claim ran out and another session took the task.
		await expireLease(task.blockId);
		await write(space.id, other, owner, [
			{ op: "setTask", block: { id: task.blockId }, task: { status: "doing" } },
		]);
		const recover = async () => {
			const handle = await startNarratorRun({
				narratorId: sub,
				locale: "en",
				text: "",
				recovered: true,
				resumeRunId: run.logicalRunId,
			});
			await handle.completion;
			await until(() => runEnded(sub), "the recovered run to end");
		};
		await recover();
		const reportId = reportBlockId(sub, run.logicalRunId);
		const report = await blockOf(reportId);
		expect(report.content).toMatch(/^Late report \(generation 1/);
		expect((await outlineStore.listChildren(space.id, reportId, 10)).map((b) => b.content)).toEqual(
			["report written before the restart"],
		);
		// Recovered once more (another restart before the delivery settled): nothing twice.
		await db.update(narrators).set({ status: "working" }).where(eq(narrators.id, sub));
		await recover();
		const under = (await outlineStore.listChildren(space.id, task.blockId, 50)).filter((b) =>
			/eport/.test(b.content),
		);
		expect(under.map((b) => b.id).filter((id) => id === reportId)).toHaveLength(1);
		expect(under).toHaveLength(2);
		const conclusion = (
			await db.query.narratorToolCalls.findFirst({
				where: eq(narratorToolCalls.id, first.call.binding.toolCallId),
			})
		)?.outputJson as string;
		expect(conclusion).toContain("report written before the restart");
		expect(conclusion.match(/<outline_report /g)).toHaveLength(1);
		expect(conclusion).toContain('reason="taken_over"');
		expect(conclusion).toContain('"Night shift"');
	});
});

describe("Agent({ task }): attaching is idempotent per run", () => {
	test("a retry finds the report it attached: one block, the same id, the same note", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { task } = await seedTask(root, owner);
		model.script = [{ text: "first" }];
		const { childId, call } = await agent(root, owner, { task: task.address });
		const sub = childId as string;
		const delegated = {
			spaceId: (await blockOf(task.blockId)).spaceId,
			blockId: task.blockId,
			epoch: 1,
			delegatorNarratorId: root,
			toolCallId: call.binding.toolCallId,
			locale: "zh-CN" as const,
		};
		const attach = () =>
			attachDelegatedReport({
				subagentId: sub,
				delegated,
				logicalRunId: "retry-run",
				text: "## 结论\n- 已修复",
				ending: "timed_out",
				principal: owner,
			});
		const once = await attach();
		const twice = await attach();
		expect(twice).toBe(once);
		const id = reportBlockId(sub, "retry-run");
		expect(id).toBe(reportBlockId(sub, "retry-run"));
		expect(id).not.toBe(reportBlockId(sub, "another-run"));
		const block = await blockOf(id);
		expect(block.content).toMatch(/^报告（第 1 代 · .* UTC） · 未完成：超时$/);
		expect(once).toContain(`report="`);
		const under = await outlineStore.listChildren(block.spaceId, task.blockId, 50);
		expect(under.filter((b) => b.id === id)).toHaveLength(1);
	});
});
