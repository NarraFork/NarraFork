/**
 * Regressions from PR 4's second review (outline P2): each case is seeded from the reviewer's
 * round-2 probe of the same name and asserts the corrected behavior.
 *
 *   S-R2-1  an item longer than a block may hold is cut into several blocks, so a large fence
 *           imports whole; after an import cut short the view shows only what did not reach the
 *           page, not the fence from its top again;
 *   N-R2-2  a block a person deleted after a partial import stays deleted, and so does what was
 *           under it: the import resumes instead of failing for good;
 *   N-R2-5  the turn-end note is decided before the pre-idle drain and written after the
 *           takeover-vs-terminal arbitration, nothing awaited between those two;
 *   N-R2-6  checkboxes on the behavior page do not use up the candidate scan;
 *   N-R2-7  a plugin SOP update in the middle of the fence during the import does not leave the
 *           moved text behind to be imported again (glued) after a restart;
 *   N-R2-8  a view that keeps failing is read (and logged) once per backoff, not every request;
 *   N-R2-9  with the outline off, the page in the spec fence has its heading and a truncation
 *           note in the owner's language; a fork's cut note is in the owner's language too.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextPart } from "@shared/prefix-context";
import { db } from "../../../db";
import { narrators, userPreferences, users } from "../../../db/schema";
import { generateId } from "../../../lib/id";
import { logger } from "../../../lib/logger";
import { settings } from "../../../lib/settings";
import { narratorService } from "../../narrator-service";
import {
	decideOutlineTurnEndNote,
	deliverOutlineTurnEndNote,
	prepareOutlineRun,
	setSpecBehaviorFenceForPlugin,
} from "../../narrator-session";
import type { ActiveNarrator } from "../../narrator-session-state";
import * as runner from "../../outline/edit-text-runner";
import { OUTLINE_LIMITS } from "../../outline/model";
import { ensureSessionSpace } from "../../outline/spaces";
import { outlineStore } from "../../outline/store";
import * as outlineWrite from "../../outline/write";
import { writeOutline } from "../../outline/write";
import { buildBehaviorFenceBody } from "../../spec-reminder";
import { readSpecFile, writeSpecFile } from "../../spec-vfs-service";
import { taskSourceForNarrator } from "../index";
import {
	copyOutlineBehaviorPage,
	cutToBlocks,
	findBehaviorPage,
	importLeftover,
	importOutlineBehaviorFence,
	OUTLINE_BEHAVIOR_LIMITS,
	resetOutlineBehaviorImport,
} from "../outline-behavior";
import { OUTLINE_VIEW_LIMITS, resetOutlineViewCache } from "../outline-views";
import { seedBehaviorPage, seedOutlineTasks } from "./outline-task-source-scenarios";

const NOW = "2026-11-02T00:00:00.000Z";

beforeEach(() => {
	settings.outline.enabled = true;
	resetOutlineViewCache();
	resetOutlineBehaviorImport();
});
const restores: Array<() => void> = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
	settings.outline.enabled = true;
	resetOutlineViewCache();
});

/** A user whose language is `language`, for the narrators that should be worded in it. */
async function user(language: "en" | "zh-CN"): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `r2-${id}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	await db
		.insert(userPreferences)
		.values({ id: generateId(), userId: id, language, createdAt: NOW, updatedAt: NOW });
	return id;
}

async function session(
	options: { backend?: "spec" | "outline"; owner?: string | null } = {},
): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
		model: "default",
		permissionMode: "default",
		status: "idle",
		cwd: "/tmp",
		taskBackend: options.backend ?? "outline",
		ownerUserId: options.owner ?? null,
		autoContinuationOverride: "off",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

/** Write a session's old fence as before PR 4 (the switch off: a spec write). */
async function oldFence(narratorId: string, text: string): Promise<void> {
	settings.outline.enabled = false;
	try {
		await writeSpecFile(narratorId, "spec://behavior_fence", text, { actor: "user" });
	} finally {
		settings.outline.enabled = true;
	}
}

async function parts(narratorId: string): Promise<ContextPart[]> {
	return await (await taskSourceForNarrator(narratorId)).contextParts("en");
}
const part = (list: ContextPart[], key: string) =>
	list.find((p) => p.key === key && !p.unreadable)?.text ?? null;

/** Contents of the live children of the session's behavior page, in order. */
async function pageChildren(narratorId: string): Promise<string[]> {
	const space = await ensureSessionSpace(narratorId);
	const page = await findBehaviorPage(space.id);
	if (!page) return [];
	return (await outlineStore.listChildren(space.id, page.id, 1000)).map((b) => b.content);
}

/** `writeOutline` failing on its `nth` call only. */
function failOnCall(nth: number): void {
	const real = outlineWrite.writeOutline;
	let calls = 0;
	const spy = spyOn(outlineWrite, "writeOutline").mockImplementation(async (...args) => {
		calls++;
		if (calls === nth) throw new Error(`transient failure on import commit ${nth}`);
		return await real(...args);
	});
	restores.push(() => spy.mockRestore());
}

const oversizeFence = () =>
	Array.from({ length: 230 }, (_, n) =>
		n === 220 ? `- Old rule ${n} ${"x".repeat(17 * 1024)}` : `- Old rule ${n}`,
	).join("\n");

describe("S-R2-1: an import that cannot write everything at once (probe R2-1)", () => {
	test("an item over a block's size becomes several blocks, and the whole fence imports", async () => {
		const id = await session();
		await oldFence(id, oversizeFence());
		await setSpecBehaviorFenceForPlugin(id, "Report back.", "upsert");
		expect(await importOutlineBehaviorFence(id, "en")).toBe("imported");

		const kids = await pageChildren(id);
		// 230 rules, the long one in two blocks, in order.
		expect(kids).toHaveLength(231);
		const long = kids.findIndex((content) => content.startsWith("Old rule 220 "));
		expect(kids.slice(0, long)).toEqual(Array.from({ length: 220 }, (_, n) => `Old rule ${n}`));
		const xs =
			(kids[long] as string).length - "Old rule 220 ".length + (kids[long + 1] ?? "").length;
		expect(xs).toBe(17 * 1024);
		expect(kids[long + 1]).toMatch(/^x+$/);
		expect(kids.slice(long + 2)).toEqual(
			Array.from({ length: 9 }, (_, n) => `Old rule ${221 + n}`),
		);
		for (const content of kids) {
			expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(OUTLINE_LIMITS.maxBodyBytes);
		}
		// The fence keeps only the SOP; nothing is shown from it twice.
		const fence = (await readSpecFile(id, "spec://behavior_fence")).content;
		expect(fence).not.toContain("Old rule");
		expect(fence).toContain("Report back.");
		expect(part(await parts(id), "outline.behavior")).not.toContain("old behavior fence");
	});

	test("cutting: within the byte limit, at a space or line break when one is near, never inside a character", () => {
		expect(cutToBlocks("short", 100)).toEqual(["short"]);
		const words = Array.from({ length: 50 }, (_, n) => `word${n}`).join(" ");
		const pieces = cutToBlocks(words, 64);
		for (const piece of pieces) expect(Buffer.byteLength(piece, "utf8")).toBeLessThanOrEqual(64);
		// Nothing is lost: the space at a cut stays with the first piece (round 3, N-R3-2).
		expect(pieces.join("")).toBe(words);
		for (const piece of pieces.slice(0, -1)) expect(piece).toMatch(/^word\d+( word\d+)* $/);
		const cjk = "边界".repeat(40);
		const cut = cutToBlocks(cjk, 31);
		for (const piece of cut) expect(Buffer.byteLength(piece, "utf8")).toBeLessThanOrEqual(31);
		expect(cut.join("")).toBe(cjk);
		expect(OUTLINE_BEHAVIOR_LIMITS.importBlockBytes).toBeLessThan(OUTLINE_LIMITS.maxBodyBytes);
	});

	test("after an import cut short, the view shows the rules that did not reach the page, once", async () => {
		const id = await session();
		const text = Array.from({ length: 230 }, (_, n) => `- Old rule ${n}`).join("\n");
		await oldFence(id, text);
		failOnCall(2);
		expect(await importOutlineBehaviorFence(id, "en")).toBe("failed");
		const onPage = await pageChildren(id);
		expect(onPage).toEqual(Array.from({ length: onPage.length }, (_, n) => `Old rule ${n}`));
		expect(onPage.length).toBeGreaterThan(100);
		expect(onPage.length).toBeLessThan(225);

		const view = part(await parts(id), "outline.behavior") ?? "";
		expect(view.length).toBeLessThanOrEqual(OUTLINE_VIEW_LIMITS.behaviorChars);
		expect(view).toContain("From this session's old behavior fence");
		// The rules still in the fence only, not the fence from its top a second time.
		expect(view).toContain("- Old rule 225");
		expect(view).toContain("- Old rule 229");
		expect(view.split("- Old rule 5\n").length - 1).toBe(1);
		const leftover = importLeftover(id, text);
		expect(leftover?.startsWith(`- Old rule ${onPage.length}\n`)).toBe(true);
		expect(leftover?.split("\n")).toHaveLength(230 - onPage.length);

		// A later run (a restart) moves the rest; the view shows no fence text any more.
		resetOutlineBehaviorImport(id);
		expect(await importOutlineBehaviorFence(id, "en")).toBe("imported");
		expect(await pageChildren(id)).toEqual(Array.from({ length: 230 }, (_, n) => `Old rule ${n}`));
		expect(part(await parts(id), "outline.behavior")).not.toContain("old behavior fence");
	});

	test("when nothing reached the page, the whole fence text is shown", async () => {
		const id = await session();
		await oldFence(id, "- Old fence rule 0\n  - Under it\n- Old fence rule 1");
		failOnCall(1);
		expect(await importOutlineBehaviorFence(id, "en")).toBe("failed");
		const view = part(await parts(id), "outline.behavior") ?? "";
		expect(view).toContain("- Old fence rule 0\n  - Under it\n- Old fence rule 1");
	});
});

describe("N-R2-2: a person deletes a block a partial import wrote (probe R2-2)", () => {
	test("the import resumes: the deleted block and what was under it stay deleted", async () => {
		const id = await session();
		await oldFence(
			id,
			["- Group", ...Array.from({ length: 250 }, (_, n) => `  - Child ${n}`), "- After"].join("\n"),
		);
		failOnCall(2);
		expect(await importOutlineBehaviorFence(id, "en")).toBe("failed");
		const space = await ensureSessionSpace(id);
		const page = await findBehaviorPage(space.id);
		const [group] = await outlineStore.listChildMetas(space.id, [page?.id as string], 10);
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "delete", block: { id: group?.id as string } }],
			actor: { kind: "human", id: "pat" },
			responsibleUserId: null,
		});

		resetOutlineBehaviorImport(id);
		expect(await importOutlineBehaviorFence(id, "en")).toBe("imported");
		// Nothing of the deleted group came back; what came after it did.
		expect(await pageChildren(id)).toEqual(["After"]);
		const under = await outlineStore.listChildMetas(space.id, [group?.id as string], 300);
		expect(under.filter((block) => !block.deleted)).toEqual([]);
		expect((await readSpecFile(id, "spec://behavior_fence")).content).not.toContain("Child");
		const view = part(await parts(id), "outline.behavior") ?? "";
		expect(view).not.toContain("Child 200");
		expect(view).not.toContain("Group");
	});
});

describe("N-R2-5: the turn-end note and the pre-idle drain", () => {
	test("the drain and the takeover-vs-terminal arbitration stay back to back", () => {
		const source = readFileSync(
			join(import.meta.dir, "../../agent-runtime/orchestrator.ts"),
			"utf8",
		);
		const decide = source.indexOf("const turnEndNote = await decideOutlineTurnEndNote(active);");
		const drain = source.indexOf("const bgCompletionAfterIdle = await", decide);
		const finalizing = source.indexOf("} else run.finalizing = true;", drain);
		const idle = source.indexOf("await narratorService.compareAndSetStatus(", finalizing);
		const deliver = source.indexOf("await deliverOutlineTurnEndNote(active, turnEndNote)", idle);
		expect(decide).toBeGreaterThan(0);
		expect(drain).toBeGreaterThan(decide);
		expect(finalizing).toBeGreaterThan(drain);
		expect(idle).toBeGreaterThan(finalizing);
		expect(deliver).toBeGreaterThan(idle);
		// Between the drain and the arbitration: only the drain's own continue branch.
		const between = source.slice(drain, finalizing);
		expect(between).not.toContain("TurnEndNote");
		expect(between.match(/\bawait\b/g)?.length).toBe(3);
		// Written only when the run settled terminal (not when it parked on a hold).
		expect(source.slice(drain, deliver)).toContain("terminal = false;");
		expect(source).not.toContain("maybeDeliverOutlineTurnEndNote(");
	});

	test("deciding writes nothing; delivering writes once; a dropped decision is decided again", async () => {
		const id = await session();
		await seedOutlineTasks(id, [{ text: "Write the parser", status: "doing" }]);
		const notes = async () =>
			(await narratorService.getModelHistorySinceLastCompact(id)).filter((row) =>
				(Array.isArray(row.contentJson) ? row.contentJson : []).some(
					(block) =>
						!!block &&
						typeof block === "object" &&
						(block as { source?: unknown }).source === "outline_task_turn_end",
				),
			);
		const active = {
			narratorId: id,
			locale: "en",
			_todoReminderCompletedToolCount: 0,
		} as unknown as ActiveNarrator;
		await prepareOutlineRun(active);
		active._todoReminderCompletedToolCount = 40;

		const dropped = await decideOutlineTurnEndNote(active);
		expect(dropped?.content).toContain("Write the parser");
		expect(await notes()).toEqual([]);
		// The drain continued the run: that decision is dropped, and the run's end decides again.
		const note = await decideOutlineTurnEndNote(active);
		expect(note).toEqual(dropped);
		if (!note) throw new Error("expected a note");
		expect(await deliverOutlineTurnEndNote(active, note)).toBe(true);
		expect(await deliverOutlineTurnEndNote(active, note)).toBe(false);
		expect(await decideOutlineTurnEndNote(active)).toBeNull();
		expect(await notes()).toHaveLength(1);
	});
});

describe("N-R2-6: checkboxes on the behavior page and the candidate scan (probe R2-6)", () => {
	test("600 checkboxes on the page do not hide the session's real task", async () => {
		const id = await session();
		const pageId = await seedBehaviorPage(id, "Rule.");
		const space = await ensureSessionSpace(id);
		for (let i = 0; i < 600; i += 150) {
			await writeOutline({
				spaceId: space.id,
				ops: Array.from({ length: 150 }, (_, n) => ({
					op: "insert" as const,
					parent: { id: pageId },
					content: `Checklist item ${i + n}`,
					task: { status: "todo" as const },
				})),
				actor: { kind: "human", id: "pat" },
				responsibleUserId: null,
			});
		}
		await writeOutline({
			spaceId: space.id,
			ops: [
				{ op: "insert", tempId: "p", parent: null, content: "Plan" },
				{ op: "insert", parent: { tempId: "p" }, content: "Real task", task: { status: "todo" } },
			],
			actor: { kind: "human", id: "pat" },
			responsibleUserId: null,
		});
		const open = await (await taskSourceForNarrator(id)).openTasks();
		expect(open.tasks.map((task) => task.text)).toEqual(["Real task"]);
	});
});

describe("N-R2-7: an SOP in the middle of the fence updated during the import (probe R2-7)", () => {
	test("the fence is rewritten, and a restart imports nothing a second time", async () => {
		const { TEAM_SOP_CLOSE, TEAM_SOP_OPEN } = await import("../../behavior-fence-sop");
		const id = await session();
		await oldFence(id, `- Rule A\n\n${TEAM_SOP_OPEN}\nOLD SOP\n${TEAM_SOP_CLOSE}\n\n- Rule B`);
		const real = runner.processEditText;
		let once = false;
		const spy = spyOn(runner, "processEditText").mockImplementation((async (
			...args: Parameters<typeof real>
		) => {
			const out = await real(...args);
			if (!once) {
				once = true;
				await setSpecBehaviorFenceForPlugin(id, "NEW SOP", "upsert");
			}
			return out;
		}) as typeof real);
		restores.push(() => spy.mockRestore());
		expect(await importOutlineBehaviorFence(id, "en")).toBe("imported");
		spy.mockRestore();
		const fence = (await readSpecFile(id, "spec://behavior_fence")).content;
		expect(fence).toContain("NEW SOP");
		expect(fence).not.toContain("Rule A");

		resetOutlineBehaviorImport(id); // a restart
		expect(await importOutlineBehaviorFence(id, "en")).toBe("nothing");
		expect(await pageChildren(id)).toEqual(["Rule A", "Rule B"]);
	});
});

describe("N-R2-8: a view that keeps failing", () => {
	test("a view never shown is read on every request, but its failures are logged once per backoff", async () => {
		let now = 1_000_000;
		resetOutlineViewCache(() => now);
		const id = await session();
		await seedBehaviorPage(id, "Never force-push.");
		const failing = spyOn(outlineStore, "findAliasOwners").mockImplementation(() =>
			Promise.reject(new Error("down")),
		);
		restores.push(() => failing.mockRestore());
		const warn = spyOn(logger, "warn");
		restores.push(() => warn.mockRestore());
		const warnings = () =>
			warn.mock.calls.filter((call) => call[0] === "Outline view could not be read").length;

		const first = await parts(id);
		expect(first.map((p) => [p.key, p.unreadable])).toEqual([
			["outline.tasks", true],
			["outline.behavior", true],
		]);
		const reads = failing.mock.calls.length;
		expect(reads).toBeGreaterThan(0);
		expect(warnings()).toBe(2);

		now += OUTLINE_VIEW_LIMITS.failureBackoffMs - 1;
		expect(await parts(id)).toEqual(first);
		expect(failing.mock.calls.length).toBeGreaterThan(reads);
		expect(warnings()).toBe(2);

		now += 1;
		await parts(id);
		expect(warnings()).toBe(4);

		// Back as soon as the reads succeed: the missing part does not wait for the backoff.
		failing.mockRestore();
		expect(part(await parts(id), "outline.behavior")).toContain("Never force-push.");
	});

	test("a view shown before is served during the backoff without another read", async () => {
		let now = 2_000_000;
		resetOutlineViewCache(() => now);
		const id = await session();
		const pageId = await seedBehaviorPage(id, "Never force-push.");
		const shown = part(await parts(id), "outline.behavior");
		const space = await ensureSessionSpace(id);
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "insert", parent: { id: pageId }, content: "Ask first." }],
			actor: { kind: "human", id: "pat" },
			responsibleUserId: null,
		});
		const failing = spyOn(outlineStore, "findAliasOwners").mockImplementation(() =>
			Promise.reject(new Error("down")),
		);
		restores.push(() => failing.mockRestore());
		expect(part(await parts(id), "outline.behavior")).toBe(shown);
		const reads = failing.mock.calls.length;
		now += 1_000;
		expect(part(await parts(id), "outline.behavior")).toBe(shown);
		expect(failing.mock.calls.length).toBe(reads);
		failing.mockRestore();
		now += OUTLINE_VIEW_LIMITS.failureBackoffMs;
		expect(part(await parts(id), "outline.behavior")).toContain("Ask first.");
	});
});

describe("N-R2-9: the page in the spec fence with the outline off, and the fork note", () => {
	test("it has its heading, and a truncation note naming no outline tool, in the owner's language", async () => {
		for (const language of ["en", "zh-CN"] as const) {
			const id = await session({ owner: await user(language) });
			const pageId = await seedBehaviorPage(id, "Rule zero.");
			const space = await ensureSessionSpace(id);
			// Over the switched-off budget (30k characters, round 3 S-R3-2).
			for (let i = 0; i < 600; i += 150) {
				await writeOutline({
					spaceId: space.id,
					ops: Array.from({ length: 150 }, (_, n) => ({
						op: "insert" as const,
						parent: { id: pageId },
						content: `Rule ${i + n + 1}: ${"keep this in mind ".repeat(3)}`,
					})),
					actor: { kind: "human", id: "pat" },
					responsibleUserId: null,
				});
			}
			const [page] = await outlineStore.getBlocks([pageId]);
			const address = `${space.key}/${page?.sid}`;
			settings.outline.enabled = false;
			const body = await buildBehaviorFenceBody(id);
			settings.outline.enabled = true;
			const text = body?.kind === "prose" ? body.text : "";
			expect(text.length).toBeGreaterThan(OUTLINE_VIEW_LIMITS.behaviorChars);
			expect(text.length).toBeLessThanOrEqual(OUTLINE_VIEW_LIMITS.switchedOffChars);
			expect(text).toContain("Rule zero.");
			expect(text).toContain("Rule 300:");
			expect(text).not.toContain("OutlineRead");
			if (language === "en") {
				expect(text.startsWith(`From this session's behavior page \`${address}\`:`)).toBe(true);
				expect(text).toMatch(
					/\n‹\d+ blocks of this page are shortened or left out here; the user can see the whole page in the outline›$/,
				);
			} else {
				expect(text.startsWith(`来自本会话的行为边界页 \`${address}\`：`)).toBe(true);
				expect(text).toMatch(
					/\n‹这一页有 \d+ 块在这里只显示了开头或没有列出；用户可以在大纲里看到整页›$/,
				);
			}
		}
	});

	test("a page that fits has its heading and no note", async () => {
		const id = await session();
		await seedBehaviorPage(id, "Never force-push.");
		settings.outline.enabled = false;
		const body = await buildBehaviorFenceBody(id);
		settings.outline.enabled = true;
		const text = body?.kind === "prose" ? body.text : "";
		expect(text).toMatch(/^From this session's behavior page `[^`]+`:\n/);
		expect(text).toContain("Never force-push.");
		expect(text).not.toContain("not all shown");
	});

	test("a fork's cut note is in the fork owner's language", async () => {
		const parent = await session();
		const pageId = await seedBehaviorPage(parent, "Rule zero.");
		const space = await ensureSessionSpace(parent);
		for (let i = 0; i < 260; i += 150) {
			await writeOutline({
				spaceId: space.id,
				ops: Array.from({ length: Math.min(150, 260 - i) }, (_, n) => ({
					op: "insert" as const,
					parent: { id: pageId },
					content: `Rule ${i + n + 1}`,
				})),
				actor: { kind: "human", id: "pat" },
				responsibleUserId: null,
			});
		}
		const [parentPage] = await outlineStore.getBlocks([pageId]);
		const child = await session({ owner: await user("zh-CN") });
		expect(await copyOutlineBehaviorPage(parent, child)).toBe(true);
		const kids = await pageChildren(child);
		expect(kids[0]).toMatch(/^fork 时只复制了这一页 262 块中的 \d+ 块；其余的在行为边界页 `/);
		expect(kids[0]).toContain(`${space.key}/${parentPage?.sid}`);
	});
});
