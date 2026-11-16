/**
 * Measurements of a space's live session (pageless plan L2): what one and ten loaded pages of
 * 2,000 blocks cost in memory, how long a page's tree takes to load, and what a keystroke costs
 * on the server. Prints a report and asserts nothing about the numbers; runs only with
 * `NF_OUTLINE_LIVE_BENCH=1`:
 *
 *   NF_OUTLINE_LIVE_BENCH=1 bun test --isolate server/services/outline/live/__tests__/live-space-bench.test.ts
 *
 * The session class is looked up by either name it has had, so the same file measures the
 * commit before this one.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { db } from "../../../../db";
import { projects, users } from "../../../../db/schema";
import { generateId } from "../../../../lib/id";
import { settings } from "../../../../lib/settings";
import { ensureProjectSpace } from "../../spaces";
import type { OutlineSpaceRow } from "../../store/port";
import { writeOutline } from "../../write";
import { closeAllLiveSessions, liveSessionOf } from "../registry";
import * as sessionModule from "../session";
import { client, forget, settle, TestLink, type, waitFor } from "./harness";

const BENCH = process.env.NF_OUTLINE_LIVE_BENCH === "1";
const NOW = "2026-11-15T00:00:00.000Z";
const BLOCKS = 2000;
let owner = "";
let space: OutlineSpaceRow;

const heapMB = () => {
	Bun.gc(true);
	return process.memoryUsage().heapUsed / 1048576;
};

async function bigPage(title: string): Promise<{ pageId: string; first: string }> {
	let pageId = "";
	let first = "";
	for (let at = 0; at < BLOCKS - 1; at += 150) {
		const n = Math.min(150, BLOCKS - 1 - at);
		const r = await writeOutline({
			spaceId: space.id,
			ops: [
				...(at === 0 ? [{ op: "insert" as const, tempId: "p", parent: null, content: title }] : []),
				...Array.from({ length: n }, (_, i) => ({
					op: "insert" as const,
					parent: at === 0 ? { tempId: "p" } : { id: pageId },
					content: `大纲 块模型 live session block ${at + i}`,
				})),
			],
			actor: { kind: "human", id: owner },
			responsibleUserId: owner,
		});
		if (at === 0) {
			pageId = r.results[0]?.blockId as string;
			first = r.results[1]?.blockId as string;
		}
	}
	return { pageId, first };
}

beforeAll(async () => {
	if (!BENCH) return;
	settings.outline.enabled = true;
	owner = generateId();
	await db
		.insert(users)
		.values({ id: owner, username: `b-${owner}`, passwordHash: "x", role: "user", createdAt: NOW });
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Live space bench",
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
	"one and ten pages of 2,000 blocks: memory, load time, the cost of a keystroke",
	async () => {
		const pages = [];
		for (let i = 0; i < 10; i++) pages.push(await bigPage(`Bench ${i}`));
		const mod = sessionModule as unknown as Record<string, { prototype: Record<string, unknown> }>;
		const cls = mod.LiveSpace ?? mod.LivePage;
		if (!cls) throw new Error("no session class");
		const timing = { updates: 0, updateMs: 0 };
		const orig = cls.prototype.handleUpdate as (...args: unknown[]) => unknown;
		cls.prototype.handleUpdate = function (this: unknown, ...args: unknown[]) {
			const t0 = performance.now();
			try {
				return orig.apply(this, args);
			} finally {
				timing.updateMs += performance.now() - t0;
				timing.updates++;
			}
		};
		// Sockets only (no client engine in this process's heap): bare joins through real clients
		// that are disposed of would leave their copies; the session's share is what stays.
		const links: TestLink[] = [];
		const heap0 = heapMB();
		const joinMs: number[] = [];
		const heaps: number[] = [];
		const clients = [];
		for (let i = 0; i < 10; i++) {
			const l = new TestLink(owner, `bench${i}`);
			links.push(l);
			const t0 = performance.now();
			const c = client(l, pages[i]?.pageId as string);
			await waitFor(() => c.ready, 20_000, "joined");
			joinMs.push(performance.now() - t0);
			clients.push(c);
			if (i === 0 || i === 9) heaps.push(heapMB() - heap0);
		}
		// The clients' copies out of the picture: the sessions stay (their idle time is far off).
		for (const c of clients.slice(1)) {
			c.dispose();
			forget(c);
		}
		await settle();
		const sessionsOnly = heapMB() - heap0;
		const c = clients[0];
		if (!c) throw new Error("no client");
		// Keystrokes one at a time (each its own frame), in a block of the first page.
		timing.updates = 0;
		timing.updateMs = 0;
		const t0 = performance.now();
		for (let i = 0; i < 150; i++) {
			type(c, pages[0]?.first as string, "x");
			// Past the client's typing batch: a frame a keystroke.
			await new Promise((r) => setTimeout(r, 34));
		}
		await settle();
		const wall = performance.now() - t0;
		expect(liveSessionOf(pages[0]?.pageId as string)).toBeDefined();
		const stats = (
			liveSessionOf(pages[0]?.pageId as string) as unknown as {
				stats: Record<string, number>;
			}
		).stats;
		const med = (v: number[]) =>
			+([...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0).toFixed(1);
		console.log(
			`LIVE-SPACE-BENCH ${JSON.stringify({
				session: mod.LiveSpace ? "per space" : "per page",
				heapMB_1pageWithClient: +(heaps[0] ?? 0).toFixed(2),
				heapMB_10pagesWithClients: +(heaps[1] ?? 0).toFixed(2),
				heapMB_10pagesSessionsAndOneClient: +sessionsOnly.toFixed(2),
				joinToReadyMs: { median: med(joinMs), all: joinMs.map((x) => +x.toFixed(1)) },
				loadMsPerTree: stats.treesLoaded
					? +((stats.loadMs ?? 0) / stats.treesLoaded).toFixed(2)
					: null,
				keystrokes: timing.updates,
				handleUpdateMicrosEach: +((timing.updateMs / Math.max(1, timing.updates)) * 1000).toFixed(
					1,
				),
				applyMicrosEach: +(
					((stats.applyMs ?? 0) / Math.max(1, stats.updatesIn ?? 1)) *
					1000
				).toFixed(1),
				flushBroadcastMsTotal: +(stats.mergeMs ?? 0).toFixed(2),
				wallMs: Math.round(wall),
			})}`,
		);
		for (const l of links) l.disconnect();
	},
	300_000,
);
