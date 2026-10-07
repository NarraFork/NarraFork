import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceContext } from "@shared/workspace-context";
import type { ExecutionBackend, ReadBytesOptions } from "../../lib/agent/execution/backend";
import { targetPathSemantics } from "../../lib/agent/execution/path-semantics";
import { exitPlanModeTool } from "../../lib/agent/tools/plan-mode";
import type { AgentConfig } from "../../lib/agent/types";
import {
	createWorkspaceFileAccess,
	readWorkspaceText,
	resolveExistingPlanFileRelPath,
	type WorkspaceFileAccess,
} from "../../lib/plan-file-path";
import { buildEffectiveSystemPrompt } from "../narrator-prompt";

function remoteFixture(cwd: string, flavor: "posix" | "windows" = "posix") {
	const paths = targetPathSemantics(flavor);
	const files = new Map<string, string>();
	const reads: Array<{ path: string; options?: ReadBytesOptions }> = [];
	const stats: string[] = [];
	const workspace: WorkspaceContext = {
		deviceId: "executor",
		cwd,
		pathFlavor: flavor,
		revision: 3,
		contextKey: `executor:${cwd}`,
		capabilities: { switchDirectory: true },
	};
	const backend = {
		deviceId: "executor",
		kind: "remote",
		paths,
		pathFlavor: flavor,
		runtimeGeneration: 7,
		defaultCwd: "/wrong-default",
		platform: {
			os: flavor === "windows" ? "windows" : "linux",
			arch: "arm64",
			shellType: flavor === "windows" ? "powershell" : "bash",
		},
		resolvePathIdentity: async (path: string) => ({
			lexicalPath: path,
			canonicalPath: path,
			exists: files.has(path),
			runtimeGeneration: backend.runtimeGeneration,
		}),
		statFile: async (path: string) => {
			stats.push(path);
			const value = files.get(path);
			return value === undefined
				? null
				: { isFile: true, isDirectory: false, size: Buffer.byteLength(value), resolvedPath: path };
		},
		readFileBytes: async (path: string, options?: ReadBytesOptions) => {
			reads.push({ path, options });
			const bytes = Buffer.from(files.get(path) ?? "");
			return {
				bytes: bytes.subarray(0, options?.maxBytes ?? bytes.length),
				truncated: bytes.length > (options?.maxBytes ?? bytes.length),
				totalSize: bytes.length,
				resolvedPath: path,
			};
		},
	} as unknown as ExecutionBackend;
	const access: WorkspaceFileAccess = createWorkspaceFileAccess({
		backend,
		workspaceContext: workspace,
		authorizeRead: async () => true,
	});
	return { backend, access, workspace, files, reads, stats, paths };
}

describe("workspace engineering file reads", () => {
	test("remote instructions ignore host decoys and backend defaultCwd", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "remote-prompt-decoy-"));
		try {
			writeFileSync(join(cwd, "CLAUDE.md"), "HOST_DECOY");
			const f = remoteFixture(cwd);
			f.files.set(f.paths.resolve(cwd, "CLAUDE.md"), "REMOTE_INSTRUCTIONS");
			const result = await buildEffectiveSystemPrompt({
				basePrompt: null,
				cwd: "/wrong-host-cwd",
				locale: "en",
				workspaceContext: f.workspace,
				fileAccess: f.access,
			});
			expect(result.prompt).toContain("REMOTE_INSTRUCTIONS");
			expect(result.prompt).toContain("Current default execution target: **executor (remote)**");
			expect(result.prompt).not.toContain("undefined (remote");
			expect(result.prompt).not.toContain("HOST_DECOY");
			expect(f.reads[0]?.path).toBe(f.paths.resolve(cwd, "CLAUDE.md"));
			expect(f.reads[0]?.options?.maxBytes).toBeGreaterThan(0);
			expect(f.reads[0]?.options?.timeoutMs).toBe(5000);
			expect(f.reads[0]?.options?.signal).toBeDefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("remote Windows uses target grammar and shell, not host detection", async () => {
		const f = remoteFixture("D:\\chosen\\repo", "windows");
		f.files.set("D:\\chosen\\repo\\AGENTS.md", "WINDOWS_REMOTE");
		const result = await buildEffectiveSystemPrompt({
			basePrompt: null,
			cwd: f.workspace.cwd,
			locale: "en",
			workspaceContext: f.workspace,
			fileAccess: f.access,
		});
		expect(result.prompt).toContain("WINDOWS_REMOTE");
		expect(result.prompt).toContain("Windows PowerShell Rules");
		expect(result.prompt).not.toContain("Windows Git Bash Rules");
		expect(f.reads[0]?.path).toBe("D:\\chosen\\repo\\AGENTS.md");
	});

	test("no access callback never probes same-name host remote engineering files", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "remote-no-access-"));
		try {
			writeFileSync(join(cwd, "AGENTS.md"), "HOST_DECOY");
			const result = await buildEffectiveSystemPrompt({
				basePrompt: null,
				cwd,
				locale: "en",
				defaultDeviceId: "offline-executor",
			});
			expect(result.prompt).not.toContain("HOST_DECOY");
			expect(result.prompt).toContain("shell: unknown");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("read denial happens before stat or bytes and cancellation reaches backend", async () => {
		const f = remoteFixture("/chosen");
		f.files.set("/chosen/AGENTS.md", "SECRET");
		await expect(
			readWorkspaceText(
				{ ...f.access, authorizeRead: async () => false },
				"/chosen/AGENTS.md",
				100,
			),
		).rejects.toThrow("denied");
		expect(f.stats).toEqual([]);
		expect(f.reads).toEqual([]);
		const abort = new AbortController();
		abort.abort(new Error("cancelled"));
		await expect(
			readWorkspaceText({ ...f.access, signal: abort.signal }, "/chosen/AGENTS.md", 100),
		).rejects.toThrow("cancelled");
		expect(f.reads).toEqual([]);
	});

	test("bounded content and runtime replacement cannot reuse frozen access", async () => {
		const f = remoteFixture("/chosen");
		f.files.set("/chosen/AGENTS.md", "0123456789");
		expect(await readWorkspaceText(f.access, "/chosen/AGENTS.md", 3)).toEqual({
			content: "012",
			truncated: true,
		});
		Object.assign(f.backend, { runtimeGeneration: 8 });
		await expect(readWorkspaceText(f.access, "/chosen/AGENTS.md", 100)).rejects.toThrow(
			"generation changed",
		);
	});

	test("ExitPlanMode freezes its original device and Windows cwd instead of the current workspace", async () => {
		const old = remoteFixture("D:\\original\\repo", "windows");
		const current = remoteFixture("/new");
		const routing = exitPlanModeTool.executionRouting;
		if (routing?.kind !== "single") throw new Error("single plan endpoint required");
		const result = await routing.resolve({ mode: "file" }, {
			cwd: "/new",
			workspaceContext: current.workspace,
			planFileBinding: {
				workspaceContext: old.workspace,
				planFileId: "cycle",
				planFilePath: ".narrafork/plans/plan-cycle.md",
			},
		} as AgentConfig);
		expect(result).toMatchObject({
			deviceId: "executor",
			workdir: "D:\\original\\repo",
			path: "D:\\original\\repo\\.narrafork\\plans\\plan-cycle.md",
		});
	});

	test("legacy plan probe uses original remote source after cwd switch", async () => {
		const old = remoteFixture("/old");
		old.files.set("/old/.narrafork/plan-cycle.md", "# Original");
		expect(await resolveExistingPlanFileRelPath("/old", "cycle", old.access)).toBe(
			".narrafork/plan-cycle.md",
		);
		const current = remoteFixture("/new");
		current.files.set("/new/.narrafork/plans/plan-cycle.md", "x".repeat(999));
		const result = await buildEffectiveSystemPrompt({
			basePrompt: null,
			cwd: "/new",
			locale: "en",
			workspaceContext: current.workspace,
			fileAccess: current.access,
			planFileAccess: old.access,
			planMode: true,
			planFilePath: ".narrafork/plan-cycle.md",
		});
		expect(result.prompt).toContain("10 bytes");
		expect(current.stats).not.toContain("/new/.narrafork/plan-cycle.md");
		expect(old.stats).toContain("/old/.narrafork/plan-cycle.md");
	});
});
