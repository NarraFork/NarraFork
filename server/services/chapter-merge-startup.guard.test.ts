import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Importing main would bind ports and recover real runtime sessions. Startup
// ordering is a composition property: inspect its wiring without starting a server.
const source = readFileSync(new URL("../main.ts", import.meta.url), "utf8");

describe("interrupted merge startup gate", () => {
	test("awaits metadata cleanup exactly once before serving or narrator recovery", () => {
		const call = "await chapterBatchMerge.cleanupStaleSessions();";
		const cleanup = source.indexOf(call);
		expect(cleanup).toBeGreaterThan(-1);
		expect(source.match(/chapterBatchMerge\.cleanupStaleSessions\(/g)).toHaveLength(1);
		for (const entry of [
			"const server = Bun.serve(",
			"_server = startServer(",
			"await recoverNarrators(",
		]) {
			expect(source.indexOf(entry)).toBeGreaterThan(cleanup);
		}
	});

	test("cleanup failure propagates rather than opening requests with live stale decisions", () => {
		const cleanup = source.indexOf("await chapterBatchMerge.cleanupStaleSessions();");
		const end = source.indexOf("startEventLoopMonitor();", cleanup);
		const gate = source.slice(cleanup, end);
		expect(gate).toContain("catch (error)");
		expect(gate).toContain("throw error;");
		expect(gate).not.toContain("materializeTree");
		expect(gate).not.toContain("abortInteractiveSnapshotMerge");
	});
});
