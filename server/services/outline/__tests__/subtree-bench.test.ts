/**
 * Benchmark of the reads that know no page (`subtree-read.ts`, `subtree-marks.ts`) through the
 * production SQLite store, on a synthetic space of 100,000 blocks with 450 open tasks and 300
 * open questions spread over it. Reports numbers; asserts nothing about time, only that no
 * read takes more level rows than its budget.
 *
 *   OUTLINE_BENCH=1 bun test --isolate server/services/outline/__tests__/subtree-bench.test.ts
 *
 * The plan left one thing to measure here: counting what is under a block from the space's
 * open things ("candidates first") instead of walking the subtree.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`. The space is seeded with plain SQL
 * (foreign keys off for the seed: its versions name no commit rows).
 */
import { describe, expect, test } from "bun:test";
import { sqlite } from "../../../db";
import type { OutlineSpaceRow } from "../store/port";
import { sqliteOutlineStore as store } from "../store/sqlite-store";
import { readOutlineMarks } from "../subtree-marks";
import { readOutlineLevels, readOutlineSubtree } from "../subtree-read";

const ENABLED = process.env.OUTLINE_BENCH === "1";
const BLOCKS = 100_000;
const SPACE = "bench-subtree-space";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Seeded {
	wide: string;
	big: string;
	deep: string[];
	sample: string[];
	lastSeq: number;
}

/**
 * 400 top-level blocks; one with 5,000 children; one with a 20,000-block subtree (fan-out 20);
 * the rest under random earlier blocks. A tenth of the blocks were rewritten once.
 */
function seed(): Seeded {
	const rnd = mulberry32(20261115);
	const id = () => {
		let out = "";
		for (let i = 0; i < 21; i++) out += ALPHABET[Math.floor(rnd() * 64)];
		return out;
	};
	const insertBlock = sqlite.prepare(
		`INSERT INTO outline_blocks (id, space_id, sid, parent_id, page_id, order_key, content,
			content_hash, author_kind, author_id, version_seq, deleted, in_process, task_json, ask_json)
		 VALUES (?, '${SPACE}', ?, ?, ?, ?, ?, 'h', 'human', 'u', ?, 0, 0, ?, ?)`,
	);
	const insertVersion = sqlite.prepare(
		`INSERT INTO outline_block_versions (block_id, from_seq, to_seq, commit_id, page_id,
			parent_id, order_key, content, content_hash, change_flags, deleted, task_json, ask_json)
		 VALUES (?, ?, NULL, 'c', ?, ?, ?, ?, 'h', ?, 0, ?, ?)`,
	);
	const closeVersion = sqlite.prepare(
		"UPDATE outline_block_versions SET to_seq = ? WHERE block_id = ? AND to_seq IS NULL",
	);
	const insertEdge = sqlite.prepare(
		"INSERT INTO outline_block_edges (parent_key, block_id, from_seq, to_seq, order_key) VALUES (?, ?, ?, NULL, ?)",
	);
	const insertMark = sqlite.prepare(
		"INSERT OR IGNORE INTO outline_subtree_changes (ancestor_id, seq) VALUES (?, ?)",
	);
	const insertQuestion = sqlite.prepare(
		`INSERT INTO outline_questions (block_id, space_id, state, proceed, created_at)
		 VALUES (?, '${SPACE}', 'open', 0, '2026-11-15T00:00:00.000Z')`,
	);
	const body = "Some text of a block, about as long as a short paragraph of notes would be. ";
	const parentOf = new Map<string, string | null>();
	const keyOf = new Map<string, string>();
	const ids: string[] = [];
	let seq = 0;
	const TASK = JSON.stringify({ status: "todo", assignee: null });
	const DOING = JSON.stringify({ status: "doing", assignee: null });
	const ASK = JSON.stringify({ to: { kind: "human", id: "someone" }, recommend: {} });
	const create = (parent: string | null, kind: "plain" | "todo" | "doing" | "ask" = "plain") => {
		const blockId = id();
		seq++;
		const key = `a${String(Math.floor(rnd() * 1e8)).padStart(8, "0")}`;
		const task = kind === "todo" ? TASK : kind === "doing" ? DOING : null;
		const ask = kind === "ask" ? ASK : null;
		parentOf.set(blockId, parent);
		keyOf.set(blockId, key);
		ids.push(blockId);
		insertBlock.run(blockId, id().slice(0, 8), parent, blockId, key, body, seq, task, ask);
		insertVersion.run(blockId, seq, blockId, parent, key, body, 1, task, ask);
		insertEdge.run(parent ?? SPACE, blockId, seq, key);
		if (kind === "ask") insertQuestion.run(blockId);
		return blockId;
	};
	let wide = "";
	let big = "";
	const deep: string[] = [];
	sqlite.run("PRAGMA foreign_keys = OFF");
	try {
		sqlite.transaction(() => {
			sqlite.run(
				`INSERT INTO outline_spaces (id, key, kind, next_seq, created_at, edges_ready)
				 VALUES ('${SPACE}', 'bnsb', 'personal', 1, '2026-11-15T00:00:00.000Z', 1)`,
			);
			const tops: string[] = [];
			for (let i = 0; i < 400; i++) tops.push(create(null));
			wide = tops[0] as string;
			big = tops[1] as string;
			for (let i = 0; i < 5000; i++) create(wide);
			const level = [big];
			for (let made = 0, at = 0; made < 20_000; at++) {
				const parent = level[at] as string;
				for (let k = 0; k < 20 && made < 20_000; k++, made++) level.push(create(parent));
			}
			deep.push(...level.slice(1, 21));
			const ordinary = tops.slice(2);
			let open = 0;
			let asks = 0;
			while (ids.length < BLOCKS) {
				const parent = ordinary[Math.floor(rnd() ** 2 * ordinary.length)] as string;
				// Open things spread over the whole space, some inside the big subtree.
				const pick = rnd();
				const kind =
					open < 450 && pick < 0.012
						? rnd() < 0.3
							? "doing"
							: "todo"
						: asks < 300 && pick > 0.994
							? "ask"
							: "plain";
				if (kind === "todo" || kind === "doing") open++;
				if (kind === "ask") asks++;
				const under =
					kind !== "plain" && rnd() < 0.3
						? (level[Math.floor(rnd() * level.length)] as string)
						: parent;
				const made = create(under, kind);
				if (kind === "plain" && rnd() < 0.35) ordinary.push(made);
			}
			for (const blockId of ids) {
				if (rnd() >= 0.1) continue;
				seq++;
				closeVersion.run(seq, blockId);
				const row = sqlite
					.query("SELECT task_json, ask_json FROM outline_blocks WHERE id = ?")
					.get(blockId) as { task_json: string | null; ask_json: string | null };
				insertVersion.run(
					blockId,
					seq,
					blockId,
					parentOf.get(blockId) ?? null,
					keyOf.get(blockId) as string,
					`${body} Rewritten.`,
					2,
					row.task_json,
					row.ask_json,
				);
				sqlite.run("UPDATE outline_blocks SET content = ?, version_seq = ? WHERE id = ?", [
					`${body} Rewritten.`,
					seq,
					blockId,
				]);
				for (let at = parentOf.get(blockId) ?? null; at !== null; at = parentOf.get(at) ?? null)
					insertMark.run(at, seq);
			}
			sqlite.run(`UPDATE outline_spaces SET next_seq = ? WHERE id = '${SPACE}'`, [seq + 1]);
		})();
	} finally {
		sqlite.run("PRAGMA foreign_keys = ON");
	}
	const sample: string[] = [];
	for (let i = 0; i < 100; i++) sample.push(ids[Math.floor(rnd() * 30_000)] as string);
	return { wide, big, deep, sample: [...new Set(sample)], lastSeq: seq };
}

function percentiles(samples: number[]): [number, number] {
	const sorted = [...samples].sort((a, b) => a - b);
	const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
	return [at(0.5), at(0.95)];
}

describe.skipIf(!ENABLED)("outline reads by block: timings on 100,000 blocks", () => {
	test("subtree, levels and marks through the service", async () => {
		const seeded = seed();
		const space = (await store.getSpace(SPACE)) as OutlineSpaceRow;
		let rows = 0;
		const counted = new Proxy(store, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (prop !== "listLevel" && prop !== "listLevels") return value;
				return async (...args: unknown[]) => {
					const result = await (value as (...a: unknown[]) => Promise<{ rows: unknown[] }>).apply(
						target,
						args,
					);
					rows += result.rows.length;
					return result;
				};
			},
		});
		const results: Array<[string, [number, number], number]> = [];
		const run = async (name: string, runs: number, fn: (i: number) => Promise<unknown>) => {
			for (let i = 0; i < 5; i++) await fn(i);
			const samples: number[] = [];
			let most = 0;
			for (let i = 0; i < runs; i++) {
				rows = 0;
				const start = performance.now();
				await fn(i);
				samples.push(performance.now() - start);
				most = Math.max(most, rows);
			}
			results.push([name, percentiles(samples), most]);
			expect(most).toBeLessThanOrEqual(800);
		};
		const asOf = () => seeded.lastSeq - Math.floor(Math.random() * 5000);
		const all = { view: "all" as const, store: counted };
		await run("subtree now, 800 of 20,000, with content", 40, () =>
			readOutlineSubtree({ space, rootId: seeded.big, budget: { blocks: 800 }, ...all }),
		);
		await run("subtree as of a seq, 800 of 20,000, with content", 40, () =>
			readOutlineSubtree({
				space,
				rootId: seeded.big,
				asOf: asOf(),
				budget: { blocks: 800 },
				...all,
			}),
		);
		await run("subtree now, 800 of the whole space", 40, () =>
			readOutlineSubtree({ space, rootId: null, budget: { blocks: 800 }, ...all }),
		);
		await run("subtree as of a seq, 800 of the whole space", 40, () =>
			readOutlineSubtree({ space, rootId: null, asOf: asOf(), budget: { blocks: 800 }, ...all }),
		);
		await run("subtree now, folded, 400 of 20,000", 40, () =>
			readOutlineSubtree({
				space,
				rootId: seeded.big,
				budget: { blocks: 400 },
				fold: { expanded: new Set(), collapsed: new Set() },
				...all,
			}),
		);
		await run("a block four levels down as a root, with its path", 60, (i) =>
			readOutlineSubtree({
				space,
				rootId: seeded.deep[i % seeded.deep.length] as string,
				budget: { blocks: 50 },
				...all,
			}),
		);
		await run("one level now, 50 of 5,000 children", 80, () =>
			readOutlineLevels({ space, parents: [{ parentId: seeded.wide }], limit: 50, store: counted }),
		);
		await run("one level as of a seq, 50 of 5,000 children", 80, () =>
			readOutlineLevels({
				space,
				parents: [{ parentId: seeded.wide }],
				asOf: asOf(),
				limit: 50,
				store: counted,
			}),
		);
		await run("levels of 20 parents now, 400 rows", 60, () =>
			readOutlineLevels({
				space,
				parents: seeded.deep.map((parentId) => ({ parentId })),
				limit: 400,
				store: counted,
			}),
		);
		const keys = [SPACE, seeded.big, seeded.wide, ...seeded.sample].slice(0, 100);
		let marks = await readOutlineMarks({ space, keys, store });
		await run("marks of 100 blocks (450 open tasks, 300 open questions)", 60, async () => {
			marks = await readOutlineMarks({ space, keys, store });
		});
		await run("marks of 100 blocks, with changed since 5,000 commits ago", 60, () =>
			readOutlineMarks({ space, keys, since: seeded.lastSeq - 5000, store }),
		);
		await run("marks of one block", 100, () =>
			readOutlineMarks({ space, keys: [seeded.big], store }),
		);
		const whole = marks.marks.find((mark) => mark.key === SPACE);
		const ofBig = marks.marks.find((mark) => mark.key === seeded.big);
		console.log(
			[
				`[outline reads by block, SQLite, ${BLOCKS.toLocaleString("en-US")} blocks] p50 / p95 ms (most level rows of a call)`,
				...results.map(
					([name, [p50, p95], most]) =>
						`  ${name}: ${p50.toFixed(2)} / ${p95.toFixed(2)} (${most})`,
				),
				`  marks: space ${JSON.stringify(whole)}, the 20,000-block subtree ${JSON.stringify(ofBig)}, atLeast ${marks.atLeast}`,
			].join("\n"),
		);
		expect(whole?.questions).toBe(300);
	}, 600_000);
});
