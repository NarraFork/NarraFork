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
 *     and WebSocket) needs write access on the root;
 *  6. every narrator's terminal follows its narrator's ACL (review round 1): reading its
 *     metadata needs read access, anything that opens it needs write, re-checked on each
 *     keystroke; a standalone terminal is its creator's and admins'; unknown and refused ids
 *     get the same answer;
 *  7. an archived subagent gets no terminal or browser session, also when its archive lands
 *     while one is opening; subagents browse headless only; no session navigates to file:.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { aclGrants, narrators, terminals, users } from "../../db/schema";
import { browserTool } from "../../lib/agent/tools/browser";
import { terminalTool } from "../../lib/agent/tools/terminal";
import type { ToolContext } from "../../lib/agent/types";
import * as browserModule from "../../lib/browser";
import "../../lib/browser/session";
import { AppError } from "../../lib/errors";
import { eventBus } from "../../lib/event-bus";
import { generateId } from "../../lib/id";
import { withRuntimePolicyTrait } from "../../lib/runtime-policy-trait";
import { terminalRoutes } from "../../routes/terminals";
import { handleTerminalWS, settleTerminalAccessSweep } from "../../websocket/terminal-ws";
import {
	PROCESS_BROWSER_SESSION_LIMIT,
	reserveBrowserLaunch,
	resetAgentResourceCapsForTest,
	SUBAGENT_TERMINAL_LIMIT,
	withTerminalSlot,
} from "../agent-resource-caps";
import { setRunControl, tryClaimExecution } from "../agent-runtime/ownership";
import {
	compileDelegationPolicy,
	isRuntimeToolAllowed,
	resolveRuntimePolicy,
	withDelegationDepth,
} from "../agent-runtime/policy";
import { resolvePermissionDecision } from "../narrator-permission";
import { narratorService } from "../narrator-service";
import { interruptAndArchiveSubagent } from "../subagent-lifecycle";
import { closeSubagentResources, releaseSubagentBrowsersAtRunEnd } from "../subagent-resources";
import { listTreeTerminals } from "../subagent-terminals";
import * as terminalAccessModule from "../terminal-access";
import { resetTerminalAccessForTest } from "../terminal-access";
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

function app(user: string, role: "user" | "admin" = "user") {
	const routes = new Hono();
	routes.use("*", async (c, next) => {
		c.set("user", { sub: user, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
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

interface Frame {
	type: string;
	code?: string;
	message?: string;
	terminalId?: string;
	terminal?: { id: string };
}

function socket(userId: string, userRole: "user" | "admin" = "user") {
	const sent: Frame[] = [];
	const ws = {
		readyState: 1,
		data: {
			channel: "terminal",
			connectedAt: Date.now(),
			lastPongAt: Date.now(),
			subscribedTerminals: new Set<string>(),
			userId,
			userRole,
		},
		send: (payload: string) => sent.push(JSON.parse(payload)),
	};
	const send = (message: Record<string, unknown>) => handleTerminalWS.message(ws as never, message);
	return { ws, sent, send };
}

async function grantWrite(narratorId: string, userId: string) {
	const id = generateId();
	await db.insert(aclGrants).values({
		id,
		scopeType: "narrator",
		scopeId: narratorId,
		principalType: "user",
		principalId: userId,
		capability: "write",
		createdAt: new Date().toISOString(),
	});
	return id;
}

async function screen(terminalId: string): Promise<string> {
	return (await terminalService.getScrollback(terminalId))?.data ?? "";
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

	test("a terminal named like an exited one resolves to the running one", async () => {
		const root = await primary();
		const worker = await subagent(root, "worker");
		const running = await terminalRow(worker.id);
		await db.update(terminals).set({ name: "dev" }).where(eq(terminals.id, running));
		const exited = await terminalRow(worker.id, "exited");
		await db
			.update(terminals)
			.set({ name: "dev", createdAt: new Date(Date.now() + 60_000).toISOString() })
			.where(eq(terminals.id, exited));
		const renamed = await terminalTool.execute(
			{ action: "rename", terminal_id: "DEV", name: "dev-server" },
			ctx(worker.id),
		);
		expect(renamed.isError).not.toBe(true);
		const name = async (id: string) =>
			(await db.query.terminals.findFirst({ where: eq(terminals.id, id) }))?.name;
		expect(await name(running)).toBe("dev-server");
		expect(await name(exited)).toBe("dev");
	});

	test("a terminal is an unfenced shell: its input is not judged line by line", () => {
		// Owner decision (2026-11-18): the Terminal tool is permitted as a whole by mode.
		expect(terminalTool.description).toContain("unfenced shell");
		const write = { action: "write", terminal_id: "t", input: "cat ~/.narrafork/settings.json\n" };
		const decide = (permMode: string) =>
			resolvePermissionDecision({
				toolName: "Terminal",
				input: write,
				permMode,
				cwd: process.cwd(),
			});
		expect(decide("bypassPermissions")).toBe("allow");
		expect(decide("default")).toBe("ask");
		expect(decide("acceptEdits")).toBe("ask");
		expect(decide("dontAsk")).toBe("deny");
		expect(decide("readOnly")).toBe("deny");
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
		await narratorService.updateStatus(worker.id, "idle");
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

	test("a Send that starts the next run while the last one finishes keeps its browser", async () => {
		const root = await primary();
		const worker = await subagent(root, "worker");
		await narratorService.updateStatus(worker.id, "idle");
		const finished = { id: "finished-run" };
		fakeSession(worker.id);

		// The next run already owns the subagent: its tabs stay, even for a stopped run.
		const next = tryClaimExecution(worker.id, "run");
		if (!next) throw new Error("could not claim the fixture execution");
		setRunControl(next, { id: "next-run" } as never);
		expect(await releaseSubagentBrowsersAtRunEnd(worker.id, { stopped: true, run: finished })).toBe(
			0,
		);
		expect(sessionCount(worker.id)).toBe(1);
		// The finishing run itself still owning it is no newer run.
		setRunControl(next, finished as never);
		expect(
			await releaseSubagentBrowsersAtRunEnd(worker.id, { stopped: false, run: finished }),
		).toBe(1);
		next.release();

		// Its status already says working (the next run is starting): kept.
		fakeSession(worker.id);
		await narratorService.updateStatus(worker.id, "working");
		expect(await releaseSubagentBrowsersAtRunEnd(worker.id, { stopped: false })).toBe(0);
		await narratorService.updateStatus(worker.id, "idle");

		// A launch of the next run is still opening its tab: kept.
		const slot = await reserveBrowserLaunch(worker.id, () => new Map([[worker.id, 1]]));
		expect(await releaseSubagentBrowsersAtRunEnd(worker.id, { stopped: false })).toBe(0);
		slot.release();
		expect(sessionCount(worker.id)).toBe(1);

		// The next run claims the subagent after the release has started: nothing is closed.
		let claimed: ReturnType<typeof tryClaimExecution> = null;
		const releasing = releaseSubagentBrowsersAtRunEnd(worker.id, {
			stopped: false,
			run: finished,
		});
		queueMicrotask(() => {
			claimed = tryClaimExecution(worker.id, "run");
		});
		expect(await releasing).toBe(0);
		expect(sessionCount(worker.id)).toBe(1);
		(claimed as ReturnType<typeof tryClaimExecution>)?.release();
	});
});

describe("listing and opening", () => {
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

	test("the terminal WebSocket opens subagents' terminals only for writers of the root", async () => {
		const t = await team();
		const reader = socket(t.reader);
		await reader.send({
			type: "subscribe",
			terminalIds: [t.workerTerminal, t.rootTerminal, "no-such-terminal"],
		});
		expect([...reader.ws.data.subscribedTerminals]).toEqual([]);
		// A refused terminal and an unknown id get the same frame.
		const frames = reader.sent.map(({ type, code }) => ({ type, code }));
		expect(frames).toEqual([
			{ type: "error", code: "TERMINAL_NOT_FOUND" },
			{ type: "error", code: "TERMINAL_NOT_FOUND" },
			{ type: "error", code: "TERMINAL_NOT_FOUND" },
		]);
		await reader.send({ type: "rename", terminalId: t.workerTerminal, name: "taken" });
		const renamed = await db.query.terminals.findFirst({
			where: eq(terminals.id, t.workerTerminal),
		});
		expect(renamed?.name).not.toBe("taken");
		await reader.send({ type: "create", requestId: "r1", narratorId: t.worker.id });
		await reader.send({ type: "create", requestId: "r2", narratorId: "no-such-narrator" });
		const creates = reader.sent.slice(-2).map(({ type, code }) => ({ type, code }));
		expect(creates).toEqual([
			{ type: "error", code: "NOT_FOUND" },
			{ type: "error", code: "NOT_FOUND" },
		]);

		const owner = socket(t.owner);
		await owner.send({ type: "subscribe", terminalIds: [t.workerTerminal, t.helperTerminal] });
		expect([...owner.ws.data.subscribedTerminals].sort()).toEqual(
			[t.workerTerminal, t.helperTerminal].sort(),
		);
	});
});

describe("terminal access for every narrator", () => {
	async function ownedShell() {
		const owner = await makeUser("owner");
		const reader = await makeUser("reader");
		const stranger = await makeUser("stranger");
		const root = await primary({ ownerUserId: owner, visibility: "public" });
		const shell = await terminalService.create({ narratorId: root, name: "owner-shell" });
		ptys.push(shell.id);
		return { owner, reader, stranger, root, shell: shell.id };
	}

	test("a read-only viewer lists a primary's terminals but cannot watch or type into them", async () => {
		const t = await ownedShell();
		const list = await app(t.reader).request(`/api/terminals?narratorId=${t.root}`);
		expect(list.status).toBe(200);
		expect(((await list.json()) as { id: string }[]).map(({ id }) => id)).toContain(t.shell);
		expect((await app(t.reader).request(`/api/terminals/${t.shell}`)).status).toBe(200);
		// The page hides the terminal panel and its create buttons from this viewer.
		const access = async (user: string) =>
			(await (await app(user).request(`/api/terminals/access?narratorId=${t.root}`)).json()) as {
				canOpen: boolean;
			};
		expect(await access(t.reader)).toEqual({ canOpen: false });
		expect(await access(t.owner)).toEqual({ canOpen: true });
		expect(
			(await app(t.stranger).request(`/api/terminals/access?narratorId=${t.root}`)).status,
		).toBe(200);
		await db.update(narrators).set({ visibility: "private" }).where(eq(narrators.id, t.root));
		expect(
			(await app(t.stranger).request(`/api/terminals/access?narratorId=${t.root}`)).status,
		).toBe(404);
		await db.update(narrators).set({ visibility: "public" }).where(eq(narrators.id, t.root));

		const reader = socket(t.reader);
		await reader.send({ type: "subscribe", terminalIds: [t.shell] });
		expect(reader.ws.data.subscribedTerminals.has(t.shell)).toBe(false);
		expect(reader.sent).toContainEqual({
			type: "error",
			terminalId: t.shell,
			code: "TERMINAL_NOT_FOUND",
			message: "Terminal not found",
		});
		// Even with a subscription it never got, input is dropped.
		reader.ws.data.subscribedTerminals.add(t.shell);
		await reader.send({ type: "input", terminalId: t.shell, data: "echo GAP_$((6*7))\n" });
		expect(reader.ws.data.subscribedTerminals.has(t.shell)).toBe(false);

		// The owner's typing runs, so the reader's would have shown by now.
		const owner = socket(t.owner);
		await owner.send({ type: "subscribe", terminalIds: [t.shell] });
		expect(owner.ws.data.subscribedTerminals.has(t.shell)).toBe(true);
		await owner.send({ type: "input", terminalId: t.shell, data: "echo OWNER_$((40+2))\n" });
		await until(async () => (await screen(t.shell)).includes("OWNER_42"), "the owner's command");
		expect(await screen(t.shell)).not.toContain("GAP_42");
	});

	test("a revoked write grant stops the next keystroke", async () => {
		const t = await ownedShell();
		const grant = await grantWrite(t.root, t.reader);
		const colleague = socket(t.reader);
		await colleague.send({ type: "subscribe", terminalIds: [t.shell] });
		expect(colleague.ws.data.subscribedTerminals.has(t.shell)).toBe(true);
		await colleague.send({ type: "input", terminalId: t.shell, data: "echo GRANT_$((6*7))\n" });
		await until(async () => (await screen(t.shell)).includes("GRANT_42"), "the granted command");
		await db.delete(aclGrants).where(eq(aclGrants.id, grant));
		await colleague.send({ type: "input", terminalId: t.shell, data: "echo REVOKED_$((6*7))\n" });
		expect(colleague.ws.data.subscribedTerminals.has(t.shell)).toBe(false);
		await colleague.send({ type: "rename", terminalId: t.shell, name: "taken" });
		await colleague.send({ type: "kill", terminalId: t.shell });
		const owner = socket(t.owner);
		await owner.send({ type: "subscribe", terminalIds: [t.shell] });
		await owner.send({ type: "input", terminalId: t.shell, data: "echo AFTER_$((6*7))\n" });
		await until(async () => (await screen(t.shell)).includes("AFTER_42"), "the owner's command");
		expect(await screen(t.shell)).not.toContain("REVOKED_42");
		const row = await db.query.terminals.findFirst({ where: eq(terminals.id, t.shell) });
		expect(row?.name).toBe("owner-shell");
		expect(row?.status).toBe("running");
	});

	test("a revoked share stops the output stream at once, and resize re-checks too", async () => {
		const t = await ownedShell();
		const grant = await grantWrite(t.root, t.reader);
		const colleague = socket(t.reader);
		handleTerminalWS.open(colleague.ws as never);
		const owner = socket(t.owner);
		handleTerminalWS.open(owner.ws as never);
		try {
			await colleague.send({ type: "subscribe", terminalIds: [t.shell] });
			await owner.send({ type: "subscribe", terminalIds: [t.shell] });
			expect(colleague.ws.data.subscribedTerminals.has(t.shell)).toBe(true);
			await db.delete(aclGrants).where(eq(aclGrants.id, grant));
			eventBus.emit({ type: "narrator:access_changed", narratorId: t.root, reason: "unshared" });
			await settleTerminalAccessSweep();
			expect(colleague.ws.data.subscribedTerminals.has(t.shell)).toBe(false);
			expect(colleague.sent.at(-1)).toEqual(
				expect.objectContaining({ type: "error", code: "TERMINAL_NOT_FOUND" }),
			);
			const before = colleague.sent.length;
			await owner.send({ type: "input", terminalId: t.shell, data: "echo SECRET_$((7*6))\n" });
			await until(async () => (await screen(t.shell)).includes("SECRET_42"), "the owner's output");
			await until(
				async () => owner.sent.some((frame) => JSON.stringify(frame).includes("SECRET_42")),
				"the owner's frames",
			);
			expect(JSON.stringify(colleague.sent.slice(before))).not.toContain("SECRET_42");

			// Without an event, the next resize re-checks and drops the subscription too.
			const grant2 = await grantWrite(t.root, t.reader);
			await colleague.send({ type: "subscribe", terminalIds: [t.shell] });
			await db.delete(aclGrants).where(eq(aclGrants.id, grant2));
			await colleague.send({ type: "resize", terminalId: t.shell, cols: 20, rows: 5 });
			expect(colleague.ws.data.subscribedTerminals.has(t.shell)).toBe(false);
		} finally {
			handleTerminalWS.close(colleague.ws as never);
			handleTerminalWS.close(owner.ws as never);
		}
	});

	test("a stranger gets the same 404 as for an unknown id, everywhere", async () => {
		const t = await ownedShell();
		await db.update(narrators).set({ visibility: "private" }).where(eq(narrators.id, t.root));
		const stranger = app(t.stranger);
		const patch = { method: "PATCH", body: JSON.stringify({ name: "pwned" }) };
		for (const id of [t.shell, "no-such-terminal"]) {
			expect((await stranger.request(`/api/terminals/${id}`)).status).toBe(404);
			expect((await stranger.request(`/api/terminals/${id}/processes`)).status).toBe(404);
			expect((await stranger.request(`/api/terminals/${id}`, patch)).status).toBe(404);
			expect((await stranger.request(`/api/terminals/${id}`, { method: "DELETE" })).status).toBe(
				404,
			);
		}
		const ws = socket(t.stranger);
		await ws.send({ type: "create", requestId: "x", narratorId: t.root });
		expect(ws.sent.find((frame) => frame.type === "created")).toBeUndefined();
		expect(ws.sent).toContainEqual(expect.objectContaining({ type: "error", code: "NOT_FOUND" }));
		const rows = await db.query.terminals.findMany({ where: eq(terminals.narratorId, t.root) });
		expect(rows.map(({ id }) => id)).toEqual([t.shell]);
		const row = rows[0];
		expect(row.name).toBe("owner-shell");
		expect(row.status).toBe("running");

		// The owner and an admin keep everything.
		expect((await app(t.owner).request(`/api/terminals/${t.shell}/processes`)).status).toBe(200);
		expect((await app(t.owner).request(`/api/terminals/${t.shell}`, patch)).status).toBe(200);
		const admin = socket(await makeUser("admin"), "admin");
		await admin.send({ type: "subscribe", terminalIds: [t.shell] });
		expect(admin.ws.data.subscribedTerminals.has(t.shell)).toBe(true);
		expect(
			(await app("someone", "admin").request(`/api/terminals/${t.shell}`, { method: "DELETE" }))
				.status,
		).toBe(200);
	});

	test("a subscription whose access is revoked while it is being added is dropped", async () => {
		const t = await ownedShell();
		const owner = socket(t.owner);
		let calls = 0;
		// Allowed at the first check, revoked before the check after the subscription.
		const spy = spyOn(terminalAccessModule, "terminalAccessAllowed").mockImplementation(
			async () => ++calls === 1,
		);
		try {
			await owner.send({ type: "subscribe", terminalIds: [t.shell] });
		} finally {
			spy.mockRestore();
		}
		expect(calls).toBe(2);
		expect(owner.ws.data.subscribedTerminals.has(t.shell)).toBe(false);
		expect(owner.sent).toContainEqual(
			expect.objectContaining({ type: "error", code: "TERMINAL_NOT_FOUND" }),
		);
	});

	test("a standalone terminal is its creator's and admins'", async () => {
		resetTerminalAccessForTest();
		const creator = await makeUser("creator");
		const other = await makeUser("other");
		const created_ = await app(creator).request("/api/terminals", {
			method: "POST",
			body: JSON.stringify({ name: "setup" }),
		});
		expect(created_.status).toBe(201);
		const { id } = (await created_.json()) as { id: string };
		ptys.push(id);
		expect((await app(other).request(`/api/terminals/${id}`)).status).toBe(404);
		const others = socket(other);
		await others.send({ type: "subscribe", terminalIds: [id] });
		expect(others.ws.data.subscribedTerminals.has(id)).toBe(false);
		expect((await app(creator).request(`/api/terminals/${id}`)).status).toBe(200);
		const mine = socket(creator);
		await mine.send({ type: "subscribe", terminalIds: [id] });
		expect(mine.ws.data.subscribedTerminals.has(id)).toBe(true);
		const admin = socket(await makeUser("admin"), "admin");
		await admin.send({ type: "subscribe", terminalIds: [id] });
		expect(admin.ws.data.subscribedTerminals.has(id)).toBe(true);
		// Anyone may still create one (unchanged); the WebSocket creator owns theirs too.
		await others.send({ type: "create", requestId: "s" });
		const made = others.sent.find((frame) => frame.type === "created");
		if (made?.terminal) ptys.push(made.terminal.id);
		expect(made?.terminal?.id).toBeDefined();
		expect(others.ws.data.subscribedTerminals.has(made?.terminal?.id ?? "")).toBe(true);
		expect((await app(creator).request(`/api/terminals/${made?.terminal?.id}`)).status).toBe(404);
	});
});

describe("archived subagents and browser rules", () => {
	test("an archived subagent gets no terminal and no browser session", async () => {
		const root = await primary();
		const worker = await subagent(root, "worker");
		await interruptAndArchiveSubagent(worker.id);
		const terminal = await terminalTool.execute({ action: "create" }, ctx(worker.id));
		expect(terminal.isError).toBe(true);
		expect(terminal.output).toContain("archived");
		await expect(terminalService.create({ narratorId: worker.id })).rejects.toThrow("archived");
		// Refused before any shell started.
		expect(
			await db.query.terminals.findMany({ where: eq(terminals.narratorId, worker.id) }),
		).toEqual([]);
		const launch = await browserTool.execute(
			{ action: "launch", url: "https://example.invalid/" },
			ctx(worker.id),
		);
		expect(launch.isError).toBe(true);
		expect(launch.output).toContain("archived");
	});

	test("a shell that finishes starting after the archive is closed again", async () => {
		const root = await primary();
		const worker = await subagent(root, "worker");
		const discarded: string[] = [];
		await expect(
			withTerminalSlot(
				worker.id,
				async () => {
					await db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, worker.id));
					return { id: "late-shell" };
				},
				async (shell) => discarded.push(shell.id),
			),
		).rejects.toThrow("archived");
		expect(discarded).toEqual(["late-shell"]);
	});

	test("a tab that finishes opening after the archive is closed again", async () => {
		const root = await primary();
		const worker = await subagent(root, "worker");
		let tab: { closed: boolean } | undefined;
		const spy = spyOn(browserModule, "createSession").mockImplementation((async (
			narratorId: string,
		) => {
			await db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, narratorId));
			tab = fakeSession(narratorId);
			const [session] = registry.sessions.get(narratorId)?.values() ?? [];
			return session;
		}) as never);
		try {
			const result = await browserTool.execute(
				{ action: "launch", url: "https://example.invalid/" },
				ctx(worker.id),
			);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(result.isError).toBe(true);
			expect(result.output).toContain("archived");
			expect(tab?.closed).toBe(true);
			expect(sessionCount(worker.id)).toBe(0);
		} finally {
			spy.mockRestore();
		}
	});

	test("subagents launch headless only; primaries keep headed launches", async () => {
		const root = await primary();
		const worker = await subagent(root, "worker");
		const refused = await browserTool.execute(
			{ action: "launch", url: "https://example.invalid/", headless: false },
			ctx(worker.id),
		);
		expect(refused.isError).toBe(true);
		expect(refused.output).toContain("headless browser sessions only");
		expect(sessionCount(worker.id)).toBe(0);
		(await reserveBrowserLaunch(root, () => new Map(), { headless: false })).release();
	});

	test("no session navigates to file:, chrome: or javascript:, for primaries too", async () => {
		const root = await primary();
		fakeSession(root);
		const [sessionId] = registry.sessions.get(root)?.keys() ?? [];
		for (const url of [
			"file:///etc/hostname",
			"chrome://version",
			"javascript:document.title='x'",
			"view-source:https://example.invalid/",
		]) {
			const result = await browserTool.execute(
				{ action: "navigate", session_id: sessionId, url },
				ctx(root),
			);
			expect(result.isError).toBe(true);
			expect(result.output).toContain("Unsupported protocol");
		}
	});
});
