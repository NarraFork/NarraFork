/**
 * Measurements of a live session's text model on the largest page a session takes (2,000 blocks):
 * what opening the session and one person's first snapshot cost, in time and memory. Skipped
 * unless `NF_OUTLINE_LIVE_BENCH=1`; prints a report, asserts nothing about the numbers.
 *
 *   NF_OUTLINE_LIVE_BENCH=1 bun test --isolate server/services/outline/live/__tests__/live-text-bench.test.ts
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */

import { heapStats } from "bun:jsc";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { LIVE_FRAME } from "@shared/outline-live-protocol";
import { db } from "../../../../db";
import { projects, users } from "../../../../db/schema";
import { generateId } from "../../../../lib/id";
import { settings } from "../../../../lib/settings";
import { ensureProjectSpace } from "../../spaces";
import type { OutlineSpaceRow } from "../../store/port";
import { writeOutline } from "../../write";
import { closeAllLiveSessions, liveSessionOf } from "../registry";
import { client, forget, settle, TestLink, type, waitFor } from "./harness";

const BENCH = process.env.NF_OUTLINE_LIVE_BENCH === "1";
const NOW = "2026-11-14T00:00:00.000Z";
const BLOCKS = 2000;

let owner: string;
let space: OutlineSpaceRow;

const heapMB = () => {
	Bun.gc(true);
	return heapStats().heapSize / 1048576;
};

beforeAll(async () => {
	if (!BENCH) return;
	settings.outline.enabled = true;
	owner = generateId();
	await db.insert(users).values({
		id: owner,
		username: `bench-${owner}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Live text bench",
		ownerUserId: owner,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	space = await ensureProjectSpace(projectId);
});

afterAll(async () => {
	if (BENCH) await closeAllLiveSessions("ended");
});

test.skipIf(!BENCH)(
	"a 2,000-block page: session open, first snapshot, memory",
	async () => {
		const words = ["大纲", "块模型", "真相", "编辑器", "live", "session", "**粗体**", "`code`"];
		const textOf = (i: number) =>
			Array.from({ length: 4 + (i % 9) }, (_, k) => words[(i + k) % words.length]).join(" ");
		const pageIds: string[] = [];
		const firstBlock: string[] = [];
		const ROUNDS = 5;
		for (let round = 0; round < ROUNDS; round++) {
			let pageId = "";
			for (let at = 0; at < BLOCKS - 1; at += 150) {
				const n = Math.min(150, BLOCKS - 1 - at);
				const r = await writeOutline({
					spaceId: space.id,
					ops: [
						...(at === 0
							? [{ op: "insert" as const, tempId: "p", parent: null, content: "Bench" }]
							: []),
						...Array.from({ length: n }, (_, i) => ({
							op: "insert" as const,
							tempId: `b${i}`,
							parent: at === 0 ? { tempId: "p" } : { id: pageId },
							content: textOf(at + i),
						})),
					],
					actor: { kind: "human", id: owner },
					responsibleUserId: owner,
				});
				if (at === 0) {
					pageId = r.results[0]?.blockId as string;
					firstBlock.push(r.results[1]?.blockId as string);
				}
			}
			pageIds.push(pageId);
		}
		const openMs: number[] = [];
		const snapshotBytes: number[] = [];
		const serverHeap: number[] = [];
		const clientHeap: number[] = [];
		const typed: number[] = [];
		for (let round = 0; round < ROUNDS; round++) {
			const pageId = pageIds[round] as string;
			const h0 = heapMB();
			const link = new TestLink(owner, "bench");
			const t0 = performance.now();
			const c = client(link, pageId);
			await waitFor(() => c.ready, 20_000, "the first snapshot");
			openMs.push(performance.now() - t0);
			expect(c.visible.children(pageId).length).toBe(BLOCKS - 1);
			const joined = link.socket.sent.find((f) => f.kind === LIVE_FRAME.joined);
			snapshotBytes.push(link.bytesDown);
			expect(joined).toBeDefined();
			// Both ends live in this process: the session and one client's copy.
			const both = heapMB() - h0;
			expect(liveSessionOf(pageId)).toBeDefined();
			const t1 = performance.now();
			type(c, firstBlock[round] as string, "x".repeat(200));
			await settle();
			typed.push(performance.now() - t1);
			serverHeap.push(both);
			c.dispose();
			forget(c);
			link.disconnect();
			await settle();
			clientHeap.push(heapMB() - h0);
		}
		const med = (v: number[]) =>
			+([...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0).toFixed(1);
		console.log(
			`LIVE-TEXT-BENCH ${JSON.stringify({
				blocks: BLOCKS,
				joinToReadyMs: { median: med(openMs), all: openMs.map((x) => +x.toFixed(1)) },
				firstSnapshotKB: med(snapshotBytes.map((b) => b / 1024)),
				sessionPlusClientHeapMB: {
					median: med(serverHeap),
					all: serverHeap.map((x) => +x.toFixed(1)),
				},
				sessionAloneHeapMB: { median: med(clientHeap), all: clientHeap.map((x) => +x.toFixed(1)) },
				type200Ms: med(typed),
			})}`,
		);
	},
	300_000,
);
