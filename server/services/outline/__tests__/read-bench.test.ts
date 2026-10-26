/**
 * As-of read benchmark on the real SQLite tables and store: a 2000-block page with about ten
 * versions per block (the P0 target: a page as of a seq, p95 within 15 ms warm), a larger page
 * read through the workers, and the rendering cost. Reports numbers; asserts nothing about time.
 *
 *   OUTLINE_BENCH=1 bun test --isolate server/services/outline/__tests__/read-bench.test.ts
 */
import { describe, expect, test } from "bun:test";
import { db } from "../../../db";
import { users } from "../../../db/schema";
import { generateId } from "../../../lib/id";
import { loadBodies, readOutline, readPageState } from "../read";
import { renderOutline } from "../render";
import { sqliteOutlineStore as store } from "../store/sqlite-store";
import { breadthFirst, type OutlineNode } from "../tree";
import { type OutlineOp, writeOutline } from "../write";

const ENABLED = process.env.OUTLINE_BENCH === "1";
const NOW = "2026-10-26T00:00:00.000Z";

function percentiles(samples: number[]) {
	const sorted = [...samples].sort((a, b) => a - b);
	const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
	const round = (n: number) => Math.round(n * 100) / 100;
	return { p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1) ?? 0) };
}

async function time(runs: number, fn: (i: number) => Promise<unknown> | unknown) {
	for (let i = 0; i < 5; i++) await fn(i);
	const samples: number[] = [];
	for (let i = 0; i < runs; i++) {
		const start = performance.now();
		await fn(i);
		samples.push(performance.now() - start);
	}
	return percentiles(samples);
}

/** A page of `blocks` blocks (page included), `versions` versions per block on average. */
async function buildPage(blocks: number, versions: number) {
	const owner = generateId();
	await db.insert(users).values({
		id: owner,
		username: `bench-${owner}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	const space = await store.ensureSpace({ kind: "personal", ownerUserId: owner }, NOW);
	const write = (ops: OutlineOp[]) =>
		writeOutline(
			{ spaceId: space.id, ops, actor: { kind: "agent", id: "bench" }, responsibleUserId: null },
			{ store },
		);
	const text = (i: number, round: number) =>
		`Block ${i} rev ${round}: ${"the refresh token is stored server side and rotated ".repeat(1 + (i % 6))}`;
	const page = (await write([{ op: "insert", parent: null, content: "Bench page" }])).results[0]
		?.blockId as string;
	// Sections of 20 under the page, items under sections: three levels.
	const ids: string[] = [];
	const sections: string[] = [];
	for (let made = 1; made < blocks; ) {
		const ops: OutlineOp[] = [];
		for (let k = 0; k < 200 && made < blocks; k++, made++) {
			const section = made % 21 === 1 || sections.length === 0;
			ops.push({
				op: "insert",
				parent: { id: section ? page : (sections.at(-1) as string) },
				content: text(made, 0),
				...(made % 37 === 0 ? { task: { status: "todo" as const } } : {}),
			});
			if (section) {
				// The section's id is known after the write; flush so children can name it.
				const r = await write(ops.splice(0));
				const id = r.results.at(-1)?.blockId as string;
				sections.push(id);
				ids.push(...r.results.map((x) => x.blockId));
			}
		}
		if (ops.length > 0) ids.push(...(await write(ops)).results.map((x) => x.blockId));
	}
	for (let round = 1; round < versions; round++) {
		for (let i = 0; i < ids.length; i += 200) {
			await write(
				ids.slice(i, i + 200).map((id, k) => ({
					op: "update" as const,
					block: { id },
					content: text(i + k + 1, round),
				})),
			);
		}
	}
	const last = ((await store.getSpace(space.id))?.nextSeq ?? 1) - 1;
	return { page, last };
}

describe("outline as-of read benchmark", () => {
	if (!ENABLED) {
		test("skipped: set OUTLINE_BENCH=1 to run the benchmark", () => {
			expect(process.env.OUTLINE_BENCH).not.toBe("1");
		});
		return;
	}

	test("2000-block page, ~10 versions per block", async () => {
		const built = performance.now();
		const { page, last } = await buildPage(2000, 10);
		const buildMs = Math.round(performance.now() - built);
		// Seqs spread over the last two thirds of the history (every block exists by then).
		const from = Math.floor(last / 3);
		const asOf = (i: number) => from + ((i * 7919) % (last - from + 1));
		const state = await readPageState(page, { asOf: last, store });
		const blocks = state?.nodes.size ?? 0;
		const versions = (await store.listPageVersions(page, { limit: 100_000 })).length;

		const structure = await time(200, (i) =>
			store.listPageStructure(page, { asOf: asOf(i), limit: 10_000 }),
		);
		const viewport = await time(100, async (i) => {
			const s = await readPageState(page, { asOf: asOf(i), store });
			await loadBodies(
				s as NonNullable<typeof s>,
				breadthFirst(s?.page as OutlineNode, "all", 500),
				{
					store,
				},
			);
		});
		const whole = await time(50, async (i) => {
			const s = await readPageState(page, { asOf: asOf(i), store });
			await loadBodies(s as NonNullable<typeof s>, [...(s?.nodes.values() ?? [])], { store });
		});
		const current = await time(100, async () => {
			const s = await readPageState(page, { store });
			await loadBodies(
				s as NonNullable<typeof s>,
				breadthFirst(s?.page as OutlineNode, "all", 500),
				{
					store,
				},
			);
		});
		const agent = await time(100, (i) => readOutline({ blockId: page, asOf: asOf(i), store }));
		const full = await readPageState(page, { asOf: last, store });
		await loadBodies(full as NonNullable<typeof full>, [...(full?.nodes.values() ?? [])], {
			store,
		});
		const root = full?.page as OutlineNode;
		const renderAll = await time(50, () =>
			renderOutline(root, { view: "all", budget: { blocks: 2000, bytes: 256 * 1024 } }),
		);
		const renderAgent = await time(200, () => renderOutline(root, {}));
		console.log(
			JSON.stringify(
				{
					page: { blocks, versions, commits: last, buildMs },
					"structure as of T (ms)": structure,
					"viewport: structure + 500 bodies as of T (ms)": viewport,
					"whole page: structure + all bodies as of T (ms)": whole,
					"current viewport, no history (ms)": current,
					"readOutline, agent budget, as of T (ms)": agent,
					"render whole page, 2000 blocks / 256 KiB (ms)": renderAll,
					"render agent budget, 80 blocks / 16 KiB (ms)": renderAgent,
				},
				null,
				1,
			),
		);
		expect(blocks).toBe(2000);
	}, 600_000);

	test("6000-block page read on the workers", async () => {
		const { page, last } = await buildPage(6000, 2);
		const structure = await time(30, () =>
			store.listPageStructure(page, { asOf: last, limit: 10_000 }),
		);
		const current = await time(30, () =>
			store.listPageStructure(page, { asOf: null, limit: 10_000 }),
		);
		const agent = await time(30, () => readOutline({ blockId: page, asOf: last, store }));
		console.log(
			JSON.stringify(
				{
					"6000 blocks: structure as of T, workers (ms)": structure,
					"6000 blocks: current structure, workers (ms)": current,
					"6000 blocks: readOutline agent budget as of T (ms)": agent,
				},
				null,
				1,
			),
		);
	}, 600_000);
});
