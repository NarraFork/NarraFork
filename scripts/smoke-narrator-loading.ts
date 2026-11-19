import { Database } from "bun:sqlite";
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type HTTPRequest, type Page } from "puppeteer-core";
import type { ReadFanoutReport } from "../server/lib/read-fanout-diagnostics";

interface SmokeRuntime {
	home: string;
	base: string;
	evidenceDir: string;
	start(): void;
	cleanup(): Promise<void>;
	assertHealthyProcess(): void;
	logTail?(): string;
	ownBrowser(browser: Browser): void;
	report(checks: Array<{ name: string; ok: boolean; detail: string }>): void;
}
// Keep the smoke-only typecheck from recursively pulling the plugin harness's unrelated
// dynamic application imports into its scope. Runtime still uses the exact shared harness.
const HARNESS_MODULE = "./smoke-plugin-ui";
const { assertSmokeInputs, createSmokeRuntime, isolatedSmokeEnvironment } = (await import(
	HARNESS_MODULE
)) as {
	assertSmokeInputs(paths: readonly string[]): void;
	createSmokeRuntime(options?: { watchdogMs?: number }): Promise<SmokeRuntime>;
	isolatedSmokeEnvironment(home: string): Record<string, string>;
};

const MAX_OUTPUT_BYTES = 32 * 1024;
const HTTP_TIMEOUT_MS = 10_000;
const GIT_DELAY_MS = 2_000;
const readFanout = process.argv.includes("--read-fanout");
const diagnosticMobile = process.argv.includes("--diagnostic-mobile");
const diagnostic = diagnosticMobile || process.argv.includes("--diagnostic");
const faultMode = process.argv.find((arg) => arg.startsWith("--fault="))?.split("=")[1];
const faultModes = ["window-403", "window-network", "locate-403", "locate-network"];
const HISTORY_KINDS = ["detail", "tail", "window", "page", "locate"];
interface VisibleFrame {
	target: string;
	sentinels: string[];
}
const SENTINELS = {
	A: ["LOADING_SENTINEL_A_USER", "LOADING_SENTINEL_A_REPLY"],
	B: ["LOADING_SENTINEL_B_USER", "LOADING_SENTINEL_B_REPLY"],
};
type Subject = keyof typeof SENTINELS;
interface Rect {
	top: number;
	height: number;
	width: number;
}
interface Paint {
	elapsedMs: number;
	viewport: Rect;
	slot: Rect | null;
	gitText: string;
	sentinels: string[];
	frame: number;
	chrome: {
		panelHeight: number;
		textareaHeight: number;
		statusHeight: number;
		innerHeight: number;
		textarea: {
			kind: "textarea" | "contenteditable";
			rect: Rect;
			clientWidth: number;
			inlineHeight: string;
			inlineMinHeight: string;
			computedMinHeight: string;
			placeholder: string;
			valueLength: number;
		} | null;
		containers: Array<{ className: string; rect: Rect }>;
		header: Rect | null;
		actionButtons: Array<{ text: string; width: number; height: number }>;
	};
}
interface BrowserProbe {
	target: string;
	expected: string[];
	startedAt: number;
	frames: number;
	candidateFrames: number;
	firstViewport: Paint | null;
	firstMessage: Paint | null;
	viewportChanges: Paint[];
	failure?: { message: string; frame: number };
}
interface ProbeWindow extends Window {
	__loadingProbe: BrowserProbe;
	__armLoadingProbe: (target: string, expected: string[]) => void;
}
interface RequestRecord {
	kind: string;
	narratorId: string;
	query?: string;
	messageVersion?: number;
	messageCount?: number;
	minSeq?: number | null;
	maxSeq?: number | null;
	layout?: {
		elapsedMs: number;
		target: string;
		viewports: Array<{ width: number; height: number; revision: string | null }>;
	};
	initiator?: Array<{ functionName: string; asset: string; line: number; column: number }>;
	atMs: number;
	endMs?: number;
	releaseMs?: number;
	delayed?: boolean;
	failed?: boolean;
	statusCode?: number;
}
interface Sample {
	viewport: string;
	iteration: number;
	coldMs: number;
	switchBMs: number;
	hotMs: number;
	coldTailRequests: number;
	switchBTailRequests: number;
	hotTailRequests: number;
	phaseRequestCounts: Record<"cold" | "switchB" | "hot", ReturnType<typeof historyRequestCounts>>;
}
interface Check {
	name: string;
	ok: boolean;
	detail: unknown;
}

export function summarize(samples: readonly number[]) {
	if (!samples.length || samples.some((sample) => !Number.isFinite(sample) || sample < 0))
		throw new Error("Invalid timing sample");
	const ordered = [...samples].sort((a, b) => a - b);
	const percentile = (q: number) =>
		Math.round((ordered[Math.max(0, Math.ceil(ordered.length * q) - 1)] ?? 0) * 10) / 10;
	return { n: ordered.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
}
// Fanout evidence is a separate allowlisted aggregate, never a copy of RequestRecord.
const FANOUT_LIMITS = {
	pendingHttp: 1_024,
	httpRows: 128,
	wsRows: 128,
	windowsPerRound: 16,
	resourceTimingEntries: 1_024,
	webSockets: 32,
	frameBytes: 64 * 1_024,
	serverReportBytes: 2 * 1_024 * 1_024,
	evidenceBytes: 64 * 1_024 * 1_024,
};
const FANOUT_LATENCY_BOUNDS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 5_000, 30_000];
type FanoutPhase = "cold" | "A_to_B" | "B_to_A" | "idle";
type FanoutLabel = FanoutPhase | "between-windows";
interface FanoutHttpCounts {
	started: number;
	responses: number;
	completed: number;
	failed: number;
	statuses: Record<string, number>;
}
interface FanoutHttpRow extends FanoutHttpCounts {
	category: string;
	method: string;
	originWindowId: number | "untracked";
}
interface FanoutInflight {
	tracked: number;
	groups: Array<{
		category: string;
		method: string;
		originWindowId: number;
		count: number;
	}>;
	groupOverflow: number;
}
interface FanoutBrowserWindow {
	windowId: number;
	label: FanoutLabel;
	documentNavigations: number;
	startedAtMs: number;
	endedAtMs?: number;
	http: FanoutHttpCounts & {
		rows: FanoutHttpRow[];
		completionDurationMs: { count: number; sumMs: number; maxMs: number; buckets: number[] };
	};
	ws: {
		sent: number;
		rows: Array<{ connection: string; type: string; kind: string; sent: number }>;
	};
	inflightAtStart: FanoutInflight;
	inflightAtEnd?: FanoutInflight;
	overflow: {
		httpRows: number;
		wsRows: number;
		pendingHttp: number;
		untrackedResponses: number;
		untrackedCompletions: number;
		webSockets: number;
		oversizedFrames: number;
		observerErrors: number;
	};
}
interface FanoutPendingHttp {
	category: string;
	method: string;
	originWindowId: number;
	startedAtMs: number;
}
const newHttpCounts = (): FanoutHttpCounts => ({
	started: 0,
	responses: 0,
	completed: 0,
	failed: 0,
	statuses: {},
});

// Only these fixed labels may leave the classifier. Neither IDs nor query strings survive.
export function readFanoutHttpCategory(url: string): string | null {
	let pathname: string;
	try {
		pathname = new URL(url).pathname;
	} catch {
		return null;
	}
	if (pathname !== "/api" && !pathname.startsWith("/api/")) return null;
	if (/^\/api\/narrators\/[^/]+(?:\/|$)/.test(pathname)) {
		if (/^\/api\/narrators\/[^/]+$/.test(pathname)) return "narrators.detail";
		if (/^\/api\/narrators\/[^/]+\/pretext-document$/.test(pathname))
			return "narrators.pretext-document";
		if (/^\/api\/narrators\/[^/]+\/message-location\/[^/]+$/.test(pathname))
			return "narrators.message-location";
		for (const suffix of ["git/summary", "git/workspace", "git/status"])
			if (pathname.endsWith(`/${suffix}`)) return `narrators.${suffix.replace("/", ".")}`;
		return "narrators.other";
	}
	const category = pathname.split("/")[2] ?? "";
	return [
		"narrators",
		"auth",
		"health",
		"settings",
		"user-preferences",
		"projects",
		"workspaces",
		"skills",
		"routines",
		"messages",
		"notifications",
		"plugins",
		"admin",
		"users",
		"models",
		"providers",
		"knowledge",
		"devices",
		"terminals",
		"files",
		"storage",
		"permissions",
		"system",
		"git",
		"search",
		"licenses",
		"context",
		"capabilities",
		"config",
		"sessions",
		"teams",
		"tasks",
	].includes(category)
		? category
		: "unknown";
}
function fanoutMethod(method: string) {
	return ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method)
		? method
		: "OTHER";
}
export function readFanoutWsCategory(payload: string, opcode = 1) {
	if (opcode !== 1) return { type: "non-text", kind: "none" };
	if (Buffer.byteLength(payload) > FANOUT_LIMITS.frameBytes)
		return { type: "oversized", kind: "none" };
	try {
		const frame = JSON.parse(payload) as { type?: unknown; kind?: unknown } | null;
		const known = [
			"pong",
			"subscribe",
			"unsubscribe",
			"subscribe_stats",
			"unsubscribe_stats",
			"sync_check",
			"reasoning_translation_visibility",
			"presence_join",
			"presence_leave",
			"chat_subscribe",
			"chat_unsubscribe",
			"editor_file_subscribe",
			"editor_file_unsubscribe",
			"git_workspace_subscribe",
			"git_workspace_unsubscribe",
			"git_workspace_refresh",
			"outline_page_subscribe",
			"outline_page_unsubscribe",
			"permission_decision",
			"buffer_message",
			"cancel_buffer",
			"update_buffer",
			"remove_buffer",
			"update_timeout",
			"input",
			"resize",
			"create",
			"kill",
			"rename",
		];
		const type =
			typeof frame?.type === "string" && known.includes(frame.type) ? frame.type : "unknown";
		const kind =
			type !== "subscribe"
				? "none"
				: frame?.kind === undefined
					? "default-messages"
					: typeof frame.kind === "string" &&
							["list", "panel", "messages", "activity"].includes(frame.kind)
						? frame.kind
						: "unknown";
		return { type, kind };
	} catch {
		return { type: "invalid-json", kind: "none" };
	}
}

export class ReadFanoutBrowserCounter {
	readonly windows: FanoutBrowserWindow[] = [];
	private readonly pending = new Map<object, FanoutPendingHttp>();
	private readonly epoch: number;
	constructor(private readonly clock: () => number = () => performance.now()) {
		this.epoch = clock();
		this.begin("between-windows");
	}
	now() {
		return this.clock() - this.epoch;
	}
	get current() {
		return this.windows[this.windows.length - 1] as FanoutBrowserWindow;
	}
	private inflight(): FanoutInflight {
		const groups: FanoutInflight["groups"] = [];
		let groupOverflow = 0;
		for (const request of this.pending.values()) {
			const group = groups.find(
				(row) =>
					row.category === request.category &&
					row.method === request.method &&
					row.originWindowId === request.originWindowId,
			);
			if (group) group.count++;
			else if (groups.length < FANOUT_LIMITS.httpRows)
				groups.push({
					category: request.category,
					method: request.method,
					originWindowId: request.originWindowId,
					count: 1,
				});
			else groupOverflow++;
		}
		return { tracked: this.pending.size, groups, groupOverflow };
	}
	close() {
		if (this.current.endedAtMs !== undefined) return;
		this.current.endedAtMs = this.now();
		this.current.inflightAtEnd = this.inflight();
	}
	begin(label: FanoutLabel) {
		if (this.windows.length) this.close();
		if (this.windows.length >= FANOUT_LIMITS.windowsPerRound)
			throw new Error("Fanout browser window budget exceeded");
		const window: FanoutBrowserWindow = {
			windowId: this.windows.length,
			label,
			documentNavigations: 0,
			startedAtMs: this.now(),
			http: {
				...newHttpCounts(),
				rows: [],
				completionDurationMs: {
					count: 0,
					sumMs: 0,
					maxMs: 0,
					buckets: Array(FANOUT_LATENCY_BOUNDS_MS.length + 1).fill(0),
				},
			},
			ws: { sent: 0, rows: [] },
			inflightAtStart: this.inflight(),
			overflow: {
				httpRows: 0,
				wsRows: 0,
				pendingHttp: 0,
				untrackedResponses: 0,
				untrackedCompletions: 0,
				webSockets: 0,
				oversizedFrames: 0,
				observerErrors: 0,
			},
		};
		this.windows.push(window);
		return window;
	}
	private row(
		request: Pick<FanoutPendingHttp, "category" | "method"> & {
			originWindowId: number | "untracked";
		},
	) {
		const rows = this.current.http.rows;
		let row = rows.find(
			(item) =>
				item.category === request.category &&
				item.method === request.method &&
				item.originWindowId === request.originWindowId,
		);
		if (!row && rows.length < FANOUT_LIMITS.httpRows) {
			row = {
				category: request.category,
				method: request.method,
				originWindowId: request.originWindowId,
				...newHttpCounts(),
			};
			rows.push(row);
		}
		if (!row) this.current.overflow.httpRows++;
		return row;
	}
	request(key: object, url: string, method: string) {
		const category = readFanoutHttpCategory(url);
		if (!category) return;
		const request = {
			category,
			method: fanoutMethod(method),
			originWindowId: this.current.windowId,
			startedAtMs: this.now(),
		};
		this.current.http.started++;
		const row = this.row(request);
		if (row) row.started++;
		if (this.pending.size < FANOUT_LIMITS.pendingHttp) this.pending.set(key, request);
		else this.current.overflow.pendingHttp++;
	}
	response(key: object, url: string, method: string, status: number) {
		const category = readFanoutHttpCategory(url);
		if (!category) return;
		const request = this.pending.get(key);
		if (!request) this.current.overflow.untrackedResponses++;
		const row = this.row(
			request ?? { category, method: fanoutMethod(method), originWindowId: "untracked" },
		);
		const statusClass =
			Number.isInteger(status) && status >= 100 && status < 600
				? `${Math.floor(status / 100)}xx`
				: "unknown";
		for (const counts of [this.current.http, ...(row ? [row] : [])]) {
			counts.responses++;
			counts.statuses[statusClass] = (counts.statuses[statusClass] ?? 0) + 1;
		}
	}
	finish(key: object, url: string, method: string, failed = false) {
		const category = readFanoutHttpCategory(url);
		if (!category) return;
		const request = this.pending.get(key);
		this.pending.delete(key);
		if (!request) this.current.overflow.untrackedCompletions++;
		const row = this.row(
			request ?? { category, method: fanoutMethod(method), originWindowId: "untracked" },
		);
		const field = failed ? "failed" : "completed";
		this.current.http[field]++;
		if (row) row[field]++;
		if (request) {
			const ms = Math.max(0, this.now() - request.startedAtMs);
			const histogram = this.current.http.completionDurationMs;
			histogram.count++;
			histogram.sumMs += ms;
			histogram.maxMs = Math.max(ms, histogram.maxMs);
			const bucket = FANOUT_LATENCY_BOUNDS_MS.findIndex((bound) => ms <= bound);
			histogram.buckets[bucket < 0 ? FANOUT_LATENCY_BOUNDS_MS.length : bucket]++;
		}
	}
	frame(connection: string, payload: string, opcode = 1) {
		const safeConnection = ["narrator", "terminal"].includes(connection) ? connection : "unknown";
		const category = readFanoutWsCategory(payload, opcode);
		if (category.type === "oversized") this.current.overflow.oversizedFrames++;
		this.current.ws.sent++;
		const rows = this.current.ws.rows;
		const row = rows.find(
			(item) =>
				item.connection === safeConnection &&
				item.type === category.type &&
				item.kind === category.kind,
		);
		if (row) row.sent++;
		else if (rows.length < FANOUT_LIMITS.wsRows)
			rows.push({ connection: safeConnection, ...category, sent: 1 });
		else this.current.overflow.wsRows++;
	}
}

async function monitorReadFanout(page: Page) {
	const counter = new ReadFanoutBrowserCounter();
	const cdp = await page.createCDPSession();
	const sockets = new Map<string, string>();
	cdp.on("Network.webSocketCreated", ({ requestId, url }) => {
		if (sockets.size >= FANOUT_LIMITS.webSockets) {
			counter.current.overflow.webSockets++;
			return;
		}
		let connection = "unknown";
		try {
			const path = new URL(url).pathname;
			if (path === "/ws/narrator") connection = "narrator";
			if (path === "/ws/terminal") connection = "terminal";
		} catch {
			counter.current.overflow.observerErrors++;
		}
		sockets.set(requestId, connection);
	});
	cdp.on("Network.webSocketClosed", ({ requestId }) => sockets.delete(requestId));
	cdp.on("Network.webSocketFrameSent", ({ requestId, response }) => {
		counter.frame(sockets.get(requestId) ?? "unknown", response.payloadData, response.opcode);
	});
	const request = (value: HTTPRequest) => {
		if (value.isNavigationRequest?.() && value.frame() === page.mainFrame())
			counter.current.documentNavigations++;
		counter.request(value, value.url(), value.method());
	};
	const response = (value: import("puppeteer-core").HTTPResponse) =>
		counter.response(value.request(), value.url(), value.request().method(), value.status());
	const finished = (value: HTTPRequest) => counter.finish(value, value.url(), value.method());
	const failed = (value: HTTPRequest) => counter.finish(value, value.url(), value.method(), true);
	page.on("request", request);
	page.on("response", response);
	page.on("requestfinished", finished);
	page.on("requestfailed", failed);
	try {
		await cdp.send("Network.enable");
	} catch (error) {
		page.off("request", request);
		page.off("response", response);
		page.off("requestfinished", finished);
		page.off("requestfailed", failed);
		await cdp.detach().catch(() => {});
		throw error;
	}
	return {
		counter,
		async cleanup() {
			counter.close();
			page.off("request", request);
			page.off("response", response);
			page.off("requestfinished", finished);
			page.off("requestfailed", failed);
			await cdp.detach().catch(() => {
				counter.current.overflow.observerErrors++;
			});
		},
	};
}

interface FanoutCapture {
	phase: FanoutPhase;
	browserWindowId: number;
	status: "starting" | "active" | "complete" | "phase-failed" | "start-failed" | "stop-failed";
	stableBoundary: boolean;
	firstVisibleMs?: number;
	control: {
		startSentAtMs: number;
		startReceivedAtMs?: number;
		stopSentAtMs?: number;
		stopReceivedAtMs?: number;
	};
	serverStart?: { captureId: string; durationMs: number; startedAt: string; endsAt: string };
	server?: ReadFanoutReport;
}
interface FanoutRound {
	viewport: string;
	iteration: number;
	kind: "functional" | "measured" | "diagnostic";
	browser: FanoutBrowserWindow[];
	captures: FanoutCapture[];
	closed: boolean;
}

export function assertReadFanoutPrivacy(value: unknown, forbidden: readonly string[]) {
	const text = JSON.stringify(value);
	if (forbidden.some((secret) => secret.length > 0 && text.includes(secret)))
		throw new Error("Read-fanout evidence privacy guard rejected sensitive fixture data");
	return text;
}
export function writeReadFanoutEvidence(
	path: string,
	value: unknown,
	forbidden: readonly string[],
) {
	const text = assertReadFanoutPrivacy(value, forbidden);
	if (Buffer.byteLength(text) > FANOUT_LIMITS.evidenceBytes)
		throw new Error("Read-fanout evidence byte budget exceeded");
	writeFileSync(path, `${text}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}

async function postReadFanout<T>(
	base: string,
	token: string,
	action: "start" | "stop",
	body: unknown,
): Promise<T> {
	const response = await fetch(`${base}/api/admin/diagnostics/read-fanout/${action}`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Read-fanout ${action} rejected with HTTP ${response.status}`);
	}
	if (action === "stop" && !response.headers.get("cache-control")?.includes("no-store")) {
		await response.body?.cancel();
		throw new Error("Read-fanout stop response must be no-store");
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Read-fanout control returned no body");
	const buffer = Buffer.allocUnsafe(FANOUT_LIMITS.serverReportBytes);
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (bytes + value.byteLength > FANOUT_LIMITS.serverReportBytes)
				throw new Error("Read-fanout server report byte budget exceeded");
			buffer.set(value, bytes);
			bytes += value.byteLength;
		}
		return JSON.parse(buffer.subarray(0, bytes).toString("utf8")) as T;
	} catch {
		await reader.cancel().catch(() => {});
		throw new Error("Read-fanout control response could not be read within its JSON budget");
	} finally {
		reader.releaseLock();
	}
}

export async function createReadFanoutSession(
	page: Page,
	runtime: SmokeRuntime,
	token: string,
	round: FanoutRound,
	forbidden: readonly string[],
	persist: () => void,
) {
	const monitor = await monitorReadFanout(page);
	round.browser = monitor.counter.windows;
	let active: FanoutCapture | undefined;
	return {
		async begin(phase: FanoutPhase) {
			if (active) throw new Error("Read-fanout phase is already active");
			const window = monitor.counter.begin(phase);
			const capture: FanoutCapture = {
				phase,
				browserWindowId: window.windowId,
				status: "starting",
				stableBoundary: false,
				control: { startSentAtMs: monitor.counter.now() },
			};
			round.captures.push(capture);
			try {
				const start = await postReadFanout<NonNullable<FanoutCapture["serverStart"]>>(
					runtime.base,
					token,
					"start",
					{ durationMs: 60_000 },
				);
				if (
					typeof start.captureId !== "string" ||
					!start.captureId ||
					start.captureId.length > 128 ||
					!Number.isInteger(start.durationMs) ||
					start.durationMs <= 0 ||
					start.durationMs > 60_000 ||
					!Number.isFinite(Date.parse(start.startedAt)) ||
					!Number.isFinite(Date.parse(start.endsAt))
				)
					throw new Error("Read-fanout start schema mismatch");
				assertReadFanoutPrivacy(start, forbidden);
				capture.serverStart = {
					captureId: start.captureId,
					durationMs: start.durationMs,
					startedAt: start.startedAt,
					endsAt: start.endsAt,
				};
				capture.control.startReceivedAtMs = monitor.counter.now();
				capture.status = "active";
				active = capture;
			} catch (error) {
				capture.status = "start-failed";
				monitor.counter.begin("between-windows");
				persist();
				throw error;
			}
		},
		async end(stableBoundary = true, firstVisibleMs?: number) {
			if (!active) return;
			const capture = active;
			active = undefined;
			capture.stableBoundary = stableBoundary;
			capture.firstVisibleMs = firstVisibleMs;
			// Browser attribution ends at the stable boundary, not after the control response.
			monitor.counter.begin("between-windows");
			capture.control.stopSentAtMs = monitor.counter.now();
			try {
				const report = await postReadFanout<ReadFanoutReport>(runtime.base, token, "stop", {
					captureId: capture.serverStart?.captureId,
				});
				capture.control.stopReceivedAtMs = monitor.counter.now();
				if (
					report.schemaVersion !== 1 ||
					report.captureId !== capture.serverStart?.captureId ||
					!Number.isFinite(report.durationMs) ||
					report.durationMs < 0 ||
					!Array.isArray(report.sources) ||
					!Array.isArray(report.templates) ||
					!Array.isArray(report.scopes) ||
					!Array.isArray(report.histogramUpperBoundsMs) ||
					!Array.isArray(report.readsPerScopeUpperBounds) ||
					!Number.isFinite(Date.parse(report.startedAt)) ||
					!Number.isFinite(Date.parse(report.endedAt)) ||
					!["stop", "timeout"].includes(report.endReason) ||
					!report.totals ||
					!report.timings ||
					!report.overflow
				)
					throw new Error("Read-fanout server report schema mismatch");
				assertReadFanoutPrivacy(report, forbidden);
				capture.server = report;
				capture.status =
					stableBoundary && report.endReason === "stop" ? "complete" : "phase-failed";
				persist();
				if (report.endReason !== "stop")
					throw new Error("Read-fanout capture expired before its stable boundary");
			} catch (error) {
				if (!capture.server) capture.status = "stop-failed";
				persist();
				throw error;
			}
		},
		async cleanup() {
			try {
				if (active) await this.end(false);
			} finally {
				await monitor.cleanup();
				round.closed = true;
				persist();
			}
		},
	};
}

export function summarizeReadFanoutValues(values: readonly number[]) {
	if (!values.length) return null;
	if (values.some((value) => !Number.isFinite(value) || value < 0))
		throw new Error("Invalid read-fanout numeric sample");
	const ordered = [...values].sort((a, b) => a - b);
	const quantile = (q: number) => ordered[Math.ceil(ordered.length * q) - 1];
	return {
		n: ordered.length,
		sum: values.reduce((sum, value) => sum + value, 0),
		min: ordered[0],
		max: ordered[ordered.length - 1],
		p50: quantile(0.5),
		p95: quantile(0.95),
	};
}
export function readFanoutTemplateRepeats(report: Pick<ReadFanoutReport, "templates">) {
	const templates = report.templates.filter((template) =>
		/^[a-f0-9]{64}$/.test(template.fingerprint),
	);
	const repeats = (key: "logicalReads" | "poolEntries" | "dispatched") =>
		templates.reduce((sum, template) => sum + Math.max(0, template.counts[key] - 1), 0);
	return {
		exactGroups: templates.length,
		excludedGroups: report.templates.length - templates.length,
		logicalReadRepeats: repeats("logicalReads"),
		poolEntryRepeats: repeats("poolEntries"),
		dispatchedRepeats: repeats("dispatched"),
	};
}
export function summarizeReadFanoutHistogram(
	histograms: readonly { count: number; sumMs: number; maxMs: number; buckets: number[] }[],
	upperBoundsMs: readonly (number | "infinity")[],
) {
	const buckets = upperBoundsMs.map(() => 0);
	let n = 0;
	let sumMs = 0;
	let maxMs = 0;
	for (const histogram of histograms) {
		if (
			histogram.buckets.length !== buckets.length ||
			histogram.count < 0 ||
			!Number.isFinite(histogram.sumMs) ||
			!Number.isFinite(histogram.maxMs) ||
			histogram.buckets.some((count) => !Number.isSafeInteger(count) || count < 0) ||
			histogram.buckets.reduce((sum, count) => sum + count, 0) !== histogram.count
		)
			throw new Error("Read-fanout histogram schema mismatch");
		n += histogram.count;
		sumMs += histogram.sumMs;
		maxMs = Math.max(maxMs, histogram.maxMs);
		for (let index = 0; index < buckets.length; index++) buckets[index] += histogram.buckets[index];
	}
	const quantileUpperBound = (q: number) => {
		if (!n) return null;
		let cumulative = 0;
		const rank = Math.ceil(n * q);
		for (let index = 0; index < buckets.length; index++) {
			cumulative += buckets[index];
			if (cumulative >= rank) return upperBoundsMs[index];
		}
		return null;
	};
	return {
		n,
		sumMs,
		maxMs,
		buckets,
		upperBoundsMs,
		p50UpperBoundMs: quantileUpperBound(0.5),
		p95UpperBoundMs: quantileUpperBound(0.95),
		estimator: "fixed-bucket-upper-bound",
	};
}
function summarizeReadFanout(rounds: readonly FanoutRound[]) {
	const summary = [];
	for (const viewport of ["desktop", "mobile390"]) {
		for (const phase of ["cold", "A_to_B", "B_to_A", "idle"] as const) {
			const captures = rounds
				.filter((round) => round.viewport === viewport && round.kind === "measured")
				.flatMap((round) =>
					round.captures
						.filter((capture) => capture.phase === phase && capture.status === "complete")
						.map((capture) => ({ capture, window: round.browser[capture.browserWindowId] })),
				);
			const reports = captures.map(({ capture }) => capture.server as ReadFanoutReport);
			if (!captures.length) continue;
			const fields = Object.keys(reports[0].totals) as Array<keyof ReadFanoutReport["totals"]>;
			const timingKeys = Object.keys(reports[0].timings) as Array<
				keyof ReadFanoutReport["timings"]
			>;
			summary.push({
				viewport,
				phase,
				n: captures.length,
				firstVisibleMs: summarizeReadFanoutValues(
					captures.flatMap(({ capture }) =>
						capture.firstVisibleMs === undefined ? [] : [capture.firstVisibleMs],
					),
				),
				browser: {
					documentNavigations: summarizeReadFanoutValues(
						captures.map(({ window }) => window.documentNavigations),
					),
					durationMs: summarizeReadFanoutValues(
						captures.map(
							({ window }) => (window.endedAtMs ?? window.startedAtMs) - window.startedAtMs,
						),
					),
					httpStarted: summarizeReadFanoutValues(captures.map(({ window }) => window.http.started)),
					httpResponses: summarizeReadFanoutValues(
						captures.map(({ window }) => window.http.responses),
					),
					httpCompleted: summarizeReadFanoutValues(
						captures.map(({ window }) => window.http.completed),
					),
					httpFailed: summarizeReadFanoutValues(captures.map(({ window }) => window.http.failed)),
					wsSent: summarizeReadFanoutValues(captures.map(({ window }) => window.ws.sent)),
				},
				server: {
					durationMs: summarizeReadFanoutValues(reports.map((report) => report.durationMs)),
					totals: Object.fromEntries(
						fields.map((field) => [
							field,
							summarizeReadFanoutValues(reports.map((report) => report.totals[field])),
						]),
					),
					timings: Object.fromEntries(
						timingKeys.map((key) => [
							key,
							{
								...Object.fromEntries(
									(["count", "sumMs", "maxMs"] as const).map((field) => [
										field,
										summarizeReadFanoutValues(reports.map((report) => report.timings[key][field])),
									]),
								),
								observations: summarizeReadFanoutHistogram(
									reports.map((report) => report.timings[key]),
									reports[0].histogramUpperBoundsMs,
								),
							},
						]),
					),
					templateRepeats: Object.fromEntries(
						Object.keys(readFanoutTemplateRepeats(reports[0])).map((key) => [
							key,
							summarizeReadFanoutValues(
								reports.map(
									(report) =>
										readFanoutTemplateRepeats(report)[
											key as keyof ReturnType<typeof readFanoutTemplateRepeats>
										],
								),
							),
						]),
					),
				},
			});
		}
	}
	return summary;
}

export function requestKind(url: string): { kind: string; narratorId: string } | null {
	const parsed = new URL(url);
	const match = parsed.pathname.match(/^\/api\/narrators\/([^/]+)(.*)$/);
	if (!match) return null;
	const suffix = match[2];
	const kind =
		suffix === ""
			? "detail"
			: suffix === "/pretext-document"
				? parsed.searchParams.has("afterSeq")
					? "window"
					: parsed.searchParams.has("beforeSeq")
						? "page"
						: "tail"
				: suffix.startsWith("/message-location/")
					? "locate"
					: suffix === "/git/summary"
						? "summary"
						: suffix === "/git/workspace"
							? "workspace"
							: suffix === "/git/status"
								? "status"
								: "other";
	return { kind, narratorId: match[1] ?? "" };
}
export function historyRequestCounts(
	records: readonly RequestRecord[],
	narratorId: string,
	from = 0,
	to = records.length,
) {
	const phase = records.slice(from, to).filter((record) => record.narratorId === narratorId);
	const count = (kind: string) => phase.filter((record) => record.kind === kind).length;
	return {
		tail: count("tail"),
		window: count("window"),
		olderPage: count("page"),
		locate: count("locate"),
	};
}
// Ended != successful: cache paint is only a timing probe, never phase acceptance.
export function phaseSuccess(
	records: readonly RequestRecord[],
	narratorId: string,
	from: number,
	expected: readonly string[],
	frames: readonly (VisibleFrame | undefined)[],
) {
	const participating = records
		.slice(from)
		.filter((record) => record.narratorId === narratorId && HISTORY_KINDS.includes(record.kind));
	const unsuccessful = participating.filter(
		(record) =>
			!Number.isFinite(record.endMs) ||
			record.failed === true ||
			!Number.isInteger(record.statusCode) ||
			(record.statusCode ?? 0) < 200 ||
			(record.statusCode ?? 0) >= 300,
	);
	const visible =
		expected.length > 0 &&
		frames.length === 2 &&
		frames.every(
			(frame) =>
				frame?.target === narratorId &&
				frame.sentinels.length === expected.length &&
				expected.every((text) => frame.sentinels.filter((value) => value === text).length === 1),
		);
	return {
		ok: participating.length > 0 && unsuccessful.length === 0 && visible,
		participatingRequests: participating.length,
		unsuccessful,
		visible,
	};
}

// Executed in Chrome after HTTP settlement, independently of the historical first-paint probe.
function currentVisibleFrame(): VisibleFrame {
	const target = location.pathname.match(/^\/narrators\/([^/]+)$/)?.[1] ?? "";
	const clip = (element: Element, initial: DOMRect) => {
		let left = Math.max(0, initial.left);
		let top = Math.max(0, initial.top);
		let right = Math.min(innerWidth, initial.right);
		let bottom = Math.min(innerHeight, initial.bottom);
		for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
			const style = getComputedStyle(ancestor);
			if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0)
				return false;
			const box = ancestor.getBoundingClientRect();
			if (style.overflowX !== "visible") {
				left = Math.max(left, box.left);
				right = Math.min(right, box.right);
			}
			if (style.overflowY !== "visible") {
				top = Math.max(top, box.top);
				bottom = Math.min(bottom, box.bottom);
			}
		}
		return right > left && bottom > top;
	};
	const sentinels: string[] = [];
	for (const viewport of document.querySelectorAll<HTMLElement>(
		"[data-pretext-exact-message-list]",
	)) {
		if (!clip(viewport, viewport.getBoundingClientRect())) continue;
		const walker = document.createTreeWalker(viewport, NodeFilter.SHOW_TEXT);
		for (
			let node = walker.nextNode(), budget = 0;
			node && budget < 5_000;
			node = walker.nextNode(), budget++
		) {
			if (!node.textContent?.includes("LOADING_SENTINEL_") || !node.parentElement) continue;
			const parent = node.parentElement;
			const range = document.createRange();
			range.selectNodeContents(node);
			if (Array.from(range.getClientRects()).some((rect) => clip(parent, rect)))
				sentinels.push(node.textContent.trim());
		}
	}
	return { target, sentinels };
}
async function settledVisibleFrames(page: Page) {
	const frames: VisibleFrame[] = [];
	for (let frame = 0; frame < 2; frame++) {
		await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
		frames.push(await page.evaluate(currentVisibleFrame));
	}
	return frames;
}

export function stableViewport(before: Rect, after: Rect) {
	return Math.abs(before.top - after.top) <= 0.5 && Math.abs(before.height - after.height) <= 0.5;
}

// Finite predicate budgets, not networkidle: the real app retains WebSockets and polling.
async function until(predicate: () => Promise<boolean>, timeoutMs: number, label: string) {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		if (await predicate()) return;
		await Bun.sleep(50);
	}
	throw new Error(`Timed out: ${label}`);
}
async function json<T>(
	base: string,
	path: string,
	token?: string,
	method = "GET",
	body?: unknown,
): Promise<T> {
	const response = await fetch(`${base}${path}`, {
		method,
		headers: {
			"content-type": "application/json",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
	});
	const text = await response.text();
	if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES)
		throw new Error(`HTTP fixture response exceeds ${MAX_OUTPUT_BYTES} bytes`);
	if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 500)}`);
	return JSON.parse(text) as T;
}

// Only a private fixture repository is modified. No git operation touches this worktree.
async function initFixtureGit(path: string, branch: string, home: string) {
	if (!path.startsWith(`${home}/`)) throw new Error("Fixture repository escaped owned HOME");
	let child: ChildProcess | undefined;
	let bytes = 0;
	let output = "";
	await new Promise<void>((done, reject) => {
		child = spawn("git", ["init", "--quiet", `--initial-branch=${branch}`, path], {
			env: {
				...isolatedSmokeEnvironment(home),
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: join(home, "no-global-git-config"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		const timer = setTimeout(() => {
			child?.kill("SIGKILL");
			reject(new Error("Fixture git init timed out"));
		}, 5_000);
		const collect = (chunk: Buffer) => {
			bytes += chunk.length;
			output += chunk
				.subarray(0, Math.max(0, MAX_OUTPUT_BYTES - Buffer.byteLength(output)))
				.toString();
			if (bytes > MAX_OUTPUT_BYTES) {
				child?.kill("SIGKILL");
				reject(new Error("Fixture git init output budget exceeded"));
			}
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code === 0) done();
			else reject(new Error(`Fixture git init exited ${code}: ${output.slice(0, 500)}`));
		});
	});
}
function seedMessages(home: string, ids: Record<Subject, string>) {
	const path = join(home, "narrafork.db");
	if (!existsSync(path) || !home.startsWith(join(tmpdir(), "narrafork-browser-smoke-")))
		throw new Error("Refusing non-owned fixture database");
	const db = new Database(path, { readwrite: true });
	try {
		db.exec("PRAGMA busy_timeout=100");
		db.transaction(() => {
			for (const subject of ["A", "B"] as const) {
				for (const [index, text] of SENTINELS[subject].entries()) {
					const id = `loading_${subject}_${index}`;
					db.query(
						"INSERT INTO narrator_messages (id, narrator_id, role, content_json, content_text, created_at) VALUES (?, ?, ?, ?, ?, ?)",
					).run(
						id,
						ids[subject],
						index ? "assistant" : "user",
						JSON.stringify([{ type: "text", text }]),
						text,
						new Date(Date.now() + index).toISOString(),
					);
					db.query(
						"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES (?, ?, ?, ?)",
					).run(`${id}_ref`, ids[subject], id, index + 1);
				}
			}
			db.query(
				"UPDATE user_preferences SET setup_wizard_completed=1, auto_load_older_messages=0",
			).run();
		})();
	} finally {
		db.close();
	}
}

// No hidden textContent counts as paint: text Range bounds must intersect a visible,
// unclipped viewport, and the same two unique sentinels must survive two rAF samples.
function installBrowserProbe(
	token: string,
	target: string,
	expected: string[],
	resourceTimingEntries = 0,
) {
	if (resourceTimingEntries > 0) performance.setResourceTimingBufferSize(resourceTimingEntries);
	localStorage.setItem("narrafork_token", token);
	localStorage.setItem("narrafork_lang", "en");
	const host = window as unknown as ProbeWindow;
	host.__armLoadingProbe = (nextTarget, nextExpected) => {
		host.__loadingProbe = {
			target: nextTarget,
			expected: nextExpected,
			startedAt: performance.now(),
			frames: 0,
			candidateFrames: 0,
			firstViewport: null,
			firstMessage: null,
			viewportChanges: [],
		};
	};
	host.__armLoadingProbe(target, expected);
	host.__loadingProbe.startedAt = 0;
	const intersects = (a: DOMRect, b: DOMRect) =>
		Math.min(a.right, b.right) > Math.max(a.left, b.left) &&
		Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
	const visible = (element: Element) => {
		const rect = element.getBoundingClientRect();
		if (
			rect.width <= 0 ||
			rect.height <= 0 ||
			!intersects(rect, new DOMRect(0, 0, innerWidth, innerHeight))
		)
			return false;
		for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
			const style = getComputedStyle(ancestor);
			if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0)
				return false;
			if (
				(style.overflowX !== "visible" || style.overflowY !== "visible") &&
				!intersects(rect, ancestor.getBoundingClientRect())
			)
				return false;
		}
		return true;
	};
	const tick = () => {
		const probe = host.__loadingProbe;
		probe.frames++;
		try {
			if (location.pathname === `/narrators/${probe.target}` && probe.frames <= 240) {
				const viewport = Array.from(
					document.querySelectorAll<HTMLElement>("[data-pretext-exact-message-list]"),
				).find(visible);
				if (viewport) {
					const panel = viewport.closest("[data-narrator-panel]");
					const textarea = panel?.querySelector<HTMLElement>("[data-narrator-composer]");
					const header = panel?.querySelector("[data-narrator-header-layout]");
					const toRect = (element: Element): Rect => {
						const box = element.getBoundingClientRect();
						return { top: box.top, height: box.height, width: box.width };
					};
					const containers: Array<{ className: string; rect: Rect }> = [];
					for (
						let ancestor = textarea?.parentElement;
						ancestor && ancestor !== panel && containers.length < 5;
						ancestor = ancestor.parentElement
					)
						containers.push({
							className: ancestor.className.slice(0, 160),
							rect: toRect(ancestor),
						});
					const slot = panel?.querySelector<HTMLElement>("[data-git-slot]");
					const rect = viewport.getBoundingClientRect();
					const slotRect = slot && visible(slot) ? slot.getBoundingClientRect() : null;
					const found: string[] = [];
					const walker = document.createTreeWalker(viewport, NodeFilter.SHOW_TEXT);
					for (
						let node = walker.nextNode(), budget = 0;
						node && budget < 5_000;
						node = walker.nextNode(), budget++
					) {
						if (!node.textContent?.includes("LOADING_SENTINEL_")) continue;
						const parent = node.parentElement;
						if (!parent || !visible(parent)) continue;
						const range = document.createRange();
						range.selectNodeContents(node);
						if (Array.from(range.getClientRects()).some((textRect) => intersects(textRect, rect)))
							found.push(node.textContent.trim());
					}
					const paint: Paint = {
						elapsedMs: performance.now() - probe.startedAt,
						viewport: { top: rect.top, height: rect.height, width: rect.width },
						slot: slotRect
							? { top: slotRect.top, height: slotRect.height, width: slotRect.width }
							: null,
						gitText: slot?.innerText ?? "",
						sentinels: found,
						frame: probe.frames,
						chrome: {
							panelHeight: panel?.getBoundingClientRect().height ?? 0,
							textareaHeight: textarea?.getBoundingClientRect().height ?? 0,
							statusHeight:
								panel?.querySelector('[data-testid="narrator-status-bar"]')?.getBoundingClientRect()
									.height ?? 0,
							innerHeight,
							textarea: textarea
								? {
										kind: textarea instanceof HTMLTextAreaElement ? "textarea" : "contenteditable",
										rect: toRect(textarea),
										clientWidth: textarea.clientWidth,
										inlineHeight: textarea.style.height,
										inlineMinHeight: textarea.style.minHeight,
										computedMinHeight: getComputedStyle(textarea).minHeight,
										placeholder:
											textarea instanceof HTMLTextAreaElement
												? textarea.placeholder
												: (textarea
														.querySelector("[data-placeholder]")
														?.getAttribute("data-placeholder") ?? ""),
										valueLength: (textarea instanceof HTMLTextAreaElement
											? textarea.value
											: textarea.innerText.replace(/\n$/, "")
										).length,
									}
								: null,
							containers,
							header: header ? toRect(header) : null,
							actionButtons: Array.from(
								textarea
									?.closest(".mantine-Group-root")
									?.querySelectorAll<HTMLButtonElement>("button") ?? [],
							)
								.filter(visible)
								.slice(0, 8)
								.map((button) => ({
									text: button.innerText.slice(0, 40),
									width: button.getBoundingClientRect().width,
									height: button.getBoundingClientRect().height,
								})),
						},
					};
					probe.firstViewport ??= paint;
					const previous = probe.viewportChanges.at(-1);
					if (
						probe.viewportChanges.length < 16 &&
						(!previous ||
							previous.viewport.top !== paint.viewport.top ||
							previous.viewport.height !== paint.viewport.height ||
							previous.gitText !== paint.gitText)
					)
						probe.viewportChanges.push(paint);
					if (
						probe.expected.every((text) => found.filter((value) => value === text).length === 1) &&
						!found.some((value) => !probe.expected.includes(value))
					) {
						probe.candidateFrames++;
						if (probe.candidateFrames >= 2) probe.firstMessage ??= paint;
					} else probe.candidateFrames = 0;
				}
			}
		} catch (error) {
			probe.failure = { message: String(error).slice(0, 500), frame: probe.frames };
			throw error;
		}
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
}
async function browserOpeningRequestTimings(page: Page, narratorId: string) {
	return page.evaluate((id) => {
		const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
		const first = (suffix: string) => {
			const entry = entries.find((item) => {
				try {
					return new URL(item.name).pathname === `/api/narrators/${id}${suffix}`;
				} catch {
					return false;
				}
			});
			return entry
				? {
						startedAtMs: entry.startTime,
						responseEndedAtMs: entry.responseEnd,
						initiator: entry.initiatorType === "fetch" ? "fetch" : "other",
					}
				: null;
		};
		return { entriesObserved: entries.length, detail: first(""), tail: first("/pretext-document") };
	}, narratorId);
}
async function paint(page: Page): Promise<{ firstViewport: Paint; firstMessage: Paint }> {
	await page.waitForFunction(
		() => {
			const probe = (window as unknown as ProbeWindow).__loadingProbe;
			return !!(probe.firstMessage || probe.failure);
		},
		{
			timeout: 15_000,
			polling: "raf",
		},
	);
	return page.evaluate(() => {
		const probe = (window as unknown as ProbeWindow).__loadingProbe;
		if (probe.failure)
			throw new Error(`Paint probe frame ${probe.failure.frame}: ${probe.failure.message}`);
		if (!probe.firstViewport || !probe.firstMessage)
			throw new Error("Missing browser paint observation");
		return { firstViewport: probe.firstViewport, firstMessage: probe.firstMessage };
	});
}
async function geometry(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
	);
	return page.evaluate(() => {
		const viewport = document.querySelector<HTMLElement>("[data-pretext-exact-message-list]");
		const slot = viewport
			?.closest("[data-narrator-panel]")
			?.querySelector<HTMLElement>("[data-git-slot]");
		if (!viewport || !slot) throw new Error("Missing active viewport or Git slot");
		const rect = viewport.getBoundingClientRect();
		return {
			viewport: { top: rect.top, height: rect.height, width: rect.width },
			slotHeight: slot.getBoundingClientRect().height,
			gitText: slot.innerText,
		};
	});
}
async function navigate(page: Page, id: string, subject: Subject, mobile: boolean) {
	if (mobile) {
		await page.waitForSelector(".mantine-Burger-root", { visible: true, timeout: 5_000 });
		await page.click(".mantine-Burger-root");
	}
	const selector = `[data-tab-sort-id="narrator:${id}"] .mantine-NavLink-root`;
	await page.waitForSelector(selector, { visible: true, timeout: 5_000 });
	await page.evaluate(
		(target, expected, rowSelector) => {
			const row = document.querySelector<HTMLElement>(rowSelector);
			if (!row) throw new Error("Missing real recent tab");
			(window as unknown as ProbeWindow).__armLoadingProbe(target, expected);
			row.click(); // Actual app click-to-prefetch + TanStack router handler, no test router.
		},
		id,
		SENTINELS[subject],
		selector,
	);
	return paint(page);
}
async function waitGit(page: Page, branch: string) {
	await page.waitForFunction(
		(expected) =>
			Array.from(document.querySelectorAll<HTMLElement>("[data-git-slot]")).some(
				(slot) =>
					slot.getBoundingClientRect().height === 30 &&
					slot.innerText.includes(expected) &&
					slot.querySelector(".mantine-Badge-root"),
			),
		{ timeout: 12_000, polling: "raf" },
		branch,
	);
}
export async function exerciseDraftComposer(page: Page) {
	const selector = "[data-narrator-composer]";
	const before = await page.$eval(selector, (element) => {
		const value =
			element instanceof HTMLTextAreaElement ? element.value : (element.textContent ?? "");
		if (value.trim()) throw new Error("Draft growth fixture requires an empty composer");
		return element.getBoundingClientRect().height;
	});
	const setDraft = async (text: string) => {
		await page.focus(selector);
		await page.$eval(selector, (element) => {
			if (element instanceof HTMLTextAreaElement) element.select();
			else {
				if (!(element instanceof HTMLElement) || !element.isContentEditable)
					throw new Error("Missing editable narrator composer");
				const selection = getSelection();
				if (!selection) throw new Error("Missing composer selection");
				const range = document.createRange();
				range.selectNodeContents(element);
				selection.removeAllRanges();
				selection.addRange(range);
			}
		});
		await page.keyboard.press("Backspace");
		// CDP Input.insertText exercises the real input path, never the Enter/send shortcut.
		if (text) await page.keyboard.sendCharacter(text);
	};
	const multiline =
		"SMOKE DRAFT LINE 1\nSMOKE DRAFT LINE 2\nSMOKE DRAFT LINE 3\nSMOKE DRAFT LINE 4";
	await setDraft(multiline);
	await page.waitForFunction(
		(target, text, height) => {
			const editor = document.querySelector<HTMLElement>(target);
			if (!editor) return false;
			const value =
				editor instanceof HTMLTextAreaElement
					? editor.value
					: Array.from(editor.children)
							.map((child) => (child as HTMLElement).innerText.replace(/\n$/, ""))
							.join("\n");
			return value === text && editor.getBoundingClientRect().height >= height + 20;
		},
		{ timeout: 5_000, polling: "raf" },
		selector,
		multiline,
		before,
	);
	const grown = await page.$eval(selector, (element) => element.getBoundingClientRect().height);
	await setDraft("");
	await page.waitForFunction(
		(target, height) => {
			const editor = document.querySelector<HTMLElement>(target);
			if (!editor) return false;
			const value = editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText.trim();
			return value === "" && Math.abs(editor.getBoundingClientRect().height - height) <= 0.5;
		},
		{ timeout: 5_000, polling: "raf" },
		selector,
		before,
	);
	const restored = await page.$eval(selector, (element) => element.getBoundingClientRect().height);
	return { before, grown, restored };
}

async function monitor(page: Page, forbidden: readonly string[] = []) {
	const consoleMessages: Array<{ level: string; text: string }> = [];
	if (readFanout)
		page.on("console", (message) => {
			if (!["warn", "error"].includes(message.type()) || consoleMessages.length >= 20) return;
			let text = message.text().slice(0, 2_000);
			for (const secret of forbidden) if (secret) text = text.split(secret).join("[redacted]");
			consoleMessages.push({
				level: message.type(),
				text: text.replace(/\?[^\s"')]+/g, "?[redacted]").slice(0, 1_000),
			});
		});
	const records: RequestRecord[] = [];
	const pending = new Map<HTTPRequest, RequestRecord>();
	const activeTails = new Map<string, number>();
	let duplicateInflight = 0;
	let delayNarrator: string | undefined;
	let faultNarrator: string | undefined;
	const injected: Array<{
		mode: string;
		kind: string;
		paintBeforeFailure: Paint;
		releasedAtMs: number;
	}> = [];
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const errors: string[] = [];
	await page.setRequestInterception(true);
	page.on("pageerror", (error) => {
		if (errors.length < 10)
			errors.push(
				(error instanceof Error ? (error.stack ?? error.message) : String(error)).slice(0, 2_000),
			);
	});
	page.on("request", (request) => {
		const parsed = requestKind(request.url());
		if (records.length > 1_000) {
			errors.push("Request budget exceeded");
			void request.abort();
			return;
		}
		if (
			request.method() !== "GET" &&
			/\/api\/narrators\/[^/]+\/(messages|continue|resume)(?:\?|$)/.test(request.url())
		) {
			errors.push("Refused provider-triggering request");
			void request.abort();
			return;
		}
		let record: RequestRecord | undefined;
		if (parsed) {
			record = {
				...parsed,
				atMs: performance.now(),
				...(["tail", "window", "page", "locate"].includes(parsed.kind)
					? {
							query: new URL(request.url()).search.slice(0, 128),
							initiator: request
								.initiator()
								?.stack?.callFrames.slice(0, 10)
								.map((frame) => ({
									functionName: frame.functionName,
									asset: frame.url.split("/").at(-1) ?? "",
									line: frame.lineNumber + 1,
									column: frame.columnNumber + 1,
								})),
						}
					: {}),
			};
			records.push(record);
			pending.set(request, record);
			if (diagnostic && parsed.kind === "tail") {
				const captured = record;
				void page
					.evaluate(() => {
						const probe = (window as unknown as ProbeWindow).__loadingProbe;
						return {
							elapsedMs: performance.now() - probe.startedAt,
							target: probe.target,
							viewports: Array.from(
								document.querySelectorAll<HTMLElement>("[data-pretext-exact-message-list]"),
							)
								.slice(0, 4)
								.map((viewport) => ({
									width: viewport.getBoundingClientRect().width,
									height: viewport.getBoundingClientRect().height,
									revision: viewport.getAttribute("data-vlist-resize-revision"),
								})),
						};
					})
					.then((layout) => {
						captured.layout = layout;
					})
					.catch(() => {});
			}
			if (parsed.kind === "tail") {
				const active = activeTails.get(parsed.narratorId) ?? 0;
				if (active) duplicateInflight++;
				activeTails.set(parsed.narratorId, active + 1);
			}
		}
		if (
			faultMode &&
			record &&
			record.narratorId === faultNarrator &&
			record.kind === faultMode.split("-")[0]
		) {
			const captured = record;
			// Let the genuine cached app view paint first; only then fail its canonical read.
			void (async () => {
				await until(
					async () =>
						page.evaluate((id) => {
							const probe = (window as unknown as ProbeWindow).__loadingProbe;
							return probe.target === id && !!probe.firstMessage;
						}, captured.narratorId),
					3_000,
					"cached paint before fault release",
				);
				const paintBeforeFailure = await page.evaluate(
					() => (window as unknown as ProbeWindow).__loadingProbe.firstMessage,
				);
				await new Promise<void>((done) => {
					const timer = setTimeout(() => {
						timers.delete(timer);
						done();
					}, 150);
					timers.add(timer);
				});
				if (!paintBeforeFailure) throw new Error("Fault requires actual cached visible paint");
				injected.push({
					mode: faultMode,
					kind: captured.kind,
					paintBeforeFailure,
					releasedAtMs: performance.now(),
				});
				if (faultMode.endsWith("403"))
					await request.respond({
						status: 403,
						contentType: "application/json",
						body: '{"error":"private smoke fault"}',
					});
				else await request.abort("failed");
			})().catch((error) => {
				if (!page.isClosed()) errors.push(`Fault injection: ${String(error).slice(0, 200)}`);
				void request.abort().catch(() => {});
			});
		} else if (record?.kind === "summary" && record.narratorId === delayNarrator) {
			record.delayed = true;
			const delayed = record;
			const timer = setTimeout(() => {
				timers.delete(timer);
				delayed.releaseMs = performance.now();
				void request.continue().catch((error) => {
					errors.push(String(error).slice(0, 200));
				});
			}, GIT_DELAY_MS);
			timers.add(timer);
		} else
			void request.continue().catch((error) => {
				if (!page.isClosed()) errors.push(String(error).slice(0, 200));
			});
	});
	const finish = (request: HTTPRequest, failed = false) => {
		const record = pending.get(request);
		if (!record) return;
		record.endMs = performance.now();
		record.failed = failed;
		if (record.kind === "tail")
			activeTails.set(
				record.narratorId,
				Math.max(0, (activeTails.get(record.narratorId) ?? 1) - 1),
			);
		pending.delete(request);
	};
	page.on("response", (response) => {
		const record = pending.get(response.request());
		if (!record) return;
		record.statusCode = response.status();
		if (!["tail", "window", "page"].includes(record.kind)) return;
		// This isolated DB contains exactly two short fixture messages; retain only
		// paging metadata, never transcript text. No extra fetch changes the app flow.
		void response
			.text()
			.then((text) => {
				if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES)
					throw new Error("Tail fixture response budget exceeded");
				const body = JSON.parse(text) as {
					messageVersion?: number;
					messages?: unknown[];
					minSeq?: number | null;
					maxSeq?: number | null;
				};
				record.messageVersion = body.messageVersion;
				record.messageCount = body.messages?.length;
				record.minSeq = body.minSeq;
				record.maxSeq = body.maxSeq;
			})
			.catch((error) => {
				if (!page.isClosed()) errors.push(`Tail metadata: ${String(error).slice(0, 200)}`);
			});
	});
	page.on("requestfinished", (request) => finish(request));
	page.on("requestfailed", (request) => finish(request, true));
	return {
		records,
		errors,
		consoleMessages,
		injected,
		armFault: (id: string) => {
			faultNarrator = id;
		},
		duplicateInflight: () => duplicateInflight,
		async finishPhase(narratorId: string, from: number, expected: string[]) {
			const startedAt = performance.now();
			await until(
				async () => {
					const history = records
						.slice(from)
						.filter(
							(record) => record.narratorId === narratorId && HISTORY_KINDS.includes(record.kind),
						);
					const last = Math.max(startedAt, ...history.map((record) => record.endMs ?? record.atMs));
					return (
						history.every((record) => record.endMs !== undefined) && performance.now() - last >= 100
					);
				},
				3_000,
				"history HTTP phase completion + 100ms quiet",
			);
			const frames = await settledVisibleFrames(page);
			const outcome = phaseSuccess(records, narratorId, from, expected, frames);
			if (!outcome.ok)
				throw new Error(`History phase rejected: ${JSON.stringify(outcome).slice(0, 2_000)}`);
			return {
				frames,
				successfulRequests: records
					.slice(from)
					.filter(
						(record) => record.narratorId === narratorId && HISTORY_KINDS.includes(record.kind),
					).length,
			};
		},
		delay: (id?: string) => {
			delayNarrator = id;
		},
		cleanup: () => {
			for (const timer of timers) clearTimeout(timer);
		},
		count: (id: string, from: number, kind: string) =>
			records.slice(from).filter((record) => record.narratorId === id && record.kind === kind)
				.length,
	};
}

async function formatHarnessSummary(path: string) {
	const file = Bun.file(path);
	if (file.size > MAX_OUTPUT_BYTES) throw new Error("Harness summary budget exceeded");
	writeFileSync(path, `${JSON.stringify(await file.json(), null, "\t")}\n`, { mode: 0o600 });
}

export async function main(iterations = 10) {
	if (faultMode && !faultModes.includes(faultMode))
		throw new Error(`Unknown private smoke fault: ${faultMode}`);
	if (!Number.isSafeInteger(iterations) || iterations < 10 || iterations > 20)
		throw new Error("Use 10-20 measured rounds per viewport");
	assertSmokeInputs(["server/index.ts", "dist/frontend/index.html"]);
	const chrome = process.env.NF_TEST_CHROMIUM_PATH ?? process.env.PUPPETEER_EXECUTABLE_PATH;
	if (!chrome || !existsSync(chrome))
		throw new Error("Set NF_TEST_CHROMIUM_PATH to an installed Chrome (no download)");
	if (readFanout && Bun.version !== "1.4.3")
		throw new Error(
			"Read-fanout measurements require Bun 1.4.3 for the harness and source backend",
		);
	const runtime = await createSmokeRuntime(readFanout ? { watchdogMs: 600_000 } : undefined);
	const fanoutRounds: FanoutRound[] = [];
	const fanoutForbidden = ["loading_smoke_admin", "loading-smoke-pass-123456"];
	let fanoutStatus: "running" | "complete" | "failed" = "running";
	let browserVersion: string | undefined;
	const fanoutPath = join(runtime.evidenceDir, "read-fanout.json");
	const fanoutCoverageComplete = () =>
		fanoutRounds.length > 0 &&
		fanoutRounds.every(
			(round) =>
				round.closed &&
				round.captures.every(
					(capture) =>
						capture.status === "complete" &&
						capture.server &&
						Object.values(capture.server.overflow).every((value) => value === 0),
				) &&
				round.browser.every(
					(window) =>
						Object.values(window.overflow).every((value) => value === 0) &&
						window.inflightAtStart.groupOverflow === 0 &&
						(window.inflightAtEnd?.groupOverflow ?? 0) === 0,
				),
		);
	const fanoutMeasuredRoundsComplete = () =>
		["desktop", "mobile390"].every((viewport) => {
			const rounds = fanoutRounds.filter(
				(round) => round.viewport === viewport && round.kind === "measured",
			);
			return (
				rounds.length === iterations &&
				rounds.every((round) =>
					(["cold", "A_to_B", "B_to_A"] as const).every(
						(phase) =>
							round.captures.filter(
								(capture) =>
									capture.phase === phase &&
									capture.status === "complete" &&
									round.browser[capture.browserWindowId].documentNavigations ===
										(phase === "cold" ? 1 : 0),
							).length === 1,
					),
				) &&
				rounds
					.flatMap((round) => round.captures)
					.filter((capture) => capture.phase === "idle" && capture.status === "complete").length ===
					1
			);
		});
	const persistFanout = () => {
		if (!readFanout) return;
		writeReadFanoutEvidence(
			fanoutPath,
			{
				schemaVersion: 1,
				kind: "isolated-narrator-read-fanout",
				status: fanoutStatus,
				diagnosticOnly: diagnostic || !!faultMode,
				acceptanceEligible:
					fanoutStatus === "complete" &&
					!diagnostic &&
					!faultMode &&
					fanoutCoverageComplete() &&
					fanoutMeasuredRoundsComplete(),
				coverageComplete: fanoutCoverageComplete(),
				requestedMeasuredRoundsPerViewport: iterations,
				runtime: {
					bunVersion: Bun.version,
					executable: process.execPath,
					sourceEntry: "server/index.ts",
					browserVersion,
				},
				methodology: {
					fixture:
						"Isolated HOME/SQLite/source backend on loopback; two fixed short messages; no provider invocation.",
					cold: "Fresh browser context, HTTP cache disabled; backend and OS caches may be warm. Exactly one main-frame document request is required for cold and none for tab switches; unexpected automatic reloads reject acceptance.",
					warm: "A_to_B and B_to_A are recent-tab clicks in the same page runtime; B_to_A revisits A.",
					functionalRound:
						"An additional first round per viewport retains original 2s Git delay and fixture/cache-aging assertions; excluded from measured distributions.",
					idle: "One 1500ms no-action observation after the last round per viewport; n=1 is background context, not a performance percentile acceptance sample.",
					boundary:
						"Browser window opens before start control is sent and closes immediately after finishPhase's history completion/100ms quiet/two-rAF visible sentinel acceptance; unrelated polling may still be in flight. Idle has a bounded elapsed-time predicate. Other browser traffic remains in explicit between-windows intervals.",
					clock:
						"Browser events use harness monotonic receipt time relative to each round, not CDP packet time. Control send/receive brackets are reported on that clock; backend durationMs is its own monotonic window, startedAt/endedAt are ISO wall clock. These windows differ by control RTT and are not assumed identical.",
					http: "All browser /api requests classified into fixed route categories and methods; unknown buckets retained. Started, response-status and completion/failure counts belong to their observed window; rows retain start-origin window, including cross-window completions. Inflight snapshots include only bounded tracked requests; overflow makes coverage incomplete. No raw URL/query/IDs retained.",
					ws: "CDP Network.webSocketFrameSent observes outgoing browser frames, with fixed connection/type/subscription-kind labels only. Sent is not a server-handler acknowledgment. Unknown, invalid, non-text and oversized frames remain fixed buckets; payloads are discarded.",
					server:
						"Complete bounded schemaVersion=1 backend aggregate retained per capture: sources, scopes, exact-template fingerprints, totals, timing histograms, limits and overflow. Logical reads, pool entries and dispatched tasks are distinct; not a total-SQL count.",
					timing:
						"Summary count distributions use exact nearest-rank p50/p95 across complete measured windows; timing count/sumMs/maxMs distributions describe per-window aggregates. Pooled same-metric observations retain fixed buckets and explicitly approximate p50/p95 upper bounds (including infinity), not fabricated exact values; overlapping metrics must not be summed. compileSync.count is compile entry count, not internal Drizzle _toSQL count.",
					templates:
						"Repeated counts are sum(max(0,count-1)) per exact HMAC template separately for logicalReads/poolEntries/dispatched; overflow/oversized groups excluded. Fingerprints are capture-local and never joined across captures. Equal template does not imply equal binds or safe dedupe.",
					attribution:
						"Window correlation only, not switching causality. Between-window traffic and backend background_or_unattributed/pre_window/detached remain explicit; background windows are not subtracted from phases.",
				},
				limits: FANOUT_LIMITS,
				browserHistogramUpperBoundsMs: [...FANOUT_LATENCY_BOUNDS_MS, "infinity"],
				summary: summarizeReadFanout(fanoutRounds),
				rounds: fanoutRounds,
			},
			fanoutForbidden,
		);
	};
	const checks: Check[] = [];
	const samples: Sample[] = [];
	const details: unknown[] = [];
	const check = (name: string, ok: boolean, detail: unknown) => {
		checks.push({ name, ok, detail });
		console.log(`[${ok ? "PASS" : "FAIL"}] ${name} ${JSON.stringify(detail).slice(0, 1_000)}`);
		// Fanout diagnostics retain failures while collecting independent stages. Original
		// smoke diagnostics and fault injection retain their fail-fast boundary.
		if (!ok && (faultMode || (diagnostic && !readFanout)))
			throw new Error(`Functional smoke assertion failed: ${name}`);
	};
	let failure: string | undefined;
	let result: unknown;
	try {
		runtime.start();
		await until(
			async () => {
				runtime.assertHealthyProcess();
				try {
					return (await fetch(`${runtime.base}/api/health`, { signal: AbortSignal.timeout(1_000) }))
						.ok;
				} catch {
					return false;
				}
			},
			25_000,
			"isolated server health",
		);
		const { token } = await json<{ token: string }>(
			runtime.base,
			"/api/auth/register",
			undefined,
			"POST",
			{ username: "loading_smoke_admin", password: "loading-smoke-pass-123456" },
		);
		fanoutForbidden.push(token);
		const dirs = { A: join(runtime.home, "repo-a"), B: join(runtime.home, "repo-b") };
		for (const dir of Object.values(dirs)) {
			mkdirSync(dir);
			writeFileSync(join(dir, "visible-change.txt"), "one fixture line\n");
		}
		await initFixtureGit(dirs.A, "loading-smoke-A", runtime.home);
		const ids = {} as Record<Subject, string>;
		for (const subject of ["A", "B"] as const) {
			ids[subject] = (
				await json<{ id: string }>(runtime.base, "/api/narrators", token, "POST", {
					cwd: dirs[subject],
				})
			).id;
			await json(runtime.base, `/api/narrators/${ids[subject]}/title`, token, "PATCH", {
				title: `Loading fixture ${subject}`,
			});
			await json(runtime.base, "/api/user-preferences/recent-tabs", token, "PUT", {
				type: "narrator",
				id: ids[subject],
				title: `Loading fixture ${subject}`,
				lastVisitedAt: Date.now(),
			});
		}
		fanoutForbidden.push(ids.A, ids.B);
		seedMessages(runtime.home, ids);
		const browser = await puppeteer.launch({
			executablePath: chrome,
			headless: true,
			args: ["--no-sandbox", "--disable-dev-shm-usage"],
			timeout: 15_000,
			protocolTimeout: 20_000,
		});
		runtime.ownBrowser(browser);
		if (readFanout) browserVersion = await browser.version();
		for (const viewport of [
			{ name: "desktop", width: 1440, height: 900, mobile: false },
			{ name: "mobile390", width: 390, height: 844, mobile: true },
		]) {
			if (diagnosticMobile && !viewport.mobile) continue;
			// Diagnostic mode deliberately cannot satisfy the measured-round acceptance check.
			const roundCount = diagnostic || faultMode ? 1 : iterations + (readFanout ? 1 : 0);
			for (let iteration = 0; iteration < roundCount; iteration++) {
				const context = await browser.createBrowserContext();
				const page = await context.newPage();
				await page.setViewport({
					width: viewport.width,
					height: viewport.height,
					isMobile: viewport.mobile,
					hasTouch: viewport.mobile,
				});
				await page.setCacheEnabled(false);
				await page.evaluateOnNewDocument(
					installBrowserProbe,
					token,
					ids.A,
					SENTINELS.A,
					readFanout ? FANOUT_LIMITS.resourceTimingEntries : 0,
				);
				const network = await monitor(page, readFanout ? fanoutForbidden : []);
				const fanoutRound: FanoutRound = {
					viewport: viewport.name,
					iteration,
					kind:
						diagnostic || faultMode ? "diagnostic" : iteration === 0 ? "functional" : "measured",
					browser: [],
					captures: [],
					closed: false,
				};
				let fanout: Awaited<ReturnType<typeof createReadFanoutSession>> | undefined;
				try {
					if (readFanout) {
						fanoutRounds.push(fanoutRound);
						fanout = await createReadFanoutSession(
							page,
							runtime,
							token,
							fanoutRound,
							fanoutForbidden,
							persistFanout,
						);
					}
					if (iteration === 0) network.delay(ids.A);
					await fanout?.begin("cold");
					const coldStart = performance.now();
					await page.goto(`${runtime.base}/narrators/${ids.A}`, {
						waitUntil: "domcontentloaded",
						timeout: 20_000,
					});
					const cold = await paint(page);
					const coldPaintAt = performance.now();
					let coldCount = network.count(ids.A, 0, "tail");
					await waitGit(page, "loading-smoke-A");
					if (iteration === 0) {
						await until(
							async () =>
								network.records.some(
									(record) =>
										record.kind === "summary" && record.narratorId === ids.A && !!record.endMs,
								),
							8_000,
							"cold delayed Git summary completion",
						);
						const summary = network.records.find(
							(record) => record.delayed && record.kind === "summary",
						);
						const detail = network.records.find(
							(record) => record.narratorId === ids.A && record.kind === "detail",
						);
						const tail = network.records.find(
							(record) => record.narratorId === ids.A && record.kind === "tail",
						);
						const browserRequestTimings = readFanout
							? await browserOpeningRequestTimings(page, ids.A)
							: undefined;
						check(
							`${viewport.name}: detail/tail parallel with delayed Git`,
							!!summary?.releaseMs &&
								!!detail &&
								!!tail &&
								detail.atMs < summary.releaseMs &&
								tail.atMs < summary.releaseMs &&
								coldPaintAt < summary.releaseMs &&
								Math.abs(detail.atMs - tail.atMs) < 500,
							{
								detailStartMs: detail ? detail.atMs - coldStart : null,
								tailStartMs: tail ? tail.atMs - coldStart : null,
								summaryStartMs: summary ? summary.atMs - coldStart : null,
								summaryReleaseMs: summary?.releaseMs ? summary.releaseMs - coldStart : null,
								visibleMessageMs: cold.firstMessage.elapsedMs,
								beforeGit: coldPaintAt < (summary?.releaseMs ?? 0),
								coldTailRequests: coldCount,
								browserRequestTimings,
							},
						);
						const after = await geometry(page);
						check(
							`${viewport.name}: cold slot and message viewport do not jump`,
							cold.firstViewport.slot?.height === 30 &&
								stableViewport(cold.firstMessage.viewport, after.viewport),
							{
								first: cold.firstMessage.viewport,
								after: after.viewport,
								firstSlot: cold.firstViewport.slot?.height,
							},
						);
					}
					// Count through the phase boundary too: a sequential post-paint reread must
					// not hide behind a count captured before the first WS baseline arrives.
					const settledCold = await network.finishPhase(ids.A, 0, SENTINELS.A);
					await fanout?.end(true, cold.firstMessage.elapsedMs);
					coldCount = network.count(ids.A, 0, "tail");
					const coldRequests = historyRequestCounts(network.records, ids.A);
					network.delay();
					await fanout?.begin("A_to_B");
					const beforeB = network.records.length;
					const switchB = await navigate(page, ids.B, "B", viewport.mobile);
					let switchBCount = network.count(ids.B, beforeB, "tail");
					if (viewport.name === "desktop" && iteration === 0) {
						await until(
							async () =>
								network.records.some(
									(record) =>
										record.narratorId === ids.B && record.kind === "workspace" && !!record.endMs,
								),
							8_000,
							"initial non-Git workspace response",
						);
						const ordinary = await geometry(page);
						check(
							"cached non-Git keeps 30px slot",
							ordinary.slotHeight === 30 && ordinary.gitText.includes("repo-b"),
							ordinary,
						);
						await initFixtureGit(dirs.B, "loading-smoke-B", runtime.home);
					}
					if (iteration === 0) {
						// Real cache aging (5s staleTime), with a finite predicate budget.
						await until(
							async () =>
								performance.now() -
									(network.records.find(
										(record) => record.narratorId === ids.A && record.kind === "summary",
									)?.endMs ?? performance.now()) >=
								5_200,
							6_000,
							"age A Git summary cache",
						);
						network.delay(ids.A);
					}
					const settledB = await network.finishPhase(ids.B, beforeB, SENTINELS.B);
					await fanout?.end(true, switchB.firstMessage.elapsedMs);
					switchBCount = network.count(ids.B, beforeB, "tail");
					const switchBRequests = historyRequestCounts(network.records, ids.B, beforeB);
					await fanout?.begin("B_to_A");
					const beforeHot = network.records.length;
					if (faultMode) network.armFault(ids.A);
					const hot = await navigate(page, ids.A, "A", viewport.mobile);
					const settledHot = await network.finishPhase(ids.A, beforeHot, SENTINELS.A);
					await fanout?.end(true, hot.firstMessage.elapsedMs);
					let hotCount = network.count(ids.A, beforeHot, "tail");
					let hotRequests = historyRequestCounts(network.records, ids.A, beforeHot);
					if (iteration === 0) {
						const first = hot.firstViewport;
						check(
							`${viewport.name}: cached Git facts in first viewport frame`,
							first.slot?.height === 30 &&
								first.gitText.includes("loading-smoke-A") &&
								first.gitText.includes("+1") &&
								first.gitText.includes("-0"),
							first,
						);
						await until(
							async () =>
								network.records.slice(beforeHot).some((record) => record.delayed && !!record.endMs),
							8_000,
							"hot delayed summary refresh",
						);
						hotCount = network.count(ids.A, beforeHot, "tail");
						const refreshed = await geometry(page);
						const viewportChanges = await page.evaluate(
							() => (window as unknown as ProbeWindow).__loadingProbe.viewportChanges,
						);
						check(
							`${viewport.name}: hot viewport survives summary refresh`,
							stableViewport(first.viewport, refreshed.viewport) && hotCount === 0,
							{
								first: first.viewport,
								after: refreshed.viewport,
								hotTailRequests: hotCount,
								viewportChanges,
							},
						);
						const draftGrowth = await exerciseDraftComposer(page);
						check(
							`${viewport.name}: multiline draft grows naturally and empty draft restores`,
							draftGrowth.grown >= draftGrowth.before + 20 &&
								Math.abs(draftGrowth.restored - draftGrowth.before) <= 0.5,
							draftGrowth,
						);
						await network.finishPhase(ids.A, beforeHot, SENTINELS.A);
						hotCount = network.count(ids.A, beforeHot, "tail");
						hotRequests = historyRequestCounts(network.records, ids.A, beforeHot);
						if (viewport.name === "desktop") {
							network.delay();
							const beforeRecovery = network.records.length;
							const recovered = await navigate(page, ids.B, "B", viewport.mobile);
							await network.finishPhase(ids.B, beforeRecovery, SENTINELS.B);
							await waitGit(page, "loading-smoke-B");
							const ready = await geometry(page);
							check(
								"cached non-Git becomes Git after real git init",
								recovered.firstViewport.slot?.height === 30 &&
									ready.gitText.includes("loading-smoke-B") &&
									stableViewport(recovered.firstViewport.viewport, ready.viewport),
								{ first: recovered.firstViewport, ready },
							);
						}
						await page.screenshot({ path: join(runtime.evidenceDir, `${viewport.name}.png`) });
						details.push({
							viewport: viewport.name,
							cold,
							switchB,
							hot,
							settled: { cold: settledCold, switchB: settledB, hot: settledHot },
							requests: network.records.map((record) => ({
								...record,
								narratorId:
									record.narratorId === ids.A ? "A" : record.narratorId === ids.B ? "B" : "other",
								atMs: record.atMs - coldStart,
								endMs: record.endMs ? record.endMs - coldStart : undefined,
								releaseMs: record.releaseMs ? record.releaseMs - coldStart : undefined,
							})),
						});
					} else {
						await network.finishPhase(ids.A, beforeHot, SENTINELS.A);
						hotCount = network.count(ids.A, beforeHot, "tail");
						hotRequests = historyRequestCounts(network.records, ids.A, beforeHot);
					}
					if (
						network.duplicateInflight() ||
						network.errors.length ||
						coldCount !== 1 ||
						switchBCount !== 1 ||
						hotCount !== 0
					)
						check(`${viewport.name} round ${iteration}: request/console invariants`, false, {
							duplicateInflight: network.duplicateInflight(),
							errors: network.errors,
							coldCount,
							switchBCount,
							hotCount,
						});
					if (fanout && iteration === roundCount - 1) {
						await fanout.begin("idle");
						const idleStartedAt = performance.now();
						await until(
							async () => performance.now() - idleStartedAt >= 1_500,
							2_500,
							"bounded no-action background observation",
						);
						await fanout.end();
					}
					if (faultMode)
						throw new Error(
							`Fault mode did not reject the hot phase: ${faultMode}; injected=${network.injected.length}`,
						);
					if (diagnostic) {
						const failed = checks.filter((item) => !item.ok).map((item) => item.name);
						throw new Error(
							failed.length
								? `Diagnostic functional assertions failed: ${failed.join("; ")}`
								: "Diagnostic-only functional round; no performance sample",
						);
					}
					if (!readFanout || iteration > 0)
						samples.push({
							viewport: viewport.name,
							iteration,
							coldMs: cold.firstMessage.elapsedMs,
							switchBMs: switchB.firstMessage.elapsedMs,
							hotMs: hot.firstMessage.elapsedMs,
							coldTailRequests: coldCount,
							switchBTailRequests: switchBCount,
							hotTailRequests: hotCount,
							phaseRequestCounts: {
								cold: coldRequests,
								switchB: switchBRequests,
								hot: hotRequests,
							},
						});
				} catch (error) {
					try {
						await page.screenshot({
							path: join(runtime.evidenceDir, `${viewport.name}-failed.png`),
						});
						details.push({
							viewport: viewport.name,
							iteration,
							error: String(error),
							requests: network.records,
							injected: network.injected,
							errors: network.errors,
							consoleMessages: network.consoleMessages,
							currentFrames: await settledVisibleFrames(page),
							probe: await page.evaluate(() => (window as unknown as ProbeWindow).__loadingProbe),
						});
					} catch (evidenceError) {
						details.push({
							evidenceError: String(evidenceError),
							requests: network.records,
							injected: network.injected,
						});
					}
					checks.push({
						name: `${viewport.name} round ${iteration}: settled phase`,
						ok: false,
						detail: String(error),
					});
					throw error;
				} finally {
					network.cleanup();
					try {
						await fanout?.cleanup();
					} finally {
						await context.close();
					}
				}
			}
		}
		const performanceSummary = [...new Set(samples.map((sample) => sample.viewport))].map(
			(viewport) => {
				const group = samples.filter((sample) => sample.viewport === viewport);
				const totals = (phase: "cold" | "switchB" | "hot") =>
					Object.fromEntries(
						(["tail", "window", "olderPage", "locate"] as const).map((kind) => [
							kind,
							group.reduce((sum, sample) => sum + sample.phaseRequestCounts[phase][kind], 0),
						]),
					);
				return {
					viewport,
					cold: summarize(group.map((sample) => sample.coldMs)),
					switchB: summarize(group.map((sample) => sample.switchBMs)),
					hot: summarize(group.map((sample) => sample.hotMs)),
					phaseRequestCounts: {
						cold: totals("cold"),
						switchB: totals("switchB"),
						hot: totals("hot"),
					},
					requestCounts: {
						coldTail: group.reduce((sum, sample) => sum + sample.coldTailRequests, 0),
						switchBTail: group.reduce((sum, sample) => sum + sample.switchBTailRequests, 0),
						hotTail: group.reduce((sum, sample) => sum + sample.hotTailRequests, 0),
					},
				};
			},
		);
		check(
			"all measured cold→B→A rounds use one cold tail, no hot tail or duplicate inflight",
			!checks.some((item) => !item.ok) && samples.length === 2 * iterations,
			{ measuredRounds: samples.length },
		);
		if (readFanout) {
			check(
				"read-fanout measured windows and bounded observer coverage",
				fanoutMeasuredRoundsComplete() && fanoutCoverageComplete(),
				{ rounds: fanoutRounds.length, coverageComplete: fanoutCoverageComplete() },
			);
		}
		result = {
			diagnostic,
			methodology:
				"Current implementation only; no old implementation benchmark or improvement percentage. Cold = fresh browser context with HTTP cache disabled; hot = real app recent-tab click A→B→A in the same JS runtime. Two visible clipped text Range/rAF frames, not hidden textContent. Fixture: two fixed short messages, local isolated SQLite and loopback server. Desktop1440x900/mobile390x844; 2s Git summary request delay only in first functional round. Timings stop at first visible paint-ready frame; request phases also await bounded history HTTP completion plus 100ms quiet, counting late requests, require every participating detail/tail/window/page/locate request to finish without network failure with 2xx status, then independently reread current clipped sentinels on two rAF frames (not the historical first-paint probe). Warm tail zero is not network zero: canonical afterSeq window GET and message-location counts are reported separately. Browser screenshot/geometry is paint-ready evidence, not physical screen scanout.",
			performanceSummary,
			samples,
			details,
			checks,
		};
		console.log(
			`${diagnostic ? "DIAGNOSTIC" : "PERFORMANCE"} ${JSON.stringify(performanceSummary)}`,
		);
		if (checks.some((item) => !item.ok))
			throw new Error("Narrator loading smoke assertions failed");
		fanoutStatus = "complete";
	} catch (error) {
		fanoutStatus = "failed";
		failure = String(error);
		throw error;
	} finally {
		try {
			persistFanout();
			if (readFanout) console.log(`Read-fanout evidence: ${fanoutPath}`);
			writeFileSync(
				join(runtime.evidenceDir, "narrator-loading.json"),
				`${JSON.stringify({ failure, diagnostic, faultMode, result, checks, samples, details }, null, "\t")}\n`,
				{ mode: 0o600 },
			);
			runtime.report(
				checks.map((item) => ({
					name: item.name,
					ok: item.ok,
					detail: JSON.stringify(item.detail).slice(0, 500),
				})),
			);
		} finally {
			try {
				if (readFanout && failure && runtime.logTail) {
					let tail = Buffer.from(runtime.logTail()).subarray(-4_096).toString("utf8");
					for (const secret of fanoutForbidden)
						if (secret) tail = tail.split(secret).join("[redacted]");
					writeFileSync(join(runtime.evidenceDir, "server-phase-tail.log"), tail, { mode: 0o600 });
				}
			} finally {
				await runtime.cleanup();
				// Preserve pre-cleanup diagnostics separately from the shutdown-heavy final tail.
				if (!readFanout || !failure)
					rmSync(join(runtime.evidenceDir, "server-tail.log"), { force: true });
				await formatHarnessSummary(join(runtime.evidenceDir, "summary.json"));
				console.log(`Artifacts: ${runtime.evidenceDir}`);
			}
		}
	}
}
if (import.meta.main) {
	void main(
		Number(process.argv.find((arg) => arg.startsWith("--iterations="))?.split("=")[1] ?? 10),
	).catch((error) => {
		console.error(String(error));
		process.exitCode = 1;
	});
}
