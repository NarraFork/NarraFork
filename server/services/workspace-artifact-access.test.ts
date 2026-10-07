import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { WorkspaceContext } from "@shared/workspace-context";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { posixPathSemantics } from "../lib/agent/execution/path-semantics";
import type { ToolContext, ToolExecutionTarget } from "../lib/agent/types";
import { narraforkDir } from "../lib/settings";
import { resolveRuntimePolicy } from "./agent-runtime/policy";

let actorExists = true;
let role = "user";
let permissionMode = "readOnly";
let planMode = false;
let relaxedPlan = false;
let narratorTraits: string[] = [];
let userTraits: string[] = [];
let projectTraits: string[] = [];
let traitInputs: unknown[] = [];
let aclWrite = true;
let aclRead = true;
let projectWrite = true;
let projectRead = true;
let revision = 3;
let contextKey = "remote-context";
let generation = 7;
let online = true;
let devicesAuthorized = true;
let decision = "ask";
let runtime: Record<string, unknown> | null = null;
let binding: Record<string, unknown> | null = null;
let blacklist: { path: string; denyLevel: "denyAll" | "denyWrite" }[] = [];
let aliases = new Map<string, string>();
let compiledClasses: unknown[] = [];
let actorChecks: unknown[] = [];
let authorityNarrators: string[] = [];
let policyNarrators: string[] = [];
let aclChecks: unknown[] = [];
let policyOperations: string[] = [];
let compileHook: (() => void) | undefined;
let fence = mock(async () => {});

const remote = {
	kind: "remote",
	deviceId: "remote",
	pathFlavor: "posix",
	paths: posixPathSemantics,
	get runtimeGeneration() {
		return generation;
	},
	async resolvePathIdentity(path: string) {
		return {
			lexicalPath: path,
			canonicalPath: aliases.get(path) ?? path,
			exists: true,
			runtimeGeneration: generation,
		};
	},
} as ExecutionBackend;
const local = {
	...remote,
	kind: "local",
	deviceId: "local",
	get runtimeGeneration() {
		return generation;
	},
} as ExecutionBackend;

mock.module("../db", () => ({
	db: {
		query: {
			users: { findFirst: async () => (actorExists ? { role } : undefined) },
			narrators: {
				findFirst: async () => ({
					id: "narrator",
					ownerUserId: "owner-not-actor",
					permissionMode,
					planMode,
					relaxedPlan,
					traits: narratorTraits,
					workspaceRevision: revision,
					workspaceContext: { contextKey },
				}),
			},
		},
	},
}));
mock.module("../lib/agent/execution/registry", () => ({
	resolveBackend: ({ requested }: { requested: string }) =>
		requested === "local" ? local : remote,
}));
mock.module("./narrator-acl", () => ({
	NARRATOR_ACL_COLUMNS: { id: true, ownerUserId: true },
	assertNarratorAccess: async (_row: unknown, principal: unknown, need: string) => {
		aclChecks.push({ principal, need });
		if (need === "write" ? !aclWrite : !aclRead) throw new Error("narrator ACL denied");
	},
}));
mock.module("./project-acl", () => ({
	loadProjectForAccess: async (_project: string, _principal: unknown, need: string) => {
		if (need === "write" ? !projectWrite : !projectRead) throw new Error("project ACL denied");
	},
}));
mock.module("./oauth-narrator-runtime-policy", () => ({
	resolveOAuthNarratorRuntimePolicy: async (narrator: string, actor: string) => {
		authorityNarrators.push(narrator);
		actorChecks.push(actor);
		return runtime;
	},
}));
mock.module("./integration-resource-binding-service", () => ({
	integrationResourceBindingService: { get: async () => binding },
}));
mock.module("./device-connection-service", () => ({
	getSessionDevices: async (project: string, actor: string) => {
		actorChecks.push({ project, actor });
		return devicesAuthorized ? [{ id: "remote", online, scope: "project" }] : [];
	},
}));
mock.module("./execution-policy/engine", () => ({
	executionPolicyEngine: {
		compile: async (id: string, context: { deviceClass: unknown }) => {
			policyNarrators.push(id);
			compiledClasses.push(context.deviceClass);
			compileHook?.();
			return {
				directoryBlacklist: blacklist,
				evaluatePath: ({ operation }: { operation: string }) => {
					policyOperations.push(operation);
					return { decision };
				},
			};
		},
	},
}));
// Trait parsing/merge has its own real regressions; these seams expose the live resolved caps.
mock.module("../lib/narrator-custom-traits", () => ({
	getDisabledToolSet: (traits: string[]) => new Set(traits),
}));
mock.module("./trait-layer-service", () => ({
	resolveNarratorProjectId: async () => "project",
	resolveEffectiveTraits: async (input: {
		narratorTraits: string[];
		actingUserId?: string | null;
		projectId?: string | null;
	}) => {
		traitInputs.push(input);
		return { traits: [...input.narratorTraits, ...userTraits, ...projectTraits] };
	},
}));
const {
	createNarratorWorkspaceAttachmentAccess,
	createApprovedWorkspaceReadGuard,
	createApprovedWorkspaceArtifactAccess,
	createNarratorWorkspaceAttachmentSourceAccess,
} = await import("./workspace-artifact-access");

function workspace(deviceId = "remote", cwd = "/workspace"): WorkspaceContext {
	return {
		revision: 3,
		contextKey: "remote-context",
		deviceId,
		cwd,
		pathFlavor: "posix",
		contextProjectId: "project",
		capabilities: { switchDirectory: true },
	};
}
function target(root = "/approved", deviceId = "remote"): ToolExecutionTarget {
	return {
		deviceId,
		backendKind: deviceId === "local" ? "local" : "remote",
		cwd: "/workspace",
		canonicalPath: root,
		lexicalPath: root,
		pathFlavor: "posix",
		runtimeGeneration: 7,
		selectionSource: "explicit",
	};
}
function context(roots = ["/approved"]): ToolContext {
	return {
		narratorId: "narrator",
		userId: "actor",
		projectId: "project",
		cwd: "/workspace",
		signal: new AbortController().signal,
		locale: "en",
		recheckAuthorization: fence,
		requestPermission: async () => ({ behavior: "allow" }),
		executionPlan: {
			kind: "multi",
			primaryKey: "source0",
			endpoints: roots.map((root, index) => ({
				key: `source${index}`,
				operation: "read",
				target: target(root),
			})),
		},
	};
}
function oauth(level: "readWrite" | "readOnly" | "denied" = "readWrite") {
	return {
		clientId: "client",
		grantId: "grant",
		allowedTools: new Set(["Read", "Write"]),
		deviceIds: ["remote"],
		allowLocalExecution: true,
		policy: { deviceAccess: { host: level, global: level, selfRegistered: "readWrite" } },
		permissionMode: "readOnly",
	};
}

beforeEach(() => {
	actorExists = true;
	role = "user";
	permissionMode = "readOnly";
	planMode = false;
	relaxedPlan = false;
	narratorTraits = [];
	userTraits = [];
	projectTraits = [];
	traitInputs = [];
	aclWrite = true;
	aclRead = true;
	projectWrite = true;
	projectRead = true;
	revision = 3;
	contextKey = "remote-context";
	generation = 7;
	online = true;
	devicesAuthorized = true;
	decision = "ask";
	runtime = null;
	binding = null;
	blacklist = [];
	aliases = new Map();
	compiledClasses = [];
	actorChecks = [];
	authorityNarrators = [];
	policyNarrators = [];
	aclChecks = [];
	policyOperations = [];
	compileHook = undefined;
	fence = mock(async () => {});
});

describe("explicit human workspace attachments", () => {
	test("ordinary AI readOnly does not prohibit a write-authorized human upload", async () => {
		const access = createNarratorWorkspaceAttachmentAccess("narrator", workspace(), {
			userId: "actor",
		});
		expect(await access.authorizeWrite("/workspace/upload.txt", remote)).toBe(true);
		expect(policyOperations).toEqual(["write"]);
		expect(aclChecks).toEqual([
			{ principal: { userId: "actor", isAdmin: false }, need: "write" },
			{ principal: { userId: "actor", isAdmin: false }, need: "write" },
		]);
		expect(actorChecks).toContain("actor");
		expect(actorChecks).toContainEqual({ project: "project", actor: "actor" });
	});
	test("anonymous never borrows narrator owner authority", async () => {
		const access = createNarratorWorkspaceAttachmentAccess("narrator", workspace());
		await expect(access.authorizeWrite("/workspace/x", remote)).rejects.toThrow(
			"authenticated actor",
		);
		expect(actorChecks).toHaveLength(0);
	});
	test("actor and workspace identity are frozen against mutable caller objects", async () => {
		const options = { userId: "actor" };
		const original = workspace();
		const access = createNarratorWorkspaceAttachmentAccess("narrator", original, options);
		options.userId = "owner-not-actor";
		original.cwd = "/other";
		expect(await access.authorizeWrite("/workspace/x", remote)).toBe(true);
		expect(actorChecks).toContain("actor");
		await expect(access.authorizeWrite("/other/x", remote)).rejects.toThrow("escaped");
	});
	test("read-only viewer cannot write and role is loaded live", async () => {
		const access = createNarratorWorkspaceAttachmentAccess("narrator", workspace(), {
			userId: "actor",
		});
		aclWrite = false;
		await expect(access.authorizeWrite("/workspace/x", remote)).rejects.toThrow("narrator ACL");
		aclWrite = true;
		role = "admin";
		expect(await access.authorizeWrite("/workspace/x", remote)).toBe(true);
		expect(aclChecks.at(-1)).toEqual({
			principal: { userId: "actor", isAdmin: true },
			need: "write",
		});
		actorExists = false;
		await expect(access.authorizeWrite("/workspace/x", remote)).rejects.toThrow(
			"actor no longer exists",
		);
	});
	test("project write gate is conjunctive", async () => {
		projectWrite = false;
		const access = createNarratorWorkspaceAttachmentAccess("narrator", workspace(), {
			userId: "actor",
		});
		await expect(access.authorizeWrite("/workspace/x", remote)).rejects.toThrow("project ACL");
	});
	test("execution write deny wins even inside canonical workspace", async () => {
		decision = "deny";
		const access = createNarratorWorkspaceAttachmentAccess("narrator", workspace(), {
			userId: "actor",
		});
		await expect(access.authorizeWrite("/workspace/x", remote)).rejects.toThrow("write denied");
		expect(policyOperations).toEqual(["write"]);
	});
	test("OAuth Write tool and readWrite device ceilings are mandatory", async () => {
		runtime = oauth("readOnly");
		const access = createNarratorWorkspaceAttachmentAccess("narrator", workspace(), {
			userId: "actor",
		});
		await expect(access.authorizeWrite("/workspace/x", remote)).rejects.toThrow(
			"device access ceiling",
		);
		runtime = oauth();
		runtime.allowedTools = new Set(["Read"]);
		await expect(access.authorizeWrite("/workspace/x", remote)).rejects.toThrow("OAuth authority");
	});
	test("same client AND grant classify selfRegistered, not project scope", async () => {
		runtime = oauth("denied");
		const access = createNarratorWorkspaceAttachmentAccess("narrator", workspace(), {
			userId: "actor",
		});
		binding = {
			sourceType: "oauth_client",
			sourceId: "client",
			authorityType: "oauth_grant",
			authorityId: "other",
			state: "active",
		};
		await expect(access.authorizeWrite("/workspace/x", remote)).rejects.toThrow(
			"device access ceiling",
		);
		binding.authorityId = "grant";
		expect(await access.authorizeWrite("/workspace/x", remote)).toBe(true);
		expect(compiledClasses).toEqual(["selfRegistered"]);
		binding.sourceId = "other-client";
		await expect(access.authorizeWrite("/workspace/x", remote)).rejects.toThrow(
			"device access ceiling",
		);
	});
	test("remote online and actor device authorization are rechecked", async () => {
		const access = createNarratorWorkspaceAttachmentAccess("narrator", workspace(), {
			userId: "actor",
		});
		online = false;
		await expect(access.authorizeWrite("/workspace/x", remote)).rejects.toThrow(
			"offline or unauthorized",
		);
		online = true;
		devicesAuthorized = false;
		await expect(access.authorizeWrite("/workspace/x", remote)).rejects.toThrow(
			"offline or unauthorized",
		);
	});
	test("canonical escape and stale canonical workspace fail closed", async () => {
		const access = createNarratorWorkspaceAttachmentAccess("narrator", workspace(), {
			userId: "actor",
		});
		aliases.set("/workspace/x", "/secrets/x");
		await expect(access.authorizeWrite("/workspace/x", remote)).rejects.toThrow(
			"canonical path changed",
		);
		aliases.clear();
		aliases.set("/workspace", "/elsewhere");
		await expect(access.authorizeWrite("/workspace/x", remote)).rejects.toThrow(
			"canonical path changed",
		);
	});
	test("workspace revision and execution generation changes fail closed", async () => {
		const access = createNarratorWorkspaceAttachmentAccess("narrator", workspace(), {
			userId: "actor",
		});
		revision++;
		await expect(access.authorizeWrite("/workspace/x", remote)).rejects.toThrow("context changed");
		revision--;
		generation++;
		await expect(access.authorizeWrite("/workspace/x", remote)).rejects.toThrow(
			"execution identity changed",
		);
	});
	test("late generation changes and caller cancellation are fenced", async () => {
		const controller = new AbortController();
		const guard = mock(async () => {});
		const access = createNarratorWorkspaceAttachmentAccess("narrator", workspace(), {
			userId: "actor",
			signal: controller.signal,
			authorizationGuard: guard,
		});
		compileHook = () => {
			generation++;
		};
		await expect(access.authorizeWrite("/workspace/x", remote)).rejects.toThrow(
			"execution identity changed",
		);
		expect(guard).toHaveBeenCalledTimes(2);
		controller.abort(new Error("cancelled"));
		await expect(
			access.authorizeWrite("/workspace/x", remote, new AbortController().signal),
		).rejects.toThrow("cancelled");
	});
	test("local platform secrets and host OAuth ceilings cannot be overwritten", async () => {
		const cwd = narraforkDir;
		const access = createNarratorWorkspaceAttachmentAccess("narrator", workspace("local", cwd), {
			userId: "actor",
		});
		await expect(
			access.authorizeWrite(local.paths.resolve(cwd, "settings.json"), local),
		).rejects.toThrow("private platform");
		runtime = oauth("readOnly");
		await expect(
			access.authorizeWrite(local.paths.resolve(cwd, "settings.json"), local),
		).rejects.toThrow("device access ceiling");
	});
	test("revocation and symlink changes during policy compilation fail at final admission", async () => {
		const access = createNarratorWorkspaceAttachmentAccess("narrator", workspace(), {
			userId: "actor",
		});
		compileHook = () => {
			aclWrite = false;
		};
		await expect(access.authorizeWrite("/workspace/x", remote)).rejects.toThrow("narrator ACL");
		aclWrite = true;
		compileHook = () => {
			aliases.set("/workspace/x", "/outside/x");
		};
		await expect(access.authorizeWrite("/workspace/x", remote)).rejects.toThrow(
			"canonical path changed",
		);
	});
	test("source inheritance must be explicit, no fabricated original root", () => {
		const without = createNarratorWorkspaceAttachmentAccess("narrator", workspace(), {
			userId: "actor",
		});
		expect(without.sourceAccess).toBeUndefined();
		const sourceAccess = { backend: remote } as never;
		const withSource = createNarratorWorkspaceAttachmentAccess("narrator", workspace(), {
			userId: "actor",
			sourceAccess,
		});
		expect(withSource.sourceAccess).toBe(sourceAccess);
	});
});

const originalAttachmentPath = "/original/.narrafork/attached/nonce/notes.txt";
function originalSourceWorkspace(): WorkspaceContext {
	return { ...workspace("remote", "/original"), contextProjectId: "source-project" };
}
describe("persisted original attachment exact source access", () => {
	test("source narrator and original project carry the Read authority, not the target narrator", async () => {
		const access = createNarratorWorkspaceAttachmentSourceAccess(
			"source-narrator",
			originalSourceWorkspace(),
			originalAttachmentPath,
			{ userId: "actor" },
		);
		expect(await access.authorizeRead(originalAttachmentPath, remote)).toBe(true);
		expect(authorityNarrators).toEqual(["source-narrator", "source-narrator"]);
		expect(policyNarrators).toEqual(["source-narrator"]);
		expect(actorChecks).toContainEqual({ actor: "actor", project: "source-project" });
		expect(policyOperations).toEqual(["read"]);
		expect(aclChecks.every((check) => (check as { need: string }).need === "read")).toBe(true);
		expect(access.runtimeGeneration).toBe(7);
	});
	test("exact-file scope never becomes a whole original workspace or a directory read", async () => {
		const access = createNarratorWorkspaceAttachmentSourceAccess(
			"source-narrator",
			originalSourceWorkspace(),
			originalAttachmentPath,
			{ userId: "actor" },
		);
		for (const path of [
			"/original",
			"/original/sibling.txt",
			`${originalAttachmentPath}/child`,
			"/current/.narrafork/attached/notes.txt",
		])
			await expect(access.authorizeRead(path, remote)).rejects.toThrow("exact original file");
		await expect(access.authorizeRead(originalAttachmentPath, local)).rejects.toThrow(
			"exact original file",
		);
		expect(actorChecks).toHaveLength(0);
	});
	test("frozen original provenance survives a later narrator workspace switch without changing the source", async () => {
		const original = originalSourceWorkspace();
		const options = { userId: "actor" };
		const access = createNarratorWorkspaceAttachmentSourceAccess(
			"source-narrator",
			original,
			originalAttachmentPath,
			options,
		);
		original.cwd = "/current";
		original.contextProjectId = "other-project";
		options.userId = "owner-not-actor";
		revision = 99;
		contextKey = "later-context";
		expect(await access.authorizeRead(originalAttachmentPath, remote)).toBe(true);
		expect(access.workspaceContext?.cwd).toBe("/original");
		expect(actorChecks).toContainEqual({ actor: "actor", project: "source-project" });
		await expect(
			access.authorizeRead("/current/.narrafork/attached/notes.txt", remote),
		).rejects.toThrow("exact original file");
	});
	test("unverified relative paths and outside-original-workspace paths cannot construct source authority", () => {
		for (const path of ["notes.txt", "/outside/notes.txt", "/original/../outside/notes.txt"])
			expect(() =>
				createNarratorWorkspaceAttachmentSourceAccess(
					"source-narrator",
					originalSourceWorkspace(),
					path,
					{ userId: "actor" },
				),
			).toThrow("original workspace binding");
	});
	test("anonymous source Read never inherits source narrator owner credentials", async () => {
		const access = createNarratorWorkspaceAttachmentSourceAccess(
			"source-narrator",
			originalSourceWorkspace(),
			originalAttachmentPath,
		);
		await expect(access.authorizeRead(originalAttachmentPath, remote)).rejects.toThrow(
			"authenticated actor",
		);
	});
	test("source narrator Read ACL and original project Read gate are independent", async () => {
		const access = createNarratorWorkspaceAttachmentSourceAccess(
			"source-narrator",
			originalSourceWorkspace(),
			originalAttachmentPath,
			{ userId: "actor" },
		);
		aclRead = false;
		await expect(access.authorizeRead(originalAttachmentPath, remote)).rejects.toThrow(
			"narrator ACL",
		);
		aclRead = true;
		projectRead = false;
		await expect(access.authorizeRead(originalAttachmentPath, remote)).rejects.toThrow(
			"project ACL",
		);
	});
	test("readOnly OAuth permits an exact Read but missing Read, denied device or offline source do not", async () => {
		const access = createNarratorWorkspaceAttachmentSourceAccess(
			"source-narrator",
			originalSourceWorkspace(),
			originalAttachmentPath,
			{ userId: "actor" },
		);
		runtime = oauth("readOnly");
		expect(await access.authorizeRead(originalAttachmentPath, remote)).toBe(true);
		runtime = { ...oauth(), allowedTools: new Set(["Write"]) };
		await expect(access.authorizeRead(originalAttachmentPath, remote)).rejects.toThrow(
			"OAuth authority",
		);
		runtime = oauth("denied");
		await expect(access.authorizeRead(originalAttachmentPath, remote)).rejects.toThrow(
			"device access ceiling",
		);
		runtime = null;
		online = false;
		await expect(access.authorizeRead(originalAttachmentPath, remote)).rejects.toThrow(
			"offline or unauthorized",
		);
	});
	test("read deny and canonical source or generation changes cannot be bypassed by old provenance", async () => {
		const access = createNarratorWorkspaceAttachmentSourceAccess(
			"source-narrator",
			originalSourceWorkspace(),
			originalAttachmentPath,
			{ userId: "actor" },
		);
		decision = "deny";
		await expect(access.authorizeRead(originalAttachmentPath, remote)).rejects.toThrow(
			"Read denied",
		);
		decision = "ask";
		aliases.set(originalAttachmentPath, "/outside/notes.txt");
		await expect(access.authorizeRead(originalAttachmentPath, remote)).rejects.toThrow(
			"canonical path changed",
		);
		aliases.clear();
		generation++;
		await expect(access.authorizeRead(originalAttachmentPath, remote)).rejects.toThrow(
			"execution identity changed",
		);
	});
	test("revocation and path replacement during compile are fenced before source Read admission", async () => {
		const guard = mock(async () => {});
		const access = createNarratorWorkspaceAttachmentSourceAccess(
			"source-narrator",
			originalSourceWorkspace(),
			originalAttachmentPath,
			{ userId: "actor", authorizationGuard: guard },
		);
		compileHook = () => {
			aclRead = false;
		};
		await expect(access.authorizeRead(originalAttachmentPath, remote)).rejects.toThrow(
			"narrator ACL",
		);
		expect(guard).toHaveBeenCalledTimes(2);
		aclRead = true;
		compileHook = () => {
			aliases.set("/original", "/replacement");
		};
		await expect(access.authorizeRead(originalAttachmentPath, remote)).rejects.toThrow(
			"canonical path changed",
		);
	});
	test("source local secrets, host-denied OAuth and combined cancellation fail closed", async () => {
		const source = createNarratorWorkspaceAttachmentSourceAccess(
			"source-narrator",
			workspace("local", narraforkDir),
			local.paths.resolve(narraforkDir, "settings.json"),
			{ userId: "actor" },
		);
		await expect(
			source.authorizeRead(local.paths.resolve(narraforkDir, "settings.json"), local),
		).rejects.toThrow("private platform");
		runtime = { ...oauth(), allowLocalExecution: false };
		await expect(
			source.authorizeRead(local.paths.resolve(narraforkDir, "settings.json"), local),
		).rejects.toThrow("OAuth authority");
		const controller = new AbortController();
		const access = createNarratorWorkspaceAttachmentSourceAccess(
			"source-narrator",
			originalSourceWorkspace(),
			originalAttachmentPath,
			{ userId: "actor", signal: controller.signal },
		);
		controller.abort(new Error("source cancelled"));
		await expect(
			access.authorizeRead(originalAttachmentPath, remote, new AbortController().signal),
		).rejects.toThrow("source cancelled");
	});
});

function artifactContext(): ToolContext {
	const ctx = context();
	ctx.workspaceContext = workspace();
	ctx.executionPlan = {
		kind: "multi",
		primaryKey: "source",
		endpoints: [
			{ key: "source", operation: "read", target: target("/published/skill") },
			{ key: "destination", operation: "write", target: target("/workspace/.narrafork/attached") },
		],
	};
	return ctx;
}
const artifactPath = "/workspace/.narrafork/attached/nonce/SKILL.md";

describe("explicit AI workspace artifact materialization", () => {
	test("a frozen approved Write endpoint admits the live authorized actor", async () => {
		permissionMode = "default";
		const access = createApprovedWorkspaceArtifactAccess(artifactContext());
		expect(await access.authorizeWrite(artifactPath, remote)).toBe(true);
		expect(policyOperations).toEqual(["write"]);
		expect(fence).toHaveBeenCalledTimes(2);
		expect(aclChecks.every((check) => (check as { need: string }).need === "write")).toBe(true);
		expect(access.sourceAccess).toBeUndefined();
	});
	test("AI readOnly is blocked while explicit human attachment remains allowed", async () => {
		const ai = createApprovedWorkspaceArtifactAccess(artifactContext());
		await expect(ai.authorizeWrite(artifactPath, remote)).rejects.toThrow("live read-only");
		const human = createNarratorWorkspaceAttachmentAccess("narrator", workspace(), {
			userId: "actor",
		});
		expect(await human.authorizeWrite(artifactPath, remote)).toBe(true);
	});
	test("strict live plan and context-bound plan copies are forbidden", async () => {
		permissionMode = "bypassPermissions";
		const ctx = artifactContext();
		planMode = true;
		await expect(
			createApprovedWorkspaceArtifactAccess(ctx).authorizeWrite(artifactPath, remote),
		).rejects.toThrow("strict plan");
		planMode = false;
		ctx.planFilePath = "/workspace/plan.md";
		await expect(
			createApprovedWorkspaceArtifactAccess(ctx).authorizeWrite(artifactPath, remote),
		).rejects.toThrow("plan authority");
	});
	test("runtime readonly and missing Write tool cannot use a manual Read approval", async () => {
		permissionMode = "default";
		const ctx = artifactContext();
		ctx.runtimePolicy = resolveRuntimePolicy({ variant: "subagent", subagentType: "explore" });
		await expect(
			createApprovedWorkspaceArtifactAccess(ctx).authorizeWrite(artifactPath, remote),
		).rejects.toThrow("runtime or plan authority");
		ctx.runtimePolicy = resolveRuntimePolicy({
			variant: "subagent",
			customDefinition: { toolAccess: "custom", customTools: ["Read"] },
		});
		await expect(
			createApprovedWorkspaceArtifactAccess(ctx).authorizeWrite(artifactPath, remote),
		).rejects.toThrow("runtime or plan authority");
	});
	test("missing workspace, live fence or approved write endpoint fails closed", async () => {
		permissionMode = "default";
		expect(() => createApprovedWorkspaceArtifactAccess(context())).toThrow("frozen workspace");
		const ctx = artifactContext();
		ctx.recheckAuthorization = undefined;
		await expect(
			createApprovedWorkspaceArtifactAccess(ctx).authorizeWrite(artifactPath, remote),
		).rejects.toThrow("live authorization fence");
		ctx.recheckAuthorization = fence;
		ctx.executionPlan = context().executionPlan;
		await expect(
			createApprovedWorkspaceArtifactAccess(ctx).authorizeWrite(artifactPath, remote),
		).rejects.toThrow("approved canonical Write endpoints");
	});
	test("OAuth device readOnly, Read-only allowedTools and live mode each deny AI copy", async () => {
		permissionMode = "default";
		const access = createApprovedWorkspaceArtifactAccess(artifactContext());
		runtime = { ...oauth("readOnly"), permissionMode: "bypassPermissions" };
		await expect(access.authorizeWrite(artifactPath, remote)).rejects.toThrow(
			"device access ceiling",
		);
		runtime = { ...oauth(), permissionMode: "bypassPermissions", allowedTools: new Set(["Read"]) };
		await expect(access.authorizeWrite(artifactPath, remote)).rejects.toThrow("OAuth authority");
		runtime = oauth();
		await expect(access.authorizeWrite(artifactPath, remote)).rejects.toThrow("live read-only");
	});
	test("dontAsk requires execution-policy Write allow, and deny always wins", async () => {
		permissionMode = "dontAsk";
		const access = createApprovedWorkspaceArtifactAccess(artifactContext());
		await expect(access.authorizeWrite(artifactPath, remote)).rejects.toThrow("automatic allow");
		decision = "allow";
		expect(await access.authorizeWrite(artifactPath, remote)).toBe(true);
		decision = "deny";
		await expect(access.authorizeWrite(artifactPath, remote)).rejects.toThrow("Write denied");
	});
	test("scope cannot expand into unapproved workspace siblings or host paths", async () => {
		permissionMode = "default";
		const ctx = artifactContext();
		const access = createApprovedWorkspaceArtifactAccess(ctx);
		if (!ctx.executionPlan) throw new Error("missing test plan");
		ctx.executionPlan.endpoints[1].target.canonicalPath = "/workspace";
		await expect(access.authorizeWrite("/workspace/other.txt", remote)).rejects.toThrow(
			"approved canonical Write endpoints",
		);
		await expect(access.authorizeWrite(artifactPath, local)).rejects.toThrow("backend changed");
	});
	test("late readOnly tightening, offline device and root symlink changes prevent materialization", async () => {
		permissionMode = "default";
		const access = createApprovedWorkspaceArtifactAccess(artifactContext());
		compileHook = () => {
			permissionMode = "readOnly";
		};
		await expect(access.authorizeWrite(artifactPath, remote)).rejects.toThrow("live read-only");
		permissionMode = "default";
		compileHook = () => {
			online = false;
		};
		await expect(access.authorizeWrite(artifactPath, remote)).rejects.toThrow(
			"offline or unauthorized",
		);
		online = true;
		compileHook = () => {
			aliases.set("/workspace/.narrafork/attached", "/outside");
		};
		await expect(access.authorizeWrite(artifactPath, remote)).rejects.toThrow(
			"canonical path changed",
		);
	});
	test.each([
		"user",
		"project",
		"narrator",
	])("live %s Write-disabled trait blocks Skill's indirect writes even with builtin=all", async (layer) => {
		permissionMode = "default";
		const ctx = artifactContext();
		ctx.runtimePolicy = resolveRuntimePolicy({ variant: "primary" });
		if (layer === "user") userTraits = ["Write"];
		else if (layer === "project") projectTraits = ["Write"];
		else narratorTraits = ["Write"];
		await expect(
			createApprovedWorkspaceArtifactAccess(ctx).authorizeWrite(artifactPath, remote),
		).rejects.toThrow("disabled by effective");
		expect(traitInputs).toContainEqual({
			narratorTraits,
			actingUserId: "actor",
			projectId: "project",
		});
		const human = createNarratorWorkspaceAttachmentAccess("narrator", workspace(), {
			userId: "actor",
		});
		expect(await human.authorizeWrite(artifactPath, remote)).toBe(true);
	});
	test("Write-disabled trait tightening during policy compile is rechecked before dispatch", async () => {
		permissionMode = "default";
		compileHook = () => {
			userTraits = ["Write"];
		};
		await expect(
			createApprovedWorkspaceArtifactAccess(artifactContext()).authorizeWrite(artifactPath, remote),
		).rejects.toThrow("disabled by effective");
		expect(traitInputs).toHaveLength(2);
	});
	test("server-global source authorization is supplied explicitly, never constructed from host paths", () => {
		const sourceAccess = { backend: local } as never;
		const access = createApprovedWorkspaceArtifactAccess(artifactContext(), sourceAccess);
		expect(access.sourceAccess).toBe(sourceAccess);
	});
});

describe("approved workspace read guard", () => {
	test("approved roots outside current workspace and multiple roots are retained", async () => {
		const guard = createApprovedWorkspaceReadGuard(context(["/approved", "/another"]));
		expect(await guard("/approved/file", remote)).toBe(true);
		expect(await guard("/another/file", remote)).toBe(true);
		await expect(guard("/workspace/file", remote)).rejects.toThrow("approved canonical endpoints");
		expect(fence).toHaveBeenCalledTimes(5);
	});
	test("endpoints and actor are frozen, arbitrary caller root cannot expand authority", async () => {
		const ctx = context();
		const guard = createApprovedWorkspaceReadGuard(ctx);
		ctx.userId = "owner-not-actor";
		if (!ctx.executionPlan) throw new Error("missing test plan");
		ctx.executionPlan.endpoints[0].target.canonicalPath = "/other";
		expect(await guard("/approved/file", remote)).toBe(true);
		expect(actorChecks).toContain("actor");
		await expect(guard("/other/file", remote)).rejects.toThrow("approved canonical endpoints");
	});
	test("no live callback, canonical endpoint or read endpoint means no authority", async () => {
		const ctx = context();
		ctx.recheckAuthorization = undefined;
		await expect(createApprovedWorkspaceReadGuard(ctx)("/approved", remote)).rejects.toThrow(
			"live authorization fence",
		);
		ctx.recheckAuthorization = fence;
		if (!ctx.executionPlan) throw new Error("missing test plan");
		ctx.executionPlan.endpoints[0].target.canonicalPath = undefined;
		await expect(createApprovedWorkspaceReadGuard(ctx)("/approved", remote)).rejects.toThrow(
			"approved canonical endpoints",
		);
		ctx.executionPlan.endpoints[0].operation = "write";
		await expect(createApprovedWorkspaceReadGuard(ctx)("/approved", remote)).rejects.toThrow(
			"approved canonical endpoints",
		);
	});
	test("frozen single target is an approved root but cannot route to another backend", async () => {
		const ctx = context();
		ctx.executionPlan = undefined;
		ctx.executionTarget = target();
		const guard = createApprovedWorkspaceReadGuard(ctx);
		expect(await guard("/approved/file", remote)).toBe(true);
		await expect(guard("/approved/file", local)).rejects.toThrow("approved canonical endpoints");
	});
	test("whole-tree shares reject blacklisted descendants before archive can read them", async () => {
		blacklist = [{ path: "/approved/private", denyLevel: "denyAll" }];
		decision = "allow";
		const guard = createApprovedWorkspaceReadGuard(context());
		await expect(guard("/approved", remote)).rejects.toThrow("tree includes");
		expect(await guard("/approved/public.txt", remote)).toBe(true);
		blacklist = [{ path: "/approved/private", denyLevel: "denyWrite" }];
		expect(await guard("/approved", remote)).toBe(true);
	});
	test("deny and device revocation are recompiled on every batch", async () => {
		const guard = createApprovedWorkspaceReadGuard(context());
		expect(await guard("/approved/file", remote)).toBe(true);
		decision = "deny";
		await expect(guard("/approved/file", remote)).rejects.toThrow("tree includes");
		decision = "ask";
		devicesAuthorized = false;
		await expect(guard("/approved/file", remote)).rejects.toThrow("offline or unauthorized");
	});
	test("live narrator/project read gates, OAuth Read and runtime tool ceilings intersect", async () => {
		const guard = createApprovedWorkspaceReadGuard(context());
		aclRead = false;
		await expect(guard("/approved/file", remote)).rejects.toThrow("narrator ACL");
		aclRead = true;
		projectRead = false;
		await expect(guard("/approved/file", remote)).rejects.toThrow("project ACL");
		projectRead = true;
		runtime = oauth("readOnly");
		runtime.allowedTools = new Set(["Write"]);
		await expect(guard("/approved/file", remote)).rejects.toThrow("OAuth authority");
		runtime = null;
		const ctx = context();
		ctx.runtimePolicy = resolveRuntimePolicy({
			variant: "subagent",
			customDefinition: { toolAccess: "custom", customTools: [] },
		});
		await expect(createApprovedWorkspaceReadGuard(ctx)("/approved/file", remote)).rejects.toThrow(
			"runtime tool authority",
		);
	});
	test("approved canonical root and backend generation cannot change between batches", async () => {
		const guard = createApprovedWorkspaceReadGuard(context());
		expect(await guard("/approved/file", remote)).toBe(true);
		aliases.set("/approved", "/changed");
		await expect(guard("/approved/file", remote)).rejects.toThrow("canonical path changed");
		aliases.clear();
		generation++;
		await expect(guard("/approved/file", remote)).rejects.toThrow("execution identity changed");
	});
	test("OAuth readOnly permits approved reads but late device revocation does not", async () => {
		runtime = oauth("readOnly");
		const guard = createApprovedWorkspaceReadGuard(context());
		expect(await guard("/approved/file", remote)).toBe(true);
		compileHook = () => {
			online = false;
		};
		await expect(guard("/approved/file", remote)).rejects.toThrow("offline or unauthorized");
	});
	test("late approved root symlink changes are fenced after policy compilation", async () => {
		compileHook = () => {
			aliases.set("/approved", "/outside");
		};
		await expect(
			createApprovedWorkspaceReadGuard(context())("/approved/file", remote),
		).rejects.toThrow("canonical path changed");
	});
	test("final live authorization failure prevents returning read admission", async () => {
		let calls = 0;
		const ctx = context();
		ctx.recheckAuthorization = async () => {
			if (++calls === 2) throw new Error("revoked at final fence");
		};
		await expect(createApprovedWorkspaceReadGuard(ctx)("/approved/file", remote)).rejects.toThrow(
			"revoked at final fence",
		);
	});
});
