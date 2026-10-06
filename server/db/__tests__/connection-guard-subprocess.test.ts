/**
 * Proves the `openDatabase` guard survives the exact failure mode it exists for:
 * a checkout whose `tests/preload.ts` has NO isolation (every worktree created before
 * the preload hardening landed). The in-process test cannot cover this, because this
 * suite's own preload has already redirected NARRAFORK_HOME.
 *
 * So spawn a child `bun test` with a bunfig that preloads nothing, and assert the
 * connection layer still refuses the real database.
 *
 * COST: this is the only way to exercise that failure mode, but it spawns a real
 * `bun test` (needs `bun` on PATH) and takes on the order of ten seconds — enough
 * to be felt in a routine local run. It is therefore opt-out via
 * `NARRAFORK_SKIP_SLOW_TESTS=1`, which a fast dev loop or a PR-time CI job can set
 * while the full/nightly run leaves it on. Skipping is announced rather than
 * silent, so a green suite never hides the fact that this guard went unverified.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..", "..");

/**
 * Child budget, deliberately below the test's own timeout so the SUBPROCESS is what
 * gives up first. If the test timeout fired first, Bun would fail the test and move
 * on while the child kept running — an orphan holding a `bun test` process (and its
 * SQLite handles) for as long as it likes.
 */
const CHILD_TIMEOUT_MS = 45_000;

/** Test timeout, above `CHILD_TIMEOUT_MS` so the child's own deadline wins. */
const TEST_TIMEOUT_MS = 60_000;

/**
 * Hard cap on captured child output.
 *
 * The child prints a few lines of `bun test` summary, so this is never reached in
 * practice — it exists because an unbounded `new Response(stream).text()` buffers
 * whatever the child decides to emit (a crash loop, a stack-trace flood) straight
 * into this process's heap.
 */
const MAX_CAPTURED_BYTES = 64 * 1024;

/**
 * Read a child stream, retaining at most `MAX_CAPTURED_BYTES`.
 *
 * Each chunk is TRUNCATED rather than merely counted: Bun hands over pipe data in
 * chunks as large as 256 KB, so a loop that only checks the running total before the
 * next `read()` can retain several times the cap from one chunk. Slicing makes the
 * bound hold no matter how the child batches its writes.
 *
 * Cancelling rather than draining is the other half: it releases the reader instead
 * of following a runaway writer, and the assertions here only need the summary line.
 */
async function readCapped(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (total < MAX_CAPTURED_BYTES) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			const room = MAX_CAPTURED_BYTES - total;
			const kept = value.byteLength > room ? value.subarray(0, room) : value;
			chunks.push(kept);
			total += kept.byteLength;
		}
	} finally {
		// Signals the child's writes can be dropped; also unblocks a child that is
		// blocked writing into a full pipe, which is one way "hung subprocess" happens.
		await reader.cancel().catch(() => {});
	}
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(merged);
}

function skipSlowTests(): boolean {
	const flag = process.env.NARRAFORK_SKIP_SLOW_TESTS?.trim().toLowerCase();
	return flag === "1" || flag === "true";
}

describe("openDatabase guard without an isolating preload", () => {
	test.skipIf(skipSlowTests())(
		"a test process with no preload still cannot open the real database",
		async () => {
			const dir = mkdtempSync(resolve(tmpdir(), "narrafork-nopreload-"));
			let proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
			try {
				// No `[test].preload`: reproduces a stale worktree's bunfig.
				writeFileSync(resolve(dir, "bunfig.toml"), "[test]\n");
				// Point NARRAFORK_HOME at the real directory the way an unisolated run would.
				const realHome = resolve(homedir(), ".narrafork");
				const testFile = resolve(dir, "probe.test.ts");
				writeFileSync(
					testFile,
					[
						`import { expect, test } from "bun:test";`,
						`import { openDatabase } from ${JSON.stringify(resolve(repoRoot, "server/db/connection.ts"))};`,
						`test("guard holds", () => {`,
						`	expect(() => openDatabase()).toThrow(/Refusing to open the real NarraFork database/);`,
						`});`,
					].join("\n"),
				);

				proc = Bun.spawn(["bun", "test", "--config", resolve(dir, "bunfig.toml"), testFile], {
					cwd: dir,
					env: { ...process.env, NARRAFORK_HOME: realHome, HOME: homedir() },
					stdout: "pipe",
					stderr: "pipe",
					timeout: CHILD_TIMEOUT_MS,
					// SIGKILL, not the default SIGTERM: the failure being bounded here is a
					// WEDGED child, and a wedged process is exactly the one that may not run
					// its signal handler.
					killSignal: "SIGKILL",
				});
				const [stdout, stderr, exitCode] = await Promise.all([
					readCapped(proc.stdout),
					readCapped(proc.stderr),
					proc.exited,
				]);
				const output = `${stdout}\n${stderr}`;
				expect(output).toContain("1 pass");
				expect(exitCode).toBe(0);
			} finally {
				// Covers what `timeout` cannot: an assertion above threw while the child was
				// still running, or `Bun.spawn` succeeded but `await proc.exited` never got
				// reached. Killing an exited process is a no-op, but this runs in a `finally`
				// — a throw here would replace the real failure with a bogus one.
				try {
					proc?.kill("SIGKILL");
				} catch {
					// Already reaped; nothing left to clean up.
				}
				rmSync(dir, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT_MS,
	);
});
