import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "puppeteer-core";

// Only a Chrome launched by this isolated test is touched. Never connect to the running server.
const home = await mkdtemp(join(tmpdir(), "nf-profile-integration-"));
const previousHome = process.env.NARRAFORK_HOME;
process.env.NARRAFORK_HOME = home;
const { getBrowser, closeBrowser } = await import("../pool");
const { createSession, closeSession, closeAllSessions } = await import("../session");
const { startMemoryProfile, stopMemoryProfile, statusMemoryProfile, cancelMemoryProfile } =
	await import("../memory-profiler");
const { getShare, revokeShareRegistry } = await import("../../shares");
let browser: Browser | undefined;
try {
	browser = await getBrowser(true);
} catch (error) {
	if (!(error instanceof Error) || !error.message.startsWith("Could not find Chrome/Chromium."))
		throw error;
}
const chromeTest = browser ? test : test.skip;
const url = `data:text/html,${encodeURIComponent("<!doctype html><title>profile-owned-fixture</title><script>globalThis.held=[]; globalThis.timer=setInterval(()=>{held.push(new Array(10000).fill(Math.random()));if(held.length>20)held.shift()},5)</script>")}`;
function required<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("Missing expected test value");
	return value;
}
afterAll(async () => {
	try {
		await closeAllSessions();
		await closeBrowser();
	} finally {
		if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
		else process.env.NARRAFORK_HOME = previousHome;
		await rm(home, { recursive: true, force: true });
	}
});

describe("memory profile with owned Chrome and real worker", () => {
	chromeTest(
		"allocation file and summary are readable, private connection stays out of views",
		async () => {
			const session = await createSession(`profile-integration-${crypto.randomUUID()}`, url, true);
			try {
				const started = await startMemoryProfile(session, { mode: "allocation", durationMs: 5000 });
				expect(started.state).toBe("recording");
				await Bun.sleep(150);
				const result = await stopMemoryProfile(session, required(started.profileId));
				expect(result.state).toBe("completed");
				expect(result.summary?.allocation?.status).toBe("ok");
				expect(result.artifacts?.map((artifact) => artifact.kind).sort()).toEqual([
					"allocation",
					"summary",
				]);
				for (const artifact of required(result.artifacts)) {
					expect((await stat(artifact.path)).size).toBe(artifact.size);
					expect(getShare(artifact.shareId)?.storagePath).toBe(artifact.path);
					const value = JSON.parse(await readFile(artifact.path, "utf8"));
					if (artifact.kind === "allocation") {
						expect(value.head).toBeDefined();
						expect(Array.isArray(value.samples)).toBe(true);
					} else expect(value).toEqual(result.summary);
				}
				expect(JSON.stringify(result)).not.toContain(required(browser).wsEndpoint());
				expect(session.memoryJob).toBeUndefined();
				expect(await cancelMemoryProfile(session, required(started.profileId))).toEqual(result);
				for (const artifact of required(result.artifacts)) revokeShareRegistry(artifact.shareId);
			} finally {
				await closeSession(session.narratorId, session.id);
			}
		},
		20000,
	);
	chromeTest(
		"both mode autostops at duration, preserves partial evidence and releases tracing",
		async () => {
			const session = await createSession(`profile-integration-${crypto.randomUUID()}`, url, true);
			try {
				const started = await startMemoryProfile(session, { mode: "both", durationMs: 1000 });
				await required(session.memoryJob).done;
				const result = statusMemoryProfile(session, started.profileId);
				expect(result.state).toBe("completed");
				expect(result.summary?.stopReason).toBe("duration_limit");
				expect(result.summary?.allocation).toBeDefined();
				expect(result.summary?.gc).toBeDefined();
				expect(result.artifacts?.some((artifact) => artifact.kind === "summary")).toBe(true);
				for (const artifact of required(result.artifacts)) revokeShareRegistry(artifact.shareId);
				const next = await startMemoryProfile(session, { mode: "gc", durationMs: 5000 });
				expect(next.state).toBe("recording");
				expect((await cancelMemoryProfile(session, required(next.profileId))).state).toBe(
					"cancelled",
				);
				expect(session.page.isClosed()).toBe(false);
				expect(required(browser).connected).toBe(true);
			} finally {
				await closeSession(session.narratorId, session.id);
			}
		},
		30000,
	);
	chromeTest(
		"new-document navigation cancels, but same-document navigation keeps recording",
		async () => {
			const session = await createSession(`profile-integration-${crypto.randomUUID()}`, url, true);
			try {
				const started = await startMemoryProfile(session, { mode: "allocation", durationMs: 5000 });
				await session.page.evaluate(() => {
					location.hash = "profile-route";
				});
				await Bun.sleep(50);
				expect(statusMemoryProfile(session, started.profileId).state).toBe("recording");
				const done = required(session.memoryJob).done;
				await session.page.goto("data:text/html,<title>new-document</title>");
				await done;
				expect(statusMemoryProfile(session, started.profileId).state).toBe("cancelled");
				expect(session.memoryJob).toBeUndefined();
				expect(session.page.isClosed()).toBe(false);
			} finally {
				await closeSession(session.narratorId, session.id);
			}
		},
		20000,
	);
});
