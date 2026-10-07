import { beforeEach, expect, mock, test } from "bun:test";
import type { WorkspaceContext } from "@shared/workspace-context";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { posixPathSemantics } from "../lib/agent/execution/path-semantics";
import { AppError } from "../lib/errors";
import type { EditorActor } from "./editor-document-service";

let revision = 8;
let generation = 5;
let actorExists = true;
let canWrite = true;
let canRead = true;
let online = true;
let size = 10;
let cap = 512 * 1024;
let canonicalAlias: string | undefined;
let pathDecision = "ask";
let oauth: Record<string, unknown> | null = null;
let checks: { principal: { userId: string }; need: string }[];
let rootHook: (() => void) | undefined;
const rootLookup = mock(async () => {
	rootHook?.();
	return { rootIdentity: "real-executor-root-object", maxWriteBytes: cap };
});
const unused = async (): Promise<never> => {
	throw new Error("Unexpected backend IO in authorization test");
};
const backend: ExecutionBackend = {
	readFileBytes: unused,
	writeFileBytes: unused,
	removeFile: unused,
	mkdirp: unused,
	listDir: unused,
	fileExists: unused,
	glob: unused,
	grep: unused,
	execCommand: unused,
	gitStatus: unused,
	gitDiff: unused,
	kind: "remote",
	deviceId: "remote",
	pathFlavor: "posix",
	paths: posixPathSemantics,
	supportsRemoteHistory: true,
	remoteHistory: async () => {
		throw new Error("History transport belongs to F composition");
	},
	get runtimeGeneration() {
		return generation;
	},
	async resolvePathIdentity(path: string) {
		return {
			lexicalPath: path,
			canonicalPath: canonicalAlias && path.endsWith("file.txt") ? canonicalAlias : path,
			exists: true,
			runtimeGeneration: generation,
		};
	},
	async statFile() {
		return { isDirectory: false, isFile: true, size };
	},
};
const registryExports = await import("../lib/agent/execution/registry");
mock.module("../lib/agent/execution/registry", () => ({
	...registryExports,
	resolveBackend: () => backend,
}));
const dbExports = await import("../db");
mock.module("../db", () => ({
	...dbExports,
	db: Object.assign(Object.create(dbExports.db), {
		query: {
			...dbExports.db.query,
			users: { findFirst: async () => (actorExists ? { role: "user" } : undefined) },
			narrators: {
				findFirst: async () => ({
					id: "narrator",
					ownerUserId: "different-owner",
					workspaceRevision: revision,
					workspaceContext: { contextKey: "workspace-eight" },
					permissionMode: "readOnly",
					traits: [],
				}),
			},
		},
	}),
}));
mock.module("./editor-document-runtime", () => ({ resolveRemoteEditorRoot: rootLookup }));
const aclExports = await import("./narrator-acl");
mock.module("./narrator-acl", () => ({
	...aclExports,
	NARRATOR_ACL_COLUMNS: { id: true },
	async assertNarratorAccess(_row: unknown, principal: { userId: string }, need: string) {
		checks.push({ principal, need });
		if ((need === "write" && !canWrite) || (need === "read" && !canRead))
			throw new AppError("Human viewer ACL forbids write", 403, "FORBIDDEN");
	},
}));
mock.module("./project-acl", () => ({ loadProjectForAccess: async () => ({}) }));
const oauthExports = await import("./oauth-narrator-runtime-policy");
mock.module("./oauth-narrator-runtime-policy", () => ({
	...oauthExports,
	resolveOAuthNarratorRuntimePolicy: async () => oauth,
}));
mock.module("./integration-resource-binding-service", () => ({
	integrationResourceBindingService: { get: async () => null },
}));
const deviceExports = await import("./device-connection-service");
mock.module("./device-connection-service", () => ({
	...deviceExports,
	getSessionDevices: async () => [{ id: "remote", online }],
}));
const policyExports = await import("./execution-policy/engine");
mock.module("./execution-policy/engine", () => ({
	...policyExports,
	executionPolicyEngine: {
		compile: async () => ({ evaluatePath: () => ({ decision: pathDecision }) }),
	},
}));
mock.module("./trait-layer-service", () => ({
	resolveEffectiveTraits: async () => ({ traits: [] }),
	resolveNarratorProjectId: async () => "project",
}));
const { authorizeRemoteEditorBinding } = await import("./remote-editor-access");
const workspace: WorkspaceContext = {
	deviceId: "remote",
	cwd: "/selected",
	pathFlavor: "posix",
	revision: 8,
	contextKey: "workspace-eight",
	contextProjectId: "project",
	capabilities: { switchDirectory: true },
};
const actor: EditorActor = {
	userId: "real-human",
	narratorId: "narrator",
	async authorize() {
		throw new Error("Recursive authorization is not used in this helper");
	},
};
const input = { path: "file.txt", deviceId: "remote", origin: "reference" as const };
function authorize(need: "read" | "write" = "read") {
	return authorizeRemoteEditorBinding(actor, workspace, input, need, {
		signal: AbortSignal.timeout(10_000),
		async authorizationGuard(required) {
			if (revision !== workspace.revision)
				throw new AppError("Workspace revision changed", 403, "WORKSPACE_STALE");
			if (required === "write" && !canWrite)
				throw new AppError("Human viewer ACL forbids write", 403, "FORBIDDEN");
		},
	});
}
beforeEach(() => {
	revision = 8;
	generation = 5;
	actorExists = true;
	canRead = true;
	canWrite = true;
	online = true;
	size = 10;
	cap = 512 * 1024;
	canonicalAlias = undefined;
	pathDecision = "ask";
	oauth = null;
	checks = [];
	rootHook = undefined;
	rootLookup.mockClear();
});

test("AI readOnly never prevents real human Write owner, and does not impersonate ownerUserId", async () => {
	const binding = await authorize("write");
	expect(binding.editable).toBe(true);
	expect(binding.deviceId).toBe("remote");
	expect(binding.cwd).toBe("/selected");
	expect(binding.workspaceRevision).toBe(8);
	expect(binding.runtimeGeneration).toBe(5);
	expect(binding.rootIdentity).toBe("real-executor-root-object");
	expect(checks.every((check) => check.principal.userId === "real-human")).toBe(true);
	expect(checks.some((check) => check.need === "write")).toBe(true);
});
test("readonly narrator viewer can open but cannot save", async () => {
	canWrite = false;
	const binding = await authorize();
	expect(binding.editable).toBe(false);
	expect(binding.readOnlyReason).toContain("ACL forbids write");
	await expect(authorize("write")).rejects.toThrow("ACL forbids write");
});
test("OAuth readOnly device ceiling is not bypassed by human Write", async () => {
	oauth = {
		clientId: "client",
		grantId: "grant",
		deviceIds: ["remote"],
		allowedTools: new Set(["Read", "Write"]),
		policy: { deviceAccess: { global: "readOnly", selfRegistered: "denied", host: "denied" } },
	};
	expect((await authorize()).editable).toBe(false);
	await expect(authorize("write")).rejects.toThrow("OAuth device access ceiling");
});
test("OAuth denied device cannot even read the editor source", async () => {
	oauth = {
		clientId: "client",
		grantId: "grant",
		deviceIds: ["remote"],
		allowedTools: new Set(["Read", "Write"]),
		policy: { deviceAccess: { global: "denied", selfRegistered: "denied", host: "denied" } },
	};
	await expect(authorize()).rejects.toThrow("OAuth device access ceiling");
	expect(rootLookup).not.toHaveBeenCalled();
});
test("offline device or actor revocation refuses before private history open", async () => {
	online = false;
	await expect(authorize()).rejects.toThrow("offline or unauthorized");
	online = true;
	actorExists = false;
	await expect(authorize()).rejects.toThrow("actor no longer exists");
	expect(rootLookup).not.toHaveBeenCalled();
});
test("path blacklist refuses human editing too", async () => {
	pathDecision = "deny";
	await expect(authorize("write")).rejects.toThrow("execution policy");
	expect(rootLookup).not.toHaveBeenCalled();
});
test("same-named canonical symlink endpoint is not treated as original file", async () => {
	canonicalAlias = "/different/file.txt";
	await expect(authorize()).rejects.toThrow("canonical identity changed");
	expect(rootLookup).not.toHaveBeenCalled();
});
test("workspace revision or reconnect during root lookup invalidates returned capability", async () => {
	rootHook = () => {
		revision++;
	};
	await expect(authorize()).rejects.toThrow("revision changed");
	revision = 8;
	rootHook = () => {
		generation++;
	};
	await expect(authorize()).rejects.toThrow("endpoint changed during authorization");
});
test("large source without chunk mutation capability is explicitly read-only; never plain fs.write", async () => {
	size = cap + 1;
	const binding = await authorize();
	expect(binding.editable).toBe(false);
	expect(binding.readOnlyReason).toContain("chunked remote editor saves");
	await expect(authorize("write")).rejects.toThrow("chunked remote editor saves");
});
