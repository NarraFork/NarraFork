/**
 * What an Agent call sent with an outline task carries for its card (outline P2 PR 9b, review
 * F2), end to end through the real Agent tool, subagent runner, run service and report
 * attachment: the call's result metadata names the task (address, title, claim generation) and,
 * once a foreground result is delivered, the head of the note it was delivered with (current or
 * late, and why). The card reads this before the text, which projections cut (the live frame to
 * 2000 characters) and the run service extends after the note (its file-change block).
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 */
import { describe, expect, test } from "bun:test";
import { OUTLINE_DELEGATION_METADATA_KEY } from "@shared/outline-report-note";
import {
	agent,
	children,
	expireLease,
	gate,
	installDelegationHarness,
	model,
	REPORT,
	rootSession,
	runEnded,
	seedTask,
	until,
	user,
	write,
} from "./outline-delegation.fixture";

installDelegationHarness();

const metaOf = (result: { metadata?: Record<string, unknown> }) =>
	result.metadata?.[OUTLINE_DELEGATION_METADATA_KEY];

describe("the Agent call's metadata", () => {
	test("a foreground result: the task and the note's head, current", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { task } = await seedTask(root, owner);
		model.script = [{ text: `${"x".repeat(3000)}\n${REPORT}` }];
		const { result, childId } = await agent(root, owner, { task: task.address });
		if (!childId) throw new Error("no subagent");
		await until(() => runEnded(childId), "the subagent's run to end");
		expect(result.output).toContain('status="current"');
		expect(metaOf(result)).toEqual({
			task: task.address,
			title: "Fix the refresh race",
			generation: 1,
			status: "current",
		});
	});

	test("a foreground result taken over meanwhile: late, and why", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const other = await rootSession(owner, { title: "Other session" });
		const { space, task } = await seedTask(root, owner);
		const open = gate();
		model.script = [{ text: REPORT, gate: open.promise }];
		const running = agent(root, owner, { task: task.address });
		await until(async () => (await children(root)).length === 1, "the subagent");
		const [childId] = await children(root);
		await until(() => model.passes.includes(childId as string), "the subagent's pass");
		await expireLease(task.blockId);
		await write(space.id, other, owner, [
			{ op: "setTask", block: { id: task.blockId }, task: { status: "doing" } },
		]);
		open.resolve();
		const { result } = await running;
		expect(metaOf(result)).toEqual({
			task: task.address,
			title: "Fix the refresh race",
			generation: 1,
			status: "late",
			reason: "taken_over",
		});
	});

	test("a background launch: the task, no result yet", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { task } = await seedTask(root, owner);
		model.script = [{ text: REPORT }];
		const { result, childId } = await agent(root, owner, {
			task: task.address,
			run_in_background: true,
		});
		if (!childId) throw new Error("no subagent");
		await until(() => runEnded(childId), "the subagent's run to end");
		expect(metaOf(result)).toEqual({
			task: task.address,
			title: "Fix the refresh race",
			generation: 1,
		});
	});

	test("an agent sent without a task carries none", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		model.script = [{ text: "Looked around." }];
		const { result, childId } = await agent(root, owner, { prompt: "Look around" });
		if (childId) await until(() => runEnded(childId), "the subagent's run to end");
		expect(result.metadata).toBeUndefined();
	});
});
