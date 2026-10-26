/**
 * Round-trip fuzz of the dialect against its own parser (marked@18): random body → serialize →
 * parse → serialize must be a fixed point, keep every character, and never gain a mark (marks may
 * only be degraded). Default size keeps the run short; `OUTLINE_FUZZ_N=14000` runs the full set.
 */
import { describe, expect, test } from "bun:test";
import { type Body, canonicalBody, parseBlock, serializeBody } from "../dialect";
import { compareBodies } from "../dialect/safe";
import { FUZZ_TIMEOUT_MS, fuzzCount, randomBody, realisticParagraph, rng } from "./fuzz.fixture";

interface Stats {
	n: number;
	notFixed: number;
	split: number;
	type: number;
	text: number;
	extraMark: number;
	markChanged: number;
}

function run(seed: number, n: number, gen: (r: () => number) => Body, failures: string[]): Stats {
	const r = rng(seed);
	const stats: Stats = { n, notFixed: 0, split: 0, type: 0, text: 0, extraMark: 0, markChanged: 0 };
	for (let i = 0; i < n; i++) {
		const b = gen(r);
		const s1 = serializeBody(b);
		const p = parseBlock(s1);
		const fail = (what: keyof Stats) => {
			stats[what]++;
			if (failures.length < 5) failures.push(`${what}: ${JSON.stringify(s1)}`);
		};
		if (serializeBody(p.body) !== s1) fail("notFixed");
		if (p.extra.length) fail("split");
		if (p.body.type !== b.type) {
			fail("type");
			continue;
		}
		if (b.type === "code" || b.type === "embed") {
			if (JSON.stringify(p.body) !== JSON.stringify(canonicalBody(b))) fail("text");
			continue;
		}
		const cmp = compareBodies(b, p.body);
		if (!cmp.textEqual) {
			fail("text");
			continue;
		}
		stats.extraMark += cmp.extraMarks;
		if (cmp.changed > 0) stats.markChanged++;
	}
	return stats;
}

function total(parts: Stats[]): Stats {
	const t: Stats = { n: 0, notFixed: 0, split: 0, type: 0, text: 0, extraMark: 0, markChanged: 0 };
	for (const s of parts) for (const k of Object.keys(t) as Array<keyof Stats>) t[k] += s[k];
	return t;
}

describe("dialect round-trip fuzz", () => {
	test(
		"adversarial alphabet (punctuation, delimiters, entities, URLs, mentions)",
		() => {
			const n = fuzzCount(2000);
			const seeds = [42, 7, 99, 1234];
			const failures: string[] = [];
			const t = total(
				seeds.map((seed) => run(seed, Math.ceil(n / seeds.length), randomBody, failures)),
			);
			expect(failures).toEqual([]);
			expect(t.extraMark).toBe(0);
			// Marks are degraded in a minority of adversarial cases, never in most of them.
			expect(t.markChanged).toBeLessThan(t.n / 3);
		},
		FUZZ_TIMEOUT_MS,
	);

	test(
		"realistic mixed Chinese/English prose",
		() => {
			const failures: string[] = [];
			const t = run(2026, fuzzCount(1000), realisticParagraph, failures);
			expect(failures).toEqual([]);
			expect(t.extraMark).toBe(0);
			// Marks touching CJK punctuation get moved or dropped in about 30% of these
			// paragraphs; the text never changes.
			expect(t.markChanged).toBeLessThan(t.n / 2);
		},
		FUZZ_TIMEOUT_MS,
	);
});
