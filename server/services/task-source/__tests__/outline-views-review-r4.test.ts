/**
 * Regression from PR 4's fourth review (outline P2), seeded from the reviewer's probe R4-1:
 *
 *   N-R4-1  on a page that does not fit at the minimum share, the share that shows the most
 *           top-level rules' starts is taken: the typical length only when it shows as many as
 *           the minimum does. The note's count stays exact.
 *
 * Every block is written `R{n}: … #END{n}#`, so each can be classed as shown whole, shortened
 * (its start shown) or left out, and the note's count checked against that.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../../db";
import { narrators } from "../../../db/schema";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import { OUTLINE_BEHAVIOR_ALIAS } from "../../outline/model";
import { ensureSessionSpace } from "../../outline/spaces";
import { type OutlineOp, writeOutline } from "../../outline/write";
import { buildBehaviorFenceBody } from "../../spec-reminder";
import { taskSourceForNarrator } from "../index";
import { resetOutlineBehaviorImport } from "../outline-behavior";
import { OUTLINE_VIEW_LIMITS, resetOutlineViewCache } from "../outline-views";

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

/** A deterministic random sequence (the probe's). */
function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

interface Spec {
	length: number;
	children?: Spec[];
}

function contentOf(n: number, length: number): string {
	const filler = "lorem ipsum dolor sit amet ".repeat(Math.ceil(length / 27) + 1).slice(0, length);
	return `R${n}: ${filler} #END${n}#`;
}

/** The page written by a person, level by level; the numbers of its top-level blocks. */
async function buildPage(id: string, specs: Spec[]): Promise<{ blocks: number; tops: number[] }> {
	const space = await ensureSessionSpace(id);
	const page = await writeOutline({
		spaceId: space.id,
		ops: [{ op: "insert", parent: null, content: "PAGE-TITLE#", alias: OUTLINE_BEHAVIOR_ALIAS }],
		actor: { kind: "human", id: "pat" },
		responsibleUserId: null,
	});
	const pageId = page.results[0]?.blockId as string;
	let n = 0;
	const tops: number[] = [];
	let level = specs.map((spec) => ({ spec, parent: pageId }));
	let first = true;
	while (level.length > 0) {
		const next: Array<{ spec: Spec; parent: string }> = [];
		for (let i = 0; i < level.length; i += 100) {
			const chunk = level.slice(i, i + 100);
			const ops: OutlineOp[] = chunk.map(({ spec, parent }) => {
				if (first) tops.push(n);
				return { op: "insert", parent: { id: parent }, content: contentOf(n++, spec.length) };
			});
			const written = await writeOutline({
				spaceId: space.id,
				ops,
				actor: { kind: "human", id: "pat" },
				responsibleUserId: null,
			});
			chunk.forEach(({ spec }, k) => {
				for (const child of spec.children ?? []) {
					next.push({ spec: child, parent: written.results[k]?.blockId as string });
				}
			});
		}
		level = next;
		first = false;
	}
	return { blocks: n, tops };
}

/** What a text shows of each block, and the count its note gives. */
function audit(text: string, blocks: number, tops: number[], note: RegExp) {
	let whole = 0;
	let started = 0;
	for (let n = 0; n < blocks; n++) {
		if (text.includes(`#END${n}#`)) whole++;
		else if (text.includes(`R${n}:`)) started++;
	}
	const notWhole = blocks + 1 - whole - (text.includes("PAGE-TITLE#") ? 1 : 0);
	return {
		topStarts: tops.filter((n) => text.includes(`R${n}:`)).length,
		whole,
		started,
		notWhole,
		noted: Number(note.exec(text)?.[1] ?? 0),
	};
}

const viewNote = /not all shown: (\d+) blocks? (?:is|are)/;
const fenceNote = /‹(\d+) blocks? of this page/;

async function views(id: string) {
	const parts = await (await taskSourceForNarrator(id)).contextParts("en");
	const view = parts.find((p) => p.key === "outline.behavior")?.text ?? "";
	settings.outline.enabled = false;
	const body = await buildBehaviorFenceBody(id);
	settings.outline.enabled = true;
	return { view, off: body?.kind === "prose" ? body.text : "" };
}

describe("N-R4-1: an over-full page shows the most rules' starts it can (probe R4-1)", () => {
	test("50 mixed (10–3000 characters): about 40 starts, not 10", async () => {
		const r = rng(7);
		const id = await session();
		const { blocks, tops } = await buildPage(
			id,
			Array.from({ length: 50 }, () => ({ length: Math.floor(10 + r() * 3000) })),
		);
		const { view, off } = await views(id);
		expect(view.length).toBeLessThanOrEqual(OUTLINE_VIEW_LIMITS.behaviorChars);
		const on = audit(view, blocks, tops, viewNote);
		// Round 4 found 10 rules shown and 40 left out with the typical-length share.
		expect(on.topStarts).toBeGreaterThanOrEqual(35);
		expect(on.noted).toBe(on.notWhole);
		const fence = audit(off, blocks, tops, fenceNote);
		expect(off.length).toBeLessThanOrEqual(OUTLINE_VIEW_LIMITS.switchedOffChars);
		expect(fence.topStarts).toBe(50);
		expect(fence.noted).toBe(fence.notWhole);
	});

	test("nested 20×5: every top-level rule's start, then what fits of their children", async () => {
		const r = rng(11);
		const id = await session();
		const { blocks, tops } = await buildPage(
			id,
			Array.from({ length: 20 }, () => ({
				length: Math.floor(10 + r() * 400),
				children: Array.from({ length: 5 }, () => ({ length: Math.floor(10 + r() * 800) })),
			})),
		);
		const { view, off } = await views(id);
		expect(view.length).toBeLessThanOrEqual(OUTLINE_VIEW_LIMITS.behaviorChars);
		const on = audit(view, blocks, tops, viewNote);
		// Round 4 found 15 of the 20 with the typical-length share.
		expect(on.topStarts).toBe(20);
		expect(on.started + on.whole).toBeGreaterThan(20);
		expect(on.noted).toBe(on.notWhole);
		const fence = audit(off, blocks, tops, fenceNote);
		expect(fence.topStarts).toBe(20);
		expect(fence.noted).toBe(fence.notWhole);
	});

	test("the typical length is kept when it shows every top-level start too", async () => {
		// Ten short rules with thirty children each, about 100 characters: all ten starts fit
		// either way, so the children are shown whole (the typical length) rather than cut to 80.
		const id = await session();
		const { blocks, tops } = await buildPage(
			id,
			Array.from({ length: 10 }, () => ({
				length: 20,
				children: Array.from({ length: 30 }, () => ({ length: 85 })),
			})),
		);
		const { view } = await views(id);
		expect(view.length).toBeLessThanOrEqual(OUTLINE_VIEW_LIMITS.behaviorChars);
		const on = audit(view, blocks, tops, viewNote);
		expect(on.topStarts).toBe(10);
		expect(on.started).toBe(0);
		expect(on.whole).toBeGreaterThan(10);
		expect(on.noted).toBe(on.notWhole);
	});
});
