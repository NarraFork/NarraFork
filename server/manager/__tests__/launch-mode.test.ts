import { describe, expect, test } from "bun:test";
import { shouldRunManager } from "../launch-mode";

describe("shouldRunManager", () => {
	test("Windows 编译产物默认进入管理器", () => {
		expect(shouldRunManager({ argv: ["narrafork.exe"], platform: "win32", compiled: true })).toBe(
			true,
		);
	});

	test("源码启动仍直接跑服务", () => {
		expect(
			shouldRunManager({
				argv: ["bun", "server/index.ts"],
				platform: "win32",
				compiled: false,
			}),
		).toBe(false);
	});

	test("--serve 永远是服务进程", () => {
		expect(
			shouldRunManager({ argv: ["narrafork.exe", "--serve"], platform: "win32", compiled: true }),
		).toBe(false);
	});

	test("开发时 --manager 进入面板", () => {
		expect(
			shouldRunManager({
				argv: ["bun", "server/index.ts", "--manager"],
				platform: "win32",
				compiled: false,
			}),
		).toBe(true);
	});

	test("其它平台不进管理器", () => {
		expect(
			shouldRunManager({ argv: ["narrafork", "--manager"], platform: "linux", compiled: true }),
		).toBe(false);
	});
});
