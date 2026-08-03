import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	__testing,
	acquireInstanceLock,
	getInstanceLockPath,
	releaseInstanceLock,
} from "../../../server/lib/instance-lock";

/**
 * These tests exist because the previous implementation refused to start whenever the recorded pid
 * merely EXISTED, without checking it was still the same process. A leftover lock from a SIGKILLed
 * run therefore blocked startup as soon as the kernel recycled that pid — the user-visible bug of
 * "cannot start even though NarraFork is not running". Every case below is one of those false
 * positives, plus the true positive that must keep working.
 */

const IS_LINUX = process.platform === "linux";
const tempDirs: string[] = [];
const spawnedPids: number[] = [];

function createTempDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "narrafork-instance-lock-"));
	tempDirs.push(dir);
	return join(dir, "narrafork.db");
}

function writeLock(dbPath: string, payload: Record<string, unknown>): string {
	const lockPath = getInstanceLockPath(dbPath);
	writeFileSync(lockPath, `${JSON.stringify(payload)}\n`, "utf8");
	return lockPath;
}

interface Helper {
	pid: number;
	/** Kill and WAIT for reaping, so the pid is truly gone rather than left as a zombie. */
	kill(): Promise<void>;
}

/** Spawn a real, long-lived process so liveness checks see a genuine live pid. */
function spawnIdleProcess(): Helper {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		stdio: "ignore",
	});
	const pid = child.pid;
	if (!pid) throw new Error("failed to spawn helper process");
	spawnedPids.push(pid);

	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	return {
		pid,
		async kill() {
			try {
				child.kill("SIGKILL");
			} catch {
				// Already gone.
			}
			// Awaiting the exit event lets the runtime reap the child. Without this the process
			// lingers as a zombie (state Z) and /proc/<pid> still exists.
			await exited;
		},
	};
}

/** Block until the helper is scheduled and observable through procfs. */
async function waitUntilObservable(pid: number): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (__testing.observeProcess(pid).kind === "present") return;
		await Bun.sleep(10);
	}
	throw new Error(`process ${pid} never became observable`);
}

async function waitUntilGone(pid: number): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (__testing.observeProcess(pid).kind === "absent") return;
		await Bun.sleep(10);
	}
	throw new Error(`process ${pid} never disappeared`);
}

/** Read a live pid's real kernel start ticks, so a payload can claim a matching identity. */
function realStartTicks(pid: number): number {
	const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
	const after = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
	return Number(after[19]);
}

afterEach(() => {
	releaseInstanceLock();
	while (spawnedPids.length > 0) {
		const pid = spawnedPids.pop();
		if (pid === undefined) continue;
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone or already reaped.
		}
	}
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("instance lock", () => {
	it("removes a stale lock when the recorded pid is no longer alive", () => {
		const dbPath = createTempDbPath();
		const lockPath = writeLock(dbPath, {
			pid: 2147483647,
			token: "stale-token",
			dbPath,
			startedAt: "2026-01-01T00:00:00.000Z",
			argv: ["narrafork"],
		});

		acquireInstanceLock(dbPath);

		const payload = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; token: string };
		expect(payload.pid).toBe(process.pid);
		expect(payload.token).not.toBe("stale-token");
	});

	it("releases only the lock owned by the current process", () => {
		const dbPath = createTempDbPath();
		const lockPath = getInstanceLockPath(dbPath);

		acquireInstanceLock(dbPath);
		expect(existsSync(lockPath)).toBe(true);

		releaseInstanceLock();

		expect(existsSync(lockPath)).toBe(false);
	});

	it("leaves a lock alone when the file on disk belongs to someone else", () => {
		// The name above promises "only the lock owned by the current process", but deleting our own
		// lock does not exercise that. Here the file is swapped for a foreign payload after we
		// acquired: release must not delete it, or a crash-and-restart sequence would let a departing
		// process remove the incoming one's lock.
		const dbPath = createTempDbPath();
		const lockPath = getInstanceLockPath(dbPath);

		acquireInstanceLock(dbPath);
		writeFileSync(
			lockPath,
			`${JSON.stringify({ version: 2, pid: process.pid + 1, token: "someone-else" })}\n`,
			"utf8",
		);

		releaseInstanceLock();

		expect(existsSync(lockPath)).toBe(true);
		const payload = JSON.parse(readFileSync(lockPath, "utf8")) as { token: string };
		expect(payload.token).toBe("someone-else");
	});

	it("starts when the recorded pid was recycled by an unrelated live process", async () => {
		const dbPath = createTempDbPath();
		const helper = spawnIdleProcess();
		await waitUntilObservable(helper.pid);

		// Live pid, but the recorded start time belongs to a process that no longer exists.
		const lockPath = writeLock(dbPath, {
			version: 2,
			pid: helper.pid,
			token: "recycled-token",
			dbPath,
			startedAt: "2020-01-01T00:00:00.000Z",
			argv: ["narrafork"],
			bootId: __testing.currentBootId(),
			procStartTicks: 1,
			execPath: "/usr/bin/definitely-not-this-binary",
			hostname: "old-host",
			uid: 0,
		});

		acquireInstanceLock(dbPath);

		const payload = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
		expect(payload.pid).toBe(process.pid);
	});

	it("starts when the recorded pid is a live process owned by another user", () => {
		// pid 1 always exists, is owned by root, and makes process.kill(pid, 0) raise EPERM — the
		// case the old code mapped to "alive", producing a lock that could never be cleared.
		const dbPath = createTempDbPath();
		const lockPath = writeLock(dbPath, {
			version: 2,
			pid: 1,
			token: "eperm-token",
			dbPath,
			startedAt: "2020-01-01T00:00:00.000Z",
			argv: ["narrafork"],
			bootId: __testing.currentBootId(),
			procStartTicks: 999999999,
			execPath: process.execPath,
			hostname: "old-host",
			uid: 0,
		});

		acquireInstanceLock(dbPath);

		const payload = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
		expect(payload.pid).toBe(process.pid);
	});

	it("starts when the lock was written in a different boot session", async () => {
		const dbPath = createTempDbPath();
		const helper = spawnIdleProcess();
		await waitUntilObservable(helper.pid);

		const lockPath = writeLock(dbPath, {
			version: 2,
			pid: helper.pid,
			token: "old-boot-token",
			dbPath,
			startedAt: new Date().toISOString(),
			argv: ["narrafork"],
			bootId: "00000000-0000-0000-0000-000000000000",
			// Matching start ticks: only the boot id proves this lock predates the current boot.
			procStartTicks: IS_LINUX ? realStartTicks(helper.pid) : 1,
			execPath: process.execPath,
			hostname: "old-host",
			uid: process.getuid?.() ?? null,
		});

		acquireInstanceLock(dbPath);

		const payload = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
		expect(payload.pid).toBe(process.pid);
	});

	it("starts on a legacy v1 lock whose pid was recycled long after it was written", async () => {
		const dbPath = createTempDbPath();
		const helper = spawnIdleProcess();
		await waitUntilObservable(helper.pid);

		// v1 payloads carry no identity fields at all, so the decision falls back to comparing the
		// observed start time against startedAt.
		const lockPath = writeLock(dbPath, {
			pid: helper.pid,
			token: "legacy-token",
			dbPath,
			startedAt: "2020-01-01T00:00:00.000Z",
			argv: ["narrafork"],
		});

		acquireInstanceLock(dbPath);

		const payload = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
		expect(payload.pid).toBe(process.pid);
	});

	it("reuses the lock when it is already held by this very process", () => {
		const dbPath = createTempDbPath();
		const lockPath = writeLock(dbPath, {
			version: 2,
			pid: process.pid,
			token: "self-token",
			dbPath,
			startedAt: new Date().toISOString(),
			argv: process.argv.slice(0, 2),
			bootId: __testing.currentBootId(),
			procStartTicks: IS_LINUX ? realStartTicks(process.pid) : null,
			execPath: process.execPath,
			hostname: "self",
			uid: process.getuid?.() ?? null,
		});

		expect(() => acquireInstanceLock(dbPath)).not.toThrow();

		// The existing payload must be preserved, not rewritten with a new token.
		const payload = JSON.parse(readFileSync(lockPath, "utf8")) as { token: string };
		expect(payload.token).toBe("self-token");
	});

	it.skipIf(!IS_LINUX)(
		"refuses to start when a matching live process still holds the lock",
		async () => {
			const dbPath = createTempDbPath();
			const helper = spawnIdleProcess();
			await waitUntilObservable(helper.pid);

			writeLock(dbPath, {
				version: 2,
				pid: helper.pid,
				token: "live-token",
				dbPath,
				startedAt: new Date().toISOString(),
				argv: ["bun", "server/index.ts"],
				bootId: __testing.currentBootId(),
				procStartTicks: realStartTicks(helper.pid),
				execPath: process.execPath,
				hostname: "self",
				uid: process.getuid?.() ?? null,
			});

			expect(() => acquireInstanceLock(dbPath)).toThrow(/already using/);
		},
	);

	it.skipIf(!IS_LINUX)("clears the lock once the matching holder has exited", async () => {
		const dbPath = createTempDbPath();
		const helper = spawnIdleProcess();
		await waitUntilObservable(helper.pid);

		const lockPath = writeLock(dbPath, {
			version: 2,
			pid: helper.pid,
			token: "live-token",
			dbPath,
			startedAt: new Date().toISOString(),
			argv: ["bun", "server/index.ts"],
			bootId: __testing.currentBootId(),
			procStartTicks: realStartTicks(helper.pid),
			execPath: process.execPath,
			hostname: "self",
			uid: process.getuid?.() ?? null,
		});

		expect(() => acquireInstanceLock(dbPath)).toThrow(/already using/);

		await helper.kill();
		await waitUntilGone(helper.pid);

		acquireInstanceLock(dbPath);
		const payload = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
		expect(payload.pid).toBe(process.pid);
	});

	it.skipIf(!IS_LINUX)("treats a zombie holder as stale and starts", async () => {
		// A killed-but-unreaped child keeps /proc/<pid> alive, so pid existence alone would block
		// startup forever. Only the process state disproves it.
		const dbPath = createTempDbPath();
		const helper = spawnIdleProcess();
		await waitUntilObservable(helper.pid);

		const lockPath = writeLock(dbPath, {
			version: 2,
			pid: helper.pid,
			token: "zombie-token",
			dbPath,
			startedAt: new Date().toISOString(),
			argv: ["bun", "server/index.ts"],
			bootId: __testing.currentBootId(),
			procStartTicks: realStartTicks(helper.pid),
			execPath: process.execPath,
			hostname: "self",
			uid: process.getuid?.() ?? null,
		});

		// Kill without reaping: the pid stays present in state Z.
		process.kill(helper.pid, "SIGKILL");
		for (let i = 0; i < 200; i++) {
			const observed = __testing.observeProcess(helper.pid);
			if (observed.kind === "present" && observed.zombie) break;
			if (observed.kind === "absent") throw new Error("child was reaped before it could be seen");
			Bun.sleepSync(5);
		}

		acquireInstanceLock(dbPath);
		const payload = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
		expect(payload.pid).toBe(process.pid);
	});

	it.skipIf(!IS_LINUX)("takes over a live lock when force-unlock is set", async () => {
		const dbPath = createTempDbPath();
		const helper = spawnIdleProcess();
		await waitUntilObservable(helper.pid);

		const lockPath = writeLock(dbPath, {
			version: 2,
			pid: helper.pid,
			token: "live-token",
			dbPath,
			startedAt: new Date().toISOString(),
			argv: ["bun", "server/index.ts"],
			bootId: __testing.currentBootId(),
			procStartTicks: realStartTicks(helper.pid),
			execPath: process.execPath,
			hostname: "self",
			uid: process.getuid?.() ?? null,
		});

		const previous = process.env.NARRAFORK_FORCE_UNLOCK;
		process.env.NARRAFORK_FORCE_UNLOCK = "1";
		try {
			acquireInstanceLock(dbPath);
		} finally {
			if (previous === undefined) delete process.env.NARRAFORK_FORCE_UNLOCK;
			else process.env.NARRAFORK_FORCE_UNLOCK = previous;
		}

		const payload = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
		expect(payload.pid).toBe(process.pid);
	});

	it("records identity fields so the next startup can verify the holder", () => {
		const dbPath = createTempDbPath();
		acquireInstanceLock(dbPath);

		const payload = JSON.parse(readFileSync(getInstanceLockPath(dbPath), "utf8")) as {
			version: number;
			bootId: string | null;
			procStartTicks: number | null;
			execPath: string;
		};
		expect(payload.version).toBe(2);
		expect(payload.bootId).toBeTruthy();
		expect(payload.execPath).toBe(process.execPath);
		if (IS_LINUX) expect(payload.procStartTicks).toBe(realStartTicks(process.pid));
	});
});

describe("lock holder classification", () => {
	const base = {
		version: 2,
		token: "t",
		dbPath: "/tmp/x/narrafork.db",
		argv: ["bun", "server/index.ts"],
		execPath: process.execPath,
		hostname: "host",
		uid: process.getuid?.() ?? null,
	};

	it("treats an unparsable lock as stale", () => {
		expect(__testing.classifyLockHolder(null).kind).toBe("stale");
	});

	it.skipIf(!IS_LINUX)(
		"ignores hostname differences so rebuilt containers are not blocked",
		async () => {
			const helper = spawnIdleProcess();
			await waitUntilObservable(helper.pid);

			const verdict = __testing.classifyLockHolder({
				...base,
				pid: helper.pid,
				startedAt: new Date().toISOString(),
				bootId: __testing.currentBootId(),
				procStartTicks: realStartTicks(helper.pid),
				hostname: "some-other-container-id",
			});

			// Same process, different hostname: must still be recognised as the live holder, so a
			// hostname change alone can never wrongly free a lock either.
			expect(verdict.kind).toBe("live");
		},
	);

	it("reports an absent pid as stale rather than undecidable", () => {
		const verdict = __testing.classifyLockHolder({
			...base,
			pid: 2147483646,
			startedAt: new Date().toISOString(),
			bootId: __testing.currentBootId(),
			procStartTicks: 12345,
		});
		expect(verdict.kind).toBe("stale");
	});

	it.skipIf(!IS_LINUX)("classifies a recycled pid as stale, not live", async () => {
		const helper = spawnIdleProcess();
		await waitUntilObservable(helper.pid);

		const verdict = __testing.classifyLockHolder({
			...base,
			pid: helper.pid,
			startedAt: new Date().toISOString(),
			bootId: __testing.currentBootId(),
			procStartTicks: realStartTicks(helper.pid) + 1,
		});
		expect(verdict.kind).toBe("stale");
	});
});

/**
 * Off Linux there is no exact boot id, so it is derived from `Date.now()/1000 - uptime()`. That
 * value drifts by ~1s between samples and jumps on NTP correction, which means comparing two
 * derived readings for equality declares the SAME boot to be different — and a "different boot"
 * verdict clears the lock of a live holder. An earlier version bucketed to 10s, which only moved
 * the disagreement to the bucket edges rather than removing it.
 */
describe("boot session comparison", () => {
	const derived = (seconds: number) => `${__testing.DERIVED_BOOT_PREFIX}${seconds}`;

	it("treats small drift between derived boot markers as the same boot", () => {
		// The exact case the 10s bucket got wrong: readings either side of a bucket edge.
		expect(__testing.bootSessionsDiffer(derived(1004), derived(1005))).toBe(false);
		expect(__testing.bootSessionsDiffer(derived(1000), derived(1010))).toBe(false);
		const edge = __testing.DERIVED_BOOT_TOLERANCE_S;
		expect(__testing.bootSessionsDiffer(derived(5000), derived(5000 + edge))).toBe(false);
	});

	it("still separates genuine reboots, which move the derived marker far", () => {
		const past = __testing.DERIVED_BOOT_TOLERANCE_S + 60;
		expect(__testing.bootSessionsDiffer(derived(5000), derived(5000 + past))).toBe(true);
	});

	it("compares exact procfs boot ids for equality", () => {
		const a = "11111111-1111-1111-1111-111111111111";
		const b = "22222222-2222-2222-2222-222222222222";
		expect(__testing.bootSessionsDiffer(a, a)).toBe(false);
		expect(__testing.bootSessionsDiffer(a, b)).toBe(true);
	});

	it("draws no conclusion when one side is exact and the other derived", () => {
		// Mixed forms mean a different platform or NarraFork version wrote the payload; that says
		// nothing about the boot session, and guessing "different" would clear a live lock.
		const exact = "11111111-1111-1111-1111-111111111111";
		expect(__testing.bootSessionsDiffer(exact, derived(1000))).toBe(false);
		expect(__testing.bootSessionsDiffer(derived(1000), exact)).toBe(false);
	});

	it("draws no conclusion when either side is missing", () => {
		expect(__testing.bootSessionsDiffer(null, derived(1000))).toBe(false);
		expect(__testing.bootSessionsDiffer(derived(1000), null)).toBe(false);
	});
});

/**
 * Clearing a lock judged stale used to be an unconditional `unlink`. When two processes both decided
 * the same lock was stale, the loser deleted the WINNER's freshly written lock and booted anyway —
 * two instances then fighting over ports, worktrees and terminals. The clear is now an atomic rename
 * guarded by the token, so only the process that judged a given payload can remove it.
 */
describe("stale lock clearing", () => {
	const payload = (token: string) => ({
		version: 2,
		pid: 2147483647,
		token,
		dbPath: "/tmp/x/narrafork.db",
		startedAt: "2026-01-01T00:00:00.000Z",
		argv: ["narrafork"],
		bootId: null,
		procStartTicks: null,
		execPath: process.execPath,
		hostname: "host",
		uid: null,
	});

	it("removes the file when it still holds the payload that was judged", () => {
		const dbPath = createTempDbPath();
		const lockPath = writeLock(dbPath, payload("judged"));

		expect(__testing.clearLockForRetry(lockPath, payload("judged"))).toBe(true);
		expect(existsSync(lockPath)).toBe(false);
	});

	it("refuses to remove a lock that was replaced after it was judged", () => {
		// The race, made deterministic: we judged token A, but by the time we clear, a competitor has
		// written its own token B. Deleting here is exactly the bug — B is a live holder.
		const dbPath = createTempDbPath();
		const lockPath = writeLock(dbPath, payload("winner"));

		expect(__testing.clearLockForRetry(lockPath, payload("loser-judged-this"))).toBe(false);

		// The winner's lock must survive intact.
		expect(existsSync(lockPath)).toBe(true);
		const onDisk = JSON.parse(readFileSync(lockPath, "utf8")) as { token: string };
		expect(onDisk.token).toBe("winner");
	});

	it("reports a lost claim when the file vanished before it could be moved", () => {
		// A competitor cleared it first. Returning false sends the caller back to re-classify rather
		// than act on a verdict about a payload that is no longer on disk.
		const dbPath = createTempDbPath();
		const lockPath = getInstanceLockPath(dbPath);
		expect(__testing.clearLockForRetry(lockPath, payload("whatever"))).toBe(false);
	});

	it("removes an unparsable lock, which carries no token to protect", () => {
		const dbPath = createTempDbPath();
		const lockPath = getInstanceLockPath(dbPath);
		writeFileSync(lockPath, "{ not json", "utf8");

		expect(__testing.clearLockForRetry(lockPath, null)).toBe(true);
		expect(existsSync(lockPath)).toBe(false);
	});

	it("does not mistake a competitor's half-written lock for a corrupt one", () => {
		// writeLockFile creates with `wx` and only then writes, so a competitor's file is briefly
		// empty. A single read of that window returns null, and treating null as "corrupt, therefore
		// clear it" would delete a lock mid-acquisition. The settled read re-checks instead.
		const dbPath = createTempDbPath();
		const lockPath = getInstanceLockPath(dbPath);
		writeFileSync(lockPath, "", "utf8");

		// A plain read sees the empty window and reports nothing.
		expect(__testing.readLockPayload(lockPath)).toBeNull();

		// Once the writer has finished, the settling read recovers the competitor's real payload —
		// which is what stops acquireInstanceLock from clearing a lock that was merely mid-write.
		writeFileSync(lockPath, `${JSON.stringify(payload("competitor"))}\n`, "utf8");
		expect(__testing.readLockPayloadSettled(lockPath)?.token).toBe("competitor");

		// And an empty file that never gets filled still settles to null, so a genuinely corrupt
		// lock is not treated as a live holder forever.
		writeFileSync(lockPath, "", "utf8");
		expect(__testing.readLockPayloadSettled(lockPath)).toBeNull();
	});
});
