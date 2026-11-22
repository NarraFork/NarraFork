import { Database } from "bun:sqlite";
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type HTTPRequest, type Page } from "puppeteer-core";

interface SmokeRuntime {
	home: string;
	base: string;
	evidenceDir: string;
	start(): void;
	cleanup(): Promise<void>;
	assertHealthyProcess(): void;
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
	createSmokeRuntime(): Promise<SmokeRuntime>;
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
// --read-fanout: browser-observed fanout per phase window. Only fixed labels, counts and
// durations leave the observer; no URL, query, ID, header, body or WS payload is retained.
const FANOUT_LIMITS = {
	categories: 64,
	wsTypes: 32,
	windowsPerRound: 16,
	pendingHttp: 1_024,
	frameBytes: 64 * 1_024,
	evidenceBytes: 4 * 1_024 * 1_024,
};
export const FANOUT_LATENCY_BOUNDS_MS = [5, 10, 25, 50, 100, 250, 500, 1_000, 5_000];
// No backend read collector exists on this build, so server metrics are reported as absent.
export const SERVER_READ_METRICS = {
	status: "unavailable",
	reason:
		"No backend read-fanout collector on this build; browser observation cannot see SQL reads.",
	blockedOn: "legacy /api/admin/diagnostics/read-fanout collector (9d9083b9e), not on main",
	blockedMetrics: [
		"logical SQL reads, read-pool entries and Worker dispatches per window",
		"exact query-template repeat counts",
		"server-side read timing histograms and background/unattributed reads",
	],
} as const;
type FanoutPhase = "cold" | "A_to_B" | "B_to_A" | "idle";
interface FanoutCounts {
	started: number;
	completed: number;
	failed: number;
}
interface OpeningTiming {
	startMs: number;
	responseEndMs: number;
}
export interface FanoutWindow {
	label: FanoutPhase | "between";
	startedAtMs: number;
	endedAtMs?: number;
	firstVisibleMs?: number;
	opening?: { detail: OpeningTiming | null; tail: OpeningTiming | null };
	http: FanoutCounts & {
		statuses: Record<string, number>;
		categories: Record<string, FanoutCounts>;
		durationMs: { count: number; sumMs: number; maxMs: number; buckets: number[] };
		inflightAtStart: number;
		inflightAtEnd?: number;
	};
	ws: { sent: Record<string, number>; received: number; receivedBytes: number };
	overflow: number;
}

export function fanoutHttpCategory(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	const group = parsed.pathname.match(/^\/api\/([^/]+)/)?.[1];
	if (!group) return null;
	if (group === "narrators" && parsed.pathname !== "/api/narrators")
		return `narrators.${requestKind(url)?.kind ?? "other"}`;
	return /^[a-z][a-z-]{0,31}$/.test(group) ? group : "unknown";
}
export function fanoutWsType(payload: string, opcode = 1) {
	if (opcode !== 1) return "non-text";
	if (Buffer.byteLength(payload) > FANOUT_LIMITS.frameBytes) return "oversized";
	try {
		const frame = JSON.parse(payload) as { type?: unknown; kind?: unknown } | null;
		const type =
			typeof frame?.type === "string" && /^[a-z][a-z_]{0,39}$/.test(frame.type)
				? frame.type
				: "unknown";
		if (type !== "subscribe") return type;
		const kind = frame?.kind ?? "messages";
		return `subscribe:${["list", "panel", "messages", "activity"].includes(String(kind)) ? kind : "unknown"}`;
	} catch {
		return "invalid-json";
	}
}

export class FanoutCounter {
	readonly windows: FanoutWindow[] = [];
	private readonly pending = new Map<object, { key: string; startedAtMs: number }>();
	private readonly epoch: number;
	constructor(private readonly clock: () => number = () => performance.now()) {
		this.epoch = clock();
		this.begin("between");
	}
	now() {
		return Math.round((this.clock() - this.epoch) * 10) / 10;
	}
	get current() {
		return this.windows[this.windows.length - 1] as FanoutWindow;
	}
	close() {
		if (this.current.endedAtMs !== undefined) return;
		this.current.endedAtMs = this.now();
		this.current.http.inflightAtEnd = this.pending.size;
	}
	begin(label: FanoutWindow["label"]) {
		if (this.windows.length) this.close();
		if (this.windows.length >= FANOUT_LIMITS.windowsPerRound)
			throw new Error("Fanout window budget exceeded");
		this.windows.push({
			label,
			startedAtMs: this.now(),
			http: {
				started: 0,
				completed: 0,
				failed: 0,
				statuses: {},
				categories: {},
				durationMs: {
					count: 0,
					sumMs: 0,
					maxMs: 0,
					buckets: Array(FANOUT_LATENCY_BOUNDS_MS.length + 1).fill(0),
				},
				inflightAtStart: this.pending.size,
			},
			ws: { sent: {}, received: 0, receivedBytes: 0 },
			overflow: 0,
		});
		return this.current;
	}
	end(firstVisibleMs?: number) {
		this.current.firstVisibleMs = firstVisibleMs;
		this.begin("between");
	}
	private category(key: string) {
		const categories = this.current.http.categories;
		if (!categories[key] && Object.keys(categories).length >= FANOUT_LIMITS.categories) {
			this.current.overflow++;
			return undefined;
		}
		categories[key] ??= { started: 0, completed: 0, failed: 0 };
		return categories[key];
	}
	request(token: object, url: string, method: string) {
		const category = fanoutHttpCategory(url);
		if (!category) return;
		const verb = ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) ? method : "OTHER";
		const key = `${verb} ${category}`;
		this.current.http.started++;
		const counts = this.category(key);
		if (counts) counts.started++;
		if (this.pending.size >= FANOUT_LIMITS.pendingHttp) this.current.overflow++;
		else this.pending.set(token, { key, startedAtMs: this.now() });
	}
	response(token: object, status: number) {
		if (!this.pending.has(token)) return;
		const statusClass = status >= 100 && status < 600 ? `${Math.floor(status / 100)}xx` : "unknown";
		this.current.http.statuses[statusClass] = (this.current.http.statuses[statusClass] ?? 0) + 1;
	}
	// Completions belong to the window they finish in; inflight counts expose the carry-over.
	finish(token: object, failed = false) {
		const request = this.pending.get(token);
		if (!request) return;
		this.pending.delete(token);
		const field = failed ? "failed" : "completed";
		this.current.http[field]++;
		const counts = this.category(request.key);
		if (counts) counts[field]++;
		const ms = Math.max(0, this.now() - request.startedAtMs);
		const histogram = this.current.http.durationMs;
		histogram.count++;
		histogram.sumMs = Math.round((histogram.sumMs + ms) * 10) / 10;
		histogram.maxMs = Math.max(histogram.maxMs, ms);
		const bucket = FANOUT_LATENCY_BOUNDS_MS.findIndex((bound) => ms <= bound);
		histogram.buckets[bucket < 0 ? FANOUT_LATENCY_BOUNDS_MS.length : bucket]++;
	}
	wsSent(payload: string, opcode = 1) {
		const type = fanoutWsType(payload, opcode);
		const sent = this.current.ws.sent;
		if (!sent[type] && Object.keys(sent).length >= FANOUT_LIMITS.wsTypes) this.current.overflow++;
		else sent[type] = (sent[type] ?? 0) + 1;
	}
	wsReceived(payload: string) {
		this.current.ws.received++;
		this.current.ws.receivedBytes += Buffer.byteLength(payload);
	}
}

async function monitorFanout(page: Page) {
	const counter = new FanoutCounter();
	const cdp = await page.createCDPSession();
	cdp.on("Network.webSocketFrameSent", ({ response }) =>
		counter.wsSent(response.payloadData, response.opcode),
	);
	cdp.on("Network.webSocketFrameReceived", ({ response }) =>
		counter.wsReceived(response.payloadData),
	);
	await cdp.send("Network.enable");
	page.on("request", (request) => counter.request(request, request.url(), request.method()));
	page.on("response", (response) => counter.response(response.request(), response.status()));
	page.on("requestfinished", (request) => counter.finish(request));
	page.on("requestfailed", (request) => counter.finish(request, true));
	return {
		counter,
		async cleanup() {
			counter.close();
			await cdp.detach().catch(() => {});
		},
	};
}
// Resource Timing for the first detail/tail fetch of the cold document; the URL is not kept.
async function openingTimings(page: Page, narratorId: string) {
	return page.evaluate((id) => {
		const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
		const first = (path: string) => {
			const entry = entries.find((item) => {
				const url = new URL(item.name);
				return (
					url.pathname === path &&
					!url.searchParams.has("afterSeq") &&
					!url.searchParams.has("beforeSeq")
				);
			});
			return entry
				? {
						startMs: Math.round(entry.startTime * 10) / 10,
						responseEndMs: Math.round(entry.responseEnd * 10) / 10,
					}
				: null;
		};
		return {
			detail: first(`/api/narrators/${id}`),
			tail: first(`/api/narrators/${id}/pretext-document`),
		};
	}, narratorId);
}

export interface FanoutRound {
	viewport: string;
	iteration: number;
	kind: "functional" | "measured" | "diagnostic";
	windows: FanoutWindow[];
	typing?: { growMs: number; restoreMs: number };
}
export function distribution(values: readonly (number | undefined)[]) {
	const finite = values.filter((value): value is number => Number.isFinite(value));
	if (!finite.length) return { n: 0, p50: null, p95: null, max: null };
	const { n, p50Ms, p95Ms } = summarize(finite);
	return { n, p50: p50Ms, p95: p95Ms, max: Math.max(...finite) };
}
export function summarizeFanout(rounds: readonly FanoutRound[]) {
	const viewports = [...new Set(rounds.map((round) => round.viewport))];
	return viewports.flatMap((viewport) =>
		(["cold", "A_to_B", "B_to_A", "idle"] as const).flatMap((phase) => {
			const windows = rounds
				.filter((round) => round.viewport === viewport && round.kind === "measured")
				.flatMap((round) => round.windows.filter((window) => window.label === phase));
			if (!windows.length) return [];
			const requestsByCategory: Record<string, number> = {};
			for (const window of windows)
				for (const [key, counts] of Object.entries(window.http.categories))
					requestsByCategory[key] = (requestsByCategory[key] ?? 0) + counts.started;
			const sum = (record: Record<string, number>) =>
				Object.values(record).reduce((total, value) => total + value, 0);
			return [
				{
					viewport,
					phase,
					windows: windows.length,
					firstVisibleMs: distribution(windows.map((window) => window.firstVisibleMs)),
					windowMs: distribution(
						windows.map((window) => (window.endedAtMs ?? window.startedAtMs) - window.startedAtMs),
					),
					httpStarted: distribution(windows.map((window) => window.http.started)),
					httpFailed: distribution(windows.map((window) => window.http.failed)),
					httpInflightAtEnd: distribution(windows.map((window) => window.http.inflightAtEnd)),
					httpMaxMs: distribution(windows.map((window) => window.http.durationMs.maxMs)),
					wsSent: distribution(windows.map((window) => sum(window.ws.sent))),
					wsReceived: distribution(windows.map((window) => window.ws.received)),
					openingDetailResponseEndMs: distribution(
						windows.map((window) => window.opening?.detail?.responseEndMs),
					),
					openingTailResponseEndMs: distribution(
						windows.map((window) => window.opening?.tail?.responseEndMs),
					),
					requestsByCategory,
				},
			];
		}),
	);
}
export function fanoutCoverageComplete(rounds: readonly FanoutRound[], expectedMeasured: number) {
	const measured = rounds.filter((round) => round.kind === "measured");
	return (
		measured.length === expectedMeasured &&
		measured.every((round) =>
			(["cold", "A_to_B", "B_to_A"] as const).every((phase) =>
				round.windows.some(
					(window) =>
						window.label === phase &&
						window.endedAtMs !== undefined &&
						window.firstVisibleMs !== undefined,
				),
			),
		) &&
		rounds.every((round) => round.windows.every((window) => window.overflow === 0))
	);
}
// Fails closed: evidence containing a fixture secret, ID, path or transcript text is not written.
export function writePrivateEvidence(path: string, value: unknown, forbidden: readonly string[]) {
	const text = `${JSON.stringify(value, null, "\t")}\n`;
	if (forbidden.some((secret) => secret.length > 0 && text.includes(secret)))
		throw new Error("Evidence privacy guard rejected sensitive fixture data");
	if (Buffer.byteLength(text) > FANOUT_LIMITS.evidenceBytes)
		throw new Error("Evidence byte budget exceeded");
	writeFileSync(path, text, { mode: 0o600 });
	chmodSync(path, 0o600);
}
// Labels persisted IDs/token/home in the general evidence file instead of raw values.
export function redactEvidence(text: string, replacements: ReadonlyArray<[string, string]>) {
	let redacted = text;
	for (const [secret, label] of replacements)
		if (secret) redacted = redacted.split(secret).join(label);
	return redacted;
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
function installBrowserProbe(token: string, target: string, expected: string[]) {
	localStorage.setItem("narrafork_token", token);
	localStorage.setItem("narrafork_lang", "en");
	// ~250 bundle chunks would otherwise fill the default buffer before the opening API fetches.
	performance.setResourceTimingBufferSize(1_000);
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
	const sample = () => {
		const probe = host.__loadingProbe;
		probe.frames++;
		if (location.pathname === `/narrators/${probe.target}` && probe.frames <= 240) {
			const viewport = Array.from(
				document.querySelectorAll<HTMLElement>("[data-pretext-exact-message-list]"),
			).find(visible);
			if (viewport) {
				const panel = viewport.closest("[data-narrator-panel]");
				// The composer is a contenteditable editor; a legacy textarea is still accepted.
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
					containers.push({ className: ancestor.className.slice(0, 160), rect: toRect(ancestor) });
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
											: (textarea.getAttribute("data-placeholder") ?? ""),
									valueLength: (textarea instanceof HTMLTextAreaElement
										? textarea.value
										: textarea.innerText.trim()
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
	};
	// A throwing sample must surface as a probe failure, not as a silent 15s paint timeout.
	const tick = () => {
		try {
			sample();
		} catch (error) {
			host.__loadingProbe.failure = {
				message: String(error).slice(0, 500),
				frame: host.__loadingProbe.frames,
			};
			return;
		}
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
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
		const menu = await page.waitForSelector("[data-mobile-nav-button]", {
			visible: true,
			timeout: 5_000,
		});
		await menu?.click();
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
			element instanceof HTMLTextAreaElement ? element.value : (element as HTMLElement).innerText;
		if (value.trim()) throw new Error("Draft growth fixture requires an empty composer");
		return element.getBoundingClientRect().height;
	});
	// Select-all + Backspace, then CDP Input.insertText: the real editor input path, never Enter/send.
	const setDraft = async (value: string) => {
		await page.focus(selector);
		await page.$eval(selector, (element) => {
			if (element instanceof HTMLTextAreaElement) return element.select();
			const range = document.createRange();
			range.selectNodeContents(element);
			getSelection()?.removeAllRanges();
			getSelection()?.addRange(range);
		});
		await page.keyboard.press("Backspace");
		if (value) await page.keyboard.sendCharacter(value);
	};
	const lines = [
		"SMOKE DRAFT LINE 1",
		"SMOKE DRAFT LINE 2",
		"SMOKE DRAFT LINE 3",
		"SMOKE DRAFT LINE 4",
	];
	const typedAt = performance.now();
	await setDraft(lines.join("\n"));
	await page.waitForFunction(
		(target, expected, height) => {
			const editor = document.querySelector<HTMLElement>(target);
			if (!editor) return false;
			const value = editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText;
			return (
				expected.every((line: string) => value.includes(line)) &&
				editor.getBoundingClientRect().height >= height + 20
			);
		},
		{ timeout: 5_000, polling: "raf" },
		selector,
		lines,
		before,
	);
	const growMs = performance.now() - typedAt;
	const grown = await page.$eval(selector, (element) => element.getBoundingClientRect().height);
	const clearedAt = performance.now();
	await setDraft("");
	await page.waitForFunction(
		(target, height) => {
			const editor = document.querySelector<HTMLElement>(target);
			if (!editor) return false;
			const value = editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText;
			return value.trim() === "" && Math.abs(editor.getBoundingClientRect().height - height) <= 0.5;
		},
		{ timeout: 5_000, polling: "raf" },
		selector,
		before,
	);
	const restoreMs = performance.now() - clearedAt;
	const restored = await page.$eval(selector, (element) => element.getBoundingClientRect().height);
	const round = (ms: number) => Math.round(ms * 10) / 10;
	return { before, grown, restored, growMs: round(growMs), restoreMs: round(restoreMs) };
}

async function monitor(page: Page) {
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
	const runtime = await createSmokeRuntime();
	const checks: Check[] = [];
	const samples: Sample[] = [];
	const details: unknown[] = [];
	const fanoutRounds: FanoutRound[] = [];
	const secrets: Array<[string, string]> = [[runtime.home, "<fixture-home>"]];
	const check = (name: string, ok: boolean, detail: unknown) => {
		checks.push({ name, ok, detail });
		console.log(`[${ok ? "PASS" : "FAIL"}] ${name} ${JSON.stringify(detail).slice(0, 1_000)}`);
		if (!ok && (diagnostic || faultMode))
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
		secrets.push([token, "<token>"]);
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
			secrets.push([ids[subject], `<narrator-${subject}>`]);
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
		seedMessages(runtime.home, ids);
		const browser = await puppeteer.launch({
			executablePath: chrome,
			headless: true,
			args: ["--no-sandbox", "--disable-dev-shm-usage"],
			timeout: 15_000,
			protocolTimeout: 20_000,
		});
		runtime.ownBrowser(browser);
		for (const viewport of [
			{ name: "desktop", width: 1440, height: 900, mobile: false },
			{ name: "mobile390", width: 390, height: 844, mobile: true },
		]) {
			if (diagnosticMobile && !viewport.mobile) continue;
			// Diagnostic mode deliberately cannot satisfy the measured-round acceptance check.
			for (let iteration = 0; iteration < (diagnostic || faultMode ? 1 : iterations); iteration++) {
				const context = await browser.createBrowserContext();
				const page = await context.newPage();
				await page.setViewport({
					width: viewport.width,
					height: viewport.height,
					isMobile: viewport.mobile,
					hasTouch: viewport.mobile,
				});
				await page.setCacheEnabled(false);
				await page.evaluateOnNewDocument(installBrowserProbe, token, ids.A, SENTINELS.A);
				const network = await monitor(page);
				const fanout = readFanout ? await monitorFanout(page) : undefined;
				const fanoutRound: FanoutRound = {
					viewport: viewport.name,
					iteration,
					kind:
						diagnostic || faultMode ? "diagnostic" : iteration === 0 ? "functional" : "measured",
					windows: fanout?.counter.windows ?? [],
				};
				try {
					if (iteration === 0) network.delay(ids.A);
					fanout?.counter.begin("cold");
					const coldStart = performance.now();
					await page.goto(`${runtime.base}/narrators/${ids.A}`, {
						waitUntil: "domcontentloaded",
						timeout: 20_000,
					});
					const cold = await paint(page);
					const coldPaintAt = performance.now();
					if (fanout) fanout.counter.current.opening = await openingTimings(page, ids.A);
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
					coldCount = network.count(ids.A, 0, "tail");
					const coldRequests = historyRequestCounts(network.records, ids.A);
					fanout?.counter.end(cold.firstMessage.elapsedMs);
					network.delay();
					const beforeB = network.records.length;
					fanout?.counter.begin("A_to_B");
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
					switchBCount = network.count(ids.B, beforeB, "tail");
					const switchBRequests = historyRequestCounts(network.records, ids.B, beforeB);
					fanout?.counter.end(switchB.firstMessage.elapsedMs);
					const beforeHot = network.records.length;
					if (faultMode) network.armFault(ids.A);
					fanout?.counter.begin("B_to_A");
					const hot = await navigate(page, ids.A, "A", viewport.mobile);
					const settledHot = await network.finishPhase(ids.A, beforeHot, SENTINELS.A);
					let hotCount = network.count(ids.A, beforeHot, "tail");
					let hotRequests = historyRequestCounts(network.records, ids.A, beforeHot);
					fanout?.counter.end(hot.firstMessage.elapsedMs);
					if (fanout && iteration > 0) {
						// Fixed 1s quiet window after the settled hot phase: background fanout only.
						fanout.counter.begin("idle");
						await new Promise((done) => setTimeout(done, 1_000));
						fanout.counter.end();
					}
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
						fanoutRound.typing = { growMs: draftGrowth.growMs, restoreMs: draftGrowth.restoreMs };
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
					if (faultMode)
						throw new Error(
							`Fault mode did not reject the hot phase: ${faultMode}; injected=${network.injected.length}`,
						);
					if (diagnostic)
						throw new Error("Diagnostic-only functional round; no performance sample");
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
					if (fanout) {
						await fanout.cleanup();
						fanoutRounds.push(fanoutRound);
					}
					await context.close();
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
		if (readFanout)
			check(
				"read-fanout windows cover every measured phase within budget",
				fanoutCoverageComplete(fanoutRounds, 2 * (iterations - 1)),
				{ rounds: fanoutRounds.length },
			);
		check(
			"all measured cold→B→A rounds use one cold tail, no hot tail or duplicate inflight",
			!checks.some((item) => !item.ok) && samples.length === 2 * iterations,
			{ measuredRounds: samples.length },
		);
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
	} catch (error) {
		failure = String(error);
		throw error;
	} finally {
		try {
			writeFileSync(
				join(runtime.evidenceDir, "narrator-loading.json"),
				redactEvidence(
					`${JSON.stringify({ failure, diagnostic, faultMode, result, checks, samples, details }, null, "\t")}\n`,
					secrets,
				),
				{ mode: 0o600 },
			);
			if (readFanout)
				writePrivateEvidence(
					join(runtime.evidenceDir, "narrator-loading-fanout.json"),
					{
						schema: "narrator-loading-fanout/v1",
						source: "browser-observed CDP HTTP/WS events, Resource Timing and rAF paint probe",
						latencyBoundsMs: FANOUT_LATENCY_BOUNDS_MS,
						serverReadMetrics: SERVER_READ_METRICS,
						summary: summarizeFanout(fanoutRounds),
						rounds: fanoutRounds,
					},
					[...secrets.map(([secret]) => secret), ...SENTINELS.A, ...SENTINELS.B],
				);
			runtime.report(
				checks.map((item) => ({
					name: item.name,
					ok: item.ok,
					detail: JSON.stringify(item.detail).slice(0, 500),
				})),
			);
		} finally {
			await runtime.cleanup();
			// Shared harness writes a 4KiB log; this smoke retains only small JSON/images.
			rmSync(join(runtime.evidenceDir, "server-tail.log"), { force: true });
			await formatHarnessSummary(join(runtime.evidenceDir, "summary.json"));
			console.log(`Artifacts: ${runtime.evidenceDir}`);
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
