import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import type { Page } from "puppeteer-core";
import {
	assertReadFanoutPrivacy,
	createReadFanoutSession,
	exerciseDraftComposer,
	ReadFanoutBrowserCounter,
	readFanoutHttpCategory,
	readFanoutTemplateRepeats,
	readFanoutWsCategory,
	summarizeReadFanoutHistogram,
	summarizeReadFanoutValues,
	writeReadFanoutEvidence,
} from "../../scripts/smoke-narrator-loading";
import {
	type ReadFanoutReport,
	startReadFanoutCapture,
	stopReadFanoutCapture,
} from "../../server/lib/read-fanout-diagnostics";

const HARNESS_MODULE = "../../scripts/smoke-plugin-ui";
const { createSmokeRuntime } = (await import(HARNESS_MODULE)) as {
	createSmokeRuntime(options?: { watchdogMs?: number }): Promise<unknown>;
};

async function controlFixture() {
	const requests: Array<{
		action: string;
		authorization: string | null;
		body: Record<string, unknown>;
	}> = [];
	const cdp = Object.assign(new EventEmitter(), {
		send: async (_method: string) => {},
		detach: async () => {},
	});
	const mainFrame = {};
	const page = Object.assign(new EventEmitter(), {
		createCDPSession: async () => cdp,
		mainFrame: () => mainFrame,
	});
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const action = new URL(request.url).pathname.split("/").at(-1) ?? "";
			const body = (await request.json()) as Record<string, unknown>;
			requests.push({ action, authorization: request.headers.get("authorization"), body });
			const result =
				action === "start"
					? startReadFanoutCapture(body.durationMs as number)
					: stopReadFanoutCapture(body.captureId as string);
			return Response.json(result, { headers: { "cache-control": "no-store" } });
		},
	});
	const round: Parameters<typeof createReadFanoutSession>[3] = {
		viewport: "desktop",
		iteration: 1,
		kind: "measured",
		browser: [],
		captures: [],
		closed: false,
	};
	let persists = 0;
	const session = await createReadFanoutSession(
		page as unknown as Page,
		{
			base: `http://127.0.0.1:${server.port}`,
			home: "",
			evidenceDir: "",
			start() {},
			async cleanup() {},
			assertHealthyProcess() {},
			ownBrowser() {},
			report() {},
		},
		"private-test-admin-token",
		round,
		["private-test-admin-token", "private-test-narrator"],
		() => {
			persists++;
		},
	);
	return {
		requests,
		page,
		cdp,
		round,
		session,
		persists: () => persists,
		async cleanup() {
			try {
				await session.cleanup();
			} finally {
				await server.stop(true);
			}
		},
	};
}

describe("read-fanout browser evidence", () => {
	test("draft growth exercises contenteditable input and restores the empty geometry", async () => {
		class Editor {
			isContentEditable = true;
			textContent = "";
			innerText = "";
			children: Array<{ innerText: string }> = [];
			getBoundingClientRect() {
				return { height: 20 + this.innerText.split("\n").length * 20 };
			}
		}
		const editor = new Editor();
		const calls: string[] = [];
		const context = createContext({
			editor,
			HTMLElement: Editor,
			HTMLTextAreaElement: class {},
			document: { createRange: () => ({ selectNodeContents() {} }), querySelector: () => editor },
			getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
		});
		const evaluate = (callback: (...args: never[]) => unknown, args: unknown[]) => {
			context.args = args;
			return runInContext(`(${callback.toString()})(...args)`, context);
		};
		const page = {
			async $eval(_selector: string, callback: (...args: never[]) => unknown) {
				return evaluate(callback, [editor]);
			},
			async focus() {
				calls.push("focus");
			},
			keyboard: {
				async press(key: string) {
					calls.push(key);
					if (key !== "Backspace") throw new Error("Unexpected composer shortcut");
					editor.innerText = "";
					editor.textContent = "";
					editor.children = [];
				},
				async sendCharacter(text: string) {
					calls.push("insertText");
					editor.innerText = text;
					editor.textContent = text;
					editor.children = [{ innerText: text }];
				},
			},
			async waitForFunction(
				callback: (...args: never[]) => unknown,
				_options: unknown,
				...args: unknown[]
			) {
				if (!evaluate(callback, args)) throw new Error("Composer growth predicate failed");
			},
		};
		const result = await exerciseDraftComposer(page as unknown as Page);
		expect(result.grown).toBeGreaterThanOrEqual(result.before + 20);
		expect(result.restored).toBe(result.before);
		expect(calls).toEqual(["focus", "Backspace", "insertText", "focus", "Backspace"]);
		expect(editor.textContent).toBe("");
	});

	test("control capture brackets the browser window and uses the isolated admin token", async () => {
		const fixture = await controlFixture();
		try {
			await fixture.session.begin("cold");
			fixture.page.emit("request", {
				url: () => "http://127.0.0.1/narrators/private-test-narrator",
				method: () => "GET",
				isNavigationRequest: () => true,
				frame: fixture.page.mainFrame,
			});
			const request = {
				url: () =>
					"http://127.0.0.1/api/narrators/private-test-narrator?token=private-test-admin-token",
				method: () => "GET",
			};
			fixture.page.emit("request", request);
			fixture.cdp.emit("Network.webSocketCreated", {
				requestId: "private-socket-id",
				url: "ws://127.0.0.1/ws/narrator?token=private-test-admin-token",
			});
			fixture.cdp.emit("Network.webSocketFrameSent", {
				requestId: "private-socket-id",
				response: {
					opcode: 1,
					payloadData:
						'{"type":"subscribe","kind":"messages","narratorIds":["private-test-narrator"]}',
				},
			});
			await fixture.session.end(true, 12.5);
			expect(fixture.requests.map((request) => request.action)).toEqual(["start", "stop"]);
			expect(fixture.requests[0].authorization).toBe("Bearer private-test-admin-token");
			expect(fixture.requests[0].body).toEqual({ durationMs: 60_000 });
			const capture = fixture.round.captures[0];
			expect(capture.status).toBe("complete");
			expect(capture.stableBoundary).toBe(true);
			expect(capture.firstVisibleMs).toBe(12.5);
			expect(capture.server?.schemaVersion).toBe(1);
			expect(capture.server?.endReason).toBe("stop");
			expect(capture.control.startReceivedAtMs).toBeGreaterThanOrEqual(
				capture.control.startSentAtMs,
			);
			expect(capture.control.stopReceivedAtMs).toBeGreaterThanOrEqual(
				capture.control.stopSentAtMs as number,
			);
			expect(fixture.round.browser[capture.browserWindowId].inflightAtEnd?.tracked).toBe(1);
			expect(fixture.round.browser[capture.browserWindowId].ws.sent).toBe(1);
			expect(fixture.round.browser[capture.browserWindowId].documentNavigations).toBe(1);
			expect(fixture.round.browser.at(-1)?.label).toBe("between-windows");
			expect(fixture.persists()).toBe(1);
			assertReadFanoutPrivacy(fixture.round, [
				"private-test-admin-token",
				"private-test-narrator",
				"private-socket-id",
			]);
		} finally {
			await fixture.cleanup();
		}
		expect(fixture.round.closed).toBe(true);
		expect(fixture.page.listenerCount("request")).toBe(0);
	});

	test("cleanup stops its active capture while retaining an explicit failed-phase result", async () => {
		const fixture = await controlFixture();
		try {
			await fixture.session.begin("B_to_A");
		} finally {
			await fixture.cleanup();
		}
		expect(fixture.requests.map((request) => request.action)).toEqual(["start", "stop"]);
		expect(fixture.round.captures[0].stableBoundary).toBe(false);
		expect(fixture.round.captures[0].status).toBe("phase-failed");
		expect(fixture.round.captures[0].server?.endReason).toBe("stop");
		expect(fixture.round.closed).toBe(true);
	});

	test("classifies all API traffic without retaining paths, IDs or query strings", () => {
		const secret = "private-narrator-token";
		const results = [
			readFanoutHttpCategory(`http://127.0.0.1/api/narrators/${secret}`),
			readFanoutHttpCategory(
				`http://127.0.0.1/api/narrators/${secret}/pretext-document?afterSeq=${secret}`,
			),
			readFanoutHttpCategory(
				`http://127.0.0.1/api/narrators/${secret}/message-location/${secret}?token=${secret}`,
			),
			readFanoutHttpCategory(`http://127.0.0.1/api/narrators/${secret}/git/summary?cwd=${secret}`),
			readFanoutHttpCategory(`http://127.0.0.1/api/projects/${secret}?q=${secret}`),
			readFanoutHttpCategory(`http://127.0.0.1/api/${secret}/${secret}`),
		];
		expect(results).toEqual([
			"narrators.detail",
			"narrators.pretext-document",
			"narrators.message-location",
			"narrators.git.summary",
			"projects",
			"unknown",
		]);
		expect(JSON.stringify(results)).not.toContain(secret);
		expect(readFanoutHttpCategory("http://127.0.0.1/api")).toBe("unknown");
		expect(readFanoutHttpCategory("http://127.0.0.1/assets/app.js?token=secret")).toBeNull();
		expect(readFanoutHttpCategory("not a URL")).toBeNull();
	});

	test("uses fixed WS type and subscription-kind labels", () => {
		expect(
			readFanoutWsCategory('{"type":"subscribe","kind":"messages","narratorIds":["secret"]}'),
		).toEqual({ type: "subscribe", kind: "messages" });
		expect(readFanoutWsCategory('{"type":"subscribe"}')).toEqual({
			type: "subscribe",
			kind: "default-messages",
		});
		expect(readFanoutWsCategory('{"type":"subscribe","kind":"secret"}')).toEqual({
			type: "subscribe",
			kind: "unknown",
		});
		expect(readFanoutWsCategory('{"type":"secret","kind":"secret"}')).toEqual({
			type: "unknown",
			kind: "none",
		});
		expect(readFanoutWsCategory("null")).toEqual({ type: "unknown", kind: "none" });
		expect(readFanoutWsCategory("secret")).toEqual({ type: "invalid-json", kind: "none" });
		expect(readFanoutWsCategory("secret", 2)).toEqual({ type: "non-text", kind: "none" });
		expect(readFanoutWsCategory("x".repeat(65_537))).toEqual({ type: "oversized", kind: "none" });
	});

	test("attributes starts, responses and completions to explicit windows, retaining start origin", () => {
		let clock = 100;
		const counter = new ReadFanoutBrowserCounter(() => clock);
		const first = {};
		const failed = {};
		const url = "http://127.0.0.1/api/narrators/real-secret/pretext-document?token=secret";
		counter.request(first, url, "GET");
		clock = 110;
		const cold = counter.begin("cold");
		expect(cold.inflightAtStart.tracked).toBe(1);
		counter.request(failed, "http://127.0.0.1/api/unknown-secret", "SECRET-METHOD");
		clock = 125;
		counter.response(first, url, "GET", 200);
		counter.finish(first, url, "GET");
		counter.finish(failed, "http://127.0.0.1/api/unknown-secret", "SECRET-METHOD", true);
		clock = 140;
		counter.begin("between-windows");
		expect(counter.windows[0].http.started).toBe(1);
		expect(counter.windows[0].http.completed).toBe(0);
		expect(counter.windows[0].inflightAtEnd?.tracked).toBe(1);
		expect(cold.http.started).toBe(1);
		expect(cold.http.completed).toBe(1);
		expect(cold.http.failed).toBe(1);
		expect(cold.http.statuses).toEqual({ "2xx": 1 });
		expect(cold.http.rows.find((row) => row.originWindowId === 0)?.completed).toBe(1);
		expect(cold.http.rows.find((row) => row.category === "unknown")?.method).toBe("OTHER");
		expect(cold.http.completionDurationMs).toMatchObject({ count: 2, sumMs: 40, maxMs: 25 });
		expect(cold.inflightAtEnd?.tracked).toBe(0);
		expect(cold.startedAtMs).toBe(10);
		expect(cold.endedAtMs).toBe(40);
		expect(JSON.stringify(counter.windows)).not.toContain("secret");
	});

	test("does not retain individual completed events or non-API requests", () => {
		const counter = new ReadFanoutBrowserCounter(() => 10);
		counter.request({}, "http://127.0.0.1/assets/main.js", "GET");
		for (let index = 0; index < 5_000; index++) {
			const request = {};
			const url = `http://127.0.0.1/api/new-private-route/${index}?token=${index}`;
			counter.request(request, url, "GET");
			counter.response(request, url, "GET", 204);
			counter.finish(request, url, "GET");
		}
		counter.close();
		expect(counter.current.http.started).toBe(5_000);
		expect(counter.current.http.rows).toHaveLength(1);
		expect(counter.current.http.completionDurationMs.count).toBe(5_000);
		expect(counter.current.inflightAtEnd?.tracked).toBe(0);
		expect(JSON.stringify(counter.windows).length).toBeLessThan(2_500);
	});

	test("reports bounded pending overflow and untracked completions explicitly", () => {
		const counter = new ReadFanoutBrowserCounter(() => 1);
		const requests = Array.from({ length: 1_025 }, () => ({}));
		const url = "http://127.0.0.1/api/health";
		for (const request of requests) counter.request(request, url, "GET");
		counter.begin("cold");
		expect(counter.current.inflightAtStart.tracked).toBe(1_024);
		expect(counter.windows[0].overflow.pendingHttp).toBe(1);
		counter.response(requests[1_024], url, "GET", 503);
		counter.finish(requests[1_024], url, "GET");
		expect(counter.current.overflow.untrackedResponses).toBe(1);
		expect(counter.current.overflow.untrackedCompletions).toBe(1);
		expect(counter.current.http.rows[0].originWindowId).toBe("untracked");
		expect(counter.current.http.statuses).toEqual({ "5xx": 1 });
	});

	test("HTTP row overflow keeps total counts and unknown status buckets", () => {
		const counter = new ReadFanoutBrowserCounter(() => 1);
		for (const category of [
			"auth",
			"health",
			"settings",
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
			"system",
		])
			for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
				const request = {};
				const url = `http://127.0.0.1/api/${category}`;
				counter.request(request, url, method);
				counter.response(request, url, method, 999);
				counter.finish(request, url, method);
			}
		expect(counter.current.http.started).toBe(140);
		expect(counter.current.http.responses).toBe(140);
		expect(counter.current.http.completed).toBe(140);
		expect(counter.current.http.rows).toHaveLength(128);
		expect(counter.current.http.statuses).toEqual({ unknown: 140 });
		expect(counter.current.overflow.httpRows).toBeGreaterThan(0);
	});

	test("WS payloads and uncontrolled connection labels are discarded", () => {
		const counter = new ReadFanoutBrowserCounter(() => 1);
		for (let index = 0; index < 5_000; index++)
			counter.frame(
				"private-connection",
				JSON.stringify({ type: "private-type", token: `secret-${index}` }),
			);
		counter.frame("narrator", "x".repeat(65_537));
		expect(counter.current.ws.sent).toBe(5_001);
		expect(counter.current.ws.rows).toEqual([
			{ connection: "unknown", type: "unknown", kind: "none", sent: 5_000 },
			{ connection: "narrator", type: "oversized", kind: "none", sent: 1 },
		]);
		expect(counter.current.overflow.oversizedFrames).toBe(1);
		expect(JSON.stringify(counter.windows)).not.toContain("secret");
		expect(JSON.stringify(counter.windows)).not.toContain("private");
	});

	test("window count is bounded and closing is idempotent", () => {
		let clock = 0;
		const counter = new ReadFanoutBrowserCounter(() => clock++);
		for (let index = 0; index < 15; index++) counter.begin("cold");
		expect(() => counter.begin("cold")).toThrow("window budget");
		counter.close();
		const ended = counter.current.endedAtMs;
		counter.close();
		expect(counter.current.endedAtMs).toBe(ended);
		expect(counter.windows).toHaveLength(16);
	});

	test("p50/p95 are exact nearest-rank window statistics with explicit n", () => {
		expect(summarizeReadFanoutValues([5, 1, 3, 2, 4])).toEqual({
			n: 5,
			sum: 15,
			min: 1,
			max: 5,
			p50: 3,
			p95: 5,
		});
		expect(summarizeReadFanoutValues([])).toBeNull();
		expect(() => summarizeReadFanoutValues([Number.NaN])).toThrow();
		expect(() => summarizeReadFanoutValues([-1])).toThrow();
	});

	test("pooled timing p50/p95 report bucket upper bounds and preserve missing observations", () => {
		expect(
			summarizeReadFanoutHistogram(
				[
					{ count: 2, sumMs: 3, maxMs: 2, buckets: [1, 1, 0] },
					{ count: 1, sumMs: 20, maxMs: 20, buckets: [0, 0, 1] },
				],
				[1, 5, "infinity"],
			),
		).toEqual({
			n: 3,
			sumMs: 23,
			maxMs: 20,
			buckets: [1, 1, 1],
			upperBoundsMs: [1, 5, "infinity"],
			p50UpperBoundMs: 5,
			p95UpperBoundMs: "infinity",
			estimator: "fixed-bucket-upper-bound",
		});
		expect(summarizeReadFanoutHistogram([], [1, "infinity"]).p50UpperBoundMs).toBeNull();
		expect(() =>
			summarizeReadFanoutHistogram(
				[{ count: 2, sumMs: 3, maxMs: 2, buckets: [1, 0] }],
				[1, "infinity"],
			),
		).toThrow("histogram schema");
	});

	test("template repeats keep logical, pool and dispatch counts separate", () => {
		const counts = (logicalReads: number, poolEntries: number, dispatched: number) =>
			({
				logicalReads,
				poolEntries,
				dispatched,
			}) as ReadFanoutReport["templates"][number]["counts"];
		expect(
			readFanoutTemplateRepeats({
				templates: [
					{ fingerprint: "a".repeat(64), counts: counts(3, 4, 2) },
					{ fingerprint: "b".repeat(64), counts: counts(1, 0, 0) },
					{ fingerprint: "overflow", counts: counts(100, 100, 100) },
					{ fingerprint: "oversized_sql", counts: counts(100, 100, 100) },
				],
			}),
		).toEqual({
			exactGroups: 2,
			excludedGroups: 2,
			logicalReadRepeats: 2,
			poolEntryRepeats: 3,
			dispatchedRepeats: 1,
		});
	});

	test("privacy guard rejects known fixture secrets before writing", () => {
		expect(() =>
			assertReadFanoutPrivacy({ server: { source: "credential-token" } }, ["credential-token"]),
		).toThrow("privacy guard");
		expect(assertReadFanoutPrivacy({ category: "narrators.detail" }, ["credential-token"])).toBe(
			'{"category":"narrators.detail"}',
		);
	});

	test("independent JSON evidence is mode 600, including replacing a prior file", () => {
		const dir = mkdtempSync(join(tmpdir(), "read-fanout-script-test-"));
		const path = join(dir, "read-fanout.json");
		try {
			writeFileSync(path, "{}", { mode: 0o644 });
			writeReadFanoutEvidence(path, { schemaVersion: 1, count: 2 }, ["credential-token"]);
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ schemaVersion: 1, count: 2 });
			expect(() =>
				writeReadFanoutEvidence(path, { token: "credential-token" }, ["credential-token"]),
			).toThrow("privacy guard");
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ schemaVersion: 1, count: 2 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("shared harness rejects invalid watchdog values before environment/process setup", async () => {
		for (const watchdogMs of [0, -1, 1.5, Number.POSITIVE_INFINITY, 600_001])
			await expect(createSmokeRuntime({ watchdogMs })).rejects.toThrow("watchdogMs");
	});
});
