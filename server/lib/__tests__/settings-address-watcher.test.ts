import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { startServerAddressWatcher } = await import("../settings-address-watcher");

// 每个用例独立的 NARRAFORK_HOME；getNarraforkHome 惰性读 env，动态 import 后也生效。
let home = "";
const tempDirs: string[] = [];

function writeSettings(server: unknown): void {
	writeFileSync(join(home, "settings.json"), JSON.stringify({ server }), "utf8");
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("waitFor timeout");
}

describe("settings-address-watcher", () => {
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "nf-watcher-"));
		tempDirs.push(home);
		process.env.NARRAFORK_HOME = home;
	});

	afterAll(() => {
		delete process.env.NARRAFORK_HOME;
		for (const dir of tempDirs) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// Windows 上 watcher 句柄可能延迟释放，清理失败可忽略。
			}
		}
	});

	test("缺 settings.json 时拒绝启动", () => {
		expect(startServerAddressWatcher({ isCurrent: () => false, onChanged: () => {} })).toBe(false);
	});

	test("地址变化触发 onChanged", async () => {
		writeSettings({ host: "0.0.0.0", port: 7779 });
		const seen: Array<{ host: string; port: number }> = [];
		const started = startServerAddressWatcher({
			isCurrent: () => false,
			onChanged: (address) => seen.push(address),
		});
		expect(started).toBe(true);
		writeSettings({ host: "0.0.0.0", port: 8080 });
		await waitFor(() => seen.length > 0);
		expect(seen).toEqual([{ host: "0.0.0.0", port: 8080 }]);
	});

	test("isCurrent 为真时跳过重绑", async () => {
		writeSettings({ host: "localhost", port: 7779 });
		const seen: unknown[] = [];
		startServerAddressWatcher({
			isCurrent: () => true,
			onChanged: (address) => seen.push(address),
		});
		writeSettings({ host: "localhost", port: 9000 });
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(seen).toHaveLength(0);
	});

	test("写回相同地址不触发", async () => {
		writeSettings({ host: "127.0.0.1", port: 7779 });
		const seen: unknown[] = [];
		startServerAddressWatcher({
			isCurrent: () => false,
			onChanged: (address) => seen.push(address),
		});
		writeSettings({ host: "127.0.0.1", port: 7779 });
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(seen).toHaveLength(0);
	});

	test("半写入（非法 JSON）不崩溃，恢复合法内容后照常触发", async () => {
		writeSettings({ host: "0.0.0.0", port: 7779 });
		const seen: unknown[] = [];
		startServerAddressWatcher({
			isCurrent: () => false,
			onChanged: (address) => seen.push(address),
		});
		writeFileSync(join(home, "settings.json"), "{oops", "utf8");
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(seen).toHaveLength(0);
		writeSettings({ host: "0.0.0.0", port: 8443 });
		await waitFor(() => seen.length > 0);
		expect(seen).toEqual([{ host: "0.0.0.0", port: 8443 }]);
	});
});
