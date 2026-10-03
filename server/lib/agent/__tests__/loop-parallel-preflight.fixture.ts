import { afterAll, beforeEach, spyOn } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Diagnostic preload: run the unchanged loop-abort suite from any isolated source
 * snapshot, making the first Read's disk preflight wait for the second execute().
 * It demonstrates that parallel execute-entry order was never an IO ordering contract.
 * Use --preload with this absolute file path and filter the two parallel group cases.
 */
if (process.env.NARRAFORK_TEST !== "1") {
	throw new Error("Parallel preflight fixture requires the isolated tests/preload.ts first");
}
const { diskSpaceMonitor } = (await import(
	pathToFileURL(resolve(process.cwd(), "server/lib/disk-safety.ts")).href
)) as typeof import("../../disk-safety");
const { toolRegistry } = (await import(
	pathToFileURL(resolve(process.cwd(), "server/lib/agent/tool-registry.ts")).href
)) as typeof import("../tool-registry");

let firstPreflight: Promise<void>;
let releaseFirst: () => void;
beforeEach(() => {
	firstPreflight = new Promise<void>((done) => {
		releaseFirst = done;
	});
});
const originalAssess = diskSpaceMonitor.assess.bind(diskSpaceMonitor);
const assess = spyOn(diskSpaceMonitor, "assess").mockImplementation(async (path, config) => {
	if (/(?:^|\/)(?:first|parallel-1)\.txt$/.test(path)) await firstPreflight;
	return originalAssess(path, config);
});
const originalRegister = toolRegistry.register.bind(toolRegistry);
const register = spyOn(toolRegistry, "register").mockImplementation((tool) => {
	if (tool.name === "Read" && tool.description === "Parallel-safe test tool") {
		const originalExecute = tool.execute;
		tool = {
			...tool,
			execute: (args, ctx) => {
				if (args.file_path === "second.txt" || args.file_path === "parallel-2.txt") releaseFirst();
				return originalExecute(args, ctx);
			},
		};
	}
	originalRegister(tool);
});
afterAll(() => {
	assess.mockRestore();
	register.mockRestore();
});
