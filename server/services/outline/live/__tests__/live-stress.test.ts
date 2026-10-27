/**
 * Randomized concurrency (P0 acceptance 5g, on the real server): three people type, split,
 * indent, outdent, move, delete, toggle checkboxes, undo and redo on one page while their
 * links are paused and released at random and an agent writes now and then. Afterwards every
 * client, the session and the database agree.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { LiveClient } from "@frontend/components/outline/editor/live-client";
import {
	type ClientOp,
	keyBetweenLoose as keyBetween,
} from "@frontend/components/outline/editor/store";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";
import { generateId } from "../../../../lib/id";
import { settings } from "../../../../lib/settings";
import { ensurePersonalSpace } from "../../spaces";
import { outlineStore } from "../../store";
import { writeOutline } from "../../write";
import { closeAllLiveSessions, liveSessionOf } from "../registry";
import { OUTLINE_LIVE_TIMING } from "../session";
import { client, settle, struct, TestLink, waitFor } from "./harness";

const NOW = "2026-10-27T00:00:00.000Z";
const saved = { ...OUTLINE_LIVE_TIMING };

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const ALPHABET = ["a", "b", "中", "文", " ", "x", "!", "*", "["];

let owner: string;

beforeAll(async () => {
	owner = generateId();
	await db.insert(users).values({
		id: owner,
		username: `stress-${owner}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
});

beforeEach(() => {
	settings.outline.enabled = true;
	Object.assign(OUTLINE_LIVE_TIMING, { flushIdleMs: 40, flushMaxMs: 200, persistMs: 20 });
});

const clients: LiveClient[] = [];
const links: TestLink[] = [];
afterEach(async () => {
	for (const c of clients.splice(0)) c.dispose();
	for (const l of links.splice(0)) if (l.connected) l.disconnect();
	await closeAllLiveSessions("ended");
	Object.assign(OUTLINE_LIVE_TIMING, saved);
});

/** One random edit by `c`, the way the editor would express it. */
function randomEdit(c: LiveClient, pageId: string, r: () => number): void {
	const blocks = [...c.visible.blocks.values()].filter(
		(b) => c.visible.inPage(b.id) && b.id !== pageId,
	);
	const pick = <T>(list: T[]): T | undefined => list[Math.floor(r() * list.length)];
	const b = pick(blocks);
	const roll = r();
	if (!b || roll < 0.08) {
		// A new block at the end of the page.
		const last = c.visible.children(pageId).at(-1);
		const k = keyBetween(last ? (c.visible.get(last)?.orderKey ?? null) : null, null);
		struct(c, [{ t: "i", id: c.newId(), p: pageId, k, content: "new" }]);
		return;
	}
	const text = c.textOf(b.id);
	const parentId = b.parentId as string;
	const sibs = c.visible.children(parentId);
	const at = sibs.indexOf(b.id);
	const keyAt = (i: number) =>
		i >= 0 && i < sibs.length ? (c.visible.get(sibs[i] as string)?.orderKey ?? null) : null;
	if (roll < 0.45) {
		const pos = Math.floor(r() * (text.length + 1));
		const ch = pick(ALPHABET) as string;
		c.commit({
			ops: [],
			bodies: [{ id: b.id, md: text.slice(0, pos) + ch + text.slice(pos) }],
			kind: "typing",
			blockId: b.id,
			selBefore: null,
			selAfter: null,
			view: null,
		});
	} else if (roll < 0.52 && text.length > 0) {
		const pos = Math.floor(r() * text.length);
		c.commit({
			ops: [],
			bodies: [{ id: b.id, md: text.slice(0, pos) + text.slice(pos + 1) }],
			kind: "typing",
			blockId: b.id,
			selBefore: null,
			selAfter: null,
			view: null,
		});
	} else if (roll < 0.62) {
		// Split at a random point: the rest goes to a new next sibling.
		const pos = Math.floor(r() * (text.length + 1));
		const k = keyBetween(b.orderKey, keyAt(at + 1));
		struct(
			c,
			[{ t: "i", id: c.newId(), p: parentId, k, content: text.slice(pos) }],
			[{ id: b.id, md: text.slice(0, pos) }],
		);
	} else if (roll < 0.7 && at > 0) {
		// Indent under the previous sibling.
		const prev = sibs[at - 1] as string;
		const last = c.visible.children(prev).at(-1);
		const k = keyBetween(last ? (c.visible.get(last)?.orderKey ?? null) : null, null);
		struct(c, [{ t: "m", id: b.id, p: prev, k }]);
	} else if (roll < 0.76 && parentId !== pageId) {
		// Outdent after the parent.
		const parent = c.visible.get(parentId);
		const grand = parent?.parentId as string;
		const gs = c.visible.children(grand);
		const pi = gs.indexOf(parentId);
		const next =
			pi + 1 < gs.length ? (c.visible.get(gs[pi + 1] as string)?.orderKey ?? null) : null;
		struct(c, [{ t: "m", id: b.id, p: grand, k: keyBetween(parent?.orderKey ?? null, next) }]);
	} else if (roll < 0.82 && at > 0) {
		// Move up one.
		struct(c, [{ t: "m", id: b.id, p: parentId, k: keyBetween(keyAt(at - 2), keyAt(at - 1)) }]);
	} else if (roll < 0.87) {
		const ops: ClientOp[] = c.visible.subtree(b.id).map((id) => ({ t: "d", id }));
		struct(c, ops.reverse());
	} else if (roll < 0.9) {
		struct(c, [{ t: "k", id: b.id, task: b.task ? null : " " }]);
	} else if (roll < 0.96) {
		c.undo();
	} else {
		c.redo();
	}
}

describe("random concurrent editing", () => {
	for (const seed of [11, 23, 47]) {
		test(`seed ${seed}: everyone converges with the database`, async () => {
			const space = await ensurePersonalSpace(owner);
			const created = await writeOutline({
				spaceId: space.id,
				ops: [
					{ op: "insert", tempId: "p", parent: null, content: `Stress ${seed}` },
					...["alpha", "beta", "gamma", "delta"].map((content, i) => ({
						op: "insert" as const,
						tempId: `b${i}`,
						parent: { tempId: "p" },
						content,
					})),
				],
				actor: { kind: "human", id: owner },
				responsibleUserId: owner,
			});
			const pageId = created.results[0]?.blockId as string;
			const r = rng(seed);
			const ls = [0, 1, 2].map((i) => {
				const l = new TestLink(owner, `p${i}`);
				links.push(l);
				return l;
			});
			const cs = ls.map((l) => {
				const c = client(l, pageId);
				clients.push(c);
				return c;
			});
			await waitFor(() => cs.every((c) => c.ready), 3000, "joined");
			for (let step = 0; step < 300; step++) {
				const i = Math.floor(r() * cs.length);
				const l = ls[i] as TestLink;
				if (r() < 0.08) l.hold(!l.held);
				if (r() < 0.02) {
					const live = [...(cs[0] as LiveClient).visible.blocks.values()].filter(
						(b) => (cs[0] as LiveClient).visible.inPage(b.id) && b.id !== pageId,
					);
					const target = live[Math.floor(r() * live.length)];
					if (target)
						await writeOutline({
							spaceId: space.id,
							ops: [{ op: "insert", parent: { id: pageId }, content: `agent ${step}` }],
							actor: { kind: "agent", id: "stress-agent" },
							responsibleUserId: owner,
						});
				}
				randomEdit(cs[i] as LiveClient, pageId, r);
				if (step % 10 === 0) await new Promise((res) => setTimeout(res, 5));
			}
			for (const l of ls) l.hold(false);
			await settle(60, 20_000);
			const outlines = cs.map((c) => c.outline());
			if (process.env.NF_LIVE_STRESS_LOG)
				console.log(
					JSON.stringify({
						seed,
						blocks: (cs[0] as LiveClient).visible.blocks.size,
						clients: cs.map((c) => ({ ...c.stats })),
					}),
				);
			expect(outlines[1]).toBe(outlines[0] as string);
			expect(outlines[2]).toBe(outlines[0] as string);
			await waitFor(() => !liveSessionOf(pageId)?.hasUnflushed, 5000, "flushed");
			// The database holds what everyone sees.
			const { blocks } = await outlineStore.listPageBlocks(pageId, 10_000);
			const c0 = cs[0] as LiveClient;
			const live = blocks.filter((b) => b.id !== pageId);
			expect(new Set(live.map((b) => b.id))).toEqual(
				new Set(
					[...c0.visible.blocks.values()]
						.filter((b) => c0.visible.inPage(b.id) && b.id !== pageId)
						.map((b) => b.id),
				),
			);
			for (const b of live) {
				expect(b.content).toBe(c0.textOf(b.id));
				expect(b.parentId).toBe(c0.visible.get(b.id)?.parentId ?? null);
			}
		}, 60_000);
	}
});
