/**
 * The outline agent tools across spaces, on the isolated SQLite database: reading and searching
 * other spaces the session may read (addresses, labels, the read ledger), the overview of every
 * readable space (`OutlineRead` with address `*`), links to what the session may not read, and
 * `OutlineEdit` in other spaces, which follows the person's write permission as it always has.
 * The permission matrix of who reads what, on SQLite and PostgreSQL, is in `access-matrix.ts`
 * (groups `listing` and `agent`).
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own users,
 * projects and sessions.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { aclGrants, narrators, outlineBlocks, projects, users } from "../../../db/schema";
import {
	outlineEditTool,
	outlineReadTool,
	outlineSearchTool,
} from "../../../lib/agent/tools/outline";
import type { ToolContext, ToolDefinition, ToolResult } from "../../../lib/agent/types";
import { eventBus } from "../../../lib/event-bus";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import { OUTLINE_AGENT_READ_LIMITS } from "../agent-read";
import { OUTLINE_TOOL_TEXT } from "../messages";
import { clearOutlineReads, seenOutlineVersion } from "../read-ledger";
import {
	invalidateSessionReadScopes,
	listSessionReadableSpaces,
	OUTLINE_SESSION_LIST_LIMITS,
} from "../session-scope";
import { ensurePersonalSpace, ensureProjectSpace, ensureSessionSpace } from "../spaces";
import { outlineStore } from "../store";
import type { OutlineSpaceRow } from "../store/port";
import { type OutlineOp, writeOutline } from "../write";

const NOW = "2026-10-26T00:00:00.000Z";

async function user(label: string): Promise<string> {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `${label}-${id}`, passwordHash: "x", role: "user", createdAt: NOW });
	return id;
}

async function project(owner: string, name: string, visibility = "private"): Promise<string> {
	const id = generateId();
	await db.insert(projects).values({
		id,
		name,
		ownerUserId: owner,
		visibility: visibility as "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

async function narrator(
	owner: string,
	projectId: string | null,
	extra: Partial<typeof narrators.$inferInsert> = {},
): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title: "cross-space",
		ownerUserId: owner,
		visibility: "private",
		contextProjectId: projectId,
		createdAt: NOW,
		updatedAt: NOW,
		...extra,
	});
	return id;
}

function ctx(narratorId: string, userId: string | null): ToolContext {
	return {
		narratorId,
		cwd: "/",
		signal: new AbortController().signal,
		locale: "en",
		userId,
		requestPermission: async () => ({ behavior: "allow" }),
	} as ToolContext;
}

async function call(
	tool: ToolDefinition,
	args: Record<string, unknown>,
	context: ToolContext,
): Promise<ToolResult> {
	return await tool.execute(args, context);
}

/** The labels a result lists after bullets, in order. */
function labels(output: string): string[] {
	return [...output.matchAll(/^\s*- \[([A-Za-z0-9/]+)\]/gm)].map((m) => m[1] as string);
}

/** Write blocks as a person; the sids of what was inserted, in order. */
async function write(space: OutlineSpaceRow, userId: string, ops: OutlineOp[]): Promise<string[]> {
	const r = await writeOutline({
		spaceId: space.id,
		ops,
		actor: { kind: "human", id: userId },
		responsibleUserId: userId,
	});
	return r.results.map((x) => x.sid);
}

async function blockBySid(space: OutlineSpaceRow, sid: string) {
	const rows = await db.select().from(outlineBlocks).where(eq(outlineBlocks.spaceId, space.id));
	const row = rows.find((r) => r.sid === sid);
	if (!row) throw new Error(`no block ${sid}`);
	return row;
}

/**
 * Alice works in a session of Atlas. She can also read Billing (a project of hers), her other
 * session's notes, and Hidden is Bob's (not hers to read).
 */
async function world() {
	const alice = await user("alice");
	const bob = await user("bob");
	const atlasId = await project(alice, "Atlas");
	const billingId = await project(alice, "Billing");
	const session = await narrator(alice, atlasId);
	const otherSession = await narrator(alice, atlasId, { title: "Login bug" });
	const atlas = await ensureProjectSpace(atlasId);
	const billing = await ensureProjectSpace(billingId);
	const hidden = await ensureProjectSpace(await project(bob, "Hidden"));
	const notes = await ensureSessionSpace(session);
	const otherNotes = await ensureSessionSpace(otherSession);
	return { alice, bob, session, otherSession, atlas, billing, hidden, notes, otherNotes };
}

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateSessionReadScopes();
	clearOutlineReads();
});

afterEach(() => {
	invalidateSessionReadScopes();
});

describe("reading another space", () => {
	test("by key/id: labeled key/id, recorded as read", async () => {
		const w = await world();
		const [page, child] = await write(w.billing, w.alice, [
			{ op: "insert", tempId: "p", parent: null, content: "Invoices" },
			{ op: "insert", parent: { tempId: "p" }, content: "Totals are kept in cents" },
		]);
		const c = ctx(w.session, w.alice);
		const read = await call(outlineReadTool, { address: `${w.billing.key}/${page}` }, c);
		expect(read.isError).toBeUndefined();
		const lines = read.output.split("\n");
		expect(lines[0]).toBe(`‹space ${w.billing.key} · project "Billing"›`);
		expect(labels(read.output)).toEqual([`${w.billing.key}/${page}`, `${w.billing.key}/${child}`]);
		const row = await blockBySid(w.billing, child as string);
		expect(seenOutlineVersion(w.session, row.id)).toBe(row.versionSeq);

		// Bare ids are looked up in the session's own spaces only: the label is the address.
		const bare = await call(outlineReadTool, { address: child as string }, c);
		expect(bare.isError).toBe(true);
		const byLabel = await call(outlineReadTool, { address: `${w.billing.key}/${child}` }, c);
		expect(byLabel.output).toContain("Totals are kept in cents");

		// A space's pages, listed by key.
		const list = await call(outlineReadTool, { address: `${w.billing.key}/` }, c);
		expect(list.output).toContain(`- [${w.billing.key}/${page}] Invoices`);
	});

	test("the session's own spaces keep short ids", async () => {
		const w = await world();
		const [own] = await write(w.atlas, w.alice, [{ op: "insert", parent: null, content: "Ours" }]);
		const [note] = await write(w.notes, w.alice, [{ op: "insert", parent: null, content: "Mine" }]);
		const c = ctx(w.session, w.alice);
		const read = await call(outlineReadTool, { address: own as string }, c);
		expect(labels(read.output)).toEqual([own]);
		const notes = await call(outlineReadTool, { address: `session/${note}` }, c);
		expect(labels(notes.output)).toEqual([note]);
	});

	test("another session's notes, when every reader of this one may read them", async () => {
		const w = await world();
		const [sid] = await write(w.otherNotes, w.alice, [
			{ op: "insert", parent: null, content: "Repro steps" },
		]);
		const read = await call(
			outlineReadTool,
			{ address: `${w.otherNotes.key}/${sid}` },
			ctx(w.session, w.alice),
		);
		expect(read.output.split("\n")[0]).toBe(`‹space ${w.otherNotes.key} · session "Login bug"›`);
		expect(read.output).toContain(`- [${w.otherNotes.key}/${sid}] Repro steps`);
		// Shared with Bob, the session may read only what Bob may read too.
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "narrator",
			scopeId: w.session,
			principalType: "user",
			principalId: w.bob,
			capability: "read",
			createdAt: NOW,
		});
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "project",
			scopeId: w.atlas.projectId as string,
			principalType: "user",
			principalId: w.bob,
			capability: "read",
			createdAt: NOW,
		});
		invalidateSessionReadScopes();
		const narrowed = await call(
			outlineReadTool,
			{ address: `${w.otherNotes.key}/${sid}` },
			ctx(w.session, w.alice),
		);
		expect(narrowed.output).toBe(OUTLINE_TOOL_TEXT.notFound(`${w.otherNotes.key}/${sid}`));
	});

	test("what the session may not read answers exactly as what does not exist", async () => {
		const w = await world();
		const [secret] = await write(w.hidden, w.bob, [
			{ op: "insert", parent: null, content: "Secret zebra" },
		]);
		const c = ctx(w.session, w.alice);
		const pairs: Array<[string, string]> = [
			[`${w.hidden.key}/${secret}`, `${w.billing.key}/Zz9Zz9Zz`],
			[`${w.hidden.key}/${secret}`, `Nokey123/${secret}`],
			[`${w.hidden.key}/`, "Nokey123/"],
		];
		const swap = (text: string, from: string, to: string) => text.split(from).join(to);
		for (const [hidden, missing] of pairs) {
			const a = await call(outlineReadTool, { address: hidden }, c);
			const b = await call(outlineReadTool, { address: missing }, c);
			expect(a.isError).toBe(true);
			expect(b.isError).toBe(true);
			expect(swap(a.output, hidden.replace(/\/$/, ""), "X")).toBe(
				swap(b.output, missing.replace(/\/$/, ""), "X"),
			);
		}
		const searchHidden = await call(
			outlineSearchTool,
			{ query: "zebra", spaces: [w.hidden.key] },
			c,
		);
		const searchMissing = await call(
			outlineSearchTool,
			{ query: "zebra", spaces: ["Nokey123"] },
			c,
		);
		expect(swap(searchHidden.output, w.hidden.key, "X")).toBe(
			swap(searchMissing.output, "Nokey123", "X"),
		);
		const all = await call(outlineSearchTool, { query: "zebra", spaces: ["*"] }, c);
		expect(all.output).not.toContain(w.hidden.key);
		expect(all.output).not.toContain("Secret");
	});
});

describe("links to what the session may not read", () => {
	test("show no title, like a link to nothing, and are never expanded", async () => {
		const w = await world();
		const [secret] = await write(w.hidden, w.bob, [
			{ op: "insert", parent: null, content: "Secret zebra" },
		]);
		const [invoices] = await write(w.billing, w.alice, [
			{ op: "insert", parent: null, content: "Invoices" },
		]);
		const hiddenRef = `${w.hidden.key}/${secret}`;
		const missingRef = `${w.billing.key}/Zz9Zz9Zz`;
		const readableRef = `${w.billing.key}/${invoices}`;
		const [page] = await write(w.atlas, w.alice, [
			{
				op: "insert",
				parent: null,
				content: `see [[${hiddenRef}]], [[${missingRef}]] and [[${readableRef}]]`,
			},
			{ op: "insert", parent: null, content: `![[${hiddenRef}]]` },
			{ op: "insert", parent: null, content: `![[${missingRef}]]` },
		]);
		const c = ctx(w.session, w.alice);
		const read = await call(outlineReadTool, { address: page as string }, c);
		expect(read.output).toContain(
			`see [[${hiddenRef}]], [[${missingRef}]] and [[${readableRef}|Invoices]]`,
		);
		expect(read.output).not.toContain("Secret");
		const overview = await call(outlineReadTool, { address: "*" }, c);
		expect(overview.output).toContain(`![[${hiddenRef}]]`);
		expect(overview.output).toContain(`![[${missingRef}]]`);
		expect(overview.output).not.toContain("Secret");
	});
});

describe("the overview of every readable space", () => {
	test("its own spaces first, then the others, each with its pages within the budget", async () => {
		const w = await world();
		await write(w.atlas, w.alice, [
			{ op: "insert", tempId: "a", parent: null, content: "Auth module" },
			{ op: "insert", parent: { tempId: "a" }, content: "Tokens live on the server" },
			{
				op: "insert",
				parent: { tempId: "a" },
				content: "Add a regression test",
				task: { status: "todo" },
			},
		]);
		const [invoices] = await write(w.billing, w.alice, [
			{ op: "insert", tempId: "i", parent: null, content: "Invoices" },
			{ op: "insert", parent: { tempId: "i" }, content: "Totals are kept in cents" },
		]);
		await write(w.hidden, w.bob, [{ op: "insert", parent: null, content: "Secret zebra" }]);
		const personal = await ensurePersonalSpace(w.alice);
		await write(personal, w.alice, [{ op: "insert", parent: null, content: "My preferences" }]);
		const c = ctx(w.session, w.alice);
		const result = await call(outlineReadTool, { address: "*" }, c);
		expect(result.isError).toBeUndefined();
		const out = result.output;
		const keys = (result.metadata?.spaces as Array<{ key: string; own: boolean }>).map(
			(s) => s.key,
		);
		// Own spaces first (project, session, personal), then the others.
		expect(keys.slice(0, 3)).toEqual([w.atlas.key, w.notes.key, personal.key]);
		expect(keys).toContain(w.billing.key);
		expect(keys).toContain(w.otherNotes.key);
		expect(keys).not.toContain(w.hidden.key);
		expect(out).not.toContain("Secret");
		expect(out.split("\n")[0]).toContain("this session can read, its own first");
		expect(out).toContain(`‹space ${w.atlas.key} · this session's project "Atlas"; bare ids`);
		expect(out).toContain("- [");
		expect(out).toContain("Tokens live on the server");
		expect(out).not.toContain("regression");
		expect(out).toContain("‹facts only: 1 block under tasks not shown");
		expect(out).toContain(`‹space ${w.billing.key} · project "Billing"›`);
		expect(out).toContain(`- [${w.billing.key}/${invoices}] Invoices`);
		expect(out).toContain("Totals are kept in cents");
		expect(out).toContain(`‹space ${w.notes.key} · this session's notes›\n‹no pages yet›`);
		expect(out).toContain("My preferences");
		expect(result.metadata?.complete).toBe(true);
		// What it showed is a read.
		const row = await blockBySid(w.billing, invoices as string);
		expect(seenOutlineVersion(w.session, row.id)).toBe(row.versionSeq);

		// A small budget fills the top level of every space first.
		const small = await call(outlineReadTool, { address: "*", budget: 3 }, c);
		expect(small.output).toContain("Auth module");
		expect(small.output).toContain("Invoices");
		expect(small.output).not.toContain("Tokens live");
		expect(small.output).not.toContain("Totals are kept");
		expect(small.output).toMatch(/^ {2}‹… 1 more›$/m);

		const all = await call(outlineReadTool, { address: "*", view: "all" }, c);
		expect(all.output).toContain("[ ] Add a regression test");

		const asOf = await call(outlineReadTool, { address: "*", asOf: 1 }, c);
		expect(asOf.isError).toBe(true);
		expect(asOf.output).toBe(OUTLINE_TOOL_TEXT.overviewNotAsOf);
	});

	test("another session's notes are process: the facts view counts their pages", async () => {
		const w = await world();
		const [repro] = await write(w.otherNotes, w.alice, [
			{ op: "insert", tempId: "r", parent: null, content: "Repro steps" },
			{ op: "insert", parent: { tempId: "r" }, content: "Log in twice" },
			{ op: "insert", parent: null, content: "Hypotheses" },
		]);
		await write(w.notes, w.alice, [{ op: "insert", parent: null, content: "Our own notes" }]);
		const c = ctx(w.session, w.alice);
		const facts = await call(outlineReadTool, { address: "*" }, c);
		expect(facts.output).toContain(
			`‹space ${w.otherNotes.key} · session "Login bug"›\n‹${OUTLINE_TOOL_TEXT.otherSessionPages(2, false)}›`,
		);
		expect(facts.output).not.toContain("Repro steps");
		expect(facts.output).not.toContain("Hypotheses");
		// The session's own notes are listed as before.
		expect(facts.output).toContain("Our own notes");
		const meta = facts.metadata?.spaces as Array<{ key: string; process?: boolean }>;
		expect(meta.find((s) => s.key === w.otherNotes.key)?.process).toBe(true);
		expect(meta.find((s) => s.key === w.notes.key)?.process).toBeUndefined();

		const all = await call(outlineReadTool, { address: "*", view: "all" }, c);
		expect(all.output).toContain(`- [${w.otherNotes.key}/${repro}] Repro steps`);
		expect(all.output).toContain("Log in twice");
		expect(all.output).toContain("Hypotheses");
		// Read by address as ever.
		const byKey = await call(outlineReadTool, { address: `${w.otherNotes.key}/` }, c);
		expect(byKey.output).toContain(`- [${w.otherNotes.key}/${repro}] Repro steps`);
	});

	test("pages that are tasks take nothing from the budget; pages not expanded say why", async () => {
		const w = await world();
		await write(w.atlas, w.alice, [
			{ op: "insert", parent: null, content: "Task one", task: { status: "todo" } },
			{ op: "insert", parent: null, content: "Task two", task: { status: "todo" } },
			{ op: "insert", parent: null, content: "Plain page" },
		]);
		const lines = (n: number, tempId: string) =>
			Array.from({ length: n }, (_, i) => ({
				op: "insert" as const,
				parent: { tempId },
				content: `line ${i}`,
			}));
		const [bigPage] = await write(w.billing, w.alice, [
			{ op: "insert", tempId: "big", parent: null, content: "Big page" },
			...lines(6, "big"),
		]);
		await write(w.billing, w.alice, [
			{ op: "insert", tempId: "small", parent: null, content: "Small page" },
			...lines(2, "small"),
		]);
		const c = ctx(w.session, w.alice);
		// Budget 1: the task pages are listed before the plain page but do not take its place.
		const one = await call(outlineReadTool, { address: "*", budget: 1 }, c);
		expect(one.output).toContain("Plain page");
		expect(one.output).toContain(OUTLINE_TOOL_TEXT.taskPagesHidden(2));
		const limits = OUTLINE_AGENT_READ_LIMITS;
		const saved = { ...limits };
		try {
			// One read takes 5 blocks: the 7-block page shows alone, the 3-block one whole.
			limits.overviewBlocksPerRead = 5;
			const large = await call(outlineReadTool, { address: "*" }, c);
			expect(large.output).toContain(`- [${w.billing.key}/${bigPage}] Big page`);
			expect(large.output).toContain(
				OUTLINE_TOOL_TEXT.notExpandedLarge([`[${w.billing.key}/${bigPage}]`]),
			);
			expect(large.output).not.toContain("line 5");
			expect(large.output).toMatch(/Small page\n {2}- \[[^\]]+\] line 0/);
			expect(large.metadata?.truncated).toBe(true);
			// Past what one overview reads in all: shown alone, and said so.
			limits.overviewBlocksPerRead = saved.overviewBlocksPerRead;
			limits.overviewBlocks = 2;
			const past = await call(outlineReadTool, { address: "*" }, c);
			expect(past.output).toMatch(
				/shown without what is under them, past the blocks one overview reads/,
			);
			expect(past.output).not.toContain("line 0");
			const meta = past.metadata?.spaces as Array<{ key: string; pages: number }>;
			expect(meta.find((s) => s.key === w.billing.key)?.pages).toBe(2);
			expect(meta.find((s) => s.key === w.atlas.key)?.pages).toBe(1);
		} finally {
			Object.assign(limits, saved);
		}
	});

	test("every space shows its pages, round-robin; structure is read in a few batched reads", async () => {
		const owner = await user("wide");
		const main = await project(owner, "Main");
		const session = await narrator(owner, main);
		const spaces = [await ensureProjectSpace(main)];
		for (let i = 0; i < 11; i++)
			spaces.push(await ensureProjectSpace(await project(owner, `P${i}`)));
		for (const space of spaces) {
			const ops: OutlineOp[] = [];
			for (let p = 0; p < 6; p++) {
				ops.push({
					op: "insert",
					tempId: `p${p}`,
					parent: null,
					content: `${space.key} page ${p}`,
				});
				for (let k = 0; k < 3; k++) {
					ops.push({ op: "insert", parent: { tempId: `p${p}` }, content: `child ${p}.${k}` });
				}
			}
			await write(space, owner, ops);
		}
		const store = outlineStore as unknown as Record<string, (...args: unknown[]) => unknown>;
		const calls = { single: 0, batched: 0 };
		const single = store.listPageStructure as (...args: unknown[]) => unknown;
		const batched = store.listPagesStructure as (...args: unknown[]) => unknown;
		store.listPageStructure = (...args) => {
			calls.single++;
			return single.apply(outlineStore, args);
		};
		store.listPagesStructure = (...args) => {
			calls.batched++;
			return batched.apply(outlineStore, args);
		};
		try {
			const c = ctx(session, owner);
			const wide = await call(outlineReadTool, { address: "*", budget: 2000 }, c);
			const sections = wide.output.split(/\n(?=‹space )/).slice(1);
			expect(sections).toHaveLength(12);
			for (const section of sections) {
				expect((section.match(/^- \[/gm) ?? []).length).toBe(6);
				expect((section.match(/^ {2}- \[/gm) ?? []).length).toBe(18);
			}
			expect(calls.single).toBe(0);
			expect(calls.batched).toBe(1);
			// A small budget takes the first page of every space before any second page.
			const small = await call(outlineReadTool, { address: "*", budget: 12 }, c);
			for (const space of spaces) {
				expect(small.output).toContain(`${space.key} page 0`);
				expect(small.output).not.toContain(`${space.key} page 1`);
				expect(small.output).toContain(OUTLINE_TOOL_TEXT.morePagesOf(space.key, 5, false));
			}
		} finally {
			store.listPageStructure = single;
			store.listPagesStructure = batched;
		}
	});

	test("the overview lets other work run between its stretches of work", async () => {
		const owner = await user("solo");
		const main = await project(owner, "Main");
		const session = await narrator(owner, main);
		const space = await ensureProjectSpace(main);
		await write(space, owner, [{ op: "insert", parent: null, content: "A page" }]);
		let ticks = 0;
		let running = true;
		const tick = () => {
			ticks++;
			if (running) setImmediate(tick);
		};
		setImmediate(tick);
		try {
			const r = await call(outlineReadTool, { address: "*" }, ctx(session, owner));
			expect(r.output).toContain("A page");
		} finally {
			running = false;
		}
		// Content, links and the render each start after a yield.
		expect(ticks).toBeGreaterThanOrEqual(3);
	});

	test("a session that can read nothing yet", async () => {
		const owner = await user("solo");
		const session = await narrator(owner, null);
		const result = await call(outlineReadTool, { address: "*" }, ctx(session, null));
		expect(result.output).toBe(OUTLINE_TOOL_TEXT.allSpacesNone);
	});
});

describe("searching every readable space", () => {
	test('spaces ["*"] covers other spaces; the default stays with the own spaces', async () => {
		const w = await world();
		await write(w.billing, w.alice, [
			{ op: "insert", parent: null, content: "Kraken ledger rounding" },
		]);
		await write(w.otherNotes, w.alice, [{ op: "insert", parent: null, content: "Kraken repro" }]);
		await write(w.hidden, w.bob, [{ op: "insert", parent: null, content: "Kraken secret" }]);
		const c = ctx(w.session, w.alice);
		const own = await call(outlineSearchTool, { query: "Kraken" }, c);
		expect(own.output).toContain(OUTLINE_TOOL_TEXT.noResultsOwn);
		const all = await call(outlineSearchTool, { query: "Kraken", spaces: ["*"] }, c);
		const hits = labels(all.output);
		expect(hits).toHaveLength(2);
		expect(hits.some((h) => h.startsWith(`${w.billing.key}/`))).toBe(true);
		expect(hits.some((h) => h.startsWith(`${w.otherNotes.key}/`))).toBe(true);
		expect(all.output).not.toContain("secret");
		// Another session's notes are process, ranked after facts.
		expect(hits[0]).toStartWith(`${w.billing.key}/`);
		expect(all.output).toContain("in a session's notes");
		// A result reads by the address it gives.
		const read = await call(outlineReadTool, { address: hits[0] as string }, c);
		expect(read.output).toContain("Kraken ledger rounding");
	});
});

describe("OutlineEdit and other spaces", () => {
	test("another project's space the person may write is written, as before", async () => {
		const w = await world();
		const [invoices] = await write(w.billing, w.alice, [
			{ op: "insert", parent: null, content: "Invoices" },
		]);
		const key = w.billing.key;
		const c = ctx(w.session, w.alice);
		const added = await call(
			outlineEditTool,
			{ edits: [{ add: `${key}/`, markdown: "- Refunds" }] },
			c,
		);
		expect(added.isError).toBeUndefined();
		expect(added.output).toContain(`to ${key} · project "Billing"`);
		// Someone else wrote it: read it, then edit it by its address, as a read labels it too.
		await call(outlineReadTool, { address: `${key}/${invoices}` }, c);
		const replaced = await call(
			outlineEditTool,
			{ edits: [{ replace: `[${key}/${invoices}]`, text: "Invoices v2" }] },
			c,
		);
		expect(replaced.isError).toBeUndefined();
		const set = await call(
			outlineEditTool,
			{ edits: [{ set: `${key}/${invoices}`, checkbox: "x" }] },
			c,
		);
		expect(set.isError).toBeUndefined();
		const child = await call(
			outlineEditTool,
			{ edits: [{ add: `${key}/${invoices}`, markdown: "- paid in full" }] },
			c,
		);
		expect(child.isError).toBeUndefined();
		const row = await blockBySid(w.billing, invoices as string);
		expect(row.content).toBe("Invoices v2");
		expect(row.taskJson?.status).toBe("done");
		const rows = await db
			.select()
			.from(outlineBlocks)
			.where(eq(outlineBlocks.spaceId, w.billing.id));
		const refunds = rows.find((r) => r.content === "Refunds");
		expect(refunds?.parentId).toBeNull();
		expect(rows.find((r) => r.content === "paid in full")?.parentId).toBe(row.id);
		const deleted = await call(
			outlineEditTool,
			{ edits: [{ delete: `${key}/${refunds?.sid}` }] },
			c,
		);
		expect(deleted.isError).toBeUndefined();
		expect((await blockBySid(w.billing, refunds?.sid as string)).deleted).toBe(true);
	});

	test("a readable space the person may not write is refused, as before", async () => {
		const w = await world();
		const open = await ensureProjectSpace(await project(w.bob, "Open", "public"));
		const [theirs] = await write(open, w.bob, [{ op: "insert", parent: null, content: "Theirs" }]);
		const c = ctx(w.session, w.alice);
		const read = await call(outlineReadTool, { address: `${open.key}/${theirs}` }, c);
		expect(read.output).toContain("Theirs");
		for (const edit of [
			{ add: `${open.key}/`, markdown: "- mine" },
			{ replace: `${open.key}/${theirs}`, text: "changed" },
		]) {
			const refused = await call(outlineEditTool, { edits: [edit] }, c);
			expect(refused.isError).toBe(true);
			expect(refused.output).toContain("Nothing was written.");
			expect(refused.output).toContain(
				OUTLINE_TOOL_TEXT.edit.noPermission(`${open.key} · project "Open"`),
			);
		}
		expect((await blockBySid(open, theirs as string)).content).toBe("Theirs");
		// A space it may not read is not found, as ever.
		const hidden = await call(
			outlineEditTool,
			{ edits: [{ add: `${w.hidden.key}/`, markdown: "- nope" }] },
			c,
		);
		expect(hidden.output).toContain(OUTLINE_TOOL_TEXT.noSuchSpace(`${w.hidden.key}/`));
	});

	test("what a read of another space shows, copied into the session's own, loses its labels", async () => {
		const w = await world();
		const [invoices] = await write(w.billing, w.alice, [
			{ op: "insert", parent: null, content: "Invoices" },
		]);
		const c = ctx(w.session, w.alice);
		const copied = await call(outlineReadTool, { address: `${w.billing.key}/${invoices}` }, c);
		const markdown = `${copied.output.split("\n").slice(1).join("\n")}\n- see [[${w.billing.key}/${invoices}]]`;
		const added = await call(outlineEditTool, { edits: [{ add: "/", markdown }] }, c);
		expect(added.isError).toBeUndefined();
		const pages = await db
			.select()
			.from(outlineBlocks)
			.where(eq(outlineBlocks.spaceId, w.atlas.id));
		expect(pages.map((p) => p.content).sort()).toEqual([
			"Invoices",
			`see [[${w.billing.key}/${invoices}]]`,
		]);
	});

	test("an edit's result labels blocks of another space by an address that works as is", async () => {
		const w = await world();
		const key = w.billing.key;
		const c = ctx(w.session, w.alice);
		const added = await call(
			outlineEditTool,
			{ edits: [{ add: `${key}/`, markdown: "- Invoices\n  - Totals in cents" }] },
			c,
		);
		const created = labels(added.output);
		expect(created).toHaveLength(2);
		for (const label of created) {
			expect(label).toStartWith(`${key}/`);
			const read = await call(outlineReadTool, { address: label }, c);
			expect(read.isError).toBeUndefined();
			// The label of a read result, copied with its brackets, works too.
			const replaced = await call(
				outlineEditTool,
				{ edits: [{ replace: `[${label}]`, text: `edited ${label}` }] },
				c,
			);
			expect(replaced.isError).toBeUndefined();
			expect(replaced.output).toContain(`replaced [${label}]`);
		}
		const [page, child] = created as [string, string];
		const moved = await call(outlineEditTool, { edits: [{ move: child, to: `${key}/` }] }, c);
		expect(moved.isError).toBeUndefined();
		expect(moved.output).toContain(`moved [${child}] under`);
		const back = await call(outlineEditTool, { edits: [{ move: child, to: page }] }, c);
		expect(back.output).toContain(`moved [${child}] under [${page}]`);
		const set = await call(outlineEditTool, { edits: [{ set: child, checkbox: "x" }] }, c);
		expect(set.output).toContain(`set [${child}]: [x]`);
		// Someone changes a block after the agent read it: the conflict names it by its address.
		await call(outlineReadTool, { address: page }, c);
		const pageRow = await blockBySid(w.billing, page.slice(key.length + 1));
		await writeOutline({
			spaceId: w.billing.id,
			ops: [{ op: "update", block: { id: pageRow.id }, content: "Invoices by a person" }],
			actor: { kind: "human", id: w.alice },
			responsibleUserId: w.alice,
		});
		const conflict = await call(outlineEditTool, { edits: [{ set: page, checkbox: "x" }] }, c);
		expect(conflict.isError).toBe(true);
		expect(conflict.output).toContain(`[${page}] was changed by a person`);
		// In the session's own space the short id stays.
		const own = await call(outlineEditTool, { edits: [{ add: "/", markdown: "- Ours" }] }, c);
		const ownLabel = labels(own.output)[0] as string;
		expect(ownLabel).not.toContain("/");
		expect((await call(outlineReadTool, { address: ownLabel }, c)).isError).toBeUndefined();
	});

	test("a task of another space someone else is doing is refused by its address", async () => {
		const w = await world();
		const key = w.billing.key;
		const [task] = await write(w.billing, w.alice, [
			{ op: "insert", parent: null, content: "Reconcile", task: { status: "todo" } },
		]);
		const doer = ctx(w.otherSession, w.alice);
		await call(outlineReadTool, { address: `${key}/${task}` }, doer);
		const started = await call(
			outlineEditTool,
			{ edits: [{ set: `${key}/${task}`, checkbox: "/" }] },
			doer,
		);
		expect(started.isError).toBeUndefined();
		const c = ctx(w.session, w.alice);
		await call(outlineReadTool, { address: `${key}/${task}` }, c);
		const refused = await call(
			outlineEditTool,
			{ edits: [{ set: `${key}/${task}`, checkbox: "/" }] },
			c,
		);
		expect(refused.isError).toBe(true);
		// The label a read of that space shows, so the agent can use it as is.
		expect(refused.output).toContain(`[${key}/${task}] is already being done by`);
		expect(refused.output).toContain('"Login bug"');
		expect((await blockBySid(w.billing, task as string)).taskJson?.status).toBe("doing");
	});

	test("a subagent reads across spaces as its root does", async () => {
		const w = await world();
		const [invoices] = await write(w.billing, w.alice, [
			{ op: "insert", parent: null, content: "Invoices" },
		]);
		const sub = await narrator(w.alice, null, { type: "subagent", aclRootNarratorId: w.session });
		const c = ctx(sub, w.alice);
		const read = await call(outlineReadTool, { address: `${w.billing.key}/${invoices}` }, c);
		expect(read.output).toContain(`- [${w.billing.key}/${invoices}] Invoices`);
		const overview = await call(outlineReadTool, { address: "*" }, c);
		const keys = (overview.metadata?.spaces as Array<{ key: string }>).map((s) => s.key);
		expect(keys.slice(0, 2)).toEqual([w.atlas.key, w.notes.key]);
		expect(keys).toContain(w.otherNotes.key);
		const own = await call(
			outlineEditTool,
			{ edits: [{ add: "session/", markdown: "- from the subagent" }] },
			c,
		);
		expect(own.isError).toBeUndefined();
	});
});

describe("limits of what one listing looks at", () => {
	/** A session of Alice's with `extra` more projects of hers; shared with Bob when asked. */
	async function setup(extra: number, sharedWithBob: boolean) {
		const alice = await user("alice");
		const bob = await user("bob");
		const main = await project(alice, "Main");
		const session = await narrator(alice, main);
		const ids = new Set([
			(await ensureProjectSpace(main)).id,
			(await ensureSessionSpace(session)).id,
		]);
		const grant = (scopeType: "project" | "narrator", scopeId: string) =>
			db.insert(aclGrants).values({
				id: generateId(),
				scopeType,
				scopeId,
				principalType: "user",
				principalId: bob,
				capability: "read",
				createdAt: NOW,
			});
		if (sharedWithBob) {
			await grant("project", main);
			await grant("narrator", session);
		}
		for (let i = 0; i < extra; i++) {
			ids.add((await ensureProjectSpace(await project(alice, `Extra ${i}`))).id);
		}
		invalidateSessionReadScopes();
		// Other cases of this file leave public projects every session may read: count ours.
		const ours = (spaces: OutlineSpaceRow[]) => spaces.filter((space) => ids.has(space.id));
		return { alice, session, ours };
	}

	test("a listing cut by its limit says more are readable; one cut by its candidates cannot tell", async () => {
		const solo = await setup(4, false);
		const all = await listSessionReadableSpaces(solo.session, {
			executingUserId: solo.alice,
			limit: 200,
		});
		expect(all).toMatchObject({ cut: null, complete: true });
		expect(solo.ours(all.spaces)).toHaveLength(6);
		const two = await listSessionReadableSpaces(solo.session, {
			executingUserId: solo.alice,
			limit: 2,
		});
		expect(two).toMatchObject({ cut: "limit", complete: false });
		expect(two.spaces).toHaveLength(2);

		// Shared with Bob, Alice's other projects are candidates Bob cannot read.
		const shared = await setup(5, true);
		const capped = await listSessionReadableSpaces(shared.session, {
			executingUserId: shared.alice,
			limit: 200,
			maxCandidates: 3,
		});
		expect(capped).toMatchObject({ cut: "candidates", complete: false });
		expect(shared.ours(capped.spaces)).toHaveLength(2);
		const whole = await listSessionReadableSpaces(shared.session, {
			executingUserId: shared.alice,
			limit: 200,
		});
		expect(whole).toMatchObject({ cut: null, complete: true });
		expect(shared.ours(whole.spaces)).toHaveLength(2);
	});

	test("the overview and the search of every space say which, past their own limits", async () => {
		const reads = OUTLINE_AGENT_READ_LIMITS;
		const lists = OUTLINE_SESSION_LIST_LIMITS;
		const saved = { reads: { ...reads }, lists: { ...lists } };
		try {
			reads.overviewSpaces = 2;
			reads.searchAllSpaces = 2;
			const solo = await setup(4, false);
			const c = ctx(solo.session, solo.alice);
			const overview = await call(outlineReadTool, { address: "*" }, c);
			expect(overview.metadata?.spaces).toHaveLength(2);
			expect(overview.metadata?.complete).toBe(false);
			expect(overview.output).toContain(OUTLINE_TOOL_TEXT.moreSpaces);
			expect(overview.output).not.toContain(OUTLINE_TOOL_TEXT.spacesUnchecked);
			const search = await call(outlineSearchTool, { query: "anything", spaces: ["*"] }, c);
			expect(search.metadata?.spaces).toHaveLength(2);
			expect(search.metadata?.complete).toBe(false);
			expect(search.output).toContain(OUTLINE_TOOL_TEXT.searchedSome(2));

			reads.overviewSpaces = saved.reads.overviewSpaces;
			reads.searchAllSpaces = saved.reads.searchAllSpaces;
			lists.defaultCandidates = 3;
			const shared = await setup(5, true);
			const s = ctx(shared.session, shared.alice);
			const unchecked = await call(outlineReadTool, { address: "*" }, s);
			expect(unchecked.metadata?.complete).toBe(false);
			expect(unchecked.output).toContain(OUTLINE_TOOL_TEXT.spacesUnchecked);
			expect(unchecked.output).not.toContain(OUTLINE_TOOL_TEXT.moreSpaces);
			const searched = await call(outlineSearchTool, { query: "anything", spaces: ["*"] }, s);
			expect(searched.output).toContain(OUTLINE_TOOL_TEXT.searchUnchecked);
			expect(searched.output).not.toContain("there are more");
		} finally {
			Object.assign(reads, saved.reads);
			Object.assign(lists, saved.lists);
		}
	});

	test("a long listing yields to the event loop between slices of candidates", async () => {
		const lists = OUTLINE_SESSION_LIST_LIMITS;
		const saved = { ...lists };
		const solo = await setup(12, false);
		let ticks = 0;
		let running = true;
		const tick = () => {
			ticks++;
			if (running) setImmediate(tick);
		};
		try {
			lists.judgeSlice = 3;
			setImmediate(tick);
			const listed = await listSessionReadableSpaces(solo.session, {
				executingUserId: solo.alice,
				limit: 200,
			});
			running = false;
			expect(solo.ours(listed.spaces)).toHaveLength(14);
			// Twelve candidates judged three at a time: other work ran in between.
			expect(ticks).toBeGreaterThanOrEqual(3);
		} finally {
			running = false;
			Object.assign(lists, saved);
		}
	});
});

describe("access that changes while the outline is read", () => {
	/** Alice's session in Main, and three projects only she reads, each with a secret. */
	async function setup() {
		const alice = await user("alice");
		const bob = await user("bob");
		const main = await project(alice, "Main");
		const mainSpace = await ensureProjectSpace(main);
		await write(mainSpace, alice, [{ op: "insert", parent: null, content: "Shared Numbat plan" }]);
		const session = await narrator(alice, main);
		const secrets: OutlineSpaceRow[] = [];
		for (let i = 0; i < 3; i++) {
			const space = await ensureProjectSpace(await project(alice, `Secret ${i}`));
			await write(space, alice, [{ op: "insert", parent: null, content: `Numbat secret ${i}` }]);
			secrets.push(space);
		}
		const grants = [
			{ scopeType: "project" as const, scopeId: main },
			{ scopeType: "narrator" as const, scopeId: session },
		];
		/** Share the session with Bob (who reads Main only), or stop sharing it. */
		const share = async (on: boolean) => {
			for (const g of grants) {
				if (on) {
					await db.insert(aclGrants).values({
						id: generateId(),
						...g,
						principalType: "user",
						principalId: bob,
						capability: "read",
						createdAt: NOW,
					});
				} else {
					await db.delete(aclGrants).where(eq(aclGrants.scopeId, g.scopeId));
				}
			}
			eventBus.emit({ type: "narrator:access_changed", narratorId: session } as never);
		};
		return { alice, session, secrets, share, mainSpace };
	}

	/**
	 * Run `fn` with `method` of the store calling `onCall(n)` before its call number `n` (only the
	 * calls `counts` admits are counted and hooked).
	 */
	async function patched<T>(
		method: "listSpacePages" | "searchBlocks",
		onCall: (n: number) => Promise<void>,
		fn: () => Promise<T>,
		counts: (args: unknown[]) => boolean = () => true,
	): Promise<T> {
		const store = outlineStore as unknown as Record<string, (...args: unknown[]) => unknown>;
		const original = store[method] as (...args: unknown[]) => unknown;
		let n = 0;
		store[method] = async (...args) => {
			if (counts(args)) await onCall(n++);
			return await original.apply(outlineStore, args);
		};
		try {
			return await fn();
		} finally {
			store[method] = original;
		}
	}

	test("the overview started before the session was shared shows nothing its new reader may not", async () => {
		const w = await setup();
		const c = ctx(w.session, w.alice);
		const before = await call(outlineReadTool, { address: "*" }, c);
		expect(before.output).toContain("Numbat secret 0");
		clearOutlineReads();
		const r = await patched(
			"listSpacePages",
			async (n) => {
				if (n === 0) await w.share(true);
			},
			() => call(outlineReadTool, { address: "*" }, c),
		);
		expect(r.isError).toBeUndefined();
		expect(r.output).toContain("Shared Numbat plan");
		expect(r.output).not.toContain("Numbat secret");
		const keys = (r.metadata?.spaces as Array<{ key: string }>).map((s) => s.key);
		for (const secret of w.secrets) expect(keys).not.toContain(secret.key);
		// What the first, dropped answer read is not taken as read.
		const secretBlock = (
			await db
				.select()
				.from(outlineBlocks)
				.where(eq(outlineBlocks.spaceId, w.secrets[0]?.id as string))
		)[0];
		expect(seenOutlineVersion(w.session, secretBlock?.id as string)).toBeUndefined();
	});

	test("a search of every space started before the change shows nothing it may not", async () => {
		const w = await setup();
		const c = ctx(w.session, w.alice);
		const r = await patched(
			"searchBlocks",
			async (n) => {
				if (n === 0) await w.share(true);
			},
			() => call(outlineSearchTool, { query: "Numbat", spaces: ["*"] }, c),
		);
		expect(r.output).toContain("Shared Numbat plan");
		expect(r.output).not.toContain("Numbat secret");
	});

	test("when access keeps changing, nothing that is not readable now is shown", async () => {
		const w = await setup();
		const c = ctx(w.session, w.alice);
		// Shared, unshared, shared again: each answer is built under access that then changes. The
		// last one, built unshared, shows the secrets; shared now, the session may not read them.
		const r = await patched(
			"listSpacePages",
			async (n) => {
				if (n === 0 || n === 2) await w.share(true);
				if (n === 1) await w.share(false);
			},
			() => call(outlineReadTool, { address: "*" }, c),
			(args) => args[0] === w.mainSpace.id,
		);
		expect(r.isError).toBe(true);
		expect(r.output).toBe(OUTLINE_TOOL_TEXT.accessChanged);
		// Unshared at once and changed (for nothing) after every answer: the last answer still
		// holds when it is checked, so it is given.
		const settledLast = await patched(
			"listSpacePages",
			async () => {
				await w.share(false);
			},
			() => call(outlineReadTool, { address: "*" }, c),
			(args) => args[0] === w.mainSpace.id,
		);
		expect(settledLast.isError).toBeUndefined();
		expect(settledLast.output).toContain("Numbat secret 0");
	});
});

describe("candidates of both kinds", () => {
	test("project candidates the session may not read do not crowd out readable session spaces", async () => {
		const alice = await user("alice");
		const bob = await user("bob");
		const main = await project(alice, "Main");
		const session = await narrator(alice, main);
		await ensureProjectSpace(main);
		const grant = (scopeType: "project" | "narrator", scopeId: string) =>
			db.insert(aclGrants).values({
				id: generateId(),
				scopeType,
				scopeId,
				principalType: "user",
				principalId: bob,
				capability: "read",
				createdAt: NOW,
			});
		await grant("project", main);
		await grant("narrator", session);
		// Ten projects only Alice reads, and a session of Main both of them read.
		for (let i = 0; i < 10; i++) await ensureProjectSpace(await project(alice, `Alice ${i}`));
		const team = await narrator(alice, main, { visibility: "project", title: "Team notes" });
		const teamSpace = await ensureSessionSpace(team);
		invalidateSessionReadScopes();
		const listed = await listSessionReadableSpaces(session, {
			executingUserId: alice,
			limit: 200,
			maxCandidates: 6,
		});
		expect(listed.cut).toBe("candidates");
		expect(listed.spaces.map((s) => s.id)).toContain(teamSpace.id);
		// Listed by kind all the same: projects before sessions.
		const kinds = listed.spaces.slice(1).map((s) => s.kind);
		expect(kinds.indexOf("session")).toBeGreaterThan(kinds.lastIndexOf("project"));
	});
});
