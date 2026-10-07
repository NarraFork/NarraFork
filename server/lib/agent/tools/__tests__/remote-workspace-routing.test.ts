import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WorkspaceContext } from "@shared/workspace-context";
import {
	createExecutionTargetContext,
	executionTargetContextKey,
} from "../../../../services/execution-policy/target-context";

import { generateId } from "../../../id";
import { settings } from "../../../settings";
import type { ExecHandle, ExecutionBackend } from "../../execution/backend";
import { withDeviceParam } from "../../execution/device-schema";
import { localToolBaseCwd, toolBaseCwd, toolExecutionCwd } from "../../execution/path-resolve";
import { posixPathSemantics, windowsPathSemantics } from "../../execution/path-semantics";
import { localBackend, setRemoteBackendResolver } from "../../execution/registry";
import type { AgentConfig, ToolContext, ToolExecutionTarget } from "../../types";

// Routing tests isolate persistence; no migration files or live database are required.
const query = { findFirst: async () => undefined, findMany: async () => [] };
interface PersistenceBuilder {
	from(): PersistenceBuilder;
	where(): PersistenceBuilder;
	values(): PersistenceBuilder;
	set(): PersistenceBuilder;
	limit(): PersistenceBuilder;
	orderBy(): PersistenceBuilder;
	returning(): PersistenceBuilder;
	onConflictDoNothing(): PersistenceBuilder;
	get(): undefined;
	all(): unknown[];
	run(): { changes: number };
}
const builder: PersistenceBuilder = {
	from: () => builder,
	where: () => builder,
	values: () => builder,
	set: () => builder,
	limit: () => builder,
	orderBy: () => builder,
	returning: () => builder,
	onConflictDoNothing: () => builder,
	get: () => undefined,
	all: () => [],
	run: () => ({ changes: 1 }),
};
mock.module("../../../../db", () => ({
	db: {
		query: new Proxy({}, { get: () => query }),
		select: () => builder,
		insert: () => builder,
		update: () => builder,
		delete: () => builder,
	},
	sqlite: {},
	activeDatabaseBackend: "sqlite",
	postgresRuntime: null,
	databaseMaintenance: {},
	startupShutdownState: {},
	markDatabaseCleanShutdown() {},
	releaseDatabaseInstanceLockOnly() {},
	closePostgresRuntime() {},
}));
const unusedPublication = () => {
	throw new Error("Unexpected publication access");
};
mock.module("../../../../services/agent-runtime/publication", () => ({
	runtimePublication: { setLegacyRuntimeAdmissionReader() {} },
	getRuntimePublicationService: unusedPublication,
	PUBLICATION_FALLBACK_BYTES: 65536,
	publicationEvent: unusedPublication,
	isRuntimePublicationUnavailableError: unusedPublication,
	publicationSummary: unusedPublication,
	createRuntimePublicationService: unusedPublication,
	createUnwiredPublicationFacade: unusedPublication,
	flushRuntimePublications: unusedPublication,
	setLegacyCompletionAdmissionReader() {},
	migrateLegacyTaskNotice: unusedPublication,
	setRuntimePublicationWake() {},
	taskPublicationRun: unusedPublication,
}));
const { resolvePermissionDecision, resolveExitPlanModeInputWithBackend } = await import(
	"../../../../services/narrator-permission"
);
const { executeTool, freezeToolExecutionTarget } = await import("../../tool-executor");
const { toolRegistry } = await import("../../tool-registry");
const { bashTool } = await import("../bash");
const { editTool } = await import("../edit");
const { globTool } = await import("../glob");
const { grepTool } = await import("../grep");
const { readTool } = await import("../read");
const { structSedTool } = await import("../struct-sed");
const { structViewTool } = await import("../struct-view");
const { switchDeviceTool } = await import("../switch-device");
const { writeTool } = await import("../write");

const configuredDir = settings.paths.defaultProjectDir;
let narratorId: string;
const trackedTools = [
	readTool,
	writeTool,
	editTool,
	globTool,
	grepTool,
	bashTool,
	structViewTool,
	structSedTool,
];
const originalTools = new Map(trackedTools.map((tool) => [tool.name, toolRegistry.get(tool.name)]));

beforeEach(() => {
	narratorId = generateId();
	for (const tool of trackedTools) toolRegistry.register(tool);
});
afterEach(() => {
	settings.paths.defaultProjectDir = configuredDir;
	setRemoteBackendResolver(null);
	for (const tool of trackedTools) {
		const original = originalTools.get(tool.name);
		if (original) toolRegistry.register(original);
		else toolRegistry.unregister(tool.name);
	}
});

function workspace(deviceId = "selected", windows = false): WorkspaceContext {
	return {
		deviceId,
		cwd: windows ? "D:\\chosen\\repo" : "/chosen/repo",
		pathFlavor: windows ? "windows" : "posix",
		revision: 7,
		contextKey: `${deviceId}:chosen:7`,
		capabilities: { switchDirectory: true },
	};
}

function remote(deviceId = "selected", windows = false) {
	const paths = windows ? windowsPathSemantics : posixPathSemantics;
	const content = Buffer.from("alpha\nbravo\n");
	const handle: ExecHandle = {
		exited: Promise.resolve(0),
		onData() {},
		isExited: () => true,
		kill: async () => {},
	};
	const backend = {
		deviceId,
		kind: "remote" as const,
		defaultCwd: windows ? "C:\\default" : `/${deviceId}/default`,
		paths,
		pathFlavor: paths.flavor,
		runtimeGeneration: 3,
		platform: {
			os: windows ? "windows" : "linux",
			arch: "amd64",
			shellType: windows ? "powershell" : "bash",
		},
		resolvePathIdentity: mock(async (path: string) => ({
			lexicalPath: paths.normalize(path),
			canonicalPath: paths.normalize(path),
			exists: true,
			runtimeGeneration: 3,
		})),
		statFile: mock(async (_path: string) => ({
			isFile: true,
			isDirectory: false,
			size: content.length,
		})),
		readFileBytes: mock(async (_path: string) => ({
			bytes: content,
			truncated: false,
			totalSize: content.length,
		})),
		writeFileBytes: mock(async (_path: string, _bytes: Uint8Array) => {}),
		mkdirp: mock(async (_path: string) => {}),
		fileExists: mock(async (_path: string) => true),
		glob: mock(async (_pattern: string, _options: Parameters<ExecutionBackend["glob"]>[1]) => []),
		grep: mock(async (_params: Parameters<ExecutionBackend["grep"]>[0]) => ({
			stdoutBytes: new Uint8Array(),
			stderr: "",
			exitCode: 1,
			truncatedByBytes: false,
			timedOut: false,
		})),
		execCommand: mock(async (_params: Parameters<ExecutionBackend["execCommand"]>[0]) => handle),
	};
	return backend;
}
function context(backend: ExecutionBackend, windows = false): ToolContext {
	return {
		narratorId,
		cwd: "/host/decoy",
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" }),
		workspaceContext: workspace(backend.deviceId, windows),
		defaultDeviceId: backend.deviceId,
		resolveBackend: () => backend,
	};
}
function config(backends: ExecutionBackend[], selected = workspace()): AgentConfig {
	setRemoteBackendResolver(
		(deviceId) => backends.find((backend) => backend.deviceId === deviceId) ?? null,
	);
	return {
		narratorId,
		conversationId: "routing-test",
		provider: "codex",
		model: "test",
		cwd: "/host/decoy",
		signal: new AbortController().signal,
		workspaceContext: selected,
		availableDevices: backends.map((backend) => ({
			id: backend.deviceId,
			name: backend.deviceId,
			slug: backend.deviceId,
			scope: "global",
			online: true,
		})),
		permissionHandler: async () => ({ behavior: "deny" }),
	};
}
async function freeze(name: string, input: Record<string, unknown>, cfg: AgentConfig) {
	return freezeToolExecutionTarget({ name, input, toolUseId: generateId() }, cfg);
}

for (const windows of [false, true]) {
	describe(`selected remote workspace (${windows ? "Windows" : "POSIX"})`, () => {
		test("all file tool admissions use selected cwd, including explicit same device", async () => {
			const backend = remote("selected", windows) as unknown as ExecutionBackend;
			const cfg = config([backend], workspace("selected", windows));
			for (const device of [undefined, "selected"]) {
				for (const name of ["Read", "Write", "Edit", "StructView", "StructSed"]) {
					const target = await freeze(name, { file_path: "notes.txt", device }, cfg);
					expect(target?.cwd).toBe(cfg.workspaceContext?.cwd);
					expect(target?.resolvedFilePath).toBe(
						backend.paths.resolve(cfg.workspaceContext?.cwd as string, "notes.txt"),
					);
				}
				for (const name of ["Glob", "Grep"]) {
					const target = await freeze(name, { pattern: "alpha", device }, cfg);
					expect(target?.cwd).toBe(cfg.workspaceContext?.cwd);
				}
			}
		});
		test("actual Read/Write/Edit/StructView/StructSed IO never uses the device default", async () => {
			const fake = remote("selected", windows);
			const backend = fake as unknown as ExecutionBackend;
			const ctx = context(backend, windows);
			const path = backend.paths.resolve(ctx.workspaceContext?.cwd as string, "notes.txt");
			const calls = [
				[readTool, { file_path: "notes.txt", limit: 2 }],
				[writeTool, { file_path: "notes.txt", content: "alpha\nbravo\n" }],
				[editTool, { file_path: "notes.txt", old_string: "alpha", new_string: "ALPHA" }],
				[structViewTool, { file_path: "notes.txt", mode: "print", address: "1" }],
				[
					structSedTool,
					{ file_path: "notes.txt", command: "replace", address: "1", content: "ALPHA" },
				],
			] as const;
			for (const [tool, input] of calls) {
				const result = await tool.execute(input, ctx);
				expect(result.isError, `${tool.name}: ${result.output}`).not.toBe(true);
			}
			for (const args of fake.statFile.mock.calls) expect(args[0]).toBe(path);
			for (const args of fake.readFileBytes.mock.calls) expect(args[0]).toBe(path);
			for (const args of fake.writeFileBytes.mock.calls) expect(args[0]).toBe(path);
		});
		test("actual search and Bash use selected cwd, and relative workdir is applied once", async () => {
			const fake = remote("selected", windows);
			const backend = fake as unknown as ExecutionBackend;
			const ctx = context(backend, windows);
			const selectedCwd = ctx.workspaceContext?.cwd;
			if (!selectedCwd) throw new Error("Fixture requires a selected workspace cwd");
			await globTool.execute({ pattern: "*.ts" }, ctx);
			await grepTool.execute({ pattern: "alpha" }, ctx);
			await structViewTool.execute({ mode: "find", symbol: "Alpha" }, ctx);
			expect(fake.glob.mock.calls[0][1]?.cwd).toBe(selectedCwd);
			for (const [args] of fake.grep.mock.calls) {
				expect(args.cwd).toBe(selectedCwd);
				expect(args.searchPath).toBe(selectedCwd);
			}
			const cfg = config([backend], workspace("selected", windows));
			ctx.executionTarget = await freeze("Bash", { command: "whoami", workdir: "src" }, cfg);
			const result = await bashTool.execute({ command: "whoami", workdir: "src" }, ctx);
			expect(result.isError, result.output).not.toBe(true);
			expect(fake.execCommand.mock.calls[0][0].cwd).toBe(backend.paths.resolve(selectedCwd, "src"));
		});
	});
}

test("cross device overrides use their own base and explicit local is pure instance default", async () => {
	const selected = remote() as unknown as ExecutionBackend;
	const other = remote("other") as unknown as ExecutionBackend;
	const cfg = config([selected, other]);
	expect(
		(await freeze("Read", { device: "other", file_path: "notes.txt" }, cfg))?.resolvedFilePath,
	).toBe("/other/default/notes.txt");
	const path = join(homedir(), `not-created-${generateId()}`);
	settings.paths.defaultProjectDir = path;
	expect(
		(await freeze("Read", { device: "local", file_path: "notes.txt" }, cfg))?.resolvedFilePath,
	).toBe(join(path, "notes.txt"));
	expect(localToolBaseCwd()).toBe(path);
	expect(existsSync(path)).toBe(false);
	expect(toolBaseCwd(other, "/host/decoy", workspace())).toBe("/other/default");
});

test("missing remote default rejects relative paths but permits an explicit absolute workdir", async () => {
	const fake = remote("other");
	const backend = { ...fake, defaultCwd: null } as unknown as ExecutionBackend;
	const cfg = config([backend]);
	await expect(freeze("Read", { device: "other", file_path: "notes.txt" }, cfg)).rejects.toThrow(
		"absolute default",
	);
	const target = await freeze(
		"Bash",
		{ device: "other", command: "whoami", workdir: "/explicit" },
		cfg,
	);
	expect(target?.cwd).toBe("/explicit");
	expect(
		(await freeze("Read", { device: "other", file_path: "/absolute/notes.txt" }, cfg))
			?.resolvedFilePath,
	).toBe("/absolute/notes.txt");
});

test("spec admissions are host virtual and offline selected workspace never falls back", async () => {
	const backend = remote() as unknown as ExecutionBackend;
	const cfg = config([backend]);
	const target = await freeze("Read", { file_path: "spec://tasks.json" }, cfg);
	expect(target).toMatchObject({
		deviceId: "local",
		cwd: "spec://",
		pathFlavor: "spec",
		lexicalPath: "spec://tasks.json",
	});
	setRemoteBackendResolver(() => null);
	await expect(freeze("Read", { file_path: "/chosen/repo/notes.txt" }, cfg)).rejects.toThrow();
	await expect(
		createExecutionTargetContext({
			backend,
			target: { ...target, deviceId: "selected", backendKind: "remote" } as ToolExecutionTarget,
		}),
	).rejects.toThrow("host virtual");
});

test("frozen permissions and IO keep selected cwd through an approval wait and retry", async () => {
	const fake = remote();
	const backend = fake as unknown as ExecutionBackend;
	const cfg = config([backend]);
	const use = { name: "Read", input: { file_path: "notes.txt" }, toolUseId: generateId() };
	const target = await freezeToolExecutionTarget(use, cfg);
	const permissions: ToolExecutionTarget[] = [];
	cfg.permissionHandler = async (_name, _input, _id, options) => {
		permissions.push(options?.executionTarget as ToolExecutionTarget);
		fake.defaultCwd = "/changed/default";
		await Promise.resolve();
		return { behavior: "allow" };
	};
	const result = await executeTool(use, cfg, { preFrozenTarget: target });
	expect(result.isError, result.output).not.toBe(true);
	expect(permissions[0]?.resolvedFilePath).toBe("/chosen/repo/notes.txt");
	expect(result.metadata?.executionTarget).toMatchObject({
		cwd: "/chosen/repo",
		resolvedFilePath: "/chosen/repo/notes.txt",
	});
	expect(fake.readFileBytes.mock.calls[0][0]).toBe("/chosen/repo/notes.txt");
	fake.readFileBytes.mockClear();
	fake.runtimeGeneration = 4;
	const retried = await executeTool(use, cfg, {
		preFrozenTarget: target,
		preGrantedPermission: { behavior: "allow" },
	});
	expect(retried.isError).toBe(true);
	expect(fake.readFileBytes).not.toHaveBeenCalled();
});

test("permission wait cannot execute after canonical target or connection generation changes", async () => {
	for (const changed of ["generation", "canonical"] as const) {
		const fake = remote();
		const backend = fake as unknown as ExecutionBackend;
		const cfg = config([backend]);
		cfg.permissionHandler = async () => {
			if (changed === "generation") fake.runtimeGeneration = 4;
			else
				fake.resolvePathIdentity.mockImplementation(async (path) => ({
					lexicalPath: path,
					canonicalPath: "/different/secret",
					exists: true,
					runtimeGeneration: 3,
				}));
			return { behavior: "allow" };
		};
		const result = await executeTool(
			{ name: "Read", input: { file_path: "notes.txt" }, toolUseId: generateId() },
			cfg,
		);
		expect(result.isError).toBe(true);
		expect(fake.readFileBytes).not.toHaveBeenCalled();
	}
});

test("effective workdir is not reapplied by Agent blacklist checks, and cache keys retain scope", async () => {
	const backend = remote() as unknown as ExecutionBackend;
	const target: ToolExecutionTarget = {
		deviceId: "selected",
		backendKind: "remote",
		cwd: "/chosen/repo/src",
		baseCwd: "/chosen/repo",
		lexicalPath: "/chosen/repo/src",
		canonicalPath: "/chosen/repo/src",
		pathFlavor: "posix",
		runtimeGeneration: 3,
		selectionSource: "session_default",
	};
	const executionContext = await createExecutionTargetContext({ backend, target });
	expect(
		resolvePermissionDecision({
			toolName: "Agent",
			input: { workdir: "src", subagent_type: "explore" },
			cwd: "/host/decoy",
			permMode: "default",
			executionContext,
			blacklistDirs: [
				{
					path: "/chosen/repo/src",
					pathFlavor: "posix",
					selector: { kind: "device", deviceId: "selected" },
					denyLevel: "denyAll",
					enabled: true,
				},
			],
		}),
	).toBe("deny");
	const otherScope = await createExecutionTargetContext({
		backend,
		target: { ...target, baseCwd: "/other" },
	});
	expect(executionTargetContextKey(executionContext)).not.toBe(
		executionTargetContextKey(otherScope),
	);
});

test("offline schema names the bound remote directory and honors the local execution ceiling", () => {
	const cfg = config([], workspace());
	cfg.allowLocalExecution = false;
	const schema = withDeviceParam({ properties: {} }, cfg) as {
		properties: { device: { enum: string[]; description: string } };
	};
	expect(schema.properties.device.enum).toEqual(["selected"]);
	expect(schema.properties.device.description).toContain("/chosen/repo");
	expect(schema.properties.device.description).toContain("offline");
});

test("same device SwitchDevice preserves chosen cwd without a transition", async () => {
	const backend = remote() as unknown as ExecutionBackend;
	const cfg = config([backend]);
	const apply = mock(async () => true);
	const ctx = {
		...context(backend),
		availableDevices: cfg.availableDevices,
		setDefaultDevice: apply,
	};
	const result = await switchDeviceTool.execute({ device: "selected" }, ctx);
	expect(result.output).toContain("/chosen/repo");
	expect(apply).not.toHaveBeenCalled();
	expect(
		toolExecutionCwd(backend, {
			...ctx,
			executionTarget: {
				deviceId: "selected",
				cwd: "/admitted",
				backendKind: "remote",
				selectionSource: "explicit",
			},
		}),
	).toBe("/admitted");
	expect(toolBaseCwd(localBackend, "/host", workspace("local"))).toBe("/chosen/repo");
});

test("cross-device Windows workdir uses the override grammar, not the POSIX workspace", async () => {
	const backend = remote("windows-device", true) as unknown as ExecutionBackend;
	const cfg = config([backend]);
	const target = await freeze(
		"Bash",
		{ device: "windows-device", command: "whoami", workdir: "src" },
		cfg,
	);
	expect(target?.cwd).toBe("C:\\default\\src");
	expect(target?.baseCwd).toBe("C:\\default");
});

test("connection drift while freezing fails before permission", async () => {
	const fake = remote();
	const backend = fake as unknown as ExecutionBackend;
	const cfg = config([backend]);
	const permission = mock(async () => ({ behavior: "allow" as const }));
	cfg.permissionHandler = permission;
	fake.resolvePathIdentity.mockImplementation(async (path) => {
		fake.runtimeGeneration = 4;
		return { lexicalPath: path, canonicalPath: path, exists: true, runtimeGeneration: 3 };
	});
	const result = await executeTool(
		{ name: "Read", input: { file_path: "notes.txt" }, toolUseId: generateId() },
		cfg,
	);
	expect(result.isError).toBe(true);
	expect(permission).not.toHaveBeenCalled();
	expect(fake.readFileBytes).not.toHaveBeenCalled();
});

test("plan file binding reads its original directory and rejects a different admitted device", async () => {
	const fake = remote();
	const bytes = Buffer.from("# Original bound plan\n\nImplement the approved change.\n");
	const stat = mock(async (path: string) => ({
		isFile: true,
		isDirectory: false,
		size: bytes.length,
		resolvedPath: path,
	}));
	const read = mock(async (path: string) => ({
		bytes,
		totalSize: bytes.length,
		truncated: false,
		resolvedPath: path,
	}));
	const backend = { ...fake, statFile: stat, readFileBytes: read } as unknown as ExecutionBackend;
	const binding = {
		workspaceContext: { ...workspace(), cwd: "/original/repo" },
		planFileId: "original",
		planFilePath: ".narrafork/plans/plan-original.md",
	};
	const result = await resolveExitPlanModeInputWithBackend(
		narratorId,
		"/later/repo",
		{ mode: "file" },
		"en",
		false,
		backend,
		undefined,
		undefined,
		{ blacklistDirs: [] },
		binding,
	);
	expect(result.ok, result.ok ? "" : result.message).toBe(true);
	expect(read.mock.calls[0][0]).toBe("/original/repo/.narrafork/plans/plan-original.md");
	const wrong = await resolveExitPlanModeInputWithBackend(
		narratorId,
		"/later/repo",
		{ mode: "file" },
		"en",
		false,
		remote("other") as unknown as ExecutionBackend,
		undefined,
		undefined,
		{ blacklistDirs: [] },
		binding,
	);
	expect(wrong.ok).toBe(false);
});

test("cross-device permission redirects retain their admitted base when device defaults change", async () => {
	const fake = remote("other");
	const backend = fake as unknown as ExecutionBackend;
	const cfg = config([backend]);
	const targets: ToolExecutionTarget[] = [];
	cfg.onExecutionTargetResolved = async (_id, target) => {
		targets.push(target);
	};
	cfg.permissionHandler = async (_name, _input, _id, options) => {
		fake.defaultCwd = "/later/default";
		await options?.onInputResolved?.({ device: "other", file_path: "final.txt" });
		return { behavior: "deny" };
	};
	const result = await executeTool(
		{ name: "Read", input: { device: "other", file_path: "draft.txt" }, toolUseId: generateId() },
		cfg,
	);
	expect(result.isError).toBe(true);
	expect(targets.map((target) => target.resolvedFilePath)).toEqual([
		"/other/default/draft.txt",
		"/other/default/final.txt",
	]);
	expect(fake.readFileBytes).not.toHaveBeenCalled();
});

test("a changed backend path grammar never reinterprets the selected workspace", () => {
	const backend = remote() as unknown as ExecutionBackend;
	expect(() => toolBaseCwd(backend, "/decoy", workspace("selected", true))).toThrow("path grammar");
});
