import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { type Browser, launch } from "puppeteer-core";
import { PROFILE_LIMITS } from "../memory-profile-constants";
import type { MemoryProfileRequest, MemoryProfileWorkerReply } from "../memory-profile-types";

const cache = process.env.PUPPETEER_CACHE_DIR ?? join(homedir(), ".cache", "puppeteer");
const candidates = [
	process.env.PUPPETEER_EXECUTABLE_PATH,
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
];
if (existsSync(cache)) {
	for await (const path of new Bun.Glob("chrome/**/*{chrome,chrome.exe}").scan({
		cwd: cache,
		absolute: true,
		onlyFiles: true,
	}))
		candidates.push(path);
}
const executablePath = candidates.find((path): path is string => !!path && existsSync(path));
const chromeTest = executablePath ? test : test.skip;
if (!executablePath)
	console.warn("SKIP memory profile worker integration: owned Chrome executable unavailable");
const temp = await mkdtemp(join(tmpdir(), "nf-profile-chrome-"));
let ownedBrowser: Browser | undefined;
async function browser(): Promise<Browser> {
	if (!ownedBrowser)
		ownedBrowser = await launch({
			executablePath,
			headless: true,
			args: ["--no-sandbox", "--disable-dev-shm-usage"],
			userDataDir: join(temp, "owned-user-data"),
			timeout: 10000,
		});
	return ownedBrowser;
}
afterAll(async () => {
	// Only a browser created above may be closed: never reconnect to the application's Chrome.
	await ownedBrowser?.close();
	await rm(temp, { recursive: true, force: true });
});
function workerRecorder(request: MemoryProfileRequest) {
	const worker = new Worker(new URL("../memory-profile-worker.ts", import.meta.url));
	const replies: MemoryProfileWorkerReply[] = [];
	let started: () => void = () => {};
	let terminal: (reply: MemoryProfileWorkerReply) => void = () => {};
	let rejectStart: (error: unknown) => void = () => {};
	let rejectTerminal: (error: unknown) => void = () => {};
	const recording = new Promise<void>((resolve, reject) => {
		started = resolve;
		rejectStart = reject;
	});
	const completed = new Promise<MemoryProfileWorkerReply>((resolve, reject) => {
		terminal = resolve;
		rejectTerminal = reject;
	});
	const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
	worker.on("error", (error) => {
		rejectStart(error);
		rejectTerminal(error);
	});
	worker.on("message", (reply: MemoryProfileWorkerReply) => {
		replies.push(reply);
		if (reply.kind === "ready") worker.postMessage({ kind: "start", request });
		if (reply.kind === "recording") started();
		if (reply.kind === "result" || reply.kind === "cancelled" || reply.kind === "failed") {
			if (!replies.some((item) => item.kind === "recording"))
				rejectStart(
					new Error(`Start failed at ${reply.kind === "result" ? "result" : reply.stage}`, {
						cause: reply.kind === "failed" ? reply.diagnostic : undefined,
					}),
				);
			terminal(reply);
		}
	});
	return { worker, recording, completed, exited, replies };
}
async function request(targetId: string, dirName: string): Promise<MemoryProfileRequest> {
	const connection = await browser();
	return {
		profileId: crypto.randomUUID(),
		wsEndpoint: connection.wsEndpoint(),
		targetId,
		dir: join(temp, dirName),
		maxArtifactsBytes: PROFILE_LIMITS.artifactBytes,
		config: {
			mode: "both",
			durationMs: 7000,
			samplingIntervalBytes: PROFILE_LIMITS.minSamplingIntervalBytes,
		},
	};
}

describe("memory profile worker with exclusively owned Chrome", () => {
	chromeTest(
		"real bounded worker records natural GC and allocation stacks, page actions remain usable, port exits",
		async () => {
			const connection = await browser();
			const page = await connection.newPage();
			await page.goto("data:text/html,<title>owned-churn-fixture</title>");
			const identity = await page.createCDPSession();
			const { targetInfo } = await identity.send("Target.getTargetInfo");
			await identity.detach();
			const opts = await request(targetInfo.targetId, "recording");
			const recording = workerRecorder(opts);
			try {
				await recording.recording;
				let mainThreadTicks = 0;
				const ticker = setInterval(() => {
					mainThreadTicks++;
				}, 10);
				try {
					await page.evaluate(() => {
						const retained: number[][] = [];
						let swap: number[][] = [];
						function allocationHotspot() {
							swap = [];
							for (let i = 0; i < 32; i++) swap.push(new Array(4096).fill(Math.random()));
							if (retained.length < 128) retained.push(new Array(512).fill(1));
						}
						setInterval(allocationHotspot, 15);
					});
					await Bun.sleep(1500);
					expect(await page.title()).toBe("owned-churn-fixture");
					recording.worker.postMessage({ kind: "stop", profileId: opts.profileId });
					const reply = await recording.completed;
					expect(reply.kind).toBe("result");
					if (reply.kind !== "result") throw new Error("Expected real worker result");
					expect(reply.traceStopped).toBe(true);
					expect(reply.summary.allocation?.status).toBe("ok");
					expect(
						reply.summary.allocation?.hotspots.some(
							(hotspot) => hotspot.functionName === "allocationHotspot",
						),
					).toBe(true);
					expect(reply.summary.gc?.scope?.threadName).toBe("CrRendererMain");
					expect(reply.summary.gc?.minorCount ?? 0).toBeGreaterThan(0);
					const gc = reply.summary.gc;
					expect(Object.keys(gc ?? {}).sort()).toEqual(
						[
							"status",
							"warnings",
							"scope",
							"durationMs",
							"minorCount",
							"majorCount",
							"observedCount",
							"nestedCount",
							"duplicateCount",
							"gcWallTimeMs",
							"gcWallTimeRatio",
							"frequencyPerSecond",
							"longestMs",
							"p50Ms",
							"p95Ms",
							"intervalMs",
							"topEvents",
						].sort(),
					);
					expect(gc?.durationMs ?? 0).toBeGreaterThan(0);
					expect(gc?.gcWallTimeMs ?? 0).toBeGreaterThan(0);
					expect(gc?.frequencyPerSecond ?? 0).toBeGreaterThan(0);
					expect(
						gc?.topEvents.some(
							(event) =>
								event.name === "MinorGC" &&
								Number.isFinite(event.durationMs) &&
								event.durationMs >= 0 &&
								typeof event.heapBeforeBytes === "number" &&
								Number.isFinite(event.heapBeforeBytes) &&
								typeof event.heapAfterBytes === "number" &&
								Number.isFinite(event.heapAfterBytes),
						),
					).toBe(true);
					expect(reply.artifacts).toHaveLength(3);
					expect(Buffer.byteLength(JSON.stringify(reply.summary))).toBeLessThan(
						PROFILE_LIMITS.summaryBytes,
					);
					for (const artifact of reply.artifacts) {
						const path = join(opts.dir, artifact.filename);
						expect((await stat(path)).size).toBe(artifact.size);
						JSON.parse(await readFile(path, "utf8"));
					}
					expect(await readdir(opts.dir)).not.toContain("raw.trace.json");
					expect(await recording.exited).toBe(0);
					expect(mainThreadTicks).toBeGreaterThan(20);
				} finally {
					clearInterval(ticker);
				}
			} finally {
				await recording.worker.terminate();
				await page.close();
			}
		},
		30000,
	);

	chromeTest(
		"real SPA navigation is allowed, root new document cancels and discards files",
		async () => {
			const connection = await browser();
			const page = await connection.newPage();
			await page.goto("about:blank");
			const identity = await page.createCDPSession();
			const { targetInfo } = await identity.send("Target.getTargetInfo");
			await identity.detach();
			const opts = await request(targetInfo.targetId, "navigation");
			opts.config.mode = "allocation";
			const recording = workerRecorder(opts);
			try {
				await recording.recording;
				await page.evaluate(() => history.replaceState(null, "", "#same-document"));
				await Bun.sleep(50);
				expect(recording.replies.some((reply) => reply.kind === "cancelled")).toBe(false);
				await page.goto("data:text/html,<title>new-document</title>");
				const reply = await recording.completed;
				expect(reply).toMatchObject({ kind: "cancelled", stage: "navigation", traceStopped: true });
				expect(await readdir(opts.dir)).toEqual([]);
				expect(await recording.exited).toBe(0);
			} finally {
				await recording.worker.terminate();
				await page.close();
			}
		},
		20000,
	);
});
