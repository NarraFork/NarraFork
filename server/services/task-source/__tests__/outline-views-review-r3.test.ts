/**
 * Regressions from PR 4's third review (outline P2): each case is seeded from the reviewer's
 * round-3 probe of the same name and asserts the corrected behavior.
 *
 *   S-R3-1  the behavior page is rendered fairly: every block gets a share of the budget (whole
 *           when shorter), so one long block never hides the rules after it; what the short ones
 *           leave goes to the long ones; a page of more rules than fit shows them whole, in order;
 *   S-R3-2  with the outline off, the page in the spec fence has a budget of its own (30k
 *           characters, injected on the spec cadence like the whole old fence was), the same
 *           fairness, and a note that points at nothing the agent cannot read;
 *   N-R3-2  an oversize item is cut at grapheme boundaries and loses no character.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ContextPart } from "@shared/prefix-context";
import { db } from "../../../db";
import { narrators } from "../../../db/schema";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import { ensureSessionSpace } from "../../outline/spaces";
import { writeOutline } from "../../outline/write";
import { buildBehaviorFenceBody } from "../../spec-reminder";
import { writeSpecFile } from "../../spec-vfs-service";
import { taskSourceForNarrator } from "../index";
import {
	cutToBlocks,
	importOutlineBehaviorFence,
	resetOutlineBehaviorImport,
} from "../outline-behavior";
import { OUTLINE_VIEW_LIMITS, resetOutlineViewCache } from "../outline-views";
import { seedBehaviorPage } from "./outline-task-source-scenarios";

const NOW = "2026-11-03T00:00:00.000Z";

beforeEach(() => {
	settings.outline.enabled = true;
	resetOutlineViewCache();
	resetOutlineBehaviorImport();
});
afterEach(() => {
	settings.outline.enabled = true;
	resetOutlineViewCache();
});

async function session(): Promise<string> {
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
		taskBackend: "outline",
		ownerUserId: null,
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

async function view(narratorId: string): Promise<string> {
	const parts: ContextPart[] = await (await taskSourceForNarrator(narratorId)).contextParts("en");
	return parts.find((p) => p.key === "outline.behavior" && !p.unreadable)?.text ?? "";
}

/** The spec fence's text with the outline switched off. */
async function switchedOffFence(narratorId: string): Promise<string> {
	settings.outline.enabled = false;
	try {
		const body = await buildBehaviorFenceBody(narratorId);
		return body?.kind === "prose" ? body.text : "";
	} finally {
		settings.outline.enabled = true;
	}
}

/** A person adds blocks under `parent`, in order. */
async function personAdds(narratorId: string, parent: string, contents: string[]): Promise<void> {
	const space = await ensureSessionSpace(narratorId);
	for (let i = 0; i < contents.length; i += 150) {
		await writeOutline({
			spaceId: space.id,
			ops: contents.slice(i, i + 150).map((content) => ({
				op: "insert" as const,
				parent: { id: parent },
				content,
			})),
			actor: { kind: "human", id: "pat" },
			responsibleUserId: null,
		});
	}
}

const paragraph = `Background: ${"long context paragraph ".repeat(300)}`.trim();

describe("S-R3-1: one long block does not hide the rules after it (probe R3-5)", () => {
	test("a long first rule shows its start; the short rules after it are shown whole", async () => {
		const id = await session();
		const pageId = await seedBehaviorPage(id, paragraph);
		await personAdds(id, pageId, [
			"Never force-push the main branch.",
			"Ask before deleting files.",
		]);
		const text = await view(id);
		expect(text.length).toBeLessThanOrEqual(OUTLINE_VIEW_LIMITS.behaviorChars);
		expect(text).toContain("  - Never force-push the main branch.\n");
		expect(text).toContain("  - Ask before deleting files.\n");
		expect(text).toContain("  - Background: long context paragraph");
		expect(text).toContain("…\n");
		// What the short rules leave goes to the long one: the budget is used, not wasted.
		expect(text.length).toBeGreaterThan(OUTLINE_VIEW_LIMITS.behaviorChars - 200);
		expect(text).toMatch(/\n‹not all shown: 1 block is shortened or left out; read `[^`]+`/);
	});

	test("an imported fence that opens with a long paragraph (probe R3-6)", async () => {
		const id = await session();
		await oldFence(
			id,
			[
				`Context: ${"this team ships to production from main every day and ".repeat(80)}`,
				"",
				"- Never force-push the main branch.",
				"- Ask before deleting files.",
			].join("\n"),
		);
		expect(await importOutlineBehaviorFence(id, "en")).toBe("imported");
		const text = await view(id);
		expect(text.length).toBeLessThanOrEqual(OUTLINE_VIEW_LIMITS.behaviorChars);
		expect(text).toContain("Never force-push the main branch.");
		expect(text).toContain("Ask before deleting files.");
		expect(text).toContain("Context: this team ships");
	});

	test("an oversize item imported as several blocks does not hide the rules after it", async () => {
		const id = await session();
		await oldFence(
			id,
			Array.from({ length: 20 }, (_, n) =>
				n === 2 ? `- Rule ${n} ${"x".repeat(17 * 1024)}` : `- Rule ${n}`,
			).join("\n"),
		);
		expect(await importOutlineBehaviorFence(id, "en")).toBe("imported");
		const text = await view(id);
		expect(text.length).toBeLessThanOrEqual(OUTLINE_VIEW_LIMITS.behaviorChars);
		for (let n = 0; n < 20; n++) expect(text).toContain(`  - Rule ${n}`);
		expect(text).toContain("  - Rule 19\n");
		// Both pieces of the long rule are shown with their start.
		expect(text.match(/ x+…\n|\n {2}- x+…\n/g)?.length).toBe(2);
	});

	test("two long blocks share what the short ones leave, about evenly", async () => {
		const id = await session();
		const pageId = await seedBehaviorPage(id, `First: ${"a".repeat(3000)}`);
		await personAdds(id, pageId, ["Rule one.", `Second: ${"b".repeat(3000)}`, "Rule two."]);
		const text = await view(id);
		expect(text.length).toBeLessThanOrEqual(OUTLINE_VIEW_LIMITS.behaviorChars);
		const first = text.match(/First: (a+)…/)?.[1]?.length ?? 0;
		const second = text.match(/Second: (b+)…/)?.[1]?.length ?? 0;
		expect(first).toBeGreaterThan(1200);
		expect(Math.abs(first - second)).toBeLessThanOrEqual(2);
		expect(text).toContain("  - Rule one.\n");
		expect(text).toContain("  - Rule two.\n");
		expect(text).toMatch(/\n‹not all shown: 2 blocks are shortened or left out;/);
	});

	test("a page of more rules than fit shows them whole, in order, and counts the rest", async () => {
		const id = await session();
		const pageId = await seedBehaviorPage(id, "Rule zero.");
		await personAdds(
			id,
			pageId,
			Array.from(
				{ length: 300 },
				(_, n) => `Rule ${n}: ${"keep this constraint ".repeat(4).trim()}`,
			),
		);
		const text = await view(id);
		expect(text.length).toBeLessThanOrEqual(OUTLINE_VIEW_LIMITS.behaviorChars);
		const shown = text.split("\n").filter((line) => /^ {2}- Rule \d+:/.test(line));
		expect(shown.length).toBeGreaterThan(30);
		for (const line of shown) expect(line.endsWith("keep this constraint")).toBe(true);
		const hidden = Number(text.match(/‹… (\d+) more›/)?.[1]);
		expect(hidden).toBe(300 - shown.length);
		expect(text).toContain(`‹not all shown: ${hidden} blocks are shortened or left out;`);
	});

	test("on a page of more rules than fit, a long block costs about what a typical rule does", async () => {
		const id = await session();
		const pageId = await seedBehaviorPage(id, "Rule zero.");
		const rules = Array.from({ length: 240 }, (_, n) => `Old rule ${n}`);
		const withLong = [...rules.slice(0, 50), paragraph, ...rules.slice(50)];
		await personAdds(id, pageId, withLong);
		const text = await view(id);
		expect(text.length).toBeLessThanOrEqual(OUTLINE_VIEW_LIMITS.behaviorChars);
		const shown = text.split("\n").filter((line) => /^ {2}- Old rule \d+$/.test(line)).length;
		// About 215 short rules fit the view; the paragraph takes the place of a few, not dozens.
		expect(shown).toBeGreaterThan(200);
		expect(text).toMatch(/\n {2}- Background: long context paragraph[^\n]{0,80}…\n/);
		expect(text).toContain(`  - Old rule ${shown - 1}\n`);
		expect(text).toContain(`‹… ${240 - shown} more›`);
	});

	test("a block cut inside a code fence does not leave the fence open", async () => {
		const id = await session();
		const code = Array.from({ length: 300 }, (_, n) => `const value${n} = ${n};`).join("\n");
		const pageId = await seedBehaviorPage(id, `Use this setup:\n\n\`\`\`ts\n${code}\n\`\`\``);
		await personAdds(id, pageId, ["Never force-push the main branch."]);
		const text = await view(id);
		expect(text.length).toBeLessThanOrEqual(OUTLINE_VIEW_LIMITS.behaviorChars);
		// The fence opens a block of its own (the normalizer splits it off), after its bullet.
		const fences = text.match(/^\s*(?:- )?```/gm)?.length ?? 0;
		expect(fences).toBe(2);
		expect(text).toMatch(/const value\d+ = \d+;\n {6}const…\n {6}```\n/);
		expect(text).toContain("  - Never force-push the main branch.\n");
	});
});

describe("S-R3-2: the page in the spec fence with the outline off (probe R3-6)", () => {
	test("a page over the view's 4000 characters reaches the spec fence whole", async () => {
		const id = await session();
		const context = `Context: ${"this team ships to production from main every day and ".repeat(80)}`;
		await oldFence(
			id,
			[context, "", "- Never force-push the main branch.", "- Ask before deleting files."].join(
				"\n",
			),
		);
		const before = await switchedOffFence(id);
		expect(await importOutlineBehaviorFence(id, "en")).toBe("imported");
		const off = await switchedOffFence(id);
		expect(before).toContain("Never force-push");
		expect(off.length).toBeGreaterThan(OUTLINE_VIEW_LIMITS.behaviorChars);
		expect(off).toContain(context.trim());
		expect(off).toContain("Never force-push the main branch.");
		expect(off).toContain("Ask before deleting files.");
		expect(off).not.toContain("not all shown");
		expect(off).not.toContain("shortened or left out");
	});

	test("over its own budget it is fair too, and its note points at the person, not a tool", async () => {
		const id = await session();
		const pageId = await seedBehaviorPage(id, `Background: ${"z".repeat(15_000)}`);
		await personAdds(id, pageId, [`More background: ${"y".repeat(15_000)}`, "Never force-push."]);
		const off = await switchedOffFence(id);
		expect(off.length).toBeLessThanOrEqual(OUTLINE_VIEW_LIMITS.switchedOffChars);
		expect(off.length).toBeGreaterThan(OUTLINE_VIEW_LIMITS.switchedOffChars - 300);
		expect(off).toContain("  - Never force-push.\n");
		expect(off).not.toContain("OutlineRead");
		expect(off).toMatch(
			/\n‹2 blocks of this page are shortened or left out here; the user can see the whole page in the outline›$/,
		);
	});
});

describe("N-R3-2: cutting an oversize item (probe R3-1)", () => {
	const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
	const max = 15 * 1024;
	const shapes: Array<[string, string]> = [
		["CJK without spaces", "规则内容测试中文".repeat(3000)],
		["emoji", "😀".repeat(12000)],
		["spaces only near the start", `${"a ".repeat(50)}${"b".repeat(40000)}`],
		["words", "word ".repeat(10000)],
		["mixed", "中文 abc 😀 ".repeat(4000)],
		["ZWJ family emoji", "👩‍👩‍👧‍👦".repeat(2000)],
		["combining marks", "é̂".repeat(9000)],
	];
	for (const [name, text] of shapes) {
		test(`${name}: within the limit, lossless, never inside a grapheme`, () => {
			const pieces = cutToBlocks(text, max);
			expect(pieces.length).toBeGreaterThan(1);
			expect(pieces.join("")).toBe(text);
			for (const piece of pieces) {
				expect(Buffer.byteLength(piece, "utf8")).toBeLessThanOrEqual(max);
				expect(lone.test(piece)).toBe(false);
			}
			const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
			const whole = [...segmenter.segment(text)].map((s) => s.segment);
			const cut = pieces.flatMap((piece) => [...segmenter.segment(piece)].map((s) => s.segment));
			expect(cut).toEqual(whole);
		});
	}
});
