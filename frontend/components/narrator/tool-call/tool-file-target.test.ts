import { describe, expect, test } from "bun:test";
import { toolExecutionFallback, toolFileTarget } from "./tool-file-target";

describe("toolFileTarget", () => {
	test("structured snapshot wins over changed default device, display input and output", () => {
		expect(
			toolFileTarget(
				{
					executionTarget: {
						deviceId: "original",
						cwd: "/work/repo/.worktrees/topic",
						lexicalPath: "/work/repo/.worktrees/topic/图 像.png",
					},
					executionDeviceId: "other",
					resolvedFilePath: "/wrong",
				},
				"display.png",
			),
		).toEqual({ deviceId: "original", path: "/work/repo/.worktrees/topic/图 像.png" });
	});
	test.each([
		["/中文/空 格/#literal%20.txt", "/unused", "/中文/空 格/#literal%20.txt"],
		["D:\\项目\\图 像.png", "/unused", "D:/项目/图 像.png"],
		[
			".test-build/img.png",
			"/repo/.worktrees/topic/frontend",
			"/repo/.worktrees/topic/frontend/.test-build/img.png",
		],
		["文档\\a.txt", "C:\\原目录", "C:/原目录/文档/a.txt"],
	])("resolves the literal path %s only against captured cwd", (path, cwd, expected) => {
		expect(toolFileTarget({ executionDeviceId: "Remote", executionCwd: cwd }, path)).toEqual({
			deviceId: "Remote",
			path: expected,
		});
	});
	test("absolute recorded paths need a recorded device, not today's cwd", () => {
		expect(
			toolFileTarget({ executionDeviceId: "local", resolvedFilePath: "/original/a.txt" }, "a.txt"),
		).toEqual({ deviceId: "local", path: "/original/a.txt" });
		expect(toolFileTarget({}, "/absolute/a.txt")).toBeNull();
		expect(toolFileTarget({ executionDeviceId: "Remote" }, "relative/a.txt")).toBeNull();
	});
	test.each([
		"\\\\server\\share\\图 像.png",
		"//server/share/a.txt",
		"C:relative.txt",
		"spec://index.md",
		"https://example.test/a.txt",
	])("unsupported target %s fails closed instead of becoming relative/local", (path) => {
		expect(
			toolFileTarget({ executionDeviceId: "Remote", executionCwd: "C:/work" }, path),
		).toBeNull();
	});
	test("execution fallback never borrows another attempt or COW row identity", () => {
		const call = {
			id: "tc",
			executionAttempt: 2,
			executionDeviceId: "Remote",
			executionCwd: "/original",
		};
		expect(toolExecutionFallback({ tcId: "tc", executionAttempt: 2 }, call)).toBe(call);
		expect(toolExecutionFallback({ tcId: "other", executionAttempt: 2 }, call)).toBeUndefined();
		expect(toolExecutionFallback({ tcId: "tc", executionAttempt: 1 }, call)).toBeUndefined();
		expect(toolExecutionFallback({ status: "success" }, call)).toBeUndefined();
		expect(toolExecutionFallback({ tcId: "other" }, call)).toBeUndefined();
		expect(toolExecutionFallback({ tcId: "tc", status: "success" }, call)).toBe(call);
	});
});
