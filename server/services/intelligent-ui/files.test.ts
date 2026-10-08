import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionBackend } from "@server/lib/agent/execution/backend";
import { LocalBackend } from "@server/lib/agent/execution/local-backend";
import { intelligentUiParameters } from "@server/lib/agent/tools/intelligent-ui";
import type { ToolContext } from "@server/lib/agent/types";
import { readIntelligentUiFileReference } from "@shared/intelligent-ui-files";
import {
	assertReferenceWorkspace,
	checkedIdentity,
	collectSources,
	validateDirectory,
} from "./files";
import { executeIntelligentUiTool, type UiToolDependencies } from "./runtime";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "nf-ui-files-"));
	roots.push(root);
	const backend = new LocalBackend();
	const base = join(root, ".narrafork/intelligent_ui");
	const ctx: ToolContext & Required<Pick<ToolContext, "workspaceContext" | "executionTarget">> = {
		narratorId: "n",
		userId: "actor",
		cwd: root,
		locale: "en",
		signal: new AbortController().signal,
		currentToolUseId: "use",
		toolCallBinding: { toolCallId: "call", attempt: 1 },
		requestPermission: async () => ({ behavior: "allow" }),
		resolveBackend: () => backend,
		workspaceContext: {
			revision: 1,
			deviceId: "local",
			cwd: root,
			pathFlavor: "posix",
			contextKey: "workspace",
			capabilities: { switchDirectory: true },
		},
		executionTarget: {
			deviceId: "local",
			backendKind: "local",
			cwd: root,
			pathFlavor: "posix",
			canonicalPath: base,
			lexicalPath: base,
			runtimeGeneration: backend.runtimeGeneration,
			selectionSource: "session_default",
		},
	};
	const events: string[] = [];
	const deps: UiToolDependencies = {
		nextId: () => "unique",
		admitCreate: async () => {
			events.push("admit");
		},
		async change(request) {
			events.push(`journal:${request.filePath}`);
			const prepared = await request.construct({ bytes: null, mode: null, identity: null });
			await request.backend.writeFileBytes(request.filePath, prepared.nextBytes, {
				expectedResolvedPath: request.filePath,
				exclusive: request.exclusiveCreate,
			});
			return prepared.result;
		},
		authorizeWrite: async (_ctx, _backend, path) => {
			events.push(`write:${path}`);
		},
		authorizeRead: async (_ctx, _backend, path) => {
			events.push(`read:${path}`);
		},
		snapshot: async (_ctx, _backend, path) => {
			events.push(`snapshot:${path}`);
		},
		track: async (_ctx, _backend, path) => {
			events.push(`track:${path}`);
		},
	};
	return { root, base, ctx, backend, deps, events };
}

describe("ordinary Intelligent UI workspace files", () => {
	test("requires only create prefix or show path with object-root schema", () => {
		expect(
			intelligentUiParameters.safeParse({ action: "create", prefix: "订单-form" }).success,
		).toBe(true);
		for (const value of [
			{ action: "create", prefix: "../escape" },
			{ action: "create", prefix: "a/b" },
			{ action: "create" },
			{ action: "show" },
			{ action: "catalog" },
			{ action: "show", path: "x", prefix: "extra" },
			{ action: "create", prefix: "ok", path: "x" },
		])
			expect(intelligentUiParameters.safeParse(value).success).toBe(false);
	});
	test("creates one ordinary App.tsx, no config/package, through file journal and attribution", async () => {
		const { root, ctx, deps, events } = await fixture();
		const result = await executeIntelligentUiTool({ action: "create", prefix: "订单" }, ctx, deps);
		const ref = readIntelligentUiFileReference(result.metadata?.intelligentUi);
		expect(ref?.directory).toBe(join(root, ".narrafork/intelligent_ui/订单-unique"));
		expect(ref?.toolUseId).toBe("use");
		expect(ref?.toolCallId).toBe("call");
		const directory = ref?.directory as string;
		expect(await readdir(directory)).toEqual(["App.tsx"]);
		expect(await readFile(join(directory, "App.tsx"), "utf8")).toContain(
			"export default function App",
		);
		expect(events[0]).toBe("admit");
		expect(events).toContain(`journal:${directory}/App.tsx`);
		expect(events).not.toContain(`snapshot:${directory}/App.tsx`);
		expect(events).toContain(`track:${directory}/App.tsx`);
	});
	test("remote compatibility explicitly reports unavailable message-history rollback", async () => {
		const { ctx, deps, backend, events } = await fixture();
		const remote = Object.assign(Object.create(backend), {
			kind: "remote",
			deviceId: "remote",
		}) as ExecutionBackend;
		ctx.resolveBackend = () => remote;
		ctx.executionTarget = { ...ctx.executionTarget, backendKind: "remote", deviceId: "remote" };
		ctx.workspaceContext = { ...ctx.workspaceContext, deviceId: "remote" };
		const result = await executeIntelligentUiTool({ action: "create", prefix: "demo" }, ctx, {
			...deps,
			change: async () => undefined,
		});
		expect(result.output).toContain("cannot be reverted through message history");
		expect(result.metadata?.fileChangeHistoryUnavailable).toBe(true);
		expect(result.metadata?.fileChangeHistoryReason).toBe("remote_journal_unsupported");
		expect(result.metadata?.fileChangeEvidence).toBeUndefined();
		const ref = readIntelligentUiFileReference(result.metadata?.intelligentUi);
		expect(events).toContain(`snapshot:${ref?.directory}/App.tsx`);
	});
	test("exclusive mkdir collision retries without touching existing content", async () => {
		const { base, ctx, deps } = await fixture();
		const first = join(base, "demo-collision");
		await mkdir(first, { recursive: true });
		await writeFile(join(first, "App.tsx"), "do not overwrite");
		const ids = ["collision", "success"];
		const result = await executeIntelligentUiTool({ action: "create", prefix: "demo" }, ctx, {
			...deps,
			nextId: () => ids.shift() as string,
		});
		expect(result.output).toContain("demo-success");
		expect(await readFile(join(first, "App.tsx"), "utf8")).toBe("do not overwrite");
	});
	test("atomic final mkdir allows exactly one concurrent creator", async () => {
		const { root, backend } = await fixture();
		const path = join(root, "exclusive");
		const outcomes = await Promise.all(
			Array.from({ length: 8 }, () => backend.mkdirExclusive(path, { expectedResolvedPath: path })),
		);
		expect(outcomes.filter(Boolean)).toHaveLength(1);
	});
	test("exclusive file writes do not overwrite an existing entry", async () => {
		const { root, backend } = await fixture();
		const path = join(root, "App.tsx");
		await writeFile(path, "existing");
		await expect(
			backend.writeFileBytes(path, new TextEncoder().encode("new"), {
				expectedResolvedPath: path,
				exclusive: true,
			}),
		).rejects.toThrow();
		await expect(
			backend.writeFileBytes(path, new TextEncoder().encode("new"), { exclusive: true }),
		).rejects.toThrow();
		expect(await readFile(path, "utf8")).toBe("existing");
	});
	test("Git worktree root wins over a nested cwd", async () => {
		const { root, ctx, deps } = await fixture();
		const cwd = join(root, "nested");
		await mkdir(cwd);
		ctx.cwd = cwd;
		ctx.workspaceContext = {
			...ctx.workspaceContext,
			cwd,
			git: { rootPath: root, workspaceKey: "git-key", repositoryKey: "repo" },
		};
		ctx.executionTarget = { ...ctx.executionTarget, cwd };
		const result = await executeIntelligentUiTool({ action: "create", prefix: "demo" }, ctx, deps);
		expect(result.output).toContain(join(root, ".narrafork/intelligent_ui/demo-unique"));
		expect(readIntelligentUiFileReference(result.metadata?.intelligentUi)?.workspaceKey).toBe(
			"git-key",
		);
	});
	test("show validates only files and returns metadata without rebuilding or writing", async () => {
		const { base, ctx, deps, events } = await fixture();
		const directory = join(base, "existing");
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "App.tsx"), "export default ()=>null");
		ctx.executionTarget = {
			...ctx.executionTarget,
			lexicalPath: directory,
			canonicalPath: directory,
		};
		const result = await executeIntelligentUiTool({ action: "show", path: directory }, ctx, deps);
		expect(result.output).toStartWith("Preview:");
		expect(events).toEqual([`read:${directory}/App.tsx`]);
	});
	test("rejects stale workspace and offline/legacy remote without local fallback", async () => {
		const { ctx, deps, backend, root } = await fixture();
		ctx.assertWorkspaceCurrent = () => {
			throw new Error("workspace changed");
		};
		await expect(
			executeIntelligentUiTool({ action: "create", prefix: "x" }, ctx, deps),
		).rejects.toThrow("workspace changed");
		ctx.assertWorkspaceCurrent = undefined;
		ctx.resolveBackend = () => {
			throw new Error("remote offline");
		};
		await expect(
			executeIntelligentUiTool({ action: "create", prefix: "x" }, ctx, deps),
		).rejects.toThrow("remote offline");
		ctx.resolveBackend = () =>
			Object.assign(Object.create(backend), { mkdirExclusive: undefined }) as ExecutionBackend;
		await expect(
			executeIntelligentUiTool({ action: "create", prefix: "x" }, ctx, deps),
		).rejects.toThrow("upgrade");
		expect(await readdir(root)).toEqual([]);
	});
	test("rejects symlinked roots, outside directories and symlinked imported files", async () => {
		const { root, base, backend, ctx } = await fixture();
		const directory = join(base, "safe");
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "App.tsx"), "export default ()=>null");
		await expect(
			validateDirectory(backend, ctx.workspaceContext, root, ctx.signal),
		).rejects.toThrow("directly inside");
		await writeFile(join(root, "outside.ts"), "secret");
		await symlink(join(root, "outside.ts"), join(directory, "escape.ts"));
		await expect(
			checkedIdentity(backend, join(directory, "escape.ts"), ctx.signal),
		).rejects.toThrow("symbolic links");
		// The local bounded glob omits symlinks; even a backend that lists one is rejected.
		const includingAlias = Object.assign(Object.create(backend), {
			glob: async () => ["App.tsx", "escape.ts"],
		}) as ExecutionBackend;
		await expect(
			collectSources(includingAlias, directory, async (path) => path, ctx.signal),
		).rejects.toThrow("symbolic links");
	});
	test("enforces file count, single-file, total-source limits and per-file authorization", async () => {
		const { base, backend, ctx } = await fixture();
		const directory = join(base, "bounded");
		await mkdir(directory, { recursive: true });
		const app = join(directory, "App.tsx");
		await writeFile(app, "export default ()=>null");
		await expect(
			collectSources(
				backend,
				directory,
				async () => {
					throw new Error("Read denied");
				},
				ctx.signal,
			),
		).rejects.toThrow("Read denied");
		await writeFile(app, "x".repeat(512 * 1024 + 1));
		await expect(
			collectSources(backend, directory, async (path) => path, ctx.signal),
		).rejects.toThrow("512 KiB");
		await writeFile(app, "x".repeat(512 * 1024));
		for (let i = 0; i < 4; i++) await writeFile(join(directory, `${i}.ts`), "x".repeat(512 * 1024));
		await expect(
			collectSources(backend, directory, async (path) => path, ctx.signal),
		).rejects.toThrow("limit");
		await rm(directory, { recursive: true });
		await mkdir(directory);
		await Promise.all(
			Array.from({ length: 129 }, (_, i) => writeFile(join(directory, `${i}.ts`), "x")),
		);
		await expect(
			collectSources(backend, directory, async (path) => path, ctx.signal),
		).rejects.toThrow("128-file");
	});
	test("saved references cannot authorize another cwd or device", async () => {
		const { ctx, backend } = await fixture();
		const reference = {
			version: 1 as const,
			toolUseId: "use",
			toolCallId: "call",
			deviceId: "remote",
			workspaceKey: "workspace",
			cwd: ctx.cwd,
			directory: "d",
			entry: "App.tsx",
			title: "x",
		};
		expect(() => assertReferenceWorkspace(reference, ctx.workspaceContext, backend)).toThrow(
			"different execution workspace",
		);
	});
});
