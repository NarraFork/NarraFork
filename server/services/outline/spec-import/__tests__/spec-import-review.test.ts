/**
 * The Dynamic Spec import after its review (outline P2 PR 12b): the reviewer's reproductions as
 * tests. A long plugin SOP arrives whole (B1); a fence whose text changed leaves no old rules
 * (S1); what a person added to an earlier attempt's blocks is never deleted (S2); an idle import
 * gives way to its session (S4); nothing is claimed before the move, and a failed attempt holds
 * nothing and writes nothing again (S5); an unknown protector locks; task texts are kept as
 * written; deleted files do not count; the `index.md` page goes with its file; a fence too large
 * to read needs attention once.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../db";
import {
	narratorBufferedMessages,
	specNamespaceFiles,
	specNamespaces,
	specProtectedTasks,
} from "../../../../db/schema";
import { eventBus } from "../../../../lib/event-bus";
import { generateId } from "../../../../lib/id";
import { settings } from "../../../../lib/settings";
import { TEAM_SOP_CLOSE, TEAM_SOP_OPEN, TEAM_SOP_PLUGIN_ID } from "../../../behavior-fence-sop";
import { isNarratorRevertAdmissionBlocked } from "../../../narrator-session-state";
import { specIndexSid } from "../../../plugin-spec-compat";
import { deleteSpecFile, readSpecFile, writeSpecFile } from "../../../spec-vfs-service";
import { invalidateTaskBackend } from "../../../task-source";
import { resetOutlineBehaviorImport } from "../../../task-source/outline-behavior";
import {
	pluginRulesSid,
	resetOutlineFenceSopMove,
} from "../../../task-source/outline-plugin-rules";
import { stopEditTextWorker } from "../../edit-text-runner";
import { keepOutlineTaskLeases } from "../../lease-keeper";
import { OUTLINE_BEHAVIOR_ALIAS } from "../../model";
import { addPersonTask } from "../../person-tasks";
import { outlineStore } from "../../store";
import { writeOutline } from "../../write";
import {
	importSpecSession,
	resetSpecImportRecords,
	SpecImportPaused,
	specImportRecord,
} from "../importer";
import { readSpecFilePointers, readSpecImportSession } from "../read-port";
import { importSpecSessionIdle, specImportStatus, watchSpecImportMessages } from "../triggers";
import {
	backendOf,
	commitCount,
	makeSession,
	pages,
	taskPage,
	writeNote,
	writeTasks,
} from "./fixtures";

beforeEach(() => {
	settings.outline.enabled = true;
	settings.outline.specImport = "manual";
	invalidateTaskBackend();
	resetSpecImportRecords();
	resetOutlineBehaviorImport();
	resetOutlineFenceSopMove();
});
afterAll(() => stopEditTextWorker());

function onCommit(fn: () => void): () => void {
	eventBus.on("outline:committed", fn);
	return () => eventBus.off("outline:committed", fn);
}

const run = (id: string) => importSpecSession(id, { trigger: "manual" });

/** An attempt cut after its `n`th commit (nothing moved). */
async function cutAfter(id: string, n: number): Promise<void> {
	const cut = new AbortController();
	let seen = 0;
	const off = onCommit(() => {
		if (++seen === n) cut.abort(new Error("cut"));
	});
	const outcome = await importSpecSession(id, { trigger: "sweep", signal: cut.signal });
	off();
	expect(outcome.status).toBe("failed");
	expect(await backendOf(id)).toBe("spec");
}

async function spaceOf(id: string) {
	const space = await outlineStore.findSpace({ kind: "session", narratorId: id });
	if (!space) throw new Error("no space");
	return space;
}

async function behaviorPage(id: string): Promise<string[]> {
	const space = await spaceOf(id);
	const [page] = await outlineStore.findAliasOwners(space.id, [OUTLINE_BEHAVIOR_ALIAS]);
	if (!page) return [];
	return (await outlineStore.listChildren(space.id, page.id, 50)).map((b) => b.content);
}

async function personWrites(id: string, owner: string, parentId: string, content: string) {
	await writeOutline({
		spaceId: (await spaceOf(id)).id,
		ops: [{ op: "insert", parent: { id: parentId }, content }],
		actor: { kind: "human", id: owner },
		responsibleUserId: owner,
	});
}

describe("the plugin SOP (B1)", () => {
	test("an SOP of 5,000+ characters arrives whole on the plugin's block; nothing is lost", async () => {
		const { id } = await makeSession();
		const sop = Array.from(
			{ length: 120 },
			(_, i) => `Step ${i}: do the thing number ${i} carefully.`,
		).join("\n");
		expect(sop.length).toBeGreaterThan(5000);
		await writeSpecFile(
			id,
			"spec://behavior_fence",
			`- Own rule\n\n${TEAM_SOP_OPEN}\n${sop}\n${TEAM_SOP_CLOSE}`,
			{ actor: "user", createdBy: "user" },
		);
		expect((await run(id)).status).toBe("imported");
		const space = await spaceOf(id);
		const [rules] = await outlineStore.getBlockMetas(space.id, {
			sids: [pluginRulesSid(TEAM_SOP_PLUGIN_ID)],
		});
		const blocks = rules ? await outlineStore.listChildren(space.id, rules.id, 500) : [];
		const text = blocks.map((b) => b.content).join("\n");
		for (let i = 0; i < 120; i++) expect(text).toContain(`Step ${i}: do the thing number ${i}`);
		// The fence dropped the SOP only because the block holds all of it.
		expect((await readSpecFile(id, "spec://behavior_fence")).content).not.toContain("Step 0");
		expect(await behaviorPage(id)).toContain("Own rule");
	});

	test("an SOP its block cannot hold whole needs attention; the fence keeps it, the session stays", async () => {
		const { id } = await makeSession();
		const sop = Array.from({ length: 260 }, (_, i) => `Paragraph ${i}.`).join("\n\n");
		await writeSpecFile(
			id,
			"spec://behavior_fence",
			`${TEAM_SOP_OPEN}\n${sop}\n${TEAM_SOP_CLOSE}`,
			{ actor: "user", createdBy: "user" },
		);
		const outcome = await run(id);
		expect(outcome).toMatchObject({ status: "failed", attention: true });
		expect(specImportRecord(id)?.reason).toEqual({ code: "sop_too_large" });
		expect(await backendOf(id)).toBe("spec");
		expect((await readSpecFile(id, "spec://behavior_fence")).content).toContain("Paragraph 259.");
		const space = await spaceOf(id);
		const [rules] = await outlineStore.getBlockMetas(space.id, {
			sids: [pluginRulesSid(TEAM_SOP_PLUGIN_ID)],
		});
		expect(rules).toBeUndefined();
	});
});

describe("the fence's own text (S1)", () => {
	test("a fence that changed between attempts: only the new rules are on the behavior page", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "t" }]);
		await writeSpecFile(id, "spec://behavior_fence", "- Never push to main", {
			actor: "user",
			createdBy: "user",
		});
		// Cut right after the behavior page got the text (the last step before the move).
		const cut = new AbortController();
		const off = onCommit(() => {
			void behaviorPage(id).then((b) => {
				if (b.length > 0) cut.abort(new Error("cut"));
			});
		});
		await importSpecSession(id, { trigger: "sweep", signal: cut.signal });
		off();
		expect(await backendOf(id)).toBe("spec");
		expect(await behaviorPage(id)).toEqual(["Never push to main"]);
		await writeSpecFile(id, "spec://behavior_fence", "- Pushing to main is fine now", {
			actor: "user",
			createdBy: "user",
		});
		expect((await run(id)).status).toBe("imported");
		expect(await behaviorPage(id)).toEqual(["Pushing to main is fine now"]);
	});

	test("the fence is written only once the tasks verified: a failed attempt leaves none of it", async () => {
		const { id, owner } = await makeSession();
		await writeTasks(id, [{ text: "the goal", protected: true }], "user");
		await writeSpecFile(id, "spec://behavior_fence", "- A rule", {
			actor: "user",
			createdBy: "user",
		});
		await cutAfter(id, 2);
		const [task] = await taskPage(id);
		// Its person unlocks it: the next attempt does not verify.
		await writeOutline({
			spaceId: (await spaceOf(id)).id,
			ops: [{ op: "setTask", block: { id: task?.id as string }, task: { lock: null } }],
			actor: { kind: "human", id: owner as string },
			responsibleUserId: owner,
		});
		expect(await run(id)).toMatchObject({ status: "failed", attention: true });
		expect(await behaviorPage(id)).toEqual([]);
	});

	test("a fence whose own text is past the parse limit needs attention once, before anything is written", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "t" }]);
		const { db: database } = await import("../../../../db");
		const { specFileRevisions } = await import("../../../../db/schema");
		// Past what a spec write takes today; an old session may hold it.
		const ns = await database.query.specNamespaces.findFirst({
			where: eq(specNamespaces.narratorId, id),
		});
		const revisionId = generateId();
		await database.insert(specFileRevisions).values({
			id: revisionId,
			namespaceId: ns?.id as string,
			path: "behavior_fence",
			content: `- ${"rule ".repeat(60_000)}`,
			contentHash: "too-large",
			createdBy: "user",
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		await database.insert(specNamespaceFiles).values({
			id: generateId(),
			namespaceId: ns?.id as string,
			path: "behavior_fence",
			revisionId,
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		const outcome = await run(id);
		expect(outcome).toMatchObject({ status: "failed", attention: true });
		expect(specImportRecord(id)?.reason?.code).toBe("fence_too_large");
		expect(await commitCount(id)).toBe(0);
	});
});

describe("what a person added to an earlier attempt's blocks (S2)", () => {
	test("a note under a stale task is kept, and the session waits for a person", async () => {
		const { id, owner } = await makeSession();
		await writeTasks(id, [{ text: "keep me" }]);
		await cutAfter(id, 2);
		const [old] = await taskPage(id);
		await personWrites(id, owner as string, old?.id as string, "my own note, typed by a person");
		await writeTasks(id, [{ text: "keep me" }, { text: "another" }]);
		const outcome = await run(id);
		expect(outcome).toMatchObject({ status: "failed", attention: true });
		expect(specImportRecord(id)?.reason).toEqual({ code: "kept_blocks", count: 1 });
		expect(await backendOf(id)).toBe("spec");
		// Nothing of the new revision beside it (review r2 NIT 3): only the kept task is there.
		const tasks = await taskPage(id);
		expect(tasks.map((t) => t.id)).toEqual([old?.id]);
		expect(tasks[0]?.children).toEqual(["my own note, typed by a person"]);
		// The person moves their note out (here: deletes the old task after copying it): the
		// next attempt goes through.
		await writeOutline({
			spaceId: (await spaceOf(id)).id,
			ops: [{ op: "delete", block: { id: old?.id as string } }],
			actor: { kind: "human", id: owner as string },
			responsibleUserId: owner,
		});
		expect((await run(id)).status).toBe("imported");
		expect((await taskPage(id)).map((t) => t.text)).toEqual(["keep me", "another"]);
	});

	test("a stale page a person added to, or edited, is kept; one only the import wrote goes", async () => {
		const { id, owner } = await makeSession();
		await writeNote(id, "plan.md", "step one\n");
		await writeNote(id, "other.md", "untouched\n");
		await writeNote(id, "edited.md", "as imported\n");
		await writeTasks(id, [{ text: "x" }]);
		// The three pages are written first (in path order: edited, other, plan).
		await cutAfter(id, 3);
		const before = await pages(id);
		expect(before.map((p) => p.title).sort()).toEqual(["edited.md", "other.md", "plan.md"]);
		const space = await spaceOf(id);
		const roots = await outlineStore.listChildren(space.id, null, 50);
		const plan = roots.find((p) => p.content === "plan.md");
		const edited = roots.find((p) => p.content === "edited.md");
		await personWrites(id, owner as string, plan?.id as string, "person's addition");
		const [line] = await outlineStore.listChildren(space.id, edited?.id as string, 5);
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "update", block: { id: line?.id as string }, content: "as a person wrote it" }],
			actor: { kind: "human", id: owner as string },
			responsibleUserId: owner,
		});
		await writeNote(id, "plan.md", "step one\nstep two\n");
		await writeNote(id, "other.md", "changed\n");
		await writeNote(id, "edited.md", "changed too\n");
		const commits = await commitCount(id);
		expect(await run(id)).toMatchObject({ status: "failed", attention: true });
		expect(specImportRecord(id)?.reason).toEqual({ code: "kept_blocks", count: 2 });
		// The attempt wrote nothing (review r2 NIT 3): the person's work is kept, no new revision
		// beside it, and the page only the import wrote waits for the next attempt.
		expect(await commitCount(id)).toBe(commits);
		const after = await pages(id);
		const titled = (title: string) => after.filter((p) => p.title === title);
		expect(titled("plan.md").map((p) => p.blocks)).toEqual([["step one", "person's addition"]]);
		expect(titled("edited.md").map((p) => p.blocks)).toEqual([["as a person wrote it"]]);
		expect(titled("other.md").map((p) => p.blocks)).toEqual([["untouched"]]);
		// The person deletes their two pages (after taking what is theirs): the next attempt
		// replaces the rest, once each.
		await writeOutline({
			spaceId: space.id,
			ops: [
				{ op: "delete", block: { id: plan?.id as string } },
				{ op: "delete", block: { id: edited?.id as string } },
			],
			actor: { kind: "human", id: owner as string },
			responsibleUserId: owner,
		});
		expect((await run(id)).status).toBe("imported");
		const done = await pages(id);
		for (const [title, blocks] of [
			["plan.md", ["step one\nstep two"]],
			["other.md", ["changed"]],
			["edited.md", ["changed too"]],
		] as const)
			expect(done.filter((p) => p.title === title).map((p) => p.blocks)).toEqual([[...blocks]]);
	});

	test("the index.md page goes when the file is gone or unreadable, when only the import wrote it", async () => {
		// The built-in file cannot be deleted or emptied through Dynamic Spec today; an old
		// namespace may still hold it deleted, or pointing at a revision that is gone (a fork).
		for (const how of ["deleted", "unreadable"] as const) {
			const { id } = await makeSession();
			await writeNote(id, "index.md", "# Index\n\nhello\n");
			await writeTasks(id, [{ text: "t" }]);
			await cutAfter(id, 1);
			expect((await pages(id)).map((p) => p.sid)).toContain(specIndexSid());
			const ns = await db.query.specNamespaces.findFirst({
				where: eq(specNamespaces.narratorId, id),
			});
			await db
				.update(specNamespaceFiles)
				.set(how === "deleted" ? { deleted: true } : { revisionId: null })
				.where(
					and(
						eq(specNamespaceFiles.namespaceId, ns?.id as string),
						eq(specNamespaceFiles.path, "index.md"),
					),
				);
			expect((await run(id)).status).toBe("imported");
			expect((await pages(id)).map((p) => p.sid)).not.toContain(specIndexSid());
		}
	});
});

describe("a person's edit under an earlier attempt's task (review r2 SF2)", () => {
	test("rewritten and ticked before the move: not hidden by the import, and never deleted as its own", async () => {
		const { id, owner } = await makeSession();
		await writeTasks(id, [{ text: "original text" }]);
		await cutAfter(id, 2);
		const [task] = await taskPage(id);
		const space = await spaceOf(id);
		// A person rewrites the task and checks it done.
		await writeOutline({
			spaceId: space.id,
			ops: [
				{
					op: "update",
					block: { id: task?.id as string },
					content: "PERSON'S REWRITE with details",
				},
				{ op: "setTask", block: { id: task?.id as string }, task: { status: "done" } },
			],
			actor: { kind: "human", id: owner as string },
			responsibleUserId: owner,
		});
		// The next attempt does not set the checkbox back as the import: verification fails.
		let commits = await commitCount(id);
		const second = await run(id);
		expect(second).toMatchObject({ status: "failed", attention: true });
		expect(specImportRecord(id)?.reason?.code).toBe("task_mismatch");
		expect(await commitCount(id)).toBe(commits);
		expect((await taskPage(id)).map((t) => [t.text, t.status])).toEqual([
			["PERSON'S REWRITE with details", "done"],
		]);
		// tasks.json changes: the task is stale now, but a person wrote it, so it is kept and the
		// attempt writes nothing.
		resetSpecImportRecords();
		await writeTasks(id, [{ text: "original text" }, { text: "added" }]);
		commits = await commitCount(id);
		const third = await run(id);
		expect(third).toMatchObject({ status: "failed", attention: true });
		expect(specImportRecord(id)?.reason).toEqual({ code: "kept_blocks", count: 1 });
		expect(await commitCount(id)).toBe(commits);
		expect(await backendOf(id)).toBe("spec");
		expect((await taskPage(id)).map((t) => [t.id, t.text, t.status])).toEqual([
			[task?.id, "PERSON'S REWRITE with details", "done"],
		]);
	});

	test("a person's edit the import later wrote over still keeps the block (its history is read)", async () => {
		const { id, owner } = await makeSession();
		await writeTasks(id, [{ text: "t" }]);
		await cutAfter(id, 2);
		const [task] = await taskPage(id);
		const space = await spaceOf(id);
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "setTask", block: { id: task?.id as string }, task: { status: "done" } }],
			actor: { kind: "human", id: owner as string },
			responsibleUserId: owner,
		});
		// As an older import would have healed it: the current version is the import's.
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "setTask", block: { id: task?.id as string }, task: { status: "todo" } }],
			actor: { kind: "system", id: "spec-import" },
			responsibleUserId: owner,
		});
		await writeTasks(id, [{ text: "t" }, { text: "u" }]);
		expect(await run(id)).toMatchObject({ status: "failed", attention: true });
		expect(specImportRecord(id)?.reason).toEqual({ code: "kept_blocks", count: 1 });
		expect((await taskPage(id)).map((t) => t.id)).toEqual([task?.id]);
	});
});

describe("claims (S5)", () => {
	test("nothing is claimed before the move; the move starts what was in progress", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [
			{ text: "going", status: "doing" },
			{ text: "stuck", status: "blocked" },
		]);
		await cutAfter(id, 2);
		const before = await taskPage(id);
		expect(before.map((t) => [t.status, t.holder])).toEqual([
			["todo", null],
			["todo", null],
		]);
		expect((await run(id)).status).toBe("imported");
		expect((await taskPage(id)).map((t) => [t.status, t.holder])).toEqual([
			["doing", id],
			["doing", id],
		]);
	});

	test("a failed verification holds nothing, and trying again writes nothing again", async () => {
		const { id, owner } = await makeSession();
		await writeTasks(
			id,
			[
				{ text: "going", status: "doing" },
				{ text: "the goal", protected: true },
			],
			"user",
		);
		await cutAfter(id, 2);
		const tasks = await taskPage(id);
		await writeOutline({
			spaceId: (await spaceOf(id)).id,
			ops: [{ op: "setTask", block: { id: tasks[1]?.id as string }, task: { lock: null } }],
			actor: { kind: "human", id: owner as string },
			responsibleUserId: owner,
		});
		expect(await run(id)).toMatchObject({ status: "failed", attention: true });
		const claims = await outlineStore.getTaskClaims(tasks.map((t) => t.id));
		expect(claims.filter((c) => c.holderNarratorId !== null)).toEqual([]);
		expect((await taskPage(id))[0]?.status).toBe("todo");
		const commits = await commitCount(id);
		for (let i = 0; i < 3; i++) expect((await run(id)).status).toBe("failed");
		expect(await commitCount(id)).toBe(commits);
	});

	test("a claim an unfinished move left on a Dynamic Spec session is not kept alive by its runs", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "going", status: "doing" }]);
		await cutAfter(id, 2);
		const [task] = await taskPage(id);
		// The move's claim, as a server that stopped right after it would leave it.
		await writeOutline({
			spaceId: (await spaceOf(id)).id,
			ops: [{ op: "setTask", block: { id: task?.id as string }, task: { status: "doing" } }],
			actor: { kind: "system", id: "spec-import" },
			responsibleUserId: null,
			narratorId: id,
		});
		const [claim] = await outlineStore.getTaskClaims([task?.id as string]);
		expect(claim?.holderNarratorId).toBe(id);
		const later = Date.parse(claim?.expiresAt as string) + 60_000;
		const keeper = keepOutlineTaskLeases(id, { now: () => later, intervalMs: 0 });
		await keeper.touch();
		await keeper.stop();
		const [after] = await outlineStore.getTaskClaims([task?.id as string]);
		expect(after?.expiresAt).toBe(claim?.expiresAt as string);
		// The next import goes on from there: it is the session's work once moved.
		expect((await run(id)).status).toBe("imported");
		expect((await taskPage(id)).map((t) => [t.status, t.holder])).toEqual([["doing", id]]);
	});

	test("an ordinary spec session's renewals do not look at its space each time; an import makes them look again (review r2 NIT 2)", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "going", status: "doing" }]);
		const looks: string[] = [];
		const store = new Proxy(outlineStore, {
			get(target, key, receiver) {
				if (key === "findSpace" || key === "listClaimedTasks") looks.push(key);
				return Reflect.get(target, key, receiver);
			},
		});
		let at = Date.now();
		const renew = async () => {
			at += 10 * 60_000;
			const keeper = keepOutlineTaskLeases(id, { now: () => at, intervalMs: 0, store });
			await keeper.touch();
			await keeper.stop();
		};
		await renew();
		const first = looks.length;
		expect(first).toBeGreaterThan(0);
		await renew();
		await renew();
		expect(looks).toHaveLength(first);
		// An attempt that leaves the move's claim behind: the keeper looks again and renews nothing.
		await cutAfter(id, 2);
		const [task] = await taskPage(id);
		await writeOutline({
			spaceId: (await spaceOf(id)).id,
			ops: [{ op: "setTask", block: { id: task?.id as string }, task: { status: "doing" } }],
			actor: { kind: "system", id: "spec-import" },
			responsibleUserId: null,
			narratorId: id,
		});
		const [claim] = await outlineStore.getTaskClaims([task?.id as string]);
		await renew();
		expect(looks.length).toBeGreaterThan(first);
		const [after] = await outlineStore.getTaskClaims([task?.id as string]);
		expect(after?.expiresAt).toBe(claim?.expiresAt as string);
	});
});

describe("the idle import gives way to its session (S4)", () => {
	async function sessionWithNotes() {
		const made = await makeSession();
		for (const name of ["a", "b", "c", "d"])
			await writeNote(made.id, `${name}.md`, `# ${name}\n\n${"text ".repeat(400)}\n`);
		await writeTasks(made.id, [{ text: "t", status: "doing" }]);
		return made;
	}

	test("past its time budget it stops after a commit, busy, and the next rounds finish it", async () => {
		const { id } = await sessionWithNotes();
		const first = await importSpecSessionIdle(id, "sweep", { budgetMs: 0 });
		expect(first).toEqual({ status: "busy" });
		expect(specImportRecord(id)).toMatchObject({ status: "busy", failures: 0 });
		expect((await specImportStatus(id)).state).toBe("busy");
		expect(await commitCount(id)).toBeGreaterThan(0);
		expect(await backendOf(id)).toBe("spec");
		expect(isNarratorRevertAdmissionBlocked(id)).toBe(false);
		let outcome = first;
		for (let i = 0; i < 20 && outcome.status === "busy"; i++)
			outcome = await importSpecSessionIdle(id, "sweep", { budgetMs: 0 });
		expect(outcome.status).toBe("imported");
		expect((await taskPage(id)).map((t) => [t.status, t.holder])).toEqual([["doing", id]]);
	});

	test("a person's message for the session arriving meanwhile makes it give way at once", async () => {
		const { id, owner } = await sessionWithNotes();
		let sent = false;
		const off = onCommit(() => {
			if (sent) return;
			sent = true;
			db.insert(narratorBufferedMessages)
				.values({
					id: generateId(),
					narratorId: id,
					text: "hello",
					seq: 1,
					createdBy: owner,
					bufferedAt: new Date().toISOString(),
				})
				.run();
		});
		const outcome = await importSpecSessionIdle(id, "sweep", {
			budgetMs: 60_000,
			messageCheckMs: 1,
		});
		off();
		expect(outcome).toEqual({ status: "busy" });
		expect(await backendOf(id)).toBe("spec");
		expect(isNarratorRevertAdmissionBlocked(id)).toBe(false);
		// The message is the session's to take; once it has, the next round finishes.
		await db.delete(narratorBufferedMessages).where(eq(narratorBufferedMessages.narratorId, id));
		expect((await importSpecSessionIdle(id, "sweep")).status).toBe("imported");
	});

	test("a person's message gives way before any commit; a notice only after one (review r2 NIT 1)", async () => {
		for (const urgent of [true, false]) {
			const { id } = await sessionWithNotes();
			const pause = new AbortController();
			pause.abort(new SpecImportPaused("asked before the import began", urgent));
			const outcome = await importSpecSession(id, { trigger: "sweep", pause: pause.signal });
			expect(outcome).toEqual({ status: "busy" });
			expect(await commitCount(id)).toBe(urgent ? 0 : 1);
		}
	});

	test("what arrives is told apart: a person's input from a team or plugin notice", async () => {
		const { id, owner } = await makeSession();
		const queue = (values: { kind?: "user_input" | "agent_message"; createdBy?: string | null }) =>
			db
				.insert(narratorBufferedMessages)
				.values({
					id: generateId(),
					narratorId: id,
					text: "x",
					seq: 1,
					bufferedAt: new Date().toISOString(),
					...values,
				})
				.run();
		queue({ createdBy: owner });
		const seen: boolean[] = [];
		const waiters: Array<() => void> = [];
		const stop = await watchSpecImportMessages(
			id,
			(person) => {
				seen.push(person);
				waiters.shift()?.();
			},
			1,
		);
		const next = () => new Promise<void>((resolve) => waiters.push(resolve));
		try {
			// Queued before it began: not news. A plugin's message, then a team notice: one notice.
			let told = next();
			queue({ createdBy: null });
			await told;
			queue({ kind: "agent_message", createdBy: null });
			told = next();
			queue({ createdBy: owner });
			await told;
			expect(seen).toEqual([false, true]);
		} finally {
			stop();
		}
	});
});

describe("mapping details", () => {
	test("a protected task whose protector is unknown is locked by the owner, as a person's", async () => {
		const { id, owner } = await makeSession();
		await writeTasks(id, [{ text: "nobody knows who", protected: true }], "assistant");
		const ns = await db.query.specNamespaces.findFirst({
			where: eq(specNamespaces.narratorId, id),
		});
		await db
			.update(specProtectedTasks)
			.set({ firstRevisionId: null })
			.where(eq(specProtectedTasks.namespaceId, ns?.id as string));
		expect((await run(id)).status).toBe("imported");
		expect((await taskPage(id)).map((t) => [t.humanCreated, t.lockedBy])).toEqual([
			[true, `human:${owner}`],
		]);
	});

	test("task texts are kept as written; a plain one is what /goal dedupes against", async () => {
		const { id, owner } = await makeSession();
		const texts = [
			"2. numbered start",
			"a &amp; b &lt;tag&gt;",
			"- [ ] boxed",
			"Fix issue #123 in parser",
		];
		await writeTasks(
			id,
			texts.map((text) => ({ text })),
		);
		expect((await run(id)).status).toBe("imported");
		const space = await spaceOf(id);
		const tasks = await taskPage(id);
		const { parseBlock } = await import("@shared/outline");
		const plain = (content: string) =>
			(parseBlock(content).body as { content: Array<{ text?: string }> }).content
				.map((i) => i.text ?? "")
				.join("");
		expect(tasks.map((t) => plain(t.text))).toEqual(texts);
		const again = await addPersonTask({
			narratorId: id,
			userId: owner as string,
			text: "Fix issue #123 in parser",
			lock: true,
		});
		expect(again.added).toBe(false);
		expect(again.spaceId).toBe(space.id);
	});

	test("a note dense with [[links]] arrives in ordinary commits, its links as text", async () => {
		const { id } = await makeSession();
		const text = Array.from({ length: 200 }, (_, p) =>
			Array.from({ length: 15 }, (_, k) => `[[n${p}x${k}]]`).join(" "),
		).join("\n\n");
		await writeNote(id, "links.md", text);
		expect((await run(id)).status).toBe("imported");
		const [page] = (await pages(id)).filter((p) => p.title === "links.md");
		expect(page?.blocks).toHaveLength(200);
		const space = await spaceOf(id);
		const roots = await outlineStore.listChildren(space.id, null, 10);
		const links = await outlineStore.listOpenLinks(
			(await outlineStore.listChildren(space.id, roots[0]?.id as string, 500)).map((b) => b.id),
			10,
		);
		expect(links).toEqual([]);
	});

	test("deleted files are not read and do not count toward the limit", async () => {
		const { id } = await makeSession();
		await writeNote(id, "a.md", "a\n");
		await writeNote(id, "b.md", "b\n");
		await deleteSpecFile(id, "spec://b.md");
		const session = await readSpecImportSession(id);
		const pointers = await readSpecFilePointers(session?.namespaceId as string);
		expect(pointers.map((p) => p.path)).toEqual(["a.md"]);
		expect((await run(id)).status).toBe("imported");
		expect((await pages(id)).map((p) => p.title)).toEqual(["a.md"]);
	});
});
