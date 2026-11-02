/**
 * Locked plans through the agent tools (design §2.2, §2.6; P2 PR 6), on the isolated SQLite
 * database: `OutlineEdit` holding changes to a locked plan and saying for whom and which tasks
 * wait, `OutlineRead` showing the proposing session its version and everyone else the original
 * (owner decision Q1), the delegate confirming and rejecting with `{ confirm }` / `{ reject }`
 * and never its own, blocks a held change adds refused until confirmed, and the proposer told
 * once of a decision.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own users,
 * projects and sessions.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../../db";
import { narrators, projects, users } from "../../../db/schema";
import { outlineEditTool, outlineReadTool } from "../../../lib/agent/tools/outline";
import type { ToolContext, ToolResult } from "../../../lib/agent/types";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import { stopEditTextWorker } from "../edit-text-runner";
import { lockOutlineTask } from "../pending";
import { clearOutlineReads } from "../read-ledger";
import { invalidateSessionReadScopes } from "../session-scope";
import { ensureProjectSpace } from "../spaces";
import { outlineStore } from "../store";
import { writeOutline } from "../write";

const NOW = "2026-10-26T00:00:00.000Z";

async function user(label: string): Promise<string> {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `${label}-${id}`, passwordHash: "x", role: "user", createdAt: NOW });
	return id;
}

async function narrator(owner: string, projectId: string, title: string): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title,
		ownerUserId: owner,
		visibility: "private",
		contextProjectId: projectId,
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

function ctx(narratorId: string, userId: string): ToolContext {
	return {
		narratorId,
		cwd: "/",
		signal: new AbortController().signal,
		locale: "en",
		userId,
		requestPermission: async () => ({ behavior: "allow" }),
	} as ToolContext;
}

async function edit(c: ToolContext, edits: Array<Record<string, unknown>>): Promise<ToolResult> {
	return await outlineEditTool.execute({ edits }, c);
}

async function read(c: ToolContext, address: string): Promise<string> {
	return (await outlineReadTool.execute({ address, view: "all" }, c)).output;
}

/** A project whose page holds a plan its owner locked, naming session `d` to confirm for them. */
async function lockedPlan() {
	const alice = await user("alice");
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Importer",
		ownerUserId: alice,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	const a = await narrator(alice, projectId, "worker");
	const b = await narrator(alice, projectId, "reviewer");
	const d = await narrator(alice, projectId, "lead");
	const space = await ensureProjectSpace(projectId);
	const written = await writeOutline({
		spaceId: space.id,
		ops: [
			{
				op: "insert",
				tempId: "r",
				parent: null,
				content: "Ship the importer",
				task: { status: "todo" },
			},
			{ op: "insert", parent: { tempId: "r" }, content: "Acceptance: old exports load" },
			{
				op: "insert",
				parent: { tempId: "r" },
				content: "Parse the header",
				task: { status: "todo" },
			},
			{ op: "insert", parent: { tempId: "r" }, content: "Load the rows", task: { status: "todo" } },
		],
		actor: { kind: "human", id: alice },
		responsibleUserId: alice,
	});
	const [root, acc, s1, s2] = written.results.map((r) => r.sid) as [string, string, string, string];
	await lockOutlineTask({
		blockId: written.results[0]?.blockId as string,
		userId: alice,
		delegate: d,
	});
	return {
		alice,
		space,
		sids: { root, acc, s1, s2 },
		a: ctx(a, alice),
		b: ctx(b, alice),
		d: ctx(d, alice),
		ids: { a, b, d },
	};
}

/** The label (`P…`) a result or read names. */
function labelIn(text: string): string {
	const m = /\b(P[A-Za-z0-9]{8})\b/.exec(text);
	if (!m) throw new Error(`no pending label in: ${text}`);
	return m[1] as string;
}

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateSessionReadScopes();
	clearOutlineReads();
});

afterEach(() => {
	invalidateSessionReadScopes();
	stopEditTextWorker();
});

describe("OutlineEdit on a locked plan", () => {
	test("a change to the plan is held: the result says as what, for whom, which tasks wait; the rest is written", async () => {
		const w = await lockedPlan();
		await read(w.a, w.sids.root);
		const result = await edit(w.a, [
			{ replace: w.sids.s1, text: "[ ] Parse the header and the footer" },
			{ add: w.sids.s1, markdown: "- found: the header is v2" },
		]);
		expect(result.isError).toBeUndefined();
		const label = labelIn(result.output);
		expect(result.output).toMatch(/^Committed #\d+/);
		expect(result.output).toContain(`1. held for confirmation: replaced [${w.sids.s1}]`);
		expect(result.output).toContain("2. added under");
		expect(result.output).toContain(
			`Held for confirmation as ${label}: 1 change to the locked plan [${w.sids.root}] Ship the importer`,
		);
		expect(result.output).toContain('the session "lead"');
		expect(result.output).toContain(`Tasks that wait for it: [${w.sids.s1}] Parse the header.`);
		expect(result.metadata?.pending).toBe(label);
		const s1 = await outlineStore.getBlockBySid(w.space.id, w.sids.s1);
		expect(s1?.content).toBe("Parse the header");

		// Only held changes: nothing is written directly.
		const only = await edit(w.a, [{ set: w.sids.root, checkbox: "x" }]);
		expect(only.output.split("\n")[0]).toBe(
			"Nothing was written directly: the change waits for confirmation (below).",
		);
		expect(labelIn(only.output)).toBe(label);
		expect(only.output).toContain("merged into the change this session had already proposed there");
	});

	test("reads: the proposer sees its version marked, others the original marked, the delegate is asked to decide", async () => {
		const w = await lockedPlan();
		await read(w.a, w.sids.root);
		const result = await edit(w.a, [
			{ replace: w.sids.s1, text: "[ ] Parse the header and the footer" },
			{ delete: w.sids.s2 },
		]);
		const label = labelIn(result.output);
		const own = await read(w.a, w.sids.root);
		expect(own).toContain(`[${w.sids.s1}] [ ] Parse the header and the footer`);
		expect(own).not.toContain("Load the rows");
		expect(own).toContain(`‹pending ${label}: your proposed change, not confirmed yet›`);
		expect(own).toContain(`‹pending ${label}: you proposed deleting 1 block here`);
		expect(own).toContain(
			`‹${label} is your change to this plan, shown above as you proposed it; it waits for`,
		);
		const others = await read(w.b, w.sids.root);
		expect(others).toContain(`[${w.sids.s1}] [ ] Parse the header\n`);
		expect(others).toContain("Load the rows");
		expect(others).toContain(`‹pending ${label}: a change proposed here waits for confirmation›`);
		const delegate = await read(w.d, w.sids.root);
		expect(delegate).toContain(`‹${label} waits for your confirmation:`);
		expect(delegate).toContain(`OutlineEdit { edits: [{ confirm: "${label}" }] }`);
	});

	test("a block a held change adds is refused until confirmed; the delegate confirms, never the proposer; the proposer is told once", async () => {
		const w = await lockedPlan();
		await read(w.a, w.sids.root);
		const added = await edit(w.a, [{ add: w.sids.root, markdown: "- [ ] Write the docs" }]);
		const label = labelIn(added.output);
		const newSid = [
			...added.output.matchAll(/^\s*- \[([A-Za-z0-9]{8})\] \[ \] Write the docs/gm),
		][0]?.[1];
		expect(newSid).toBeDefined();
		const under = await edit(w.a, [{ add: newSid as string, markdown: "- the README" }]);
		expect(under.isError).toBe(true);
		expect(under.output).toContain(`${newSid} is a block ${label} adds`);

		const own = await edit(w.a, [{ confirm: label }]);
		expect(own.isError).toBe(true);
		expect(own.output).toContain("was proposed by this session, so it cannot confirm it");
		const mixed = await edit(w.d, [{ confirm: label }, { delete: w.sids.acc }]);
		expect(mixed.isError).toBe(true);
		expect(mixed.output).toContain("confirm and reject go in a call of their own");
		const stranger = await edit(w.b, [{ confirm: label }]);
		expect(stranger.isError).toBe(true);
		expect(stranger.output).toContain("is not yours to decide");

		const confirmed = await edit(w.d, [{ confirm: label }]);
		expect(confirmed.isError).toBeUndefined();
		expect(confirmed.output).toMatch(
			new RegExp(
				`Confirmed ${label} \\(proposed by the session "worker" \\(${w.ids.a}\\)\\): committed #\\d+`,
			),
		);
		expect((await outlineStore.getBlockBySid(w.space.id, newSid as string))?.content).toBe(
			"Write the docs",
		);
		const told = await read(w.a, w.sids.root);
		expect(told).toContain(`‹${label} was confirmed by the session "lead"`);
		expect(await read(w.a, w.sids.root)).not.toContain(`${label} was confirmed`);
		// Now it exists: writing under it is a plain write.
		const after = await edit(w.a, [{ add: newSid as string, markdown: "- the README" }]);
		expect(after.isError).toBeUndefined();
	});

	test("reject: the delegate rejects with a reason the proposer reads once; the proposer withdraws its own; a bad label is named", async () => {
		const w = await lockedPlan();
		await read(w.a, w.sids.root);
		const first = await edit(w.a, [{ replace: w.sids.acc, text: "Acceptance: none" }]);
		const label = labelIn(first.output);
		const rejected = await edit(w.d, [{ reject: label, reason: "the acceptance stays" }]);
		expect(rejected.output).toBe(`1. Rejected ${label}; its proposer is told on its next read.`);
		const told = await read(w.a, w.sids.root);
		expect(told).toContain(`‹${label} was rejected by the session "lead"`);
		expect(told).toContain(": the acceptance stays›");
		expect(told).toContain("Acceptance: old exports load");
		expect(await read(w.a, w.sids.root)).not.toContain("was rejected");

		const second = await edit(w.a, [{ replace: w.sids.acc, text: "Acceptance: almost none" }]);
		const again = labelIn(second.output);
		expect(again).not.toBe(label);
		const withdrawn = await edit(w.a, [{ reject: again }]);
		expect(withdrawn.output).toBe(`1. Withdrew ${again}, which this session had proposed.`);
		const bad = await edit(w.d, [{ confirm: "P12" }]);
		expect(bad.isError).toBe(true);
		expect(bad.output).toContain("is not a pending change");
	});
});

describe("review round 1", () => {
	test("the proposer reads its change over what is there now: merged where it does not overlap, the conflict shown where it does (S-2)", async () => {
		const w = await lockedPlan();
		await read(w.a, w.sids.root);
		const label = labelIn(
			(await edit(w.a, [{ replace: w.sids.s1, text: "[ ] Parse the header fast" }])).output,
		);
		const s1 = (await outlineStore.getBlockBySid(w.space.id, w.sids.s1))?.id as string;
		const person = (content: string) =>
			writeOutline({
				spaceId: w.space.id,
				ops: [{ op: "update", block: { id: s1 }, content }],
				actor: { kind: "human", id: w.alice },
				responsibleUserId: w.alice,
			});
		// A person's change that does not overlap: the read shows what confirming would write.
		await person("Carefully parse the header");
		const merged = await read(w.a, w.sids.root);
		expect(merged).toContain(`[${w.sids.s1}] [ ] Carefully parse the header fast`);
		expect(merged).toContain(`‹pending ${label}: your proposed change, merged over changes`);
		expect(merged).toContain(`${label} is your change to this plan, shown above merged`);
		// One that overlaps: the block as it is now, with the conflict, and what to do.
		await person("Do NOT parse the header; use the library");
		const conflict = await read(w.a, w.sids.root);
		expect(conflict).toContain(`[${w.sids.s1}] [ ] Do NOT parse the header; use the library`);
		expect(conflict).toContain("your change no longer applies here");
		expect(conflict).toContain("it cannot be confirmed as it is");
		// Others read the outline as it is, marked.
		const other = await read(w.b, w.sids.root);
		expect(other).toContain("Do NOT parse the header; use the library");
		expect(other).toContain(`‹pending ${label}: a change proposed here waits for confirmation›`);
	});

	test("a rewrite proposed again over a person's change carries the version it was written against, so it confirms as written (S-3)", async () => {
		const w = await lockedPlan();
		await read(w.a, w.sids.root);
		const label = labelIn(
			(await edit(w.a, [{ replace: w.sids.s1, text: "[ ] Parse the header fast" }])).output,
		);
		const s1 = (await outlineStore.getBlockBySid(w.space.id, w.sids.s1))?.id as string;
		await writeOutline({
			spaceId: w.space.id,
			ops: [{ op: "update", block: { id: s1 }, content: "Carefully parse the header" }],
			actor: { kind: "human", id: w.alice },
			responsibleUserId: w.alice,
		});
		// Not read again: the replace merges with the person's change, and goes into the same change.
		const again = await edit(w.a, [
			{ replace: w.sids.s1, text: "[ ] Parse the header fast and safe" },
		]);
		expect(again.output).toContain("merged into the change this session had already proposed");
		const confirmed = await edit(w.d, [{ confirm: label }]);
		expect(confirmed.isError).toBeUndefined();
		expect((await outlineStore.getBlock(s1))?.content).toBe(
			"Carefully parse the header fast and safe",
		);
	});

	test("a step added through nested markdown, or a block of the plan given a checkbox, is held (B-1); a step's checkbox alone is not (S-1)", async () => {
		const w = await lockedPlan();
		await read(w.a, w.sids.root);
		const nested = await edit(w.a, [
			{ add: w.sids.root, markdown: "- Phase 2\n  - [ ] Deploy to production" },
		]);
		expect(nested.output).toContain("held in part for confirmation");
		expect(nested.output).toContain("Held for confirmation as P");
		const boxed = await edit(w.a, [
			{ replace: w.sids.acc, text: "[ ] Acceptance: old exports load" },
		]);
		expect(boxed.output).toContain("Nothing was written directly");
		expect(boxed.output).toContain("Held for confirmation as P");
		expect((await outlineStore.getBlockBySid(w.space.id, w.sids.acc))?.taskJson).toBeNull();
		// The checkbox of a step (progress) with its text unchanged is written directly.
		const progress = await edit(w.a, [{ replace: w.sids.s1, text: "[/] Parse the header" }]);
		expect(progress.output).toMatch(/^Committed #\d+/);
		expect(progress.output).not.toContain("held");
		expect((await outlineStore.getBlockBySid(w.space.id, w.sids.s1))?.taskJson?.status).toBe(
			"doing",
		);
	});

	test("reads and results name who decides now: a delegate named since is asked; the delegate's own change goes to the locker alone (S-8)", async () => {
		const w = await lockedPlan();
		await read(w.a, w.sids.root);
		const label = labelIn(
			(await edit(w.a, [{ replace: w.sids.s1, text: "[ ] Parse the header fast" }])).output,
		);
		const rootId = (await outlineStore.getBlockBySid(w.space.id, w.sids.root))?.id as string;
		await lockOutlineTask({ blockId: rootId, userId: w.alice, delegate: w.ids.b });
		expect(await read(w.b, w.sids.root)).toContain(`${label} waits for your confirmation`);
		expect(await read(w.d, w.sids.root)).not.toContain(`${label} waits for your confirmation`);
		expect(await read(w.a, w.sids.root)).toContain(`(or the session "reviewer"`);
		// The delegate proposing: its change waits for the locker only.
		await read(w.b, w.sids.root);
		const own = await edit(w.b, [{ replace: w.sids.s2, text: "[ ] Load the rows twice" }]);
		expect(own.output).toMatch(/waiting for alice-[^ ]+ to confirm\./);
		expect(own.output).not.toContain("on their behalf");
	});

	test("deciding needs write access: a delegate run by someone who may not write the space neither confirms nor rejects (B-3)", async () => {
		const w = await lockedPlan();
		await read(w.a, w.sids.root);
		const label = labelIn(
			(await edit(w.a, [{ replace: w.sids.s1, text: "[ ] Parse the header fast" }])).output,
		);
		const readOnly = { ...w.d, userId: await user("viewer") } as ToolContext;
		for (const decision of [{ confirm: label }, { reject: label, reason: "no" }]) {
			const refused = await edit(readOnly, [decision]);
			expect(refused.isError).toBe(true);
			expect(refused.output).toContain("may not write");
		}
		const row = (await outlineStore.getPending([label.slice(1)]))[0];
		expect(row?.status).toBe("open");
	});

	test("sessions are named by title only to sessions that may read them (S-5)", async () => {
		const w = await lockedPlan();
		const bob = await user("bob");
		const secret = generateId();
		await db.insert(narrators).values({
			id: secret,
			title: "Secret: layoffs plan",
			ownerUserId: bob,
			visibility: "private",
			createdAt: NOW,
			updatedAt: NOW,
		});
		const rootId = (await outlineStore.getBlockBySid(w.space.id, w.sids.root))?.id as string;
		await lockOutlineTask({ blockId: rootId, userId: w.alice, delegate: secret });
		await read(w.a, w.sids.root);
		const held = await edit(w.a, [{ replace: w.sids.s1, text: "[ ] Parse the header fast" }]);
		expect(held.output).toContain(`(or the session ${secret} on their behalf)`);
		const reads = await read(w.a, w.sids.root);
		expect(held.output + reads).not.toContain("layoffs");
		expect(reads).toContain(`the session ${secret}`);
	});
});
