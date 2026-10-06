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

import { describe, expect, test } from "bun:test";
import { runArchiver } from "../share-file";

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
