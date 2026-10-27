/**
 * The editor's conversion (P0 acceptance item 9 of design §6.9): every block the dialect can
 * store goes into the editor and back unchanged, so opening and editing a page never rewrites
 * blocks nobody touched. Random bodies from the dialect's fuzz generators; a copied outline
 * (editor fragment → markdown outline) parses back to the same blocks.
 */
import { describe, expect, test } from "bun:test";
import {
	type Body,
	type OutlineItem,
	parseBlock,
	parseMarkdownOutline,
	serializeBody,
	serializeMarkdownOutline,
} from "@shared/outline";
import {
	FUZZ_TIMEOUT_MS,
	fuzzCount,
	pick,
	randomBody,
	realisticParagraph,
	rng,
} from "@shared/outline/__tests__/fuzz.fixture";
import { Fragment } from "prosemirror-model";
import { fragmentToOutline, outlineToPM, parseToPM, serializePM } from "./convert";
import { schema } from "./schema";

function roundTrip(gen: (r: () => number) => Body, seed: number, n: number): string[] {
	const r = rng(seed);
	const failures: string[] = [];
	for (let i = 0; i < n; i++) {
		// What a block stores is the dialect's canonical form of what was written.
		const stored = serializeBody(parseBlock(serializeBody(gen(r))).body);
		const node = parseToPM(stored).node;
		try {
			node.check();
		} catch (error) {
			failures.push(`invalid node for ${JSON.stringify(stored)}: ${String(error)}`);
			continue;
		}
		const back = serializePM(node);
		if (back !== stored) failures.push(`${JSON.stringify(stored)} → ${JSON.stringify(back)}`);
		if (failures.length >= 5) break;
	}
	return failures;
}

function strip(items: OutlineItem[]): unknown[] {
	return items.map((i) => ({
		content: i.content,
		task: i.task?.status ?? null,
		children: strip(i.children),
	}));
}

describe("editor conversion round trip", () => {
	test(
		"adversarial bodies come back as stored",
		() => {
			const n = fuzzCount(2000);
			const failures = [42, 7, 99, 1234].flatMap((seed) =>
				roundTrip(randomBody, seed, Math.ceil(n / 4)),
			);
			expect(failures).toEqual([]);
		},
		FUZZ_TIMEOUT_MS,
	);

	test(
		"realistic mixed Chinese and English prose comes back as stored",
		() => {
			expect(roundTrip(realisticParagraph, 2026, fuzzCount(1000))).toEqual([]);
		},
		FUZZ_TIMEOUT_MS,
	);

	test(
		"an outline of random blocks survives editor nodes → copy → paste",
		() => {
			const r = rng(31);
			const statuses = [null, "todo", "doing", "done", "cancelled"] as const;
			const failures: string[] = [];
			for (let round = 0; round < fuzzCount(200); round++) {
				const make = (depth: number): OutlineItem[] =>
					Array.from({ length: 1 + Math.floor(r() * 3) }, () => {
						const status = pick(r, statuses);
						return {
							content: serializeBody(parseBlock(serializeBody(realisticParagraph(r))).body),
							task: status ? { status, assignee: null } : null,
							props: {},
							children: depth < 2 && r() < 0.4 ? make(depth + 1) : [],
						};
					});
				const items = make(0);
				let id = 0;
				const nodes = outlineToPM(items, () => `n${id++}`);
				const copied = fragmentToOutline(Fragment.from(nodes));
				expect(strip(copied)).toEqual(strip(items));
				// Through the clipboard's text: the markdown outline parses back to the same items.
				const md = serializeMarkdownOutline(copied);
				const pasted = parseMarkdownOutline(md).items;
				const a = JSON.stringify(strip(pasted));
				const b = JSON.stringify(strip(items));
				if (a !== b && failures.length < 3) failures.push(`${md}\n→ ${a}\n≠ ${b}`);
			}
			expect(failures).toEqual([]);
		},
		FUZZ_TIMEOUT_MS,
	);

	test("every body kind of the schema converts both ways", () => {
		for (const src of [
			"plain",
			"# Title",
			"> quoted *em*",
			"```ts\nlet a = 1;\n```",
			"| a | b |\n| --- | --- |\n| 1 | 2 |",
			"![[K/abc]]",
			"see [[K/abc|label]] and **bold** `code` ~~gone~~ [link](https://example.com)",
			"line one\\\nline two",
		]) {
			const stored = serializeBody(parseBlock(src).body);
			const node = parseToPM(stored).node;
			expect(node.type.schema).toBe(schema);
			expect(serializePM(node)).toBe(stored);
		}
	});
});
