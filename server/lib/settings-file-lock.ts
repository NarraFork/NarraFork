/**
 * settings.json 的跨进程写锁。
 *
 * 管理器面板和正在运行的服务都会整份读改写同一文件。锁内重新读取再改自己的字段，
 * 后拿到锁的一方才能看见对方刚写入的键。用 mkdir 抢锁：创建目录在同一文件系统上是原子的。
 */

import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const STALE_MS = 15_000;
const WAIT_MS = 2_000;

function sleepBriefly(ms: number): void {
	const buffer = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(buffer, 0, 0, ms);
}

export function withSettingsFileLock<T>(directory: string, fn: () => T): T {
	const lockDir = join(directory, "settings.lock");
	const deadline = Date.now() + WAIT_MS;
	for (;;) {
		try {
			mkdirSync(lockDir);
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(lockDir).mtimeMs > STALE_MS) {
					rmSync(lockDir, { recursive: true, force: true });
					continue;
				}
			} catch {
				// 锁目录刚被对方释放。
			}
			if (Date.now() >= deadline) {
				throw new Error("Timed out waiting for the settings.json lock");
			}
			sleepBriefly(20);
		}
	}
	try {
		return fn();
	} finally {
		rmSync(lockDir, { recursive: true, force: true });
	}
}
