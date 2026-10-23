import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WorkspaceContext } from "@shared/workspace-context";
import { z } from "zod/v4";
import {
	createExecutionTargetContext,
	executionTargetContextKey,
} from "../../../../services/execution-policy/target-context";

import { toolContinuationService } from "../../../../services/tool-continuation-service";
import {
	beginQuiescingTools,
	failScheduledUpdate,
	resetUpdateCoordinationForTests,
	scheduleUpdate,
	waitForUpdateCheckpointFence,
} from "../../../../services/update-coordinator";
import { generateId } from "../../../id";
import { createWorkspaceFileAccess } from "../../../plan-file-path";
import { settings } from "../../../settings";
import type { ExecHandle, ExecutionBackend } from "../../execution/backend";
import { withDeviceParam } from "../../execution/device-schema";
import { localToolBaseCwd, toolBaseCwd, toolExecutionCwd } from "../../execution/path-resolve";
import { posixPathSemantics, windowsPathSemantics } from "../../execution/path-semantics";
import { localBackend, setRemoteBackendResolver } from "../../execution/registry";
import type { AgentConfig, ToolContext, ToolExecutionTarget } from "../../types";

// Routing tests isolate persistence; no migration files or live database are required.
const query = { findFirst: async () => undefined, findMany: async () => [] };
let terminalEndpoint:
	| { id: string; deviceId: string; cwd?: string; workspaceContext?: WorkspaceContext }
	| undefined;
const terminalQuery = { ...query, findFirst: async () => terminalEndpoint };
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
		query: new Proxy(
			{},
			{ get: (_target, table) => (table === "terminals" ? terminalQuery : query) },
		),
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
const { executeTool, freezeToolExecution, freezeToolExecutionTarget } = await import(
	"../../tool-executor"
);
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
const { terminalTool } = await import("../terminal");

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
	terminalTool,
];
const originalTools = new Map(trackedTools.map((tool) => [tool.name, toolRegistry.get(tool.name)]));

beforeEach(() => {
	narratorId = generateId();
	terminalEndpoint = undefined;
	for (const tool of trackedTools) toolRegistry.register(tool);
});
afterEach(() => {
	settings.paths.defaultProjectDir = configuredDir;
	resetUpdateCoordinationForTests();
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
function config(
	backends: ExecutionBackend[],
	selected = workspace(),
	bindings = new Map([[selected.deviceId, selected]]),
): AgentConfig {
	setRemoteBackendResolver(
		(deviceId) => backends.find((backend) => backend.deviceId === deviceId) ?? null,
	);
	const assertCurrent = (frozen: WorkspaceContext) => {
		const current = bindings.get(frozen.deviceId);
		if (
			!current ||
			current.cwd !== frozen.cwd ||
			current.contextKey !== frozen.contextKey ||
			JSON.stringify(current.binding) !== JSON.stringify(frozen.binding)
		)
			throw new Error("WORKSPACE_BINDING_STALE: original device binding changed");
	};
	return {
		narratorId,
		conversationId: "routing-test",
		resolveDeviceWorkspace: async (id) => bindings.get(id) ?? null,
		assertEndpointAuthorized: async (target) => {
			const admitted =
				target.deviceId === "local"
					? localBackend
					: backends.find((item) => item.deviceId === target.deviceId);
			if (!admitted) throw new Error("Fixture device is unauthorized");
			const generation = admitted.runtimeGeneration;
			return {
				assertStillCurrent() {
					if (admitted.runtimeGeneration !== generation)
						throw new Error("Fixture device generation changed");
				},
			};
		},
		assertDeviceWorkspaceCurrent: async (frozen) => assertCurrent(frozen),
		assertDeviceWorkspaceCurrentSync: assertCurrent,
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

test("cross device overrides cannot borrow global or host directory defaults", async () => {
	const selected = remote() as unknown as ExecutionBackend;
	const fakeOther = remote("other");
	const other = fakeOther as unknown as ExecutionBackend;
	const cfg = config([selected, other]);
	for (const device of ["other", "local"])
		await expect(freeze("Read", { device, file_path: "notes.txt" }, cfg)).rejects.toThrow(
			"WORKSPACE_DIRECTORY_NOT_CONFIGURED",
		);
	expect(fakeOther.resolvePathIdentity).not.toHaveBeenCalled();
	expect(fakeOther.readFileBytes).not.toHaveBeenCalled();
	const path = join(homedir(), `not-created-${generateId()}`);
	settings.paths.defaultProjectDir = path;
	expect(localToolBaseCwd()).toBe(path);
	expect(existsSync(path)).toBe(false);
	expect(() => toolBaseCwd(other, "/host/decoy", workspace())).toThrow(
		"WORKSPACE_DIRECTORY_NOT_CONFIGURED",
	);
});

test("missing remote default rejects relative paths but permits an explicit absolute workdir", async () => {
	const fake = remote("other");
	const backend = { ...fake, defaultCwd: null } as unknown as ExecutionBackend;
	const cfg = config([backend]);
	await expect(freeze("Read", { device: "other", file_path: "notes.txt" }, cfg)).rejects.toThrow(
		"WORKSPACE_DIRECTORY_NOT_CONFIGURED",
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
	const selected = workspace();
	const cfg = config(
		[backend],
		selected,
		new Map([
			[selected.deviceId, selected],
			["windows-device", workspace("windows-device", true)],
		]),
	);
	const target = await freeze(
		"Bash",
		{ device: "windows-device", command: "whoami", workdir: "src" },
		cfg,
	);
	expect(target?.cwd).toBe("D:\\chosen\\repo\\src");
	expect(target?.baseCwd).toBe("D:\\chosen\\repo");
});

for (const bound of [false, true]) {
	test(`live registry replacement rejects the old backend object before Read dispatch (${bound ? "bound" : "temporary"})`, async () => {
		const old = remote("A");
		const replacement = remote("A");
		replacement.runtimeGeneration = 4;
		const original = boundWorkspace("A", "/n1/a");
		const cfg = config(
			[old as unknown as ExecutionBackend],
			original,
			bound ? new Map([["A", original]]) : new Map(),
		);
		cfg.permissionHandler = async () => {
			setRemoteBackendResolver((id) =>
				id === "A" ? (replacement as unknown as ExecutionBackend) : null,
			);
			return { behavior: "allow" };
		};
		const result = await executeTool(
			{
				name: "Read",
				toolUseId: generateId(),
				input: { device: "A", file_path: bound ? "notes.txt" : "/temporary/notes.txt" },
			},
			cfg,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("runtime generation");
		expect(old.runtimeGeneration).toBe(3);
		expect(old.readFileBytes).not.toHaveBeenCalled();
		expect(replacement.readFileBytes).not.toHaveBeenCalled();
	});
}

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
	const selected = workspace();
	const cfg = config(
		[backend],
		selected,
		new Map([
			[selected.deviceId, selected],
			["other", { ...workspace("other"), cwd: "/other/session" }],
		]),
	);
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
		"/other/session/draft.txt",
		"/other/session/final.txt",
	]);
	expect(fake.readFileBytes).not.toHaveBeenCalled();
});

test("a changed backend path grammar never reinterprets the selected workspace", () => {
	const backend = remote() as unknown as ExecutionBackend;
	expect(() => toolBaseCwd(backend, "/decoy", workspace("selected", true))).toThrow("path grammar");
});

function boundWorkspace(
	deviceId: string,
	cwd: string,
	owner = narratorId,
	version = 1,
): WorkspaceContext {
	return {
		...workspace(deviceId),
		cwd,
		contextKey: `${owner}:${deviceId}:${version}`,
		binding: {
			version: 1,
			bindingId: `${owner}-${deviceId}`,
			narratorId: owner,
			deviceId,
			bindingRevision: version,
			bindingKey: `${owner}:${deviceId}:${version}`,
		},
	};
}

describe("independent narrator/device execution bindings", () => {
	test("real Read and Bash use N1/A, N1/B and N2/A independently; metadata names the actual endpoint", async () => {
		const a = remote("A");
		const b = remote("B");
		const backends = [a, b] as unknown as ExecutionBackend[];
		const n1a = boundWorkspace("A", "/n1/a");
		const n1b = boundWorkspace("B", "/n1/b");
		const n1 = config(
			backends,
			n1a,
			new Map([
				["A", n1a],
				["B", n1b],
			]),
		);
		const n2a = boundWorkspace("A", "/n2/a", "N2");
		const n2 = { ...config(backends, n2a), narratorId: "N2" };
		for (const [cfg, device, expected] of [
			[n1, "A", n1a],
			[n1, "B", n1b],
			[n2, "A", n2a],
		] as const) {
			cfg.permissionHandler = async () => ({ behavior: "allow" });
			for (const name of ["Read", "Bash"]) {
				const result = await executeTool(
					{
						name,
						toolUseId: generateId(),
						input:
							name === "Read" ? { device, file_path: "notes.txt" } : { device, command: "pwd" },
					},
					cfg,
				);
				expect(result.isError, result.output).not.toBe(true);
				expect(result.metadata?.executionWorkspace).toEqual(expected);
				expect(result.metadata?.executionTarget).toMatchObject({
					deviceId: device,
					cwd: expected.cwd,
					workspaceBinding: expected.binding,
				});
			}
		}
		expect(a.readFileBytes.mock.calls.map(([path]) => path)).toEqual([
			"/n1/a/notes.txt",
			"/n2/a/notes.txt",
		]);
		expect(b.readFileBytes.mock.calls[0][0]).toBe("/n1/b/notes.txt");
		expect(a.execCommand.mock.calls.map(([input]) => input.cwd)).toEqual(["/n1/a", "/n2/a"]);
		expect(b.execCommand.mock.calls[0][0].cwd).toBe("/n1/b");
	});

	test("non-default resource scopes do not inherit the selected device's skill, git, worktree or file-access origins", async () => {
		const a = remote("A");
		const b = remote("B");
		const first = boundWorkspace("A", "/n1/a");
		const second = {
			...boundWorkspace("B", "/n1/b"),
			git: { rootPath: "/n1/b/git", repositoryKey: "repo-b", workspaceKey: "git-b" },
		};
		const cfg = config(
			[a, b] as unknown as ExecutionBackend[],
			first,
			new Map([
				["A", first],
				["B", second],
			]),
		);
		cfg.permissionHandler = async () => ({ behavior: "allow" });
		cfg.skillRoot = "/n1/a/git";
		cfg.projectGitPath = "/n1/a/git";
		cfg.worktreePath = "/n1/a/worktree";
		cfg.skillScopeKey = "selected-A-scope";
		cfg.workspaceFileAccess = createWorkspaceFileAccess({
			backend: a as unknown as ExecutionBackend,
			workspaceContext: first,
			signal: cfg.signal,
			authorizeRead: async () => false,
		});
		const name = "__ResourceBindingOrigin";
		toolRegistry.register({
			name,
			description: "Resource scope source check",
			parameters: z.object({}),
			executionRouting: {
				kind: "single",
				resolve: () => ({ key: "primary", operation: "control", deviceId: "B", path: "." }),
			},
			async execute(_input, ctx) {
				return {
					output: "scope",
					metadata: {
						sourceSkillRoot: ctx.skillRoot,
						sourceGitPath: ctx.projectGitPath,
						sourceWorktree: ctx.worktreePath,
						sourceScopeKey: ctx.skillScopeKey,
						sourceAccess: ctx.workspaceFileAccess?.workspaceContext,
					},
				};
			},
		});
		try {
			const result = await executeTool({ name, input: {}, toolUseId: generateId() }, cfg);
			expect(result.isError, result.output).not.toBe(true);
			expect(result.metadata).toMatchObject({
				sourceSkillRoot: "/n1/b/git",
				sourceGitPath: "/n1/b/git",
				sourceScopeKey: second.binding?.bindingKey,
				executionWorkspace: second,
			});
			expect(result.metadata?.sourceWorktree).toBeUndefined();
			expect(result.metadata?.sourceAccess).toBeUndefined();
		} finally {
			toolRegistry.unregister(name);
		}
	});

	test("each endpoint of a multi-device plan retains its own binding, including a persisted retry", async () => {
		const a = remote("A");
		const b = remote("B");
		const first = boundWorkspace("A", "/n1/a");
		const second = boundWorkspace("B", "/n1/b");
		const bindings = new Map([
			["A", first],
			["B", second],
		]);
		const cfg = config([a, b] as unknown as ExecutionBackend[], first, bindings);
		cfg.permissionHandler = async () => ({ behavior: "allow" });
		const name = "__MultiBindingRead";
		toolRegistry.register({
			name,
			description: "Two real approved Read endpoints",
			parameters: z.object({}),
			executionRouting: {
				kind: "multi",
				resolve: () => ({
					primaryKey: "A",
					endpoints: [
						{ key: "A", operation: "read", deviceId: "A", path: "notes.txt" },
						{ key: "B", operation: "read", deviceId: "B", path: "notes.txt" },
					],
				}),
			},
			async execute(_input, ctx) {
				const outputs: string[] = [];
				for (const endpoint of ctx.executionPlan?.endpoints ?? []) {
					const backend = ctx.resolveBackend?.(endpoint.target.deviceId);
					if (!backend) throw new Error("Fixture endpoint backend missing");
					const result = await readTool.execute(
						{ file_path: endpoint.target.lexicalPath },
						{
							...ctx,
							cwd: endpoint.target.cwd,
							executionTarget: endpoint.target,
							workspaceContext: endpoint.target.workspaceContext,
							resolveBackend: () => backend,
						},
					);
					outputs.push(result.output);
				}
				return { output: outputs.join("\n") };
			},
		});
		try {
			const use = { name, input: {}, toolUseId: generateId() };
			const frozen = await freezeToolExecution(use, cfg);
			if (!frozen) throw new Error("Expected frozen plan");
			expect(frozen.plan.endpoints.map((endpoint) => endpoint.target.workspaceBinding)).toEqual([
				first.binding,
				second.binding,
			]);
			const result = await executeTool(use, cfg, {
				preFrozenTarget: frozen.target,
				preFrozenPlan: frozen.plan,
			});
			expect(result.isError, result.output).not.toBe(true);
			expect(result.metadata?.executionWorkspace).toEqual(first);
			expect(a.readFileBytes.mock.calls[0][0]).toBe("/n1/a/notes.txt");
			expect(b.readFileBytes.mock.calls[0][0]).toBe("/n1/b/notes.txt");
			a.readFileBytes.mockClear();
			b.readFileBytes.mockClear();
			bindings.set("B", boundWorkspace("B", "/n1/b", narratorId, 2));
			const retried = await executeTool(use, cfg, {
				preFrozenTarget: frozen.target,
				preFrozenPlan: frozen.plan,
				preGrantedPermission: { behavior: "allow" },
			});
			expect(retried.isError).toBe(true);
			expect(retried.output).toContain("WORKSPACE_BINDING_STALE");
			expect(a.readFileBytes).not.toHaveBeenCalled();
			expect(b.readFileBytes).not.toHaveBeenCalled();
			expect(frozen.plan.endpoints[1].target.workspaceBinding?.bindingRevision).toBe(1);
		} finally {
			toolRegistry.unregister(name);
		}
	});

	test("unbound relative Read/Bash perform zero RPC; explicit workdir/path is one-shot only", async () => {
		const fake = remote("B");
		const selected = boundWorkspace("A", "/n1/a");
		const bindings = new Map([["A", selected]]);
		const cfg = config([fake as unknown as ExecutionBackend], selected, bindings);
		const permission = mock(async () => ({ behavior: "allow" as const }));
		cfg.permissionHandler = permission;
		for (const [name, input] of [
			["Read", { device: "B", file_path: "notes.txt" }],
			["Bash", { device: "B", command: "pwd" }],
		] as const) {
			const result = await executeTool({ name, input, toolUseId: generateId() }, cfg);
			expect(result.isError).toBe(true);
			expect(result.output).toContain("WORKSPACE_DIRECTORY_NOT_CONFIGURED");
		}
		expect(permission).not.toHaveBeenCalled();
		expect(fake.resolvePathIdentity).not.toHaveBeenCalled();
		expect(fake.execCommand).not.toHaveBeenCalled();
		expect(fake.readFileBytes).not.toHaveBeenCalled();
		for (const [name, input] of [
			["Read", { device: "B", file_path: "/once/notes.txt" }],
			["Bash", { device: "B", command: "pwd", workdir: "/once" }],
		] as const) {
			const result = await executeTool({ name, input, toolUseId: generateId() }, cfg);
			expect(result.isError, result.output).not.toBe(true);
			expect(result.metadata?.executionWorkspace).toBeUndefined();
		}
		expect(bindings.size).toBe(1);
		expect(bindings.has("B")).toBe(false);
		expect(fake.execCommand.mock.calls[0][0].cwd).toBe("/once");
	});

	for (const stage of ["permission", "final-ticket"] as const) {
		test(`same-cwd binding version changes at ${stage} reject before real Read IO`, async () => {
			const fake = remote("A");
			const original = boundWorkspace("A", "/n1/a");
			const bindings = new Map([["A", original]]);
			const cfg = config([fake as unknown as ExecutionBackend], original, bindings);
			const change = () => bindings.set("A", boundWorkspace("A", "/n1/a", narratorId, 2));
			cfg.permissionHandler = async () => {
				if (stage === "permission") change();
				return { behavior: "allow" };
			};
			if (stage === "final-ticket")
				cfg.onToolExecutionFinalAuthorization = async () => {
					change();
					return { assertStillCurrent() {} };
				};
			const result = await executeTool(
				{ name: "Read", input: { file_path: "notes.txt" }, toolUseId: generateId() },
				cfg,
			);
			expect(result.isError).toBe(true);
			expect(result.output).toContain("WORKSPACE_BINDING_STALE");
			expect(fake.readFileBytes).not.toHaveBeenCalled();
			expect(result.metadata?.executionWorkspace).toEqual(original);
		});
	}

	test("update-queued approved Read keeps its original binding and rejects a later same-cwd version", async () => {
		const fake = remote("A");
		const original = boundWorkspace("A", "/n1/a");
		const bindings = new Map([["A", original]]);
		const cfg = config([fake as unknown as ExecutionBackend], original, bindings);
		const pending = Promise.withResolvers<void>();
		const approve = Promise.withResolvers<void>();
		const deferred = Promise.withResolvers<void>();
		const originalUpsert = toolContinuationService.upsert;
		toolContinuationService.upsert = mock(async (input) => {
			if (input.state === "paused") deferred.resolve();
			return input as never;
		}) as typeof toolContinuationService.upsert;
		try {
			cfg.permissionHandler = async (_name, _input, _id, options) => {
				options?.onAwaitingUserDecision?.();
				pending.resolve();
				await approve.promise;
				return { behavior: "allow" };
			};
			cfg.onToolExecutionStarting = async (_id, binding) => binding;
			const execution = executeTool(
				{ name: "Read", toolUseId: generateId(), input: { file_path: "notes.txt" } },
				cfg,
				{ toolCallBinding: { toolCallId: "queued-binding-receipt", attempt: 1 } },
			);
			await pending.promise;
			scheduleUpdate("binding-test");
			beginQuiescingTools();
			await waitForUpdateCheckpointFence();
			approve.resolve();
			await deferred.promise;
			bindings.set("A", boundWorkspace("A", "/n1/a", narratorId, 2));
			expect(fake.readFileBytes).not.toHaveBeenCalled();
			failScheduledUpdate("binding-test reopen");
			const result = await execution;
			expect(result.isError).toBe(true);
			expect(result.output).toContain("WORKSPACE_BINDING_STALE");
			expect(fake.readFileBytes).not.toHaveBeenCalled();
			expect(result.metadata?.executionWorkspace).toEqual(original);
		} finally {
			toolContinuationService.upsert = originalUpsert;
			resetUpdateCoordinationForTests();
		}
	});

	test("Terminal explicitly refuses another device rather than borrowing the selected binding", async () => {
		const a = remote("A");
		const b = remote("B");
		const cfg = config([a, b] as unknown as ExecutionBackend[], boundWorkspace("A", "/n1/a"));
		cfg.permissionHandler = async () => ({ behavior: "allow" });
		terminalEndpoint = { id: "terminal-B", deviceId: "B" };
		for (const action of ["read", "write", "rename"] as const) {
			const result = await executeTool(
				{
					name: "Terminal",
					toolUseId: generateId(),
					input: { action, terminal_id: "terminal-B", input: "pwd", name: "renamed" },
				},
				cfg,
			);
			expect(result.isError).toBe(true);
			expect(result.output).toContain("WORKSPACE_TERMINAL_BINDING_UNSUPPORTED");
		}
		terminalEndpoint = {
			id: "terminal-A-old",
			deviceId: "A",
			cwd: "/n1/a",
			workspaceContext: boundWorkspace("A", "/n1/a", narratorId, 0),
		};
		const oldSameDevice = await executeTool(
			{
				name: "Terminal",
				toolUseId: generateId(),
				input: { action: "read", terminal_id: "terminal-A-old" },
			},
			cfg,
		);
		expect(oldSameDevice.isError).toBe(true);
		expect(oldSameDevice.output).toContain("WORKSPACE_TERMINAL_BINDING_UNSUPPORTED");
		expect(b.execCommand).not.toHaveBeenCalled();
	});

	test("denied retry retains the exact original binding instead of refreshing its device map", async () => {
		const fake = remote("A");
		const original = boundWorkspace("A", "/n1/a");
		const bindings = new Map([["A", original]]);
		const cfg = config([fake as unknown as ExecutionBackend], original, bindings);
		const use = { name: "Read", input: { file_path: "notes.txt" }, toolUseId: generateId() };
		const target = await freezeToolExecutionTarget(use, cfg);
		bindings.set("A", boundWorkspace("A", "/replacement", narratorId, 2));
		const result = await executeTool(use, cfg, {
			preFrozenTarget: target,
			preGrantedPermission: { behavior: "allow" },
		});
		expect(result.isError).toBe(true);
		expect(result.output).toContain("WORKSPACE_BINDING_STALE");
		expect(fake.readFileBytes).not.toHaveBeenCalled();
	});

	test("late real Read completion retains the admitted workspace after its binding changes", async () => {
		const fake = remote("A");
		const original = boundWorkspace("A", "/n1/a");
		const bindings = new Map([["A", original]]);
		const cfg = config([fake as unknown as ExecutionBackend], original, bindings);
		cfg.permissionHandler = async () => ({ behavior: "allow" });
		const reading = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		fake.readFileBytes.mockImplementation(async () => {
			reading.resolve();
			await finish.promise;
			return { bytes: Buffer.from("old source\n"), truncated: false, totalSize: 11 };
		});
		const execution = executeTool(
			{ name: "Read", input: { file_path: "notes.txt" }, toolUseId: generateId() },
			cfg,
		);
		await reading.promise;
		bindings.set("A", boundWorkspace("A", "/replacement", narratorId, 2));
		finish.resolve();
		const result = await execution;
		expect(result.metadata?.executionWorkspace).toEqual(original);
		expect(result.metadata?.executionTarget).toMatchObject({
			cwd: "/n1/a",
			workspaceBinding: original.binding,
		});
		expect(fake.readFileBytes.mock.calls[0][0]).toBe("/n1/a/notes.txt");
	});
});
