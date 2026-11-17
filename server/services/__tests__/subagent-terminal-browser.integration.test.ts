/**
 * Terminal and Browser for subagents (Project Teams S2) through the real services.
 *
 * What has to hold:
 *  1. ceilings and preload: a worker gets Terminal and Browser, a reviewer Browser only, the
 *     other templates neither; a helper gets them only within its parent's ceiling;
 *  2. a worker opens a real terminal, runs a command and reads its output; another narrator
 *     cannot use that terminal; the fourth running terminal is refused;
 *  3. browser caps: the third session of a subagent, the seventh of a team and any launch past
 *     the process cap are refused, also for concurrent launches, before any tab opens;
 *  4. archiving or deleting a subagent closes its terminals and browser sessions; a run's end
 *     closes its browser sessions unless work is pending;
 *  5. the tree's terminals are listed read-only for readers of the root, and opening one (REST
 *     and WebSocket) needs write access on the root.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { aclGrants, narrators, terminals, users } from "../../db/schema";
import { browserTool } from "../../lib/agent/tools/browser";
import { terminalTool } from "../../lib/agent/tools/terminal";
import type { ToolContext } from "../../lib/agent/types";
import "../../lib/browser/session";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { withRuntimePolicyTrait } from "../../lib/runtime-policy-trait";
import { terminalRoutes } from "../../routes/terminals";
import { handleTerminalWS } from "../../websocket/terminal-ws";
import {
	PROCESS_BROWSER_SESSION_LIMIT,
	reserveBrowserLaunch,
	resetAgentResourceCapsForTest,
	SUBAGENT_TERMINAL_LIMIT,
} from "../agent-resource-caps";
import {
	compileDelegationPolicy,
	isRuntimeToolAllowed,
	resolveRuntimePolicy,
	withDelegationDepth,
} from "../agent-runtime/policy";
import { narratorService } from "../narrator-service";
import { interruptAndArchiveSubagent } from "../subagent-lifecycle";
import { closeSubagentResources, releaseSubagentBrowsersAtRunEnd } from "../subagent-resources";
import { listTreeTerminals } from "../subagent-terminals";
import { terminalService } from "../terminal-service";
import { resetTraitLayerCaches, resolveNarratorRuntimePolicy } from "../trait-layer-service";

const created: string[] = [];
const userIds: string[] = [];
const ptys: string[] = [];

interface FakeSessionOwner {
	sessions: Map<string, Map<string, unknown>>;
}
const registry = (globalThis as unknown as Record<symbol, FakeSessionOwner>)[
	Symbol.for("narrafork.browser.sessions")
];

beforeAll(async () => {
	(await import("../agent-runtime/publication")).runtimePublication.stop();
});

afterEach(async () => {
	resetTraitLayerCaches();
	resetAgentResourceCapsForTest();
	for (const id of ptys.splice(0)) await terminalService.kill(id).catch(() => {});
	registry.sessions.clear();
	const ids = created.splice(0);
	if (ids.length) {
		await db.delete(terminals).where(inArray(terminals.narratorId, ids));
		await db.delete(aclGrants).where(inArray(aclGrants.scopeId, ids));
		await db
			.update(narrators)
			.set({
				parentNarratorId: null,
				aclRootNarratorId: null,
				policySourceNarratorId: null,
				runtimeRegistrationJson: null,
			})
			.where(inArray(narrators.id, ids));
		await db.delete(narrators).where(inArray(narrators.id, ids));
	}
	const users_ = userIds.splice(0);
	if (users_.length) await db.delete(users).where(inArray(users.id, users_));
});

afterAll(async () => {
	await terminalService.shutdownAll().catch(() => {});
});

async function makeUser(label: string): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `${label}-${id}`,
		passwordHash: "x",
		role: "user",
		createdAt: new Date().toISOString(),
	});
	userIds.push(id);
	return id;
}

async function primary(options: { ownerUserId?: string; visibility?: "public" } = {}) {
	const row = await narratorService.create({
		locale: "en",
		ownerUserId: options.ownerUserId,
		visibility: options.visibility,
		writeAudience: "owner",
		cwd: process.cwd(),
	});
	created.push(row.id);
	return row.id;
}

async function subagent(parentNarratorId: string, subagentType: string, title?: string) {
	const row = await narratorService.createSubagent({
		subagentOriginKind: "standalone",
		parentNarratorId,
		subagentType,
		title: title ?? subagentType,
		cwd: process.cwd(),
	});
	created.push(row.id);
	return row;
}

function ctx(narratorId: string): ToolContext {
	return {
		narratorId,
		signal: new AbortController().signal,
		currentToolUseId: `call-${generateId()}`,
	} as ToolContext;
}

/** A row-only terminal: enough for ownership, listing and caps without a PTY. */
async function terminalRow(narratorId: string, status: "running" | "exited" = "running") {
	const id = generateId();
	await db.insert(terminals).values({
		id,
		narratorId,
		name: `t-${id.slice(0, 4)}`,
		cwd: process.cwd(),
		status,
		createdAt: new Date().toISOString(),
	});
	return id;
}

/** A browser session in the live registry; it never touches Chrome. */
function fakeSession(narratorId: string) {
	const id = generateId().slice(0, 8);
	const state = { closed: false };
	const session = {
		id,
		narratorId,
		context: {
			browser: () => ({ defaultBrowserContext: () => null, connected: true }),
			close: async () => {
				state.closed = true;
			},
		},
		page: { target: () => ({}), isClosed: () => false, url: () => "about:blank" },
		url: "about:blank",
		lastActivity: Date.now(),
		ttlMs: 600_000,
		headless: true,
		inUserBrowser: false,
		networkCaptureEnabled: false,
		viewport: { width: 1280, height: 720 },
		consoleMessages: [],
		consoleMessageSeq: 0,
		pendingConsoleCaptures: new Set(),
		networkRequests: [],
		networkRequestMap: new WeakMap(),
	};
	let map = registry.sessions.get(narratorId);
	if (!map) {
		map = new Map();
		registry.sessions.set(narratorId, map);
	}
	map.set(id, session);
	return state;
}

function sessionCount(narratorId: string): number {
	return registry.sessions.get(narratorId)?.size ?? 0;
}

async function until(predicate: () => Promise<boolean>, what: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await Bun.sleep(25);
	}
}

describe("ceilings and preload", () => {
	const ceiling = (template: string) =>
		resolveRuntimePolicy([withDelegationDepth(compileDelegationPolicy({ template }), 1)]);

	test("worker gets Terminal and Browser, review Browser only, the others neither", () => {
		expect(isRuntimeToolAllowed(ceiling("worker"), "Terminal")).toBe(true);
		expect(isRuntimeToolAllowed(ceiling("worker"), "Browser")).toBe(true);
		expect(isRuntimeToolAllowed(ceiling("review"), "Browser")).toBe(true);
		expect(isRuntimeToolAllowed(ceiling("review"), "Terminal")).toBe(false);
		for (const template of ["general", "explore", "plan", "search"]) {
			expect(isRuntimeToolAllowed(ceiling(template), "Terminal")).toBe(false);
			expect(isRuntimeToolAllowed(ceiling(template), "Browser")).toBe(false);
		}
	});

	test("templates preload what their ceiling allows, at creation", async () => {
		const root = await primary();
		const enabled = async (template: string) =>
			(await subagent(root, template)).enabledTools ?? null;
		expect(await enabled("worker")).toEqual(["Terminal", "Browser"]);
		expect(await enabled("Worker")).toEqual(["Terminal", "Browser"]);
		expect(await enabled("review")).toEqual(["Browser"]);
		for (const template of ["general", "explore", "plan"])
			expect(await enabled(template)).toBe(null);
	});

	test("a helper of a worker gets them only within its parent's ceiling", async () => {
		const root = await primary();
		const worker = await subagent(root, "worker");
		const workerHelper = await subagent(worker.id, "worker");
		const generalHelper = await subagent(worker.id, "general");
		const reviewHelper = await subagent(worker.id, "review");
		expect(workerHelper.enabledTools).toEqual(["Terminal", "Browser"]);
		expect(generalHelper.enabledTools ?? null).toBe(null);
		expect(reviewHelper.enabledTools).toEqual(["Browser"]);
		const live = async (id: string) => resolveNarratorRuntimePolicy(id);
		expect(isRuntimeToolAllowed(await live(workerHelper.id), "Terminal")).toBe(true);
		expect(isRuntimeToolAllowed(await live(generalHelper.id), "Terminal")).toBe(false);
		expect(isRuntimeToolAllowed(await live(reviewHelper.id), "Terminal")).toBe(false);
		expect(isRuntimeToolAllowed(await live(reviewHelper.id), "Browser")).toBe(true);

		// A worker whose own ceiling no longer lists Terminal: its worker helper neither starts
		// with it nor may use it (the helper follows the parent's ceiling live).
		const narrowed = await subagent(root, "worker", "narrowed");
		const trait = withDelegationDepth(compileDelegationPolicy({ template: "worker" }), 1);
		await db
			.update(narrators)
			.set({
				traits: withRuntimePolicyTrait(["standalone"], {
					...trait,
					tools: (trait.tools ?? []).filter((name) => name !== "Terminal"),
				}),
			})
			.where(eq(narrators.id, narrowed.id));
		resetTraitLayerCaches();
		const capped = await subagent(narrowed.id, "worker");
		expect(capped.enabledTools).toEqual(["Browser"]);
		expect(isRuntimeToolAllowed(await live(capped.id), "Terminal")).toBe(false);
		expect(isRuntimeToolAllowed(await live(capped.id), "Browser")).toBe(true);
	});
});

describe("terminals", () => {
	test("a worker opens a terminal, runs a command and reads its output; others are refused", async () => {
		const root = await primary();
		const worker = await subagent(root, "worker");
		const sibling = await subagent(root, "worker", "sibling");
		const createdTerminal = await terminalTool.execute(
			{ action: "create", name: "dev" },
			ctx(worker.id),
		);
		expect(createdTerminal.isError).not.toBe(true);
		const id = /- ID: (\S+)/.exec(createdTerminal.output)?.[1] ?? "";
		ptys.push(id);
		const row = await db.query.terminals.findFirst({ where: eq(terminals.id, id) });
		expect(row?.narratorId).toBe(worker.id);

		const written = await terminalTool.execute(
			{ action: "write", terminal_id: id, input: "echo S2_MARK_$((40+2))\n" },
			ctx(worker.id),
		);
		expect(written.isError).not.toBe(true);
		let screen = "";
		await until(async () => {
			const read = await terminalTool.execute(
				{ action: "read", terminal_id: id, last_n_lines: 50 },
				ctx(worker.id),
			);
			screen = read.output;
			return screen.includes("S2_MARK_42");
		}, "the command's output");
		expect(screen).toContain("S2_MARK_42");

		for (const call of [
			{ action: "read", terminal_id: id },
			{ action: "write", terminal_id: id, input: "echo hijack\n" },
			{ action: "rename", terminal_id: id, name: "mine" },
		]) {
			const refused = await terminalTool.execute(call, ctx(sibling.id));
			expect(refused.isError).toBe(true);
			expect(refused.output).toContain("does not belong to this narrator");
		}
		const parentRead = await terminalTool.execute({ action: "read", terminal_id: id }, ctx(root));
		expect(parentRead.isError).toBe(true);
	});

	test("a subagent's fourth running terminal is refused; exited ones do not count", async () => {
		const root = await primary();
		const worker = await subagent(root, "worker");
		await terminalRow(worker.id, "exited");
		for (let i = 0; i < SUBAGENT_TERMINAL_LIMIT; i++) await terminalRow(worker.id);
		const refused = await terminalTool.execute({ action: "create" }, ctx(worker.id));
		expect(refused.isError).toBe(true);
		expect(refused.output).toContain(`already has ${SUBAGENT_TERMINAL_LIMIT} running terminals`);
		// The same cap holds for a person creating one on the subagent through the service.
		await expect(terminalService.create({ narratorId: worker.id })).rejects.toThrow(
			"running terminals",
		);
		const rows = await db.query.terminals.findMany({
			where: eq(terminals.narratorId, worker.id),
		});
		expect(rows).toHaveLength(SUBAGENT_TERMINAL_LIMIT + 1);
	});

	test("concurrent creates cannot pass the cap together", async () => {
		const root = await primary();
		const worker = await subagent(root, "worker");
		for (let i = 0; i < SUBAGENT_TERMINAL_LIMIT - 1; i++) await terminalRow(worker.id);
		const results = await Promise.all([
			terminalTool.execute({ action: "create" }, ctx(worker.id)),
			terminalTool.execute({ action: "create" }, ctx(worker.id)),
		]);
		for (const result of results) {
			const id = /- ID: (\S+)/.exec(result.output)?.[1];
			if (id) ptys.push(id);
		}
		expect(results.filter((result) => !result.isError)).toHaveLength(1);
		expect(results.filter((result) => result.isError)).toHaveLength(1);
	});

	test("a primary's terminals are not capped", async () => {
		const root = await primary();
		for (let i = 0; i < SUBAGENT_TERMINAL_LIMIT; i++) await terminalRow(root);
		const result = await terminalTool.execute({ action: "create" }, ctx(root));
		const id = /- ID: (\S+)/.exec(result.output)?.[1];
		if (id) ptys.push(id);
		expect(result.isError).not.toBe(true);
	});
});

describe("browser caps", () => {
	test("a subagent's third session is refused by the Browser tool before any tab opens", async () => {
		const root = await primary();
		const worker = await subagent(root, "worker");
		fakeSession(worker.id);
		fakeSession(worker.id);
		const refused = await browserTool.execute(
			{ action: "launch", url: "https://example.invalid/" },
			ctx(worker.id),
		);
		expect(refused.isError).toBe(true);
		expect(refused.output).toContain("already has 2 browser sessions");
		expect(sessionCount(worker.id)).toBe(2);
	});

	test("a team's seventh session is refused; six are fine", async () => {
		const root = await primary();
		const a = await subagent(root, "worker");
		const b = await subagent(root, "worker");
		const c = await subagent(a.id, "worker");
		const d = await subagent(root, "review");
		const outsider = await subagent(await primary(), "worker");
		for (const id of [root, a.id, a.id, b.id, b.id]) fakeSession(id);
		fakeSession(outsider.id);
		fakeSession(outsider.id);
		const counts = () =>
			new Map([...registry.sessions].map(([id, map]) => [id, map.size] as [string, number]));
		// Five in the tree (the outsider's two are another team's): the sixth is admitted.
		const sixth = await reserveBrowserLaunch(c.id, counts);
		await expect(reserveBrowserLaunch(d.id, counts)).rejects.toThrow(
			"This team already has 6 browser sessions",
		);
		sixth.release();
		const again = await reserveBrowserLaunch(d.id, counts);
		again.release();
		// The root itself is never refused by the team cap.
		(await reserveBrowserLaunch(root, () => new Map([[root, 6]]))).release();
	});

	test("concurrent launches of one subagent see each other", async () => {
		const root = await primary();
		const worker = await subagent(root, "worker");
		fakeSession(worker.id);
		const counts = () => new Map([[worker.id, sessionCount(worker.id)]]);
		const outcomes = await Promise.allSettled([
			reserveBrowserLaunch(worker.id, counts),
			reserveBrowserLaunch(worker.id, counts),
		]);
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
	});

	test("the process cap refuses everyone, primaries included", async () => {
		const root = await primary();
		const full = () => new Map([["someone", PROCESS_BROWSER_SESSION_LIMIT]]);
		await expect(reserveBrowserLaunch(root, full)).rejects.toThrow(
			`already has ${PROCESS_BROWSER_SESSION_LIMIT} browser sessions open`,
		);
		const below = () => new Map([["someone", PROCESS_BROWSER_SESSION_LIMIT - 1]]);
		(await reserveBrowserLaunch(root, below)).release();
	});
});

describe("closing", () => {
	test("archiving a subagent closes its terminals and browser sessions, not its parent's", async () => {
		const root = await primary();
		const worker = await subagent(root, "worker");
		const created_ = await terminalTool.execute({ action: "create" }, ctx(worker.id));
		const pty = /- ID: (\S+)/.exec(created_.output)?.[1] ?? "";
		ptys.push(pty);
		const rowOnly = await terminalRow(worker.id);
		const rootTerminal = await terminalRow(root);
		const workerTab = fakeSession(worker.id);
		const rootTab = fakeSession(root);

		const result = await interruptAndArchiveSubagent(worker.id);
		expect(result.ok).toBe(true);
		const status = async (id: string) =>
			(await db.query.terminals.findFirst({ where: eq(terminals.id, id) }))?.status;
		expect(await status(pty)).toBe("exited");
		expect(await status(rowOnly)).toBe("exited");
		expect(await status(rootTerminal)).toBe("running");
		expect(sessionCount(worker.id)).toBe(0);
		expect(workerTab.closed).toBe(true);
		expect(sessionCount(root)).toBe(1);
		expect(rootTab.closed).toBe(false);
	});

	test("deleting a subagent with its parent closes what it left open", async () => {
		const root = await primary();
		const worker = await subagent(root, "worker");
		const created_ = await terminalTool.execute({ action: "create" }, ctx(worker.id));
		const pty = /- ID: (\S+)/.exec(created_.output)?.[1] ?? "";
		ptys.push(pty);
		const tab = fakeSession(worker.id);
		expect(terminalService.getActiveBuffer(pty)).toBeDefined();
		await db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, root));
		await narratorService.remove(root);
		expect(terminalService.getActiveBuffer(pty)).toBeUndefined();
		expect(tab.closed).toBe(true);
		expect(sessionCount(worker.id)).toBe(0);
	});

	test("a primary's resources are never closed by the subagent paths", async () => {
		const root = await primary();
		const rootTerminal = await terminalRow(root);
		fakeSession(root);
		expect(await closeSubagentResources(root)).toEqual({ terminals: 0, browserSessions: 0 });
		expect(await releaseSubagentBrowsersAtRunEnd(root, { stopped: true })).toBe(0);
		const row = await db.query.terminals.findFirst({ where: eq(terminals.id, rootTerminal) });
		expect(row?.status).toBe("running");
		expect(sessionCount(root)).toBe(1);
	});

	test("a run's end closes browser sessions unless a helper is still working", async () => {
		const root = await primary();
		const worker = await subagent(root, "worker");
		const helper = await subagent(worker.id, "general");
		await narratorService.updateStatus(helper.id, "working");
		fakeSession(worker.id);
		expect(await releaseSubagentBrowsersAtRunEnd(worker.id, { stopped: false })).toBe(0);
		expect(sessionCount(worker.id)).toBe(1);
		// Stopped or timed out: its helpers are being stopped, nothing is pending.
		expect(await releaseSubagentBrowsersAtRunEnd(worker.id, { stopped: true })).toBe(1);
		expect(sessionCount(worker.id)).toBe(0);
		fakeSession(worker.id);
		await narratorService.updateStatus(helper.id, "idle");
		expect(await releaseSubagentBrowsersAtRunEnd(worker.id, { stopped: false })).toBe(1);
		expect(sessionCount(worker.id)).toBe(0);
	});
});

describe("listing and opening", () => {
	function app(user: string) {
		const routes = new Hono();
		routes.use("*", async (c, next) => {
			c.set("user", { sub: user, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
			await next();
		});
		routes.onError(
			(error) =>
				new Response(JSON.stringify({ error: error.message }), {
					status: error instanceof AppError ? error.statusCode : 500,
				}),
		);
		routes.route("/api/terminals", terminalRoutes);
		return routes;
	}

	async function team() {
		const owner = await makeUser("owner");
		const reader = await makeUser("reader");
		const root = await primary({ ownerUserId: owner, visibility: "public" });
		const worker = await subagent(root, "worker", "w1");
		const helper = await subagent(worker.id, "worker", "w2");
		const workerTerminal = await terminalRow(worker.id);
		const helperTerminal = await terminalRow(helper.id);
		await terminalRow(worker.id, "exited");
		const rootTerminal = await terminalRow(root);
		return { owner, reader, root, worker, helper, workerTerminal, helperTerminal, rootTerminal };
	}

	test("the root lists every subagent's running terminals; a subagent lists its helpers'", async () => {
		const t = await team();
		const rootRow = await narratorService.getById(t.root);
		const listing = await listTreeTerminals(rootRow);
		expect(listing.truncated).toBe(false);
		expect(listing.terminals.map((row) => row.id).sort()).toEqual(
			[t.workerTerminal, t.helperTerminal].sort(),
		);
		expect(listing.terminals.find((row) => row.id === t.helperTerminal)?.narratorTitle).toBe("w2");
		const workerListing = await listTreeTerminals(t.worker);
		expect(workerListing.terminals.map((row) => row.id)).toEqual([t.helperTerminal]);
	});

	test("readers list read-only; opening needs write access on the root", async () => {
		const t = await team();
		const asReader = app(t.reader);
		const asOwner = app(t.owner);
		const stranger = app(await makeUser("stranger"));
		await db.update(narrators).set({ visibility: "private" }).where(eq(narrators.id, t.root));
		expect((await stranger.request(`/api/terminals/tree?narratorId=${t.root}`)).status).toBe(404);
		await db.update(narrators).set({ visibility: "public" }).where(eq(narrators.id, t.root));

		const readerList = await asReader.request(`/api/terminals/tree?narratorId=${t.root}`);
		expect(readerList.status).toBe(200);
		const body = (await readerList.json()) as { terminals: { id: string }[]; canOpen: boolean };
		expect(body.terminals).toHaveLength(2);
		expect(body.canOpen).toBe(false);
		const ownerBody = (await (
			await asOwner.request(`/api/terminals/tree?narratorId=${t.root}`)
		).json()) as { canOpen: boolean };
		expect(ownerBody.canOpen).toBe(true);

		// Metadata is a read; renaming, closing and its processes are opening it.
		expect((await asReader.request(`/api/terminals/${t.helperTerminal}`)).status).toBe(200);
		const patch = { method: "PATCH", body: JSON.stringify({ name: "x" }) };
		expect((await asReader.request(`/api/terminals/${t.helperTerminal}`, patch)).status).toBe(404);
		expect(
			(await asReader.request(`/api/terminals/${t.helperTerminal}`, { method: "DELETE" })).status,
		).toBe(404);
		expect((await asReader.request(`/api/terminals/${t.helperTerminal}/processes`)).status).toBe(
			404,
		);
		expect((await asOwner.request(`/api/terminals/${t.helperTerminal}`, patch)).status).toBe(200);

		// A write grant on the root opens it, like driving the session.
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "narrator",
			scopeId: t.root,
			principalType: "user",
			principalId: t.reader,
			capability: "write",
			createdAt: new Date().toISOString(),
		});
		const granted = (await (
			await asReader.request(`/api/terminals/tree?narratorId=${t.root}`)
		).json()) as { canOpen: boolean };
		expect(granted.canOpen).toBe(true);
		expect((await asReader.request(`/api/terminals/${t.helperTerminal}`, patch)).status).toBe(200);
	});

	test("the terminal WebSocket subscribes only callers with write access on the root", async () => {
		const t = await team();
		const socket = (userId: string) => {
			const sent: { type: string; code?: string; terminalId?: string }[] = [];
			const ws = {
				data: {
					channel: "terminal",
					connectedAt: Date.now(),
					lastPongAt: Date.now(),
					subscribedTerminals: new Set<string>(),
					userId,
					userRole: "user",
				},
				send: (payload: string) => sent.push(JSON.parse(payload)),
			};
			return { ws, sent };
		};
		const reader = socket(t.reader);
		await handleTerminalWS.message(reader.ws as never, {
			type: "subscribe",
			terminalIds: [t.workerTerminal, t.rootTerminal],
		});
		expect([...reader.ws.data.subscribedTerminals]).toEqual([t.rootTerminal]);
		expect(reader.sent).toContainEqual(
			expect.objectContaining({
				type: "error",
				code: "TERMINAL_ACCESS_DENIED",
				terminalId: t.workerTerminal,
			}),
		);
		await handleTerminalWS.message(reader.ws as never, {
			type: "rename",
			terminalId: t.workerTerminal,
			name: "taken",
		});
		const renamed = await db.query.terminals.findFirst({
			where: eq(terminals.id, t.workerTerminal),
		});
		expect(renamed?.name).not.toBe("taken");
		await handleTerminalWS.message(reader.ws as never, {
			type: "create",
			requestId: "r1",
			narratorId: t.worker.id,
		});
		expect(reader.sent).toContainEqual(
			expect.objectContaining({ type: "error", code: "TERMINAL_ACCESS_DENIED", terminalId: "" }),
		);

		const owner = socket(t.owner);
		await handleTerminalWS.message(owner.ws as never, {
			type: "subscribe",
			terminalIds: [t.workerTerminal, t.helperTerminal],
		});
		expect([...owner.ws.data.subscribedTerminals].sort()).toEqual(
			[t.workerTerminal, t.helperTerminal].sort(),
		);
	});
});
