import { mock } from "bun:test";
import type { Browser } from "puppeteer-core";

const realPuppeteer = { ...(await import("puppeteer-core")) };
let closed = 0;
let disconnected = 0;
let released!: () => void;
const release = new Promise<void>((resolve) => {
	released = resolve;
});
const browser = {
	connected: true,
	close: async () => {
		closed++;
		released();
	},
	disconnect: () => {
		disconnected++;
		released();
	},
} as unknown as Browser;
mock.module("puppeteer-core", () => ({
	...realPuppeteer,
	default: { ...realPuppeteer.default, connect: async () => browser },
}));
const { closeMemoryDiagnosticWorkers, memoryDiagnosticQueue } = await import("../memory-job");
const pool = await import("../pool");
await pool.connectBrowser(true, "ws://fixture-private-endpoint");
const claimed = process.argv[2] === "claimed";
if (claimed) pool.claimBrowserShutdownOwnership();
const hooks = process.listenerCount("SIGTERM");
const reloaded = await import(`../pool.ts?signal-owner=${crypto.randomUUID()}`);
if (reloaded.closeBrowser === pool.closeBrowser || process.listenerCount("SIGTERM") !== hooks)
	throw new Error("Pool did not retain one signal owner across HMR");
let timer: ReturnType<typeof setTimeout> | undefined;
try {
	process.emit("SIGTERM");
	if (claimed) {
		// All signal continuations can run, but main has not begun handoff persistence yet.
		await Bun.sleep(20);
		if (closed !== 0 || disconnected !== 0 || memoryDiagnosticQueue.stats.closed)
			throw new Error("Signal cleanup raced main handoff");
		reloaded.setBrowserPreserveMode(true);
		await closeMemoryDiagnosticWorkers();
		await reloaded.closeBrowser();
	} else {
		await Promise.race([
			release,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Standalone signal did not clean browser")),
					1000,
				);
			}),
		]);
	}
	console.log(
		JSON.stringify({
			claimed,
			closed,
			disconnected,
			workersClosed: memoryDiagnosticQueue.stats.closed,
			hooksUnchanged: process.listenerCount("SIGTERM") === hooks,
		}),
	);
} finally {
	clearTimeout(timer);
	await pool.closeBrowser();
}
