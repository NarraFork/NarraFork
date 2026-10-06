import { afterEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import type { ExecutionBackend } from "../execution/backend";
import { posixPathSemantics } from "../execution/path-semantics";
import type { AgentConfig, ToolDefinition } from "../types";

const databaseAccess = mock(() => {
	throw new Error("Unexpected database access");
});
mock.module("../../../db", () => ({
	db: new Proxy({}, { get: databaseAccess }),
	sqlite: new Proxy({}, { get: databaseAccess }),
	activeDatabaseBackend: "sqlite",
	postgresRuntime: null,
	databaseMaintenance: new Proxy({}, { get: databaseAccess }),
	startupShutdownState: {},
	markDatabaseCleanShutdown: databaseAccess,
	releaseDatabaseInstanceLockOnly: databaseAccess,
	closePostgresRuntime: databaseAccess,
}));
// Permission imports the session graph; keep its publication singleton from bootstrapping DB state.
mock.module("../../../services/agent-runtime/publication", () => ({
	runtimePublication: { setLegacyRuntimeAdmissionReader: () => {} },
	getRuntimePublicationService: databaseAccess,
	PUBLICATION_FALLBACK_BYTES: 65536,
	publicationEvent: databaseAccess,
	isRuntimePublicationUnavailableError: databaseAccess,
	publicationSummary: databaseAccess,
	createRuntimePublicationService: databaseAccess,
	createUnwiredPublicationFacade: databaseAccess,
	flushRuntimePublications: databaseAccess,
	setLegacyCompletionAdmissionReader: () => {},
	migrateLegacyTaskNotice: databaseAccess,
	setRuntimePublicationWake: () => {},
	taskPublicationRun: databaseAccess,
}));
const { executeTool, freezeToolExecutionTarget } = await import("../tool-executor");
const { toolRegistry } = await import("../tool-registry");
const { handlePermission, resolvePermissionDecision } = await import(
	"../../../services/narrator-permission"
);
const { localBackend, setRemoteBackendResolver } = await import("../execution/registry");
const permission = mock(async () => ({ behavior: "allow" as const }));
const persistedTarget = mock(async () => {});
const executed = mock(async () => ({ output: "done" }));
const beforeExecution = mock(async () => {});
const pathIdentity = mock(async (path: string) => ({
	lexicalPath: path,
	canonicalPath: path,
	exists: true,
	runtimeGeneration: 1,
}));
const remote = {
	deviceId: "remote-test",
	kind: "remote",
	paths: posixPathSemantics,
	defaultCwd: "/work",
	runtimeGeneration: 1,
	resolvePathIdentity: pathIdentity,
} as unknown as ExecutionBackend;
const backendResolution = mock(() => remote);
const config = (): AgentConfig => ({
	narratorId: "spec-routing",
	conversationId: "spec-routing",
	provider: "codex",
	model: "test",
	cwd: "/work",
	signal: new AbortController().signal,
	permissionHandler: permission,
	availableDevices: [
		{ id: "remote-test", name: "Remote", slug: "remote", online: true, scope: "global" },
	],
	onExecutionTargetResolved: persistedTarget,
	onToolExecutionBefore: beforeExecution,
});
const names = new Set<string>();
function register(name: string, routing?: ToolDefinition["executionRouting"]) {
	names.add(name);
	toolRegistry.register({
		name,
		description: "test",
		parameters: z.record(z.string(), z.unknown()),
		executionRouting: routing,
		execute: executed,
	});
}
const fileRouting: ToolDefinition["executionRouting"] = {
	kind: "single",
	resolve: (input) => ({
		key: "primary",
		operation: "write",
		deviceId: typeof input.device === "string" ? input.device : undefined,
		path: input.file_path as string,
		...(String(input.file_path).startsWith("spec://")
			? { hostOnly: true, pathFlavor: "spec" as const }
			: {}),
	}),
};

afterEach(() => {
	for (const name of names) toolRegistry.unregister(name);
	names.clear();
	setRemoteBackendResolver(null);
	for (const fn of [
		databaseAccess,
		permission,
		persistedTarget,
		executed,
		beforeExecution,
		pathIdentity,
		backendResolution,
	])
		fn.mockClear();
});

describe("executor Spec path validation", () => {
	test("permission entry rejects malformed inputs before database or policy shortcuts", async () => {
		for (const name of ["Read", "Write", "Edit", "Grep", "Glob", "StructView", "StructSed"]) {
			const input = { file_path: "/spec://tasks.json", path: "/spec://tasks.json", pattern: "*" };
			const decision = resolvePermissionDecision({
				toolName: name,
				input,
				cwd: "/work",
				permMode: "readOnly",
			});
			expect(decision).toBe("deny");
			const result = await handlePermission(
				"spec-routing",
				new AbortController().signal,
				name,
				input,
				"bad-permission",
				"/work",
			);
			expect(result.behavior).toBe("deny");
		}
		expect(databaseAccess).not.toHaveBeenCalled();
	});

	test("valid task maintenance keeps its read-only permission shortcut", () => {
		for (const toolName of ["Write", "Edit"]) {
			expect(
				resolvePermissionDecision({
					toolName,
					input: { file_path: "spec://tasks.json" },
					cwd: "/work",
					permMode: "readOnly",
				}),
			).toBe("allow");
		}
		expect(databaseAccess).not.toHaveBeenCalled();
	});

	test("raw Write typo is rejected by execute and freeze before resolver, permissions or scope", async () => {
		register("Write", fileRouting);
		setRemoteBackendResolver(backendResolution);
		for (const path of [
			"/spec://tasks.json",
			"spec:/tasks.json",
			"C:\\spec://tasks.json",
			"spec://notes/../tasks.json",
			"spec://notes/%2e%2e/tasks.json",
		]) {
			const use = {
				name: "Write",
				toolUseId: "bad",
				input: { file_path: path, content: "{}", device: "remote-test" },
			};
			expect((await executeTool(use, config())).isError).toBe(true);
			await expect(freezeToolExecutionTarget(use, config())).rejects.toThrow(/spec:\/\//);
		}
		for (const fn of [
			backendResolution,
			pathIdentity,
			permission,
			persistedTarget,
			executed,
			beforeExecution,
			databaseAccess,
		])
			expect(fn).not.toHaveBeenCalled();
	});

	test("all endpoints are validated before resolving the first one", async () => {
		register("__SpecMulti", {
			kind: "multi",
			resolve: () => ({
				primaryKey: "from",
				endpoints: [
					{ key: "from", operation: "read", deviceId: "remote-test", path: "/work/source" },
					{ key: "to", operation: "write", deviceId: "remote-test", path: "/spec://tasks.json" },
				],
			}),
		});
		setRemoteBackendResolver(backendResolution);
		const use = { name: "__SpecMulti", toolUseId: "multi", input: {} };
		await expect(freezeToolExecutionTarget(use, config())).rejects.toThrow(/spec:\/\//);
		expect((await executeTool(use, config())).isError).toBe(true);
		for (const fn of [
			backendResolution,
			pathIdentity,
			permission,
			persistedTarget,
			executed,
			beforeExecution,
		])
			expect(fn).not.toHaveBeenCalled();
	});

	test("pre-frozen remote targets cannot bypass raw input validation", async () => {
		register("Write", fileRouting);
		setRemoteBackendResolver(backendResolution);
		const result = await executeTool(
			{ name: "Write", toolUseId: "retry", input: { file_path: "/spec://tasks.json" } },
			config(),
			{
				preGrantedPermission: { behavior: "allow" },
				preFrozenTarget: {
					deviceId: "remote-test",
					backendKind: "remote",
					pathFlavor: "posix",
					cwd: "/work",
					selectionSource: "explicit",
					runtimeGeneration: 1,
				},
			},
		);
		expect(result.isError).toBe(true);
		expect(backendResolution).not.toHaveBeenCalled();
		expect(executed).not.toHaveBeenCalled();
	});

	test("permission returned or callback-updated inputs are revalidated before a second resolution", async () => {
		register("Write", fileRouting);
		setRemoteBackendResolver(backendResolution);
		for (const mode of ["returned", "callback", "mutated"]) {
			pathIdentity.mockClear();
			persistedTarget.mockClear();
			const cfg = config();
			cfg.permissionHandler = async (_name, input, _id, options) => {
				const updatedInput = mode === "mutated" ? input : { ...input };
				updatedInput.file_path = "/spec://tasks.json";
				if (mode === "callback") await options?.onInputResolved?.(updatedInput);
				return { behavior: "allow", updatedInput };
			};
			const result = await executeTool(
				{
					name: "Write",
					toolUseId: "rewrite",
					input: { file_path: "/work/file", device: "remote-test" },
				},
				cfg,
			);
			expect(result.isError).toBe(true);
			expect(result.output).toContain("spec://");
			expect(pathIdentity).toHaveBeenCalledTimes(1);
			expect(persistedTarget).toHaveBeenCalledTimes(1);
			expect(executed).not.toHaveBeenCalled();
			expect(beforeExecution).not.toHaveBeenCalled();
		}
	});

	test("valid Spec freezes host-only without physical path resolution", async () => {
		register("Write", fileRouting);
		setRemoteBackendResolver(backendResolution);
		const original = localBackend.resolvePathIdentity;
		localBackend.resolvePathIdentity = pathIdentity as typeof original;
		try {
			const cfg = { ...config(), defaultDeviceId: "remote-test" };
			const target = await freezeToolExecutionTarget(
				{ name: "Write", toolUseId: "valid", input: { file_path: "spec://tasks.json" } },
				cfg,
			);
			expect(target?.deviceId).toBe("local");
			expect(target?.pathFlavor).toBe("spec");
			expect(target?.lexicalPath).toBe("spec://tasks.json");
			expect(pathIdentity).not.toHaveBeenCalled();
			expect(backendResolution).not.toHaveBeenCalled();
		} finally {
			localBackend.resolvePathIdentity = original;
		}
	});

	test("unsupported tools reject canonical Spec before backend resolution", async () => {
		for (const name of ["StructView", "StructSed", "Glob"]) {
			register(name, fileRouting);
			const use = {
				name,
				toolUseId: name,
				input: { file_path: "spec://tasks.json", path: "spec://" },
			};
			await expect(freezeToolExecutionTarget(use, config())).rejects.toThrow(/not support/);
			expect((await executeTool(use, config())).isError).toBe(true);
		}
		expect(permission).not.toHaveBeenCalled();
		expect(executed).not.toHaveBeenCalled();
	});
});
