import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withSettingsFileLock } from "../settings-file-lock";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("withSettingsFileLock", () => {
	test("锁在回调结束后释放", () => {
		const dir = mkdtempSync(join(tmpdir(), "nf-settings-lock-"));
		dirs.push(dir);
		let ran = false;
		withSettingsFileLock(dir, () => {
			ran = true;
			expect(existsSync(join(dir, "settings.lock"))).toBe(true);
		});
		expect(ran).toBe(true);
		expect(existsSync(join(dir, "settings.lock"))).toBe(false);
	});

	test("过期锁可以被下一个写入者清掉", () => {
		const dir = mkdtempSync(join(tmpdir(), "nf-settings-lock-"));
		dirs.push(dir);
		const lock = join(dir, "settings.lock");
		mkdirSync(lock);
		const stale = new Date(Date.now() - 60_000);
		utimesSync(lock, stale, stale);
		expect(withSettingsFileLock(dir, () => "ok")).toBe("ok");
		expect(existsSync(lock)).toBe(false);
	});
});
