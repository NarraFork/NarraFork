/**
 * Agents in the live outline editor's presence (outline P2 PR 10b, design §2.9, owner decision
 * Q4 A), in Chromium against the test server's real live sessions, at phone width (360 px), in
 * English and Chinese, light and dark:
 *
 *   - a running session holding a task on the page shows in the bar as a robot in its colour with
 *     its first letter, a link to the session and its title in the label, for someone who may
 *     read the session; its cursor frames the task's block (`ob-peer-bsel`);
 *   - a running subagent that just wrote a block is an agent of its own, its session named;
 *   - someone who may not read the sessions sees agents without a name or a link, the same
 *     cursors;
 *   - the agents leave the bar and the blocks when their runs end.
 * Nothing scrolls sideways. No timing is asserted.
 *
 * NF_10B_SHOTS=<dir> writes a screenshot of each view (and one with the label shown) there.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { livePeerColor } from "@shared/outline-live-protocol";
import { eq } from "drizzle-orm";
import { db } from "../../../../server/db";
import { narrators } from "../../../../server/db/schema";
import { eventBus } from "../../../../server/lib/event-bus";
import { generateId } from "../../../../server/lib/id";
import { writeOutline } from "../../../../server/services/outline/write";
import en from "../../../locales/en/outline.json";
import zh from "../../../locales/zh-CN/outline.json";
import {
	type Editor,
	errorsOf,
	type Harness,
	openEditor,
	resetHarness,
	seedPage,
	startHarness,
	stopHarness,
	until,
} from "./outline-live-harness.browser-fixture";

const NOW = "2026-11-08T00:00:00.000Z";
const WIDTH = 360;
const shots = process.env.NF_10B_SHOTS;
const VIEWS = [
	{ lang: "en", scheme: "light" },
	{ lang: "en", scheme: "dark" },
	{ lang: "zh-CN", scheme: "light" },
	{ lang: "zh-CN", scheme: "dark" },
] as const;

let h: Harness;

beforeAll(async () => {
	h = await startHarness();
	if (shots) mkdirSync(shots, { recursive: true });
}, 60_000);

afterAll(async () => {
	await stopHarness(h);
});

afterEach(async () => {
	await resetHarness(h);
});

async function session(title: string, root?: string): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title,
		ownerUserId: h.owner,
		visibility: "private",
		contextProjectId: h.space.projectId,
		taskBackend: "outline",
		status: "idle",
		...(root ? { type: "subagent" as const, parentNarratorId: root, aclRootNarratorId: root } : {}),
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

/** A run starting or ending, as `narratorService.updateStatus` records and announces it. */
async function run(narratorId: string, on: boolean): Promise<void> {
	const status = on ? "working" : "idle";
	await db.update(narrators).set({ status }).where(eq(narrators.id, narratorId));
	eventBus.emit({ type: "narrator:status_changed", narratorId, status });
}

/** `#rrggbb` as the browser reports an inline colour. */
const rgb = (hex: string) =>
	`rgb(${[1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(", ")})`;

const fill = (template: string, values: Record<string, string>) =>
	template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? "");

async function shoot(editor: Editor, name: string): Promise<void> {
	if (!shots) return;
	const root = await editor.page.$("#root");
	await root?.screenshot({ path: join(shots, `${name}.png`) });
}

test("agents at work: named and linked for who may read them, a block cursor, gone when the run ends; 360 px, en/zh-CN, light/dark", async () => {
	const { pageId, ids } = await seedPage(h, "Release", [
		"[ ] Fix the refresh race",
		"Notes from the review",
		"[ ] Write the changelog",
	]);
	const [task, notes] = ids as [string, string, string];
	const worker = await session("Refresh worker");
	const helper = await session("Doc helper", worker);
	await run(worker, true);
	await run(helper, true);
	// The worker starts the task: it holds it, whether or not anyone has the page open.
	await writeOutline({
		spaceId: h.space.id,
		ops: [{ op: "setTask", block: { id: task }, task: { status: "doing" } }],
		actor: { kind: "agent", id: worker },
		narratorId: worker,
		responsibleUserId: h.owner,
	});
	/** The helper writes into the notes block: seen by a page open live (its cursor, a while). */
	let round = 0;
	const helperWrites = async () =>
		await writeOutline({
			spaceId: h.space.id,
			ops: [
				{ op: "update", block: { id: notes }, content: `Notes from the review, round ${++round}` },
			],
			actor: { kind: "agent", id: helper },
			narratorId: helper,
			responsibleUserId: h.owner,
		});

	for (const view of VIEWS) {
		const labels = (view.lang === "en" ? en : zh).editor;
		const owner = await openEditor(h, h.owner, pageId, { width: WIDTH, ...view });
		await helperWrites();
		await until(
			owner,
			(f) => f.agentAvatars().length === 2 && f.agentBlocks().length === 2,
			[],
			8000,
		);
		const avatars = await owner.call((f) => f.agentAvatars());
		expect(avatars.map((a) => ({ label: a.label, href: a.href, initial: a.initial }))).toEqual([
			{
				label: fill(labels.agentWorking, { name: "Refresh worker" }),
				href: `/narrators/${worker}`,
				initial: "R",
			},
			{
				label: fill(labels.agentWorkingIn, { name: "Doc helper", session: "Refresh worker" }),
				href: `/narrators/${helper}`,
				initial: "D",
			},
		]);
		// Each agent in its session's colour, its cursor framing its block in that colour.
		expect(avatars.map((a) => a.color)).toEqual([
			rgb(livePeerColor(worker)),
			rgb(livePeerColor(helper)),
		]);
		expect(
			(await owner.call((f) => f.agentBlocks())).sort((a, b) => a.id.localeCompare(b.id)),
		).toEqual(
			[
				{ id: task, agent: "Refresh worker", color: livePeerColor(worker) },
				{ id: notes, agent: "Doc helper", color: livePeerColor(helper) },
			].sort((a, b) => a.id.localeCompare(b.id)),
		);
		expect(await owner.call((f) => f.overflowsX())).toBe(false);
		const name = `${view.lang}-${view.scheme}`;
		await shoot(owner, `agents-${name}`);
		// The label on hover.
		await owner.page.hover("[data-testid=outline-agent-avatar]");
		await until(
			owner,
			(_f, text) =>
				[...document.querySelectorAll("[role=tooltip]")].some((t) => t.textContent === text),
			[fill(labels.agentWorking, { name: "Refresh worker" })],
		);
		if (shots) await owner.page.screenshot({ path: join(shots, `agents-label-${name}.png`) });

		// Someone who may read the page but not the sessions: agents without names or links.
		const reader = await openEditor(h, h.reader, pageId, { width: WIDTH, ...view });
		await until(
			reader,
			(f) => f.agentAvatars().length === 2 && f.agentBlocks().length === 2,
			[],
			8000,
		);
		expect(
			(await reader.call((f) => f.agentAvatars())).map((a) => [a.label, a.href, a.initial]),
		).toEqual([
			[labels.agentHidden, null, ""],
			[labels.agentHidden, null, ""],
		]);
		expect((await reader.call((f) => f.agentBlocks())).map((b) => b.id).sort()).toEqual(
			[task, notes].sort(),
		);
		expect(await reader.call((f) => f.overflowsX())).toBe(false);
		await shoot(reader, `agents-hidden-${name}`);
		expect([...errorsOf(owner), ...errorsOf(reader)]).toEqual([]);
		await resetHarness(h);
	}

	// The runs end: the agents leave the bar and the blocks.
	const owner = await openEditor(h, h.owner, pageId, { width: WIDTH });
	await helperWrites();
	await until(owner, (f) => f.agentAvatars().length === 2, [], 8000);
	await run(helper, false);
	await until(
		owner,
		(f) => f.agentAvatars().length === 1 && f.agentBlocks().length === 1,
		[],
		8000,
	);
	await run(worker, false);
	await until(
		owner,
		(f) => f.agentAvatars().length === 0 && f.agentBlocks().length === 0,
		[],
		8000,
	);
	expect(errorsOf(owner)).toEqual([]);
}, 120_000);
