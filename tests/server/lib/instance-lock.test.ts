import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireInstanceLock,
	getInstanceLockPath,
	releaseInstanceLock,
} from "../../../server/lib/instance-lock";

const tempDirs: string[] = [];

function createTempDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "narrafork-instance-lock-"));
	tempDirs.push(dir);
	return join(dir, "narrafork.db");
}

afterEach(() => {
	releaseInstanceLock();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("instance lock", () => {
	it("removes a stale lock when the recorded pid is no longer alive", () => {
		const dbPath = createTempDbPath();
		const lockPath = getInstanceLockPath(dbPath);
		writeFileSync(
			lockPath,
			`${JSON.stringify({
				pid: 2147483647,
				token: "stale-token",
				dbPath,
				startedAt: "2026-01-01T00:00:00.000Z",
				argv: ["narrafork"],
			})}\n`,
			"utf8",
		);

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
});
