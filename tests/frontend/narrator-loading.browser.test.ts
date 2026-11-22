import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FanoutCounter,
	type FanoutRound,
	fanoutCoverageComplete,
	fanoutHttpCategory,
	fanoutWsType,
	historyRequestCounts,
	phaseSuccess,
	redactEvidence,
	requestKind,
	SERVER_READ_METRICS,
	stableViewport,
	summarize,
	summarizeFanout,
	writePrivateEvidence,
} from "../../scripts/smoke-narrator-loading";

// CI guards run unconditionally. The real full-app browser script is separately executable
// with NF_TEST_CHROMIUM_PATH; a missing browser/build is a hard failure there, never a pass.
describe("full-app narrator loading browser evidence", () => {
	test("nearest-rank p50/p95 are computed from actual finite samples without mutation", () => {
		const samples = [10, 2, 9, 3, 8, 4, 7, 5, 6, 1];
		expect(summarize(samples)).toEqual({ n: 10, p50Ms: 5, p95Ms: 10 });
		expect(samples[0]).toBe(10);
		for (const bad of [[], [-1], [Number.NaN], [Number.POSITIVE_INFINITY]]) {
			expect(() => summarize(bad)).toThrow("Invalid timing sample");
		}
	});
	test("tail requests are distinguished from cursor pages and unrelated requests", () => {
		expect(requestKind("http://127.0.0.1:123/api/narrators/a/pretext-document?limit=20")).toEqual({
			kind: "tail",
			narratorId: "a",
		});
		expect(
			requestKind("http://127.0.0.1:123/api/narrators/a/pretext-document?beforeSeq=20"),
		).toEqual({ kind: "page", narratorId: "a" });
		expect(
			requestKind("http://127.0.0.1:123/api/narrators/a/pretext-document?afterSeq=0&limit=100"),
		).toEqual({ kind: "window", narratorId: "a" });
		expect(
			requestKind("http://127.0.0.1:123/api/narrators/a/message-location/fixture_message"),
		).toEqual({ kind: "locate", narratorId: "a" });
		expect(requestKind("http://127.0.0.1:123/api/narrators/b/git/summary")).toEqual({
			kind: "summary",
			narratorId: "b",
		});
		expect(requestKind("http://127.0.0.1:123/api/narrators/a")).toEqual({
			kind: "detail",
			narratorId: "a",
		});
		expect(requestKind("http://127.0.0.1:123/api/narrators")).toBeNull();
	});
	test("zero warm tails does not hide canonical window/locate requests across phase boundaries", () => {
		const records = [
			{ kind: "tail", narratorId: "A", atMs: 0 },
			{ kind: "window", narratorId: "A", atMs: 1 },
			{ kind: "locate", narratorId: "A", atMs: 2 },
			{ kind: "page", narratorId: "A", atMs: 3 },
			{ kind: "tail", narratorId: "B", atMs: 4 },
			{ kind: "tail", narratorId: "A", atMs: 5 },
		];
		expect(historyRequestCounts(records, "A", 1, 5)).toEqual({
			tail: 0,
			window: 1,
			olderPage: 1,
			locate: 1,
		});
		expect(historyRequestCounts(records, "A", 1)).toEqual({
			tail: 1,
			window: 1,
			olderPage: 1,
			locate: 1,
		});
	});
	test("phase success requires 2xx, finished non-failed requests and two current visible frames", () => {
		const frames = [
			{ target: "A", sentinels: ["user", "reply"] },
			{ target: "A", sentinels: ["user", "reply"] },
		];
		for (const kind of ["detail", "tail", "window", "page", "locate"]) {
			const request = { kind, narratorId: "A", atMs: 1, endMs: 2, statusCode: 200 };
			for (const statusCode of [200, 201, 204, 299])
				expect(
					phaseSuccess([{ ...request, statusCode }], "A", 0, ["user", "reply"], frames).ok,
				).toBe(true);
			for (const override of [
				{ statusCode: 403 },
				{ statusCode: 500 },
				{ statusCode: 503 },
				{ statusCode: 304 },
				{ statusCode: undefined },
				{ failed: true },
				{ endMs: undefined },
			])
				expect(
					phaseSuccess([{ ...request, ...override }], "A", 0, ["user", "reply"], frames).ok,
				).toBe(false);
		}
		const successful = [{ kind: "window", narratorId: "A", atMs: 3, endMs: 4, statusCode: 200 }];
		// A historic cache paint cannot certify the current cleared, hidden or wrong-route DOM.
		for (const current of [
			[],
			frames.slice(0, 1),
			[frames[0], { target: "A", sentinels: [] }],
			[frames[0], { target: "B", sentinels: ["user", "reply"] }],
			[frames[0], { target: "A", sentinels: ["user", "reply", "reply"] }],
		])
			expect(phaseSuccess(successful, "A", 0, ["user", "reply"], current).ok).toBe(false);
		expect(phaseSuccess(successful, "A", 0, ["user", "reply"], frames).ok).toBe(true);
		expect(phaseSuccess([], "A", 0, ["user", "reply"], frames).ok).toBe(false);
		// An older/other-narrator failure is not attributed to the newly bounded phase.
		expect(
			phaseSuccess(
				[
					{ kind: "window", narratorId: "A", atMs: 1, failed: true },
					{ kind: "window", narratorId: "B", atMs: 2, failed: true },
					...successful,
				],
				"A",
				1,
				["user", "reply"],
				frames,
			).ok,
		).toBe(true);
	});
	test("a 30px Git-strip shift cannot be counted as stable message geometry", () => {
		const before = { top: 100, height: 500, width: 390 };
		expect(stableViewport(before, { ...before })).toBe(true);
		expect(stableViewport(before, { ...before, top: 130, height: 470 })).toBe(false);
		expect(stableViewport(before, { ...before, top: 100.4, height: 499.8 })).toBe(true);
	});
	test("harness owns isolated HOME, child cleanup and output/time budgets", () => {
		const harness = readFileSync(
			new URL("../../scripts/smoke-plugin-ui.ts", import.meta.url),
			"utf8",
		);
		expect(harness).toContain("NARRAFORK_HOME: home");
		expect(harness).toContain('"--no-auto-resume"');
		expect(harness).toContain('server.kill("SIGTERM")');
		expect(harness).toContain("MAX_SERVER_LOG_BYTES");
		expect(harness).toContain("WATCHDOG_MS");
		const script = readFileSync(
			new URL("../../scripts/smoke-narrator-loading.ts", import.meta.url),
			"utf8",
		);
		expect(script).toContain("MAX_OUTPUT_BYTES");
		expect(script).toContain("AbortSignal.timeout");
		expect(script).toContain("Refusing non-owned fixture database");
		expect(script).toContain("Refused provider-triggering request");
		expect(script).toContain("range.getClientRects()");
		expect(script).toContain("probe.candidateFrames >= 2");
		expect(script).toContain("iterations < 10");
		expect(script).toContain('"window-403", "window-network", "locate-403", "locate-network"');
		expect(script).toContain("diagnostic || faultMode ? 1 : iterations");
		expect(script).toContain("Diagnostic-only functional round; no performance sample");
		expect(script).toContain("Fault mode did not reject the hot phase");
		expect(script).toContain("settledVisibleFrames(page)");
		expect(script).toContain("network.armFault(ids.A)");
		expect(script).toContain("paintBeforeFailure");
		expect(script).toContain("-failed.png");
		expect(script).not.toContain("bun run start:dev");
	});
});

describe("--read-fanout browser-observed evidence", () => {
	test("HTTP and WS frames reduce to fixed labels without IDs, queries or payloads", () => {
		const base = "http://127.0.0.1:9/api";
		expect(fanoutHttpCategory(`${base}/narrators/secret-id/pretext-document?afterSeq=4`)).toBe(
			"narrators.window",
		);
		expect(fanoutHttpCategory(`${base}/narrators/secret-id/message-location/77`)).toBe(
			"narrators.locate",
		);
		expect(fanoutHttpCategory(`${base}/narrators`)).toBe("narrators");
		expect(fanoutHttpCategory(`${base}/Weird_Group/x`)).toBe("unknown");
		expect(fanoutHttpCategory("http://127.0.0.1:9/assets/app.js")).toBeNull();
		expect(fanoutHttpCategory("not a url")).toBeNull();
		expect(fanoutWsType('{"type":"subscribe","kind":"panel","id":"secret-id"}')).toBe(
			"subscribe:panel",
		);
		expect(fanoutWsType('{"type":"subscribe","kind":"secret-id"}')).toBe("subscribe:unknown");
		expect(fanoutWsType('{"type":"secret-id/../x"}')).toBe("unknown");
		expect(fanoutWsType("{")).toBe("invalid-json");
		expect(fanoutWsType("AAEC", 2)).toBe("non-text");
		expect(fanoutWsType(JSON.stringify({ type: "x".repeat(70_000) }))).toBe("oversized");
	});

	test("counter attributes completions to the finishing window and keeps a bounded histogram", () => {
		let now = 0;
		const counter = new FanoutCounter(() => now);
		const carried = {};
		counter.begin("cold");
		counter.request(carried, "http://h/api/narrators/n1/pretext-document", "GET");
		counter.request({}, "http://h/static/app.js", "GET");
		now = 40;
		counter.end(35);
		counter.begin("A_to_B");
		counter.wsSent('{"type":"subscribe","kind":"messages"}');
		counter.wsReceived("12345");
		counter.response(carried, 200);
		now = 700;
		counter.finish(carried);
		counter.end(650);
		const [, cold, , switchB] = counter.windows;
		expect(cold?.http).toMatchObject({ started: 1, completed: 0, inflightAtEnd: 1 });
		expect(cold?.firstVisibleMs).toBe(35);
		expect(switchB?.http).toMatchObject({
			started: 0,
			completed: 1,
			inflightAtStart: 1,
			inflightAtEnd: 0,
			statuses: { "2xx": 1 },
		});
		expect(switchB?.http.durationMs).toMatchObject({ count: 1, maxMs: 700 });
		expect(switchB?.http.durationMs.buckets[7]).toBe(1);
		expect(switchB?.ws).toEqual({
			sent: { "subscribe:messages": 1 },
			received: 1,
			receivedBytes: 5,
		});
		expect(JSON.stringify(counter.windows)).not.toContain("n1");
		for (let i = 0; i < 11; i++) counter.begin("between");
		expect(() => counter.begin("idle")).toThrow("Fanout window budget exceeded");
	});

	test("summary and coverage use only measured rounds with complete phase windows", () => {
		const window = (label: "cold" | "A_to_B" | "B_to_A", firstVisibleMs?: number) => {
			const counter = new FanoutCounter(() => 0);
			const opened = counter.begin(label);
			counter.request({}, "http://h/api/narrators/n/pretext-document", "GET");
			counter.end(firstVisibleMs);
			return opened;
		};
		const round = (kind: FanoutRound["kind"], visible?: number): FanoutRound => ({
			viewport: "desktop",
			iteration: 1,
			kind,
			windows: [window("cold", 10), window("A_to_B", 20), window("B_to_A", visible)],
		});
		const rounds = [round("functional", 1), round("measured", 5), round("measured", 7)];
		expect(fanoutCoverageComplete(rounds, 2)).toBe(true);
		expect(fanoutCoverageComplete(rounds, 3)).toBe(false);
		expect(fanoutCoverageComplete([...rounds, round("measured")], 3)).toBe(false);
		const hot = summarizeFanout(rounds).find((row) => row.phase === "B_to_A");
		expect(hot).toMatchObject({
			viewport: "desktop",
			windows: 2,
			firstVisibleMs: { n: 2, p50: 5, p95: 7, max: 7 },
			requestsByCategory: { "GET narrators.tail": 2 },
		});
	});

	test("server read metrics are declared unavailable, never fabricated", () => {
		expect(SERVER_READ_METRICS.status).toBe("unavailable");
		expect(SERVER_READ_METRICS.blockedOn).toContain("/api/admin/diagnostics/read-fanout");
		const script = readFileSync(
			new URL("../../scripts/smoke-narrator-loading.ts", import.meta.url),
			"utf8",
		);
		expect(script).not.toMatch(/read-fanout\/(start|stop)/);
		expect(script).toContain("--read-fanout");
		expect(script).toContain("Network.webSocketFrameSent");
		expect(script).toContain('"contenteditable"');
		expect(script).toContain("probe.failure");
	});

	test("evidence writer fails closed on fixture secrets and writes mode 0600", () => {
		const dir = mkdtempSync(join(tmpdir(), "nf-fanout-evidence-"));
		try {
			const path = join(dir, "fanout.json");
			expect(() => writePrivateEvidence(path, { leaked: "x/token-123/y" }, ["token-123"])).toThrow(
				"privacy guard",
			);
			writePrivateEvidence(path, { ok: 1 }, ["token-123", ""]);
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(
				redactEvidence('{"id":"n-1","home":"/h/x/n-1"}', [
					["/h/x", "<home>"],
					["n-1", "<narrator-A>"],
				]),
			).toBe('{"id":"<narrator-A>","home":"<home>/<narrator-A>"}');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
