import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Protocol } from "devtools-protocol";
import { PROFILE_LIMITS } from "../memory-profile-constants";
import { downloadProfileTrace, removeProfileFiles, writeProfileJson } from "../memory-profile-io";
import type { MemoryProfileRequest, MemoryProfileWorkerReply } from "../memory-profile-types";
import {
	boundProfileSummary,
	MemoryProfileRecorder,
	PROFILE_SESSION_DISCONNECTED,
	type ProfileSession,
} from "../memory-profile-worker";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const profile: Protocol.HeapProfiler.SamplingHeapProfile = {
	head: {
		id: 1,
		selfSize: 16384,
		callFrame: {
			functionName: "churn",
			scriptId: "1",
			url: "fixture.js",
			lineNumber: 0,
			columnNumber: 0,
		},
		children: [],
	},
	samples: [{ size: 16384, nodeId: 1, ordinal: 1 }],
};
class FakeSession extends EventEmitter implements ProfileSession {
	calls: Array<{ method: string; params?: Record<string, unknown>; timeout?: number }> = [];
	fail = new Set<string>();
	errors = new Map<string, Error>();
	traceConfirmed = true;
	browserVersion = "Chrome/146.0.7680.31";
	categories = ["devtools.timeline", "v8", "disabled-by-default-v8.gc", "blink.user_timing"];
	categoryResult?: unknown;
	traceLoss = false;
	malformedProfile = false;
	heapDelay = 0;
	detached = false;
	private markers: string[] = [];
	private rawSent = false;

	async send(
		method: string,
		params?: Record<string, unknown>,
		options?: { timeout: number },
	): Promise<unknown> {
		this.calls.push({ method, params, timeout: options?.timeout });
		const error = this.errors.get(method);
		if (error) throw error;
		if (this.fail.has(method))
			throw new Error("private ws://canary/page-content must never escape");
		switch (method) {
			case "Page.getFrameTree":
				return { frameTree: { frame: { id: "root-frame", loaderId: "initial-document" } } };
			case "Browser.getVersion":
				return { product: this.browserVersion };
			case "Tracing.getCategories":
				return this.categoryResult ?? { categories: this.categories };
			case "Runtime.evaluate": {
				const marker = (params?.expression as string).match(/performance\.mark\(("[^"]+")\)/);
				if (marker) this.markers.push(JSON.parse(marker[1]));
				return {};
			}
			case "HeapProfiler.stopSampling":
				return { profile: this.malformedProfile ? {} : profile };
			case "Tracing.end": {
				if (this.traceConfirmed)
					this.emit("Tracing.tracingComplete", {
						stream: "private-stream",
						dataLossOccurred: this.traceLoss,
					});
				return {};
			}
			case "IO.read": {
				if (this.rawSent) return { data: "", eof: true };
				this.rawSent = true;
				return {
					data: JSON.stringify({
						traceEvents: [
							{ name: "thread_name", ph: "M", pid: 42, tid: 7, args: { name: "CrRendererMain" } },
							{ name: this.markers[0], ph: "I", pid: 42, tid: 7, ts: 1000 },
							{
								name: "MinorGC",
								ph: "X",
								pid: 42,
								tid: 7,
								ts: 1200,
								dur: 50,
								args: { data: { usedHeapSizeBefore: 100, usedHeapSizeAfter: 20 } },
							},
							{ name: this.markers[1], ph: "I", pid: 42, tid: 7, ts: 2000 },
							{
								name: "secret-other-target",
								ph: "X",
								pid: 90,
								tid: 7,
								ts: 1200,
								dur: 80,
								args: { url: "private-other-page" },
							},
						],
					}),
					eof: true,
				};
			}
			case "Runtime.getHeapUsage": {
				await Bun.sleep(this.heapDelay);
				return { usedSize: 100, totalSize: 200 };
			}
			default:
				return {};
		}
	}
	async detach(): Promise<void> {
		this.detached = true;
	}
	count(method: string): number {
		return this.calls.filter((call) => call.method === method).length;
	}
}
async function fixture(mode: MemoryProfileRequest["config"]["mode"] = "both") {
	const dir = await mkdtemp(join(tmpdir(), "nf-profile-worker-"));
	directories.push(dir);
	const request: MemoryProfileRequest = {
		profileId: "profile-exact-id",
		wsEndpoint: "ws://private-canary",
		targetId: "exact-target-not-url",
		dir,
		maxArtifactsBytes: PROFILE_LIMITS.artifactBytes,
		config: {
			mode,
			durationMs: 1000,
			samplingIntervalBytes: PROFILE_LIMITS.defaultSamplingIntervalBytes,
		},
	};
	const session = new FakeSession();
	const replies: MemoryProfileWorkerReply[] = [];
	let disconnected = false;
	let recording: () => void = () => {};
	const recorded = new Promise<void>((resolve) => {
		recording = resolve;
	});
	let connectedRequest: MemoryProfileRequest | undefined;
	const recorder = new MemoryProfileRecorder(
		(reply) => {
			replies.push(reply);
			if (reply.kind === "recording") recording();
		},
		{
			connect: async (opts) => {
				connectedRequest = opts;
				return {
					session,
					disconnect: async () => {
						disconnected = true;
					},
				};
			},
		},
	);
	return {
		dir,
		request,
		session,
		replies,
		recorder,
		recorded,
		disconnected: () => disconnected,
		connectedRequest: () => connectedRequest,
	};
}
function result(replies: MemoryProfileWorkerReply[]) {
	const reply = replies.find((reply) => reply.kind === "result");
	if (!reply || reply.kind !== "result") throw new Error("Expected bounded profile result");
	return reply;
}

describe("isolated memory profile recorder", () => {
	for (const missing of [
		"devtools.timeline",
		"v8",
		"disabled-by-default-v8.gc",
		"blink.user_timing",
	] as const) {
		test(`missing category ${missing} is advisory when original trace request provides full GC evidence`, async () => {
			const f = await fixture();
			f.session.categories = f.session.categories.filter((category) => category !== missing);
			const task = f.recorder.command({ kind: "start", request: f.request });
			f.recorder.command({ kind: "stop", profileId: f.request.profileId });
			await task;
			const completed = result(f.replies);
			expect(f.replies.map((reply) => reply.kind)).toEqual(["recording", "finalizing", "result"]);
			expect(completed.traceStopped).toBe(true);
			expect(completed.summary.gc).toMatchObject({
				status: "ok",
				scope: { threadName: "CrRendererMain" },
				minorCount: 1,
				majorCount: 0,
				topEvents: [
					{ name: "MinorGC", durationMs: 0.05, heapBeforeBytes: 100, heapAfterBytes: 20 },
				],
			});
			expect(completed.summary.allocation?.status).toBe("ok");
			expect(f.session.calls.find((call) => call.method === "Tracing.start")?.params).toMatchObject(
				{
					traceConfig: {
						includedCategories: [
							"devtools.timeline",
							"v8",
							"disabled-by-default-v8.gc",
							"blink.user_timing",
						],
					},
				},
			);
			expect(f.session.count("Tracing.start")).toBe(1);
			expect(f.session.count("Tracing.end")).toBe(1);
			expect(f.session.count("HeapProfiler.startSampling")).toBe(1);
			expect(f.session.detached).toBe(true);
			expect(f.disconnected()).toBe(true);
		});
	}

	for (const enumeration of ["empty", "malformed", "unavailable"] as const) {
		test(`${enumeration} category enumeration still requires actual protocol and complete parsed evidence`, async () => {
			const f = await fixture();
			if (enumeration === "empty") f.session.categories = [];
			if (enumeration === "malformed")
				f.session.categoryResult = { categories: { token: "PRIVATE-CANARY" } };
			if (enumeration === "unavailable")
				f.session.errors.set("Tracing.getCategories", new Error("ws://PRIVATE-CANARY"));
			const task = f.recorder.command({ kind: "start", request: f.request });
			f.recorder.command({ kind: "stop", profileId: f.request.profileId });
			await task;
			const completed = result(f.replies);
			expect(completed.traceStopped).toBe(true);
			expect(completed.summary.gc).toMatchObject({
				status: "ok",
				scope: { threadName: "CrRendererMain" },
				minorCount: 1,
				topEvents: [
					{ name: "MinorGC", durationMs: 0.05, heapBeforeBytes: 100, heapAfterBytes: 20 },
				],
			});
			expect(completed.summary.allocation?.status).toBe("ok");
			expect(f.session.calls.find((call) => call.method === "Tracing.start")?.params).toMatchObject(
				{
					traceConfig: {
						includedCategories: [
							"devtools.timeline",
							"v8",
							"disabled-by-default-v8.gc",
							"blink.user_timing",
						],
					},
				},
			);
			expect(JSON.stringify(f.replies)).not.toContain("PRIVATE-CANARY");
		});
		test(`${enumeration} category enumeration never hides a real trace protocol rejection`, async () => {
			const f = await fixture();
			if (enumeration === "empty") f.session.categories = [];
			if (enumeration === "malformed")
				f.session.categoryResult = { categories: { token: "PRIVATE-CANARY" } };
			if (enumeration === "unavailable")
				f.session.errors.set("Tracing.getCategories", new Error("ws://PRIVATE-CANARY"));
			f.session.errors.set(
				"Tracing.start",
				new Error("Protocol error (Tracing.start): Method not found"),
			);
			await f.recorder.command({ kind: "start", request: f.request });
			expect(f.replies).toEqual([
				{
					kind: "failed",
					profileId: f.request.profileId,
					stage: "trace_capability",
					traceStopped: true,
					diagnostic: {
						diagnosticStage: "trace_capability",
						browserVersion: "Chrome/146.0.7680.31",
						missingCategories:
							enumeration === "empty"
								? ["devtools.timeline", "v8", "disabled-by-default-v8.gc", "blink.user_timing"]
								: [],
					},
				},
			]);
			expect(f.session.count("Tracing.start")).toBe(1);
			expect(f.session.count("Tracing.end")).toBe(0);
			expect(f.session.count("HeapProfiler.startSampling")).toBe(0);
			expect(await readdir(f.dir)).toEqual([]);
			expect(JSON.stringify(f.replies)).not.toContain("PRIVATE-CANARY");
		});
	}

	test("capability diagnostics list every missing category and reject private browser text", async () => {
		const f = await fixture();
		f.session.categories = ["devtools.timeline", "ws://CATEGORY-PRIVATE-CANARY"];
		f.session.browserVersion = `Chrome/154.0.8037.97 token=${"PRIVATE-CANARY".repeat(100)}`;
		f.session.errors.set(
			"Tracing.start",
			new Error("Protocol error (Tracing.start): Method not found"),
		);
		await f.recorder.command({ kind: "start", request: f.request });
		expect(f.replies).toEqual([
			{
				kind: "failed",
				profileId: f.request.profileId,
				stage: "trace_capability",
				traceStopped: true,
				diagnostic: {
					diagnosticStage: "trace_capability",
					browserVersion: "unavailable",
					missingCategories: ["v8", "disabled-by-default-v8.gc", "blink.user_timing"],
				},
			},
		]);
		expect(JSON.stringify(f.replies)).not.toContain("PRIVATE-CANARY");
		expect(Buffer.byteLength(JSON.stringify(f.replies))).toBeLessThan(512);
	});

	test("exact-target start ACK, manual stop, markers, private raw deletion and valid 0600 artifacts", async () => {
		const f = await fixture();
		const task = f.recorder.command({ kind: "start", request: f.request });
		await f.recorded;
		expect(f.connectedRequest()?.targetId).toBe("exact-target-not-url");
		f.recorder.command({ kind: "stop", profileId: f.request.profileId });
		await task;
		const completed = result(f.replies);
		expect(f.replies.map((reply) => reply.kind)).toEqual(["recording", "finalizing", "result"]);
		expect(completed.traceStopped).toBe(true);
		expect(completed.summary.status).toBe("complete");
		expect(completed.summary.gc?.minorCount).toBe(1);
		expect(completed.summary.allocation?.hotspots[0].functionName).toBe("churn");
		expect(completed.summary.stopReason).toBe("manual");
		expect(completed.artifacts.map((artifact) => artifact.filename)).toEqual([
			"allocation.heapprofile",
			"gc.trace.json",
			"summary.json",
		]);
		for (const artifact of completed.artifacts) {
			const path = join(f.dir, artifact.filename);
			expect((await stat(path)).size).toBe(artifact.size);
			if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
			JSON.parse(await readFile(path, "utf8"));
		}
		expect(await readdir(f.dir)).not.toContain("raw.trace.json");
		expect(await readFile(join(f.dir, "gc.trace.json"), "utf8")).not.toContain(
			"private-other-page",
		);
		expect(
			f.session.calls.find((call) => call.method === "HeapProfiler.startSampling")?.params,
		).toEqual({
			samplingInterval: PROFILE_LIMITS.defaultSamplingIntervalBytes,
			stackDepth: PROFILE_LIMITS.stackDepth,
			includeObjectsCollectedByMinorGC: true,
			includeObjectsCollectedByMajorGC: true,
		});
		expect(f.session.calls.find((call) => call.method === "Tracing.start")?.params).toMatchObject({
			transferMode: "ReturnAsStream",
			streamFormat: "json",
			streamCompression: "none",
			bufferUsageReportingInterval: PROFILE_LIMITS.traceBufferUsageIntervalMs,
			traceConfig: {
				recordMode: "recordUntilFull",
				traceBufferSizeInKb: PROFILE_LIMITS.traceBufferKb,
			},
		});
		expect(
			f.session.calls
				.filter((call) => call.method === "Runtime.evaluate")
				.every((call) => String(call.params?.expression).includes("performance.clearMarks")),
		).toBe(true);
		expect(f.session.count("HeapProfiler.collectGarbage")).toBe(0);
		expect(f.session.count("HeapProfiler.takeHeapSnapshot")).toBe(0);
		expect(f.disconnected()).toBe(true);
		expect(f.session.detached).toBe(true);
		expect(JSON.stringify(f.replies)).not.toContain("private-canary");
	});

	test("duration auto-stop and stale IDs/idempotent stop cannot stop another recording", async () => {
		const f = await fixture("allocation");
		const task = f.recorder.command({ kind: "start", request: f.request });
		await f.recorded;
		f.recorder.command({ kind: "stop", profileId: "stale-id" });
		f.recorder.command({ kind: "cancel", profileId: "stale-id" });
		await task;
		expect(result(f.replies).summary.stopReason).toBe("duration_limit");
		expect(result(f.replies).traceStopped).toBe(true);
		f.recorder.command({ kind: "stop", profileId: f.request.profileId });
		expect(f.session.count("HeapProfiler.stopSampling")).toBe(1);
		expect(f.session.count("Tracing.start")).toBe(0);
	});

	test("90% trace buffer triggers bounded automatic finalization", async () => {
		const f = await fixture();
		const task = f.recorder.command({ kind: "start", request: f.request });
		await f.recorded;
		f.session.emit("Tracing.bufferUsage", { percentFull: PROFILE_LIMITS.traceBufferStopRatio });
		await task;
		expect(result(f.replies).summary.stopReason).toBe("buffer_limit");
		expect(result(f.replies).summary.gc?.status).toBe("incomplete");
		expect(result(f.replies).summary.status).toBe("partial");
	});

	test("partial collector startup rolls back only our successfully started trace", async () => {
		const f = await fixture();
		f.session.fail.add("HeapProfiler.startSampling");
		await f.recorder.command({ kind: "start", request: f.request });
		expect(f.replies).toEqual([
			{ kind: "failed", profileId: f.request.profileId, stage: "start", traceStopped: true },
		]);
		expect(f.session.count("Tracing.end")).toBe(1);
		expect(f.session.count("HeapProfiler.stopSampling")).toBe(1);
		expect(await readdir(f.dir)).toEqual([]);
		expect(f.disconnected()).toBe(true);
	});

	test("cancel during connect disconnects a late connection and never publishes recording", async () => {
		const f = await fixture();
		let release: () => void = () => {};
		const connectionGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached: () => void = () => {};
		const connecting = new Promise<void>((resolve) => {
			reached = resolve;
		});
		let disconnected = false;
		const recorder = new MemoryProfileRecorder((reply) => f.replies.push(reply), {
			connect: async () => {
				reached();
				await connectionGate;
				return {
					session: f.session,
					disconnect: async () => {
						disconnected = true;
					},
				};
			},
		});
		const task = recorder.command({ kind: "start", request: f.request });
		await connecting;
		recorder.command({ kind: "cancel", profileId: f.request.profileId });
		await task;
		release();
		await Bun.sleep(10);
		expect(f.replies).toEqual([
			{ kind: "cancelled", profileId: f.request.profileId, stage: "cancelled", traceStopped: true },
		]);
		expect(disconnected).toBe(true);
		expect(f.session.calls).toEqual([]);
		expect(await readdir(f.dir)).toEqual([]);
	});

	for (const message of [
		"Protocol error (Tracing.start): Tracing has already been started",
		"Protocol error (Tracing.start): Tracing is already recording",
		"Protocol error (Tracing.start): Starting trace recording is already in progress",
		"Protocol error (Tracing.start): Invalid parameters",
		"Protocol error (Tracing.start): Method not found",
	]) {
		test(`definite Tracing.start rejection releases only our unstarted lease: ${message}`, async () => {
			const f = await fixture();
			f.session.errors.set("Tracing.start", new Error(message));
			await f.recorder.command({ kind: "start", request: f.request });
			expect(f.replies).toEqual([
				{
					kind: "failed",
					profileId: f.request.profileId,
					stage: "trace_capability",
					traceStopped: true,
					diagnostic: {
						diagnosticStage: "trace_capability",
						browserVersion: "Chrome/146.0.7680.31",
						missingCategories: [],
					},
				},
			]);
			expect(f.session.count("Tracing.start")).toBe(1);
			expect(f.session.count("Tracing.end")).toBe(0);
			expect(f.session.count("HeapProfiler.startSampling")).toBe(0);
			expect(await readdir(f.dir)).toEqual([]);
			expect(f.disconnected()).toBe(true);
			expect(JSON.stringify(f.replies)).not.toContain(message);
		});
	}

	for (const message of [
		"Protocol error (Tracing.start): Tracing.start timed out",
		"Protocol error (Tracing.start): Target closed",
		"Protocol error (Tracing.start): Connection closed",
	]) {
		test(`unknown Tracing.start outcome retains uncertainty: ${message}`, async () => {
			const f = await fixture();
			f.session.errors.set("Tracing.start", new Error(message));
			await f.recorder.command({ kind: "start", request: f.request });
			expect(f.replies).toEqual([
				{
					kind: "failed",
					profileId: f.request.profileId,
					stage: "trace_capability",
					traceStopped: false,
					diagnostic: {
						diagnosticStage: "trace_capability",
						browserVersion: "Chrome/146.0.7680.31",
						missingCategories: [],
					},
				},
			]);
			expect(f.session.count("Tracing.start")).toBe(1);
			expect(f.session.count("Tracing.end")).toBe(0);
			expect(await readdir(f.dir)).toEqual([]);
			expect(f.disconnected()).toBe(true);
			expect(JSON.stringify(f.replies)).not.toContain(message);
		});
	}

	test("unconfirmed trace start outcome is uncertain and must NEVER send Tracing.end", async () => {
		const f = await fixture();
		f.session.fail.add("Tracing.start");
		await f.recorder.command({ kind: "start", request: f.request });
		expect(f.replies.at(-1)).toMatchObject({ kind: "failed", traceStopped: false });
		expect(f.session.count("Tracing.end")).toBe(0);
		expect(JSON.stringify(f.replies)).not.toContain("private");
		expect(await readdir(f.dir)).toEqual([]);
	});

	test("failed end cannot claim stop confirmation; allocation survives as partial", async () => {
		const f = await fixture();
		f.session.fail.add("Tracing.end");
		const task = f.recorder.command({ kind: "start", request: f.request });
		await f.recorded;
		f.recorder.command({ kind: "stop", profileId: f.request.profileId });
		await task;
		const completed = result(f.replies);
		expect(completed.traceStopped).toBe(false);
		expect(completed.summary.status).toBe("partial");
		expect(completed.summary.gc?.status).toBe("failed");
		expect(completed.summary.allocation?.status).toBe("ok");
		expect(completed.artifacts.map((artifact) => artifact.kind)).toEqual(["allocation", "summary"]);
		expect(f.session.count("Tracing.end")).toBe(1);
	}, 8000);

	test("invalid allocation does not masquerade as zero allocations; GC remains valid", async () => {
		const f = await fixture();
		f.session.malformedProfile = true;
		const task = f.recorder.command({ kind: "start", request: f.request });
		await f.recorded;
		f.recorder.command({ kind: "stop", profileId: f.request.profileId });
		await task;
		const completed = result(f.replies);
		expect(completed.summary.allocation?.status).toBe("failed");
		expect(completed.summary.allocation?.estimatedSelfBytes).toBeNull();
		expect(completed.summary.gc?.status).toBe("ok");
		expect(completed.artifacts.map((artifact) => artifact.kind)).toEqual(["gc", "summary"]);
	});

	for (const event of ["manual", "document", "disconnected"] as const) {
		test(`${event} cancellation discards all files and emits only a generic stage`, async () => {
			const f = await fixture();
			const task = f.recorder.command({ kind: "start", request: f.request });
			await f.recorded;
			if (event === "manual")
				f.recorder.command({ kind: "cancel", profileId: f.request.profileId });
			if (event === "document")
				f.session.emit("Page.frameNavigated", {
					frame: { id: "root-frame", loaderId: "new-document" },
				});
			if (event === "disconnected") f.session.emit(PROFILE_SESSION_DISCONNECTED);
			await task;
			expect(f.replies.at(-1)).toMatchObject({ kind: "cancelled", traceStopped: true });
			expect(Object.keys(f.replies.at(-1) ?? {}).sort()).toEqual([
				"kind",
				"profileId",
				"stage",
				"traceStopped",
			]);
			expect(await readdir(f.dir)).toEqual([]);
			expect(f.disconnected()).toBe(true);
		});
	}

	test("SPA navigation and iframe documents are permitted, without target rebinding", async () => {
		const f = await fixture();
		const task = f.recorder.command({ kind: "start", request: f.request });
		await f.recorded;
		f.session.emit("Page.navigatedWithinDocument", { frameId: "root-frame", url: "private-route" });
		f.session.emit("Page.frameNavigated", {
			frame: { id: "child-frame", parentId: "root-frame", loaderId: "new-child" },
		});
		f.recorder.command({ kind: "stop", profileId: f.request.profileId });
		await task;
		expect(result(f.replies).summary.warnings.join(" ")).toContain("Same-document");
		expect(JSON.stringify(f.replies)).not.toContain("private-route");
	});

	test("heap commands have a 1s protocol timeout, never overlap, progress is <=1/s", async () => {
		const f = await fixture("allocation");
		f.request.config.durationMs = 3200;
		f.session.heapDelay = 1500;
		const task = f.recorder.command({ kind: "start", request: f.request });
		await task;
		const calls = f.session.calls.filter((call) => call.method === "Runtime.getHeapUsage");
		expect(calls.length).toBe(2);
		expect(calls.every((call) => call.timeout === PROFILE_LIMITS.heapIntervalMs)).toBe(true);
		expect(result(f.replies).summary.heapTrend.length).toBe(1);
		expect(f.replies.filter((reply) => reply.kind === "progress").length).toBe(1);
	}, 7000);

	test("hanging detach cannot delay disconnect or exceed the total 5s cleanup budget", async () => {
		const f = await fixture("allocation");
		f.session.detach = () => new Promise<void>(() => {});
		const task = f.recorder.command({ kind: "start", request: f.request });
		await f.recorded;
		const start = performance.now();
		f.recorder.command({ kind: "cancel", profileId: f.request.profileId });
		await Bun.sleep(20);
		expect(f.disconnected()).toBe(true);
		await task;
		expect(performance.now() - start).toBeLessThan(
			PROFILE_LIMITS.cleanupTimeoutMs + PROFILE_LIMITS.heapIntervalMs,
		);
		expect(f.replies.at(-1)).toMatchObject({ kind: "cancelled", traceStopped: true });
		expect(await readdir(f.dir)).toEqual([]);
	}, 8000);

	test("shared artifact budget rejects over-budget components, keeps explicit partial summary", async () => {
		const f = await fixture("allocation");
		f.request.maxArtifactsBytes = PROFILE_LIMITS.summaryBytes;
		const task = f.recorder.command({ kind: "start", request: f.request });
		await f.recorded;
		f.recorder.command({ kind: "stop", profileId: f.request.profileId });
		await task;
		const completed = result(f.replies);
		expect(completed.summary.status).toBe("partial");
		expect(completed.artifacts.map((artifact) => artifact.kind)).toEqual(["summary"]);
		expect(
			completed.artifacts.reduce((sum, artifact) => sum + artifact.size, 0),
		).toBeLessThanOrEqual(f.request.maxArtifactsBytes);
		expect(await readdir(f.dir)).toEqual(["summary.json"]);
	});

	test("summary preserves fields while bounding URLs and UTF-8 output below 32KiB", () => {
		const summary = boundProfileSummary({
			status: "partial",
			browserVersion: "Chrome/146",
			mode: "allocation",
			startedAt: "start",
			endedAt: "end",
			durationMs: 1000,
			stopReason: "manual",
			heapTrend: Array.from({ length: PROFILE_LIMITS.heapPoints }, (_, elapsedMs) => ({
				elapsedMs,
				usedBytes: 100,
				totalBytes: 200,
			})),
			warnings: ["warnings"],
			allocation: {
				status: "ok",
				warnings: [],
				flags: [],
				nodeCount: 20,
				sampleCount: 20,
				estimatedSelfBytes: 1,
				estimatedSampleBytes: 1,
				hotspots: Array.from({ length: 20 }, () => ({
					functionName: "函数".repeat(2000),
					url: "超长URL".repeat(2000),
					line: 1,
					column: 2,
					selfBytes: 1,
					inclusiveBytes: 1,
					flags: [],
				})),
			},
		});
		expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(PROFILE_LIMITS.summaryBytes);
		expect(summary.heapTrend).toHaveLength(PROFILE_LIMITS.heapPoints);
		expect(summary.allocation?.hotspots).toHaveLength(20);
		expect(summary.allocation?.hotspots[0].url).toContain("[truncated]");
	});
});

test("cancel while opening JSON file cannot leave a late private partial artifact", async () => {
	const dir = await mkdtemp(join(tmpdir(), "nf-profile-late-open-"));
	directories.push(dir);
	const controller = new AbortController();
	const writing = writeProfileJson(
		join(dir, "summary.json"),
		{ diagnostic: "private" },
		PROFILE_LIMITS.summaryBytes,
		controller.signal,
	);
	const rejected = writing.catch((error: unknown) => error);
	controller.abort();
	await removeProfileFiles(dir);
	expect(await rejected).toBeInstanceOf(Error);
	expect(await readdir(dir)).toEqual([]);
});

test("cancel during IO.read removes raw input even when read settles after outer cleanup", async () => {
	const dir = await mkdtemp(join(tmpdir(), "nf-profile-late-read-"));
	directories.push(dir);
	const controller = new AbortController();
	let reached: () => void = () => {};
	const reading = new Promise<void>((resolve) => {
		reached = resolve;
	});
	let release: () => void = () => {};
	const delay = new Promise<void>((resolve) => {
		release = resolve;
	});
	let closed = false;
	const capture = downloadProfileTrace(
		{
			read: async () => {
				reached();
				await delay;
				return { data: "private-trace", eof: true };
			},
			close: async () => {
				closed = true;
			},
		},
		"stream",
		join(dir, "raw.trace.json"),
		PROFILE_LIMITS.traceBytes,
		controller.signal,
	).catch((error: unknown) => error);
	await reading;
	controller.abort();
	await removeProfileFiles(dir);
	release();
	expect(await capture).toBeInstanceOf(Error);
	expect(closed).toBe(true);
	expect(await readdir(dir)).toEqual([]);
});

test("IO.read is source-bounded at 64KiB, sequential, 0600, and IO.close always runs on overlimit", async () => {
	const dir = await mkdtemp(join(tmpdir(), "nf-profile-io-"));
	directories.push(dir);
	let calls = 0;
	let closed = false;
	const signal = new AbortController().signal;
	await expect(
		downloadProfileTrace(
			{
				read: async (_, size) => {
					expect(size).toBe(PROFILE_LIMITS.traceReadBytes);
					calls++;
					return { data: "x".repeat(64), eof: false };
				},
				close: async () => {
					closed = true;
				},
			},
			"handle",
			join(dir, "raw.trace.json"),
			100,
			signal,
		),
	).rejects.toThrow("trace_limit");
	expect(calls).toBe(2);
	expect(closed).toBe(true);
	expect((await stat(join(dir, "raw.trace.json"))).size).toBe(64);
});
