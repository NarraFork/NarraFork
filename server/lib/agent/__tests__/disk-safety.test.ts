import { afterEach, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { z } from "zod/v4";
import { type DiskAssessment, DiskSpaceMonitor, diskSpaceMonitor } from "../../disk-safety";
import { DEFAULT_DISK_SAFETY } from "../../disk-safety-config";
import { getNarraforkHome } from "../../narrafork-home";
import { settings } from "../../settings";
import { checkToolDiskSafety, normalizeDiskToolResult } from "../disk-safety";
import { executeTool } from "../tool-executor";
import { toolRegistry } from "../tool-registry";
import type { AgentConfig, ToolExecutionTarget } from "../types";

const NAME = "__DiskSafetyWrite";
const MB = 1024 * 1024;
const originalSettings = settings.diskSafety;
const originalAssess = diskSpaceMonitor.assess;
const originalRead = toolRegistry.get("Read");
afterEach(() => {
	settings.diskSafety = originalSettings;
	diskSpaceMonitor.assess = originalAssess;
	toolRegistry.unregister(NAME);
	toolRegistry.unregister("Read");
	if (originalRead) toolRegistry.register(originalRead);
});

function assessment(path: string, freeMb: number): DiskAssessment {
	return {
		path,
		level: freeMb <= 64 ? "critical" : freeMb <= 256 ? "blocked" : "ok",
		space: {
			key: path === getNarraforkHome() ? "home" : "work",
			mountPath: path,
			freeBytes: freeMb * MB,
			totalBytes: 10000 * MB,
			checkedAt: 1,
		},
	};
}
function config(): AgentConfig {
	return {
		narratorId: "disk-safety-test",
		conversationId: "disk-safety-test",
		provider: "anthropic",
		model: "test",
		cwd: tmpdir(),
		signal: new AbortController().signal,
		locale: "zh-CN",
		permissionHandler: async () => ({ behavior: "allow" }),
	};
}

describe("disk guard tool admission", () => {
	test("permission approval cannot bypass low-space refusal; no snapshot or tool is started", async () => {
		settings.diskSafety = { ...DEFAULT_DISK_SAFETY };
		diskSpaceMonitor.assess = mock(async (path) => assessment(path, 200));
		const execute = mock(async () => ({ output: "wrote" }));
		const before = mock(async () => {});
		const after = mock(async () => {});
		const starting = mock(async (_id, binding) => binding);
		toolRegistry.register({
			name: NAME,
			description: "disk test",
			parameters: z.object({}),
			execute,
		});
		const cfg = config();
		cfg.onToolExecutionBefore = before;
		cfg.onToolExecutionAfter = after;
		cfg.onToolExecutionStarting = starting;
		const result = await executeTool({ name: NAME, toolUseId: "low", input: {} }, cfg);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("本次写入已拒绝");
		expect(result.metadata?.diskSafety).toMatchObject({ code: "DISK_SPACE_LOW", occurred: false });
		expect(execute).not.toHaveBeenCalled();
		expect(before).not.toHaveBeenCalled();
		expect(after).not.toHaveBeenCalled();
		expect(starting).not.toHaveBeenCalled();
	});

	test("critical home marks a mutating tool fatal even if its worktree has ample space", async () => {
		settings.diskSafety = { ...DEFAULT_DISK_SAFETY };
		diskSpaceMonitor.assess = mock(async (path) =>
			assessment(path, path === getNarraforkHome() ? 10 : 2048),
		);
		toolRegistry.register({
			name: NAME,
			description: "disk test",
			parameters: z.object({}),
			execute: async () => ({ output: "write" }),
		});
		const result = await executeTool({ name: NAME, toolUseId: "critical", input: {} }, config());
		expect(result.fatal).toBe(true);
		expect(result.isError).toBe(true);
	});

	test("read-only tools remain available on a critical worktree disk when HOME is healthy", async () => {
		settings.diskSafety = { ...DEFAULT_DISK_SAFETY };
		diskSpaceMonitor.assess = mock(async (path) =>
			assessment(path, path === getNarraforkHome() ? 2048 : 10),
		);
		toolRegistry.register({
			name: "Read",
			description: "disk test read",
			parameters: z.object({}),
			execute: async () => ({ output: "file content" }),
		});
		const cfg = config();
		cfg.narratorId = "disk-read-notice";
		const result = await executeTool({ name: "Read", toolUseId: "read", input: {} }, cfg);
		expect(result.isError).not.toBe(true);
		expect(result.fatal).not.toBe(true);
		expect(result.output).toContain("file content");
		expect(result.output).toContain("磁盘空间警告");
	});

	test("critical HOME also stops read history writes but background cancellation remains available", async () => {
		settings.diskSafety = { ...DEFAULT_DISK_SAFETY };
		diskSpaceMonitor.assess = mock(async (path) => assessment(path, 10));
		const execute = mock(async () => ({ output: "content" }));
		toolRegistry.register({
			name: "Read",
			description: "disk read",
			parameters: z.object({}),
			execute,
		});
		const result = await executeTool(
			{ name: "Read", toolUseId: "critical-read", input: {} },
			config(),
		);
		expect(result.fatal).toBe(true);
		expect(execute).not.toHaveBeenCalled();
		await expect(
			checkToolDiskSafety(
				"Bash",
				{ stop: "background-writer" },
				{ narratorId: "cancel-under-pressure", cwd: "/work", locale: "en" },
			),
		).resolves.toBeDefined();
	});

	test("warn mode explicitly lets the tool run; off performs no probes", async () => {
		settings.diskSafety = { ...DEFAULT_DISK_SAFETY, mode: "warn" };
		const assess = mock(async (path: string) => assessment(path, 10));
		diskSpaceMonitor.assess = assess;
		const execute = mock(async () => ({ output: "override write" }));
		toolRegistry.register({
			name: NAME,
			description: "disk test",
			parameters: z.object({}),
			execute,
		});
		expect(
			(await executeTool({ name: NAME, toolUseId: "override", input: {} }, config())).isError,
		).not.toBe(true);
		expect(execute).toHaveBeenCalledTimes(1);
		assess.mockClear();
		settings.diskSafety.mode = "off";
		await executeTool({ name: NAME, toolUseId: "off", input: {} }, config());
		expect(assess).not.toHaveBeenCalled();
	});
});

describe("tool path coverage and error consistency", () => {
	const local: ToolExecutionTarget = {
		deviceId: "local",
		backendKind: "local",
		cwd: "/work",
		canonicalPath: "/other-volume/file",
		selectionSource: "local_default",
	};
	test("canonical input and multi-target destination partitions are checked", async () => {
		const resolveVolume = mock(async (path: string) => ({ key: path, mountPath: path }));
		const monitor = new DiskSpaceMonitor({
			resolveVolume,
			statVolume: async () => ({ freeBytes: 2048 * MB, totalBytes: 10000 * MB }),
			now: Date.now,
		});
		await checkToolDiskSafety(
			"StructSed",
			{},
			{
				narratorId: "multi",
				cwd: "/work",
				locale: "en",
				executionPlan: {
					kind: "multi",
					primaryKey: "source",
					endpoints: [
						{ key: "source", operation: "write", target: local },
						{
							key: "destination",
							operation: "write",
							target: { ...local, canonicalPath: "/third-volume/dest" },
						},
					],
				},
			},
			monitor,
			DEFAULT_DISK_SAFETY,
			"/home",
		);
		expect(resolveVolume.mock.calls.map((c) => c[0])).toEqual(
			expect.arrayContaining(["/home", "/work", "/other-volume/file", "/third-volume/dest"]),
		);
	});

	test("remote paths are not probed on the host; host home remains covered", async () => {
		const resolveVolume = mock(async (path: string) => ({ key: path, mountPath: path }));
		const monitor = new DiskSpaceMonitor({
			resolveVolume,
			statVolume: async () => ({ freeBytes: 2048 * MB, totalBytes: 10000 * MB }),
			now: Date.now,
		});
		const result = await checkToolDiskSafety(
			"Read",
			{},
			{
				narratorId: "remote-check",
				cwd: "/remote",
				locale: "zh-CN",
				executionTarget: { ...local, backendKind: "remote", deviceId: "device" },
			},
			monitor,
			DEFAULT_DISK_SAFETY,
			"/home",
		);
		expect(resolveVolume.mock.calls.map((c) => c[0])).toEqual(["/home"]);
		expect(result.notice).toContain("远程设备磁盘空间尚不能探测");
	});

	test("failure normalization preserves evidence and never treats successful source text as ENOSPC", () => {
		const raw = {
			output: "Error: ENOSPC: no space left on device",
			isError: true,
			metadata: { observed: "partial" },
		};
		const normalized = normalizeDiskToolResult(raw, "/data/file", "zh-CN");
		expect(normalized.output).toContain("可能已部分写入");
		expect(normalized.output).toContain(raw.output);
		expect(normalized.metadata?.observed).toBe("partial");
		const success = { output: "const ENOSPC = 'test';" };
		expect(normalizeDiskToolResult(success, "/file", "en")).toBe(success);
	});
});
