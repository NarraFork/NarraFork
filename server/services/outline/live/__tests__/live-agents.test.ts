/**
 * Agents in a live page's presence (outline P2 PR 10b, design §2.9, owner decision Q4 A): the real
 * registry and session, the editor's client engine over the in-process network.
 *
 *   - A running session holding a task in progress on the page is shown, its cursor that task's
 *     block; it disappears when its run ends; an idle holder is never shown.
 *   - A running session's write shows it on the blocks it wrote, for a while after the write.
 *   - A subagent is its own agent, its session named beside it.
 *   - Its name and session only for people who may read the session; "Agent" for the others.
 *   - Agents take no participant's place; at most eight a page, the rest counted.
 *   - Work is only done for pages open live, and at most once per interval.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; each test makes its own sessions and
 * page. Sessions' runs are their `status` and the status event, as `narratorService` sets them.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import type { LiveClient, Peer } from "@frontend/components/outline/editor/live-client";
import { OUTLINE_LIVE_AGENT_PNO_BASE, OUTLINE_LIVE_LIMITS } from "@shared/outline-live-protocol";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { aclGrants, narrators, projects, users } from "../../../../db/schema";
import { eventBus } from "../../../../lib/event-bus";
import { generateId } from "../../../../lib/id";
import { settings } from "../../../../lib/settings";
import { invalidateSessionReadScopes } from "../../session-scope";
import { ensureProjectSpace } from "../../spaces";
import type { OutlineSpaceRow } from "../../store/port";
import { writeOutline } from "../../write";
import * as agentPresence from "../agent-presence";
import { OUTLINE_LIVE_AGENT_BOUNDS } from "../agent-presence";
import { closeAllLiveSessions, liveSessionOf, outlineLiveStats } from "../registry";
import { OUTLINE_LIVE_TIMING } from "../session";
import { client, TestLink, waitFor } from "./harness";

const NOW = "2026-11-08T00:00:00.000Z";
const savedTiming = { ...OUTLINE_LIVE_TIMING };
const savedBounds = { ...OUTLINE_LIVE_AGENT_BOUNDS };

let owner: string;
let member: string;
let projectId: string;
let space: OutlineSpaceRow;
const clients: LiveClient[] = [];
const links: TestLink[] = [];

async function user(label: string) {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `${label}-${id}`, passwordHash: "x", role: "user", createdAt: NOW });
	return id;
}

async function session(title: string, options: { root?: string } = {}): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title,
		ownerUserId: owner,
		visibility: "private",
		contextProjectId: projectId,
		taskBackend: "outline",
		status: "idle",
		...(options.root
			? {
					type: "subagent" as const,
					parentNarratorId: options.root,
					aclRootNarratorId: options.root,
				}
			: {}),
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

/** A run starting or ending, as `narratorService.updateStatus` records and announces it. */
async function run(narratorId: string, on: boolean) {
	const status = on ? "working" : "idle";
	await db.update(narrators).set({ status }).where(eq(narrators.id, narratorId));
	eventBus.emit({ type: "narrator:status_changed", narratorId, status });
}

function open(userId: string, pageId: string): LiveClient {
	const link = new TestLink(userId, userId);
	links.push(link);
	const c = client(link, pageId, "edit");
	clients.push(c);
	return c;
}

/** A page with plain blocks, written by the owner. */
async function page(texts: string[]) {
	const r = await writeOutline({
		spaceId: space.id,
		ops: [
			{ op: "insert", tempId: "p", parent: null, content: "Page" },
			...texts.map((content, i) => ({
				op: "insert" as const,
				tempId: `b${i}`,
				parent: { tempId: "p" },
				content,
			})),
		],
		actor: { kind: "human", id: owner },
		responsibleUserId: owner,
	});
	const [p, ...rest] = r.results;
	return { pageId: p?.blockId as string, blocks: rest.map((b) => b.blockId) };
}

/** The session starts a task under the page (it holds it), or writes a plain block. */
async function agentWrites(narratorId: string, pageId: string, content: string, doing: boolean) {
	const r = await writeOutline({
		spaceId: space.id,
		ops: [
			{
				op: "insert",
				parent: { id: pageId },
				content,
				...(doing ? { task: { status: "doing" as const } } : {}),
			},
		],
		actor: { kind: "agent", id: narratorId },
		narratorId,
		responsibleUserId: owner,
	});
	return r.results[0]?.blockId as string;
}

const agents = (c: LiveClient): Peer[] => [...c.presence.values()].filter((p) => p.agent);

beforeAll(async () => {
	owner = await user("owner");
	member = await user("member");
	projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Presence project",
		ownerUserId: owner,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	// The member reads the project's space, but not the owner's private sessions.
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "project",
		scopeId: projectId,
		principalType: "user",
		principalId: member,
		capability: "write",
		createdAt: NOW,
	});
	space = await ensureProjectSpace(projectId);
});

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateSessionReadScopes();
	Object.assign(OUTLINE_LIVE_TIMING, { agentsMs: 20, persistMs: 20, idleCloseMs: 150 });
});

afterEach(async () => {
	for (const c of clients.splice(0)) c.dispose();
	for (const l of links.splice(0)) if (l.connected) l.disconnect();
	await closeAllLiveSessions("ended");
	Object.assign(OUTLINE_LIVE_TIMING, savedTiming);
	Object.assign(OUTLINE_LIVE_AGENT_BOUNDS, savedBounds);
	invalidateSessionReadScopes();
});

afterAll(() => {
	Object.assign(OUTLINE_LIVE_TIMING, savedTiming);
});

describe("who is shown", () => {
	test("a running session's task in progress: shown with its cursor on the task, gone when the run ends", async () => {
		const worker = await session("Refresh worker");
		const { pageId } = await page(["Notes"]);
		await run(worker, true);
		const task = await agentWrites(worker, pageId, "Fix the refresh race", true);
		const c = open(owner, pageId);
		await waitFor(() => agents(c).length === 1, 3000, "the agent");
		const [shown] = agents(c);
		expect(shown).toMatchObject({
			name: "Refresh worker",
			userId: "",
			editing: true,
			agent: { narratorId: worker, session: null },
			sel: { b: [task] },
		});
		expect(shown?.pno).toBeGreaterThanOrEqual(OUTLINE_LIVE_AGENT_PNO_BASE);
		// Agents hold no participant's place.
		expect(outlineLiveStats().participants).toBe(1);
		expect(liveSessionOf(pageId)?.editors).toBe(1);
		await run(worker, false);
		await waitFor(() => agents(c).length === 0, 3000, "the agent gone");
	});

	test("an idle session holding a task is not shown; it is once its run starts", async () => {
		const worker = await session("Idle holder");
		const { pageId } = await page(["Notes"]);
		const task = await agentWrites(worker, pageId, "Held while idle", true);
		const c = open(owner, pageId);
		await waitFor(() => c.ready, 3000, "joined");
		// Give the page its look at the claims, then check nobody is shown.
		await waitFor(
			() => liveSessionOf(pageId)?.agentInterest.has(worker) ?? false,
			3000,
			"holders read",
		);
		expect(agents(c)).toEqual([]);
		await run(worker, true);
		await waitFor(() => agents(c).length === 1, 3000, "the agent");
		expect(agents(c)[0]?.sel).toEqual({ b: [task] });
	});

	test("a write puts the agent's cursor on what it wrote, for a while", async () => {
		OUTLINE_LIVE_AGENT_BOUNDS.writeMs = 400;
		const writer = await session("Note writer");
		const { pageId } = await page(["Notes"]);
		const c = open(owner, pageId);
		await waitFor(() => c.ready, 3000, "joined");
		await run(writer, true);
		const note = await agentWrites(writer, pageId, "A note from the agent", false);
		await waitFor(() => agents(c).length === 1, 3000, "the writer");
		expect(agents(c)[0]?.sel).toEqual({ b: [note] });
		// It holds nothing here: once the write is old, it is gone, though it still runs.
		await waitFor(() => agents(c).length === 0, 3000, "the cursor's while over");
	});

	test("a run that ends takes the agent away at once, whatever it just wrote", async () => {
		const writer = await session("Quick writer");
		const { pageId } = await page(["Notes"]);
		const c = open(owner, pageId);
		await waitFor(() => c.ready, 3000, "joined");
		await run(writer, true);
		await agentWrites(writer, pageId, "Written just now", false);
		await waitFor(() => agents(c).length === 1, 3000, "the writer");
		await run(writer, false);
		await waitFor(() => agents(c).length === 0, 3000, "gone with its run");
	});

	test("a subagent is an agent of its own, its session named beside it", async () => {
		const root = await session("Main line");
		const helper = await session("Helper", { root });
		const { pageId } = await page(["Notes"]);
		await run(helper, true);
		const task = await agentWrites(helper, pageId, "Delegated step", true);
		const c = open(owner, pageId);
		await waitFor(() => agents(c).length === 1, 3000, "the subagent");
		expect(agents(c)[0]).toMatchObject({
			name: "Helper",
			agent: { narratorId: helper, session: "Main line" },
			sel: { b: [task] },
		});
	});
});

describe("names and limits", () => {
	test("only people who may read the session see its name; the others see an agent without one", async () => {
		const worker = await session("Private plans");
		const { pageId } = await page(["Notes"]);
		await run(worker, true);
		await agentWrites(worker, pageId, "Working on it", true);
		const mine = open(owner, pageId);
		const theirs = open(member, pageId);
		await waitFor(() => agents(mine).length === 1 && agents(theirs).length === 1, 3000, "agents");
		expect(agents(mine)[0]).toMatchObject({ name: "Private plans", agent: { narratorId: worker } });
		expect(agents(theirs)[0]).toMatchObject({
			name: "",
			agent: { narratorId: null, session: null },
		});
		// Both see where it works.
		expect(agents(theirs)[0]?.sel).toEqual(agents(mine)[0]?.sel ?? null);
	});

	test("an access change asks again: someone granted the session sees its name", async () => {
		const worker = await session("Shared later");
		const { pageId } = await page(["Notes"]);
		await run(worker, true);
		await agentWrites(worker, pageId, "Working on it", true);
		const theirs = open(member, pageId);
		await waitFor(() => agents(theirs).length === 1, 3000, "the agent");
		expect(agents(theirs)[0]?.name).toBe("");
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "narrator",
			scopeId: worker,
			principalType: "user",
			principalId: member,
			capability: "read",
			createdAt: NOW,
		});
		eventBus.emit({ type: "narrator:access_changed", narratorId: worker, reason: "grant_changed" });
		await waitFor(() => agents(theirs)[0]?.name === "Shared later", 3000, "the name");
		expect(agents(theirs)[0]?.agent?.narratorId).toBe(worker);
	});

	test("read access revoked while the agent is shown: the person's view drops its name", async () => {
		const worker = await session("Shared then private");
		const grantId = generateId();
		await db.insert(aclGrants).values({
			id: grantId,
			scopeType: "narrator",
			scopeId: worker,
			principalType: "user",
			principalId: member,
			capability: "read",
			createdAt: NOW,
		});
		const { pageId } = await page(["Notes"]);
		await run(worker, true);
		await agentWrites(worker, pageId, "Working on it", true);
		const theirs = open(member, pageId);
		await waitFor(() => agents(theirs)[0]?.name === "Shared then private", 3000, "the name");
		await db.delete(aclGrants).where(eq(aclGrants.id, grantId));
		eventBus.emit({ type: "narrator:access_changed", narratorId: worker, reason: "grant_changed" });
		await waitFor(() => agents(theirs)[0]?.name === "", 3000, "the name gone");
		expect(agents(theirs)[0]?.agent).toEqual({ narratorId: null, session: null });
	});

	test("read access revoked while no agent is shown: someone joining later is not named it", async () => {
		const worker = await session("Secret title");
		const grantId = generateId();
		await db.insert(aclGrants).values({
			id: grantId,
			scopeType: "narrator",
			scopeId: worker,
			principalType: "user",
			principalId: member,
			capability: "read",
			createdAt: NOW,
		});
		const { pageId } = await page(["Notes"]);
		await run(worker, true);
		await agentWrites(worker, pageId, "Working on it", true);
		const mine = open(owner, pageId);
		const theirs = open(member, pageId);
		await waitFor(() => agents(theirs)[0]?.name === "Secret title", 3000, "named");
		// The member leaves; the owner keeps the page live; the run ends.
		theirs.dispose();
		links[1]?.disconnect();
		await run(worker, false);
		await waitFor(() => agents(mine).length === 0, 3000, "the agent gone");
		// Revoked while nobody is shown, then the agent is back and the member rejoins.
		await db.delete(aclGrants).where(eq(aclGrants.id, grantId));
		eventBus.emit({ type: "narrator:access_changed", narratorId: worker, reason: "grant_changed" });
		await run(worker, true);
		await waitFor(() => agents(mine).length === 1, 3000, "the agent back");
		const again = open(member, pageId);
		await waitFor(() => again.ready && agents(again).length === 1, 3000, "rejoined");
		expect(agents(again)[0]?.name).toBe("");
		expect(agents(again)[0]?.agent?.narratorId).toBeNull();
	});

	test("revoked while shown and the person away: on their return the page names it to them nowhere, not even at join", async () => {
		const worker = await session("Away title");
		const grantId = generateId();
		await db.insert(aclGrants).values({
			id: grantId,
			scopeType: "narrator",
			scopeId: worker,
			principalType: "user",
			principalId: member,
			capability: "read",
			createdAt: NOW,
		});
		const { pageId } = await page(["Notes"]);
		await run(worker, true);
		await agentWrites(worker, pageId, "Working on it", true);
		const mine = open(owner, pageId);
		const theirs = open(member, pageId);
		await waitFor(() => agents(theirs)[0]?.name === "Away title", 3000, "named");
		theirs.dispose();
		links[1]?.disconnect();
		await waitFor(() => (liveSessionOf(pageId)?.participants.size ?? 0) === 1, 3000, "left");
		const looks = spyOn(agentPresence, "readLiveAgents");
		try {
			await db.delete(aclGrants).where(eq(aclGrants.id, grantId));
			eventBus.emit({
				type: "narrator:access_changed",
				narratorId: worker,
				reason: "grant_changed",
			});
			await waitFor(() => looks.mock.calls.length > 0, 3000, "asked again");
			await waitFor(() => agents(mine).length === 1, 3000, "still shown");
		} finally {
			looks.mockRestore();
		}
		const again = open(member, pageId);
		// The join's own answer already leaves the name out.
		await waitFor(() => again.ready && agents(again).length === 1, 3000, "rejoined");
		expect(agents(again)[0]?.name).toBe("");
	});

	test("a person's commit made for a session is not the session's write", async () => {
		const worker = await session("Lock owner");
		const { pageId } = await page(["Notes"]);
		await run(worker, true);
		const task = await agentWrites(worker, pageId, "Held task", true);
		const c = open(owner, pageId);
		await waitFor(() => agents(c).length === 1, 3000, "the agent");
		const seen: string[][] = [];
		const original = agentPresence.readLiveAgents;
		const looks = spyOn(agentPresence, "readLiveAgents").mockImplementation(async (input) => {
			seen.push([...input.writes.keys()]);
			return await original(input);
		});
		try {
			// The task was started before anyone had the page open: no write of the session's is known.
			// A person writes on the page for the session (as locking a plan for it does).
			await writeOutline({
				spaceId: space.id,
				ops: [{ op: "insert", parent: { id: pageId }, content: "The person's note" }],
				actor: { kind: "human", id: owner },
				narratorId: worker,
				responsibleUserId: owner,
			});
			await waitFor(() => c.outline(pageId).includes("The person's note"), 3000, "applied");
			seen.length = 0;
			// A look for another reason: no write of the session's is in it.
			await run(worker, true);
			await waitFor(() => seen.length > 0, 3000, "a look");
			expect(seen.every((writes) => writes.length === 0)).toBe(true);
			expect(agents(c)[0]?.sel).toEqual({ b: [task] });
		} finally {
			looks.mockRestore();
		}
	});

	test("at most eight agents a page; the rest are counted", async () => {
		const { pageId } = await page(["Notes"]);
		const n = OUTLINE_LIVE_LIMITS.agentsPerPage + 1;
		for (let i = 0; i < n; i++) {
			const worker = await session(`Worker ${i}`);
			await run(worker, true);
			await agentWrites(worker, pageId, `Task ${i}`, true);
		}
		const c = open(owner, pageId);
		await waitFor(
			() => agents(c).length === OUTLINE_LIVE_LIMITS.agentsPerPage && c.agentsMore === 1,
			3000,
			"eight shown, one counted",
		);
	});

	test("worked out at most once an interval, and never for a page nobody has open", async () => {
		const worker = await session("Busy");
		const { pageId } = await page(["Notes"]);
		const times: number[] = [];
		const original = agentPresence.readLiveAgents;
		const looks = spyOn(agentPresence, "readLiveAgents").mockImplementation(async (input) => {
			times.push(Date.now());
			return await original(input);
		});
		try {
			// Nobody has the page open: runs and writes look at nothing.
			await run(worker, true);
			await agentWrites(worker, pageId, "Unwatched", true);
			await run(worker, false);
			expect(looks).not.toHaveBeenCalled();
			Object.assign(OUTLINE_LIVE_TIMING, { agentsMs: 300 });
			await run(worker, true);
			const c = open(owner, pageId);
			await waitFor(() => agents(c).length === 1, 3000, "the agent");
			times.length = 0;
			// The run ends: one look. A burst of runs starting and ending right after it waits out
			// the interval, and is one look, which sees where the burst ended (running).
			await run(worker, false);
			await waitFor(() => times.length === 1 && agents(c).length === 0, 3000, "the first look");
			for (let i = 0; i < 10; i++) await run(worker, i % 2 === 1);
			await waitFor(() => agents(c).length === 1, 3000, "the agent back");
			expect(times.length).toBe(2);
			expect((times[1] as number) - (times[0] as number)).toBeGreaterThanOrEqual(290);
		} finally {
			looks.mockRestore();
		}
	});
});

describe("which agents a page shows", () => {
	test("a write's cursor lasts its while; holders past the writers are still found running", async () => {
		const recent = await session("Recent writer");
		const old = await session("Old writer");
		await run(recent, true);
		await run(old, true);
		const now = Date.now();
		const read = await agentPresence.readLiveAgents({
			doing: [],
			writes: new Map([
				[old, { blocks: ["b-old"], at: now - OUTLINE_LIVE_AGENT_BOUNDS.writeMs - 1 }],
				[recent, { blocks: ["b-new"], at: now - 1 }],
			]),
			now,
		});
		expect(read.agents.map((a) => [a.narratorId, a.blocks])).toEqual([[recent, ["b-new"]]]);
	});
});
