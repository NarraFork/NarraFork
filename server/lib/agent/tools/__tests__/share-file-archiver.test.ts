/**
 * The archiving subprocesses used to run as `await proc.exited` with no timeout and an
 * unbounded `new Response(proc.stderr).text()`. Both violate the CLAUDE.md rule that a
 * subprocess must have an output limit and a timeout, and both fail silently: a wedged `tar`
 * (hung network mount, symlink cycle) stalls the narrator with nothing to show, and a child
 * that emits one error line per file decides how much memory we allocate.
 *
 * These tests drive REAL subprocesses rather than stubbing `safeSpawn`, because the claim
 * being defended is "the child is actually killed / the capture is actually bounded", not
 * "the right arguments were passed".
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECRET_PATH_REFUSAL } from "../../../fs-secret-paths";
import { narraforkDir } from "../../../settings";
import { createShare, deleteShare, getShare } from "../../../shares";
import type { ToolContext } from "../../types";
import { runArchiver, shareFileTool } from "../share-file";

describe("runArchiver", () => {
	test("returns null when the command succeeds", async () => {
		expect(await runArchiver("true", ["sh", "-c", "exit 0"])).toBeNull();
	});

	test("reports the child's stderr on failure", async () => {
		const failure = await runArchiver("tar", ["sh", "-c", "echo 'no such file' >&2; exit 2"]);
		expect(failure).toBe("no such file");
	});

	test("falls back to the exit code when stderr is empty", async () => {
		expect(await runArchiver("gzip", ["sh", "-c", "exit 3"])).toBe("gzip exited with code 3");
	});

	test("kills a wedged child and NAMES the timeout", async () => {
		const started = Date.now();
		// `sleep 30` stands in for the stall this timeout exists for. Without a timeout this
		// call would take 30s (in production: forever).
		const failure = await runArchiver("tar", ["sleep", "30"], { timeoutMs: 300 });

		expect(failure).toBe("tar timed out after 0s");
		// The decisive assertion: control came back long before the child would have finished.
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	test("bounds the captured stderr instead of retaining all of it", async () => {
		// 200 KB of stderr from a child that failed — the pathological-error-loop shape.
		const failure = await runArchiver(
			"tar",
			["sh", "-c", "head -c 200000 /dev/zero | tr '\\0' 'E' >&2; exit 1"],
			{ maxStderrBytes: 4096 },
		);

		expect(failure).not.toBeNull();
		// Capped, and by a wide margin over the cap to allow for stream chunking.
		expect((failure as string).length).toBeLessThanOrEqual(8192);
		// Still a usable diagnosis: what was kept is the child's own output.
		expect(failure as string).toContain("EEE");
	});
});

const sourceRoot = mkdtempSync(join(tmpdir(), "nf-share-recording-privacy-"));
const recordingRoots = [
	"request-recordings",
	"saved-request-recordings",
	"editor-transfers",
	"editor-native",
	"editor-native-operations",
].map((name) => {
	const directory = join(narraforkDir, name, "share-privacy-test");
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "request.json"), "private-recording-marker");
	return directory;
});
const ordinary = join(sourceRoot, "ordinary.json");
writeFileSync(ordinary, "ordinary workspace data");

function context(signal = new AbortController().signal): ToolContext {
	return {
		cwd: sourceRoot,
		narratorId: "privacy-test-narrator",
		locale: "en",
		signal,
		requestPermission: async () => ({ behavior: "allow" }),
	};
}
afterAll(() => {
	for (const directory of recordingRoots) rmSync(directory, { recursive: true, force: true });
	rmSync(sourceRoot, { recursive: true, force: true });
});

describe("ShareFile cannot publish private request recordings", () => {
	test.each([
		0, 1, 2, 3, 4,
	])("refuses private directory %s, files, compression and multi-file archives", async (index) => {
		const directory = recordingRoots[index];
		const file = join(directory, "request.json");
		for (const args of [
			{ path: file },
			{ path: file, compress: true },
			{ path: directory },
			{ path: [ordinary, file] },
			{ path: [ordinary, directory] },
		]) {
			const result = await shareFileTool.execute(args, context());
			expect(result.isError).toBe(true);
			expect(result.output).toBe(SECRET_PATH_REFUSAL);
			expect(result.metadata?.shareId).toBeUndefined();
		}
	});
	test("refuses a parent directory whose archive would include both private areas", async () => {
		const result = await shareFileTool.execute({ path: narraforkDir }, context());
		expect(result.isError).toBe(true);
		expect(result.output).toBe(SECRET_PATH_REFUSAL);
	});
	test("refuses direct and nested symlink sources before copying or archiving", async () => {
		const file = join(recordingRoots[0], "request.json");
		const direct = join(sourceRoot, "file-alias.json");
		symlinkSync(file, direct, "file");
		const nested = join(sourceRoot, "nested");
		mkdirSync(nested);
		symlinkSync(file, join(nested, "private.json"), "file");
		const linkedDirectory = join(sourceRoot, "nested-directory");
		mkdirSync(linkedDirectory);
		symlinkSync(recordingRoots[1], join(linkedDirectory, "private-recordings"), "dir");
		for (const path of [direct, nested, linkedDirectory, [ordinary, nested]]) {
			const result = await shareFileTool.execute({ path }, context());
			expect(result.isError).toBe(true);
			expect(result.output).toBe(SECRET_PATH_REFUSAL);
		}
	});
	test("share registry refuses direct private paths and rechecks retargeted symlinks", () => {
		const file = join(recordingRoots[1], "request.json");
		const opts = {
			id: "private-registry",
			originalName: "request.json",
			storagePath: file,
			size: 20,
			createdBy: "privacy-test",
		};
		expect(() => createShare(opts)).toThrow(SECRET_PATH_REFUSAL);
		expect(getShare(opts.id)).toBeNull();
		const alias = join(sourceRoot, "retargeted.json");
		symlinkSync(ordinary, alias, "file");
		const registered = createShare({ ...opts, id: "retargeted-registry", storagePath: alias });
		try {
			expect(getShare(registered.id)).not.toBeNull();
			rmSync(alias);
			symlinkSync(file, alias, "file");
			expect(getShare(registered.id)).toBeNull();
		} finally {
			deleteShare(registered.id);
		}
	});
	test("ordinary files and legacy dumps remain shareable", async () => {
		const legacy = join(narraforkDir, "malformed-request-dumps", "share-privacy-test.json");
		mkdirSync(join(legacy, ".."), { recursive: true });
		writeFileSync(legacy, "legacy dump evidence");
		try {
			for (const path of [ordinary, legacy]) {
				const result = await shareFileTool.execute({ path }, context());
				expect(result.isError).not.toBe(true);
				const shareId = result.metadata?.shareId;
				expect(typeof shareId).toBe("string");
				if (typeof shareId === "string") {
					try {
						const record = getShare(shareId);
						expect(record).not.toBeNull();
						expect(await Bun.file(record?.storagePath ?? "").text()).not.toContain(
							"private-recording-marker",
						);
					} finally {
						deleteShare(shareId);
					}
				}
			}
		} finally {
			rmSync(legacy, { force: true });
		}
	});
	test("privacy scan bounds the number of selected sources before filesystem work", async () => {
		const result = await shareFileTool.execute({ path: Array(129).fill(ordinary) }, context());
		expect(result.isError).toBe(true);
		expect(result.output).toContain("source count limit");
	});
	test("privacy scanning honors cancellation and fails closed at its depth cap", async () => {
		const controller = new AbortController();
		controller.abort(new Error("privacy scan cancelled"));
		const cancelled = await shareFileTool.execute({ path: ordinary }, context(controller.signal));
		expect(cancelled.isError).toBe(true);
		expect(cancelled.output).toContain("cancelled");
		const deep = join(
			sourceRoot,
			"deep",
			...Array.from({ length: 66 }, (_, index) => `level-${index}`),
		);
		mkdirSync(deep, { recursive: true });
		const limited = await shareFileTool.execute({ path: join(sourceRoot, "deep") }, context());
		expect(limited.isError).toBe(true);
		expect(limited.output).toContain("depth limit");
	});
});
