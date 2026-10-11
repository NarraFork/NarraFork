import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { NativePathDescriptorV2 } from "@shared/target-native-path";
import type { WorkspaceContext } from "@shared/workspace-context";
import { posixPathSemantics, windowsPathSemantics } from "../lib/agent/execution/path-semantics";
import { compileExecutionPolicy } from "./execution-policy/compiler";
import type { ExecutionTargetContext } from "./execution-policy/types";

let context: WorkspaceContext;
let platformOs: "linux" | "windows" = "linux";
let nativeIdentity: NativePathDescriptorV2 | undefined;
let lastExpectedNativeRoot: NativePathDescriptorV2 | undefined;
let missingFeature: string | undefined;
let online = true;
let authorized = true;
let denied = false;
let records: Record<string, unknown>[] = [];
let policyTargets: string[] = [];
let groupDeny: "global" | "selfRegistered" | null = null;
let canonicalDefault: string | null = null;
let selfRegistered = false;
let oauth: {
	clientId: string;
	grantId: string;
	deviceIds: string[];
	allowLocalExecution: boolean;
	allowedTools: Set<string>;
	policy: { deviceAccess: { host: string; global: string; selfRegistered: string } };
} | null = null;
let exitResolvers: Array<(code: number | null) => void> = [];
const registerActivity = mock(async (_input: unknown) => {});
const registerTerminalActivity = mock(async (_input: unknown) => {});
const finishActivity = mock(async (_input: unknown) => {});
mock.module("./remote-tree-snapshot-hooks", () => ({
	registerRemoteActivity: registerActivity,
	registerRemoteTerminalActivity: registerTerminalActivity,
	finishRemoteActivity: finishActivity,
}));
const write = mock((_data: string) => {});
const remotePty = mock((_device: string, _options: unknown, _dependencies?: unknown) => ({
	write,
	resize: () => {},
	kill: () => {},
	close: () => {},
	exited: new Promise<number | null>((resolve) => {
		exitResolvers.push(resolve);
	}),
}));
const localPty = mock((_options: unknown) => {
	throw new Error("Host PTY must not start");
});
mock.module("../db", () => ({
	db: {
		query: {
			users: { findFirst: async () => ({ role: "user" }) },
			narrators: {
				findFirst: async () => ({ id: "n", cwd: "/host/decoy", defaultDeviceId: "remote" }),
			},
			terminals: { findFirst: async () => records[0] },
		},
		update: () => ({
			set: (patch: Record<string, unknown>) => ({
				where: () => {
					if (records[0]) Object.assign(records[0], patch);
					return { returning: async () => [records[0]] };
				},
			}),
		}),
		insert: () => ({
			values: (record: Record<string, unknown>) => ({
				returning: async () => {
					records.push(record);
					return [record];
				},
			}),
		}),
	},
}));
mock.module("./narrator-acl", () => ({ loadNarratorForAccess: async () => ({ id: "n" }) }));
mock.module("./workspace-context-service", () => ({
	workspaceContextService: {
		get: async () => context,
		withRevision: async (
			_id: string,
			revision: number,
			_key: unknown,
			action: (frozen: WorkspaceContext) => Promise<unknown>,
		) => {
			if (revision !== context.revision) throw new Error("stale revision");
			return action(structuredClone(context));
		},
	},
}));
mock.module("./execution-policy/engine", () => ({
	executionPolicyEngine: {
		compile: async (_narrator: string, target: ExecutionTargetContext) => {
			policyTargets.push(target.target.cwd);
			if (groupDeny)
				return compileExecutionPolicy(
					{
						directoryWhitelist: [],
						directoryBlacklist: [
							{
								ruleType: "directoryBlacklist",
								enabled: true,
								path: "/chosen/first",
								pathFlavor: "posix",
								pathKey: "/chosen/first",
								denyLevel: "denyAll",
								selector: { kind: "oauthGroup", group: groupDeny },
								source: "narrator",
							},
						],
						commandWhitelist: [],
						commandBlacklist: [],
					},
					target,
				);
			return { evaluatePath: () => ({ decision: denied ? "deny" : "allow" }) };
		},
	},
}));
mock.module("./oauth-narrator-runtime-policy", () => ({
	resolveOAuthNarratorRuntimePolicy: async () => oauth,
}));
mock.module("./integration-resource-binding-service", () => ({
	integrationResourceBindingService: {
		get: async () =>
			selfRegistered
				? { sourceType: "oauth_client", sourceId: "client", authorityId: "grant" }
				: null,
	},
}));
mock.module("./oauth-device-runtime-policy", () => ({
	resolveOAuthDeviceRuntimeAuthorization: async () => ({ allowed: true }),
}));
mock.module("../lib/agent/execution/registry", () => ({
	resolveBackend: () => ({
		kind: "remote",
		deviceId: "remote",
		paths: platformOs === "windows" ? windowsPathSemantics : posixPathSemantics,
		runtimeGeneration: 2,
		resolvePathIdentity: async (
			path: string,
			options?: { expectedNativeDescriptor?: NativePathDescriptorV2 },
		) => {
			lastExpectedNativeRoot = options?.expectedNativeDescriptor;
			return {
				canonicalPath: path === "/remote/default-decoy" ? (canonicalDefault ?? path) : path,
				lexicalPath: path,
				exists: true,
				runtimeGeneration: 2,
				...(nativeIdentity ? { nativeDescriptor: nativeIdentity } : {}),
			};
		},
	}),
}));
mock.module("../lib/agent/execution/path-resolve", () => ({
	localToolBaseCwd: () => "/host/default",
}));
mock.module("./device-connection-service", () => ({
	isDeviceOnline: () => online,
	getConnectedDeviceHello: () => ({
		defaultCwd: platformOs === "windows" ? "C:\\chosen" : "/remote/default-decoy",
		capabilities: { pty: true },
		platform: {
			os: platformOs,
			shellPath: platformOs === "windows" ? "powershell.exe" : "/bin/sh",
		},
	}),
}));
mock.module("./device-service", () => ({
	DeviceScopeError: class extends Error {},
	deviceHasFeature: (_capabilities: unknown, feature: string) => feature !== missingFeature,
	isDeviceAuthorized: () => authorized,
	requireAuthorizedDeviceForProject: async () => ({
		capabilities: { pty: true },
		platformOs: "linux",
		defaultCwd: "/other/decoy",
	}),
}));
mock.module("../lib/agent/tools/terminal", () => ({ resetCursorForTerminal: () => {} }));
mock.module("../terminal/runtime-remote", () => ({
	REMOTE_PTY_READY_FEATURE: "pty.ready.v1",
	REMOTE_PTY_CONPTY_FEATURE: "pty.conpty.v1",
	REMOTE_PTY_LIFECYCLE_FEATURE: "pty.lifecycle-evidence.v1",
	REMOTE_PTY_BOUNDED_IO_FEATURE: "pty.bounded-io.v1",
	spawnRemotePty: remotePty,
}));
mock.module("../terminal/runtime-bun", () => ({ spawnBunTerminal: localPty }));
mock.module("../terminal/runtime-pty", () => ({ spawnPortablePty: localPty }));
mock.module("../terminal/dtach-service", () => ({
	dtachService: { isAvailable: async () => false },
	findProcessesByArg: async () => [],
	getDescendantPids: async () => [],
	ProcessSnapshot: class {},
}));
mock.module("../terminal/buffer-manager", () => ({
	BufferManager: class {
		startPeriodicFlush() {}
		async dispose() {}
	},
}));
mock.module("../websocket/terminal-ws", () => ({ sendToTerminal: () => {} }));
const { terminalService } = await import("./terminal-service");
const principal = { userId: "actor", isAdmin: false };
beforeEach(() => {
	platformOs = "linux";
	nativeIdentity = undefined;
	lastExpectedNativeRoot = undefined;
	missingFeature = undefined;
	context = {
		revision: 8,
		contextKey: "chosen-1",
		deviceId: "remote",
		cwd: "/chosen/first",
		pathFlavor: "posix",
		capabilities: { switchDirectory: true },
	};
	online = true;
	authorized = true;
	denied = false;
	groupDeny = null;
	canonicalDefault = null;
	selfRegistered = false;
	oauth = null;
	exitResolvers = [];
	records = [];
	policyTargets = [];
	remotePty.mockClear();
	localPty.mockClear();
	write.mockClear();
	registerActivity.mockClear();
	registerTerminalActivity.mockClear();
	finishActivity.mockClear();
});
function windowsRootProof(fileId = "directory-1"): NativePathDescriptorV2 {
	const root = {
		canonicalPath: "C:\\",
		object: { volumeId: "volume-1", fileId: "root-1", creationTime: "1" },
		caseSensitive: false,
	};
	return {
		version: 2,
		platform: "windows",
		volumeId: "volume-1",
		pathSlotKey: "native:C:chosen",
		componentKeys: ["C:", "chosen"],
		ancestors: [root],
		parent: root,
		missingSuffix: [],
		object: { volumeId: "volume-1", fileId, creationTime: "2" },
		caseSensitive: false,
	};
}
function selectWindowsRoot() {
	platformOs = "windows";
	nativeIdentity = windowsRootProof();
	context = {
		...context,
		cwd: "C:\\chosen",
		pathFlavor: "windows",
		nativeRootDescriptor: structuredClone(nativeIdentity),
	};
}

describe("terminal frozen workspace creation", () => {
	test("native Windows dispatch freezes the ORIGINAL root and never uses Unix interactive flags", async () => {
		selectWindowsRoot();
		const original = structuredClone(context.nativeRootDescriptor);
		const terminal = await terminalService.create({
			narratorId: "n",
			expectedRevision: 8,
			contextKey: "chosen-1",
			principal,
		});
		expect(lastExpectedNativeRoot).toEqual(original);
		expect(remotePty.mock.calls[0][1]).toMatchObject({
			cmd: [],
			cwd: "C:\\chosen",
			env: { TERM: "xterm-256color" },
		});
		expect(
			(remotePty.mock.calls[0][1] as { env: Record<string, string> }).env.HISTFILE,
		).toBeUndefined();
		expect(remotePty.mock.calls[0][2]).toMatchObject({
			requireLifecycleEvidence: true,
			expectedNativeDescriptor: original,
		});
		expect(terminal.workspaceContext?.nativeRootDescriptor).toEqual(original);
		expect(localPty).not.toHaveBeenCalled();
	});
	test("native root replacement refuses before row, writer claim or shell dispatch", async () => {
		selectWindowsRoot();
		nativeIdentity = windowsRootProof("external-replacement");
		await expect(
			terminalService.create({
				narratorId: "n",
				expectedRevision: 8,
				contextKey: "chosen-1",
				principal,
			}),
		).rejects.toThrow("incarnation changed");
		expect(records).toHaveLength(0);
		expect(registerActivity).not.toHaveBeenCalled();
		expect(remotePty).not.toHaveBeenCalled();
		expect(localPty).not.toHaveBeenCalled();
	});
	test("Windows legacy capability or missing original proof cannot silently dispatch/fallback", async () => {
		selectWindowsRoot();
		missingFeature = "pty.lifecycle-evidence.v1";
		await expect(
			terminalService.create({
				narratorId: "n",
				expectedRevision: 8,
				contextKey: "chosen-1",
				principal,
			}),
		).rejects.toThrow("upgrade");
		missingFeature = undefined;
		context.nativeRootDescriptor = undefined;
		await expect(
			terminalService.create({
				narratorId: "n",
				expectedRevision: 8,
				contextKey: "chosen-1",
				principal,
			}),
		).rejects.toThrow("original native directory proof");
		expect(records).toHaveLength(0);
		expect(registerActivity).not.toHaveBeenCalled();
		expect(remotePty).not.toHaveBeenCalled();
		expect(localPty).not.toHaveBeenCalled();
	});
	test("standalone remote origin metadata is persisted before native spawn and frozen after ready", async () => {
		remotePty.mockImplementationOnce(() => {
			expect(records[0]).toMatchObject({
				narratorId: null,
				ownerUserId: "actor",
				deviceId: "remote",
				cwd: "/remote/default-decoy",
				status: "exited",
				exitCode: null,
				workspaceContext: {
					revision: 0,
					deviceId: "remote",
					cwd: "/remote/default-decoy",
					terminalOrigin: { version: 1, runtimeGeneration: 2 },
				},
			});
			return {
				write,
				resize: () => {},
				kill: () => {},
				close: () => {},
				exited: new Promise(() => {}),
			};
		});
		const terminal = await terminalService.create({ deviceId: "remote", principal });
		expect(terminal.status).toBe("running");
		expect(records).toHaveLength(1);
		expect(terminal.workspaceContext?.deviceId).toBe("remote");
		expect(terminal.ownerUserId).toBe("actor");
		expect(terminal.workspaceContext?.contextKey).toHaveLength(64);
		expect(registerActivity).not.toHaveBeenCalled();
		expect(registerTerminalActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				principal,
				terminalId: terminal.id,
				activityId: `pty:${terminal.id}`,
				runtimeGeneration: 2,
				workspaceContext: expect.objectContaining({
					cwd: "/remote/default-decoy",
					terminalOrigin: { version: 1, runtimeGeneration: 2 },
				}),
			}),
		);
	});

	test("standalone awaits its true-origin claim before spawn and retains a non-running row on refusal", async () => {
		let release: (() => void) | undefined;
		registerTerminalActivity.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const creating = terminalService.create({ deviceId: "remote", principal });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(records[0]?.status).toBe("exited");
		expect(remotePty).not.toHaveBeenCalled();
		release?.();
		const terminal = await creating;
		expect(terminal.status).toBe("running");
		registerTerminalActivity.mockRejectedValueOnce(new Error("actual terminal origin denied"));
		await expect(terminalService.create({ deviceId: "remote", principal })).rejects.toThrow(
			"origin denied",
		);
		expect(remotePty).toHaveBeenCalledTimes(1);
		expect(records[1]).toMatchObject({ status: "exited", exitCode: null, ownerUserId: "actor" });
	});

	test("standalone real exit is settled on original generation, while lost readiness stays unknown", async () => {
		const terminal = await terminalService.create({ deviceId: "remote", principal });
		exitResolvers[0]?.(6);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(finishActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				activityId: `pty:${terminal.id}`,
				outcome: "finished",
				target: expect.objectContaining({ runtimeGeneration: 2, cwd: "/remote/default-decoy" }),
			}),
		);
		finishActivity.mockClear();
		remotePty.mockImplementationOnce(() => ({
			write,
			resize: () => {},
			kill: () => {},
			close: () => {},
			ready: Promise.reject(new Error("remote readiness lost")),
			exited: Promise.resolve(null),
		}));
		await expect(terminalService.create({ deviceId: "remote", principal })).rejects.toThrow(
			"readiness lost",
		);
		expect(finishActivity).toHaveBeenCalledWith(expect.objectContaining({ outcome: "unknown" }));
		expect(
			finishActivity.mock.calls.some(
				([input]) => (input as { outcome: string }).outcome === "finished",
			),
		).toBe(false);
	});
	test("PTY starts in selected cwd, persists revision, and an existing terminal never follows switch", async () => {
		const old = await terminalService.create({
			narratorId: "n",
			principal,
			expectedRevision: 8,
			contextKey: "chosen-1",
		});
		expect(remotePty.mock.calls[0]?.[1]).toMatchObject({ cwd: "/chosen/first" });
		expect(old.workspaceContext).toEqual(context);
		expect(old.workspaceRevision).toBe(8);
		context = { ...context, cwd: "/chosen/second", contextKey: "chosen-2", revision: 9 };
		const newer = await terminalService.create({ narratorId: "n", principal, expectedRevision: 9 });
		expect(remotePty.mock.calls[1]?.[1]).toMatchObject({ cwd: "/chosen/second" });
		expect(old.cwd).toBe("/chosen/first");
		expect(newer.cwd).toBe("/chosen/second");
		terminalService.write(String(old.id), "old terminal input");
		expect(write).toHaveBeenCalledWith("old terminal input");
		expect(localPty).not.toHaveBeenCalled();
	});
	test("temporary other-device creation canonicalizes its own default without moving the resident workspace", async () => {
		context = { ...context, deviceId: "resident-other", cwd: "/resident/selected" };
		canonicalDefault = "/target/canonical";
		const terminal = await terminalService.create({
			narratorId: "n",
			principal,
			deviceId: "remote",
		});
		expect(terminal.cwd).toBe("/target/canonical");
		expect(terminal.workspaceContext).toMatchObject({
			deviceId: "remote",
			cwd: "/target/canonical",
			revision: 8,
		});
		expect(context).toMatchObject({ deviceId: "resident-other", cwd: "/resident/selected" });
		expect(localPty).not.toHaveBeenCalled();
	});

	test("remote disconnect preserves unknown exit rather than inventing successful process termination", async () => {
		await terminalService.create({ narratorId: "n", principal });
		exitResolvers[0]?.(null);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(records[0]?.status).toBe("exited");
		expect(records[0]?.exitCode).toBeNull();
		expect(finishActivity).toHaveBeenCalledWith(expect.objectContaining({ outcome: "unknown" }));
	});

	test("PTY lifetime registers creator/frozen target before spawn and finishes only confirmed exit", async () => {
		let release: (() => void) | undefined;
		registerActivity.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const creating = terminalService.create({ narratorId: "n", principal });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(registerActivity).toHaveBeenCalledTimes(1);
		expect(remotePty).not.toHaveBeenCalled();
		expect(records).toHaveLength(0);
		release?.();
		const terminal = await creating;
		expect(registerActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				narratorId: "n",
				userId: "actor",
				actorKind: "human",
				kind: "pty",
				activityId: `pty:${terminal.id}`,
				target: expect.objectContaining({
					deviceId: "remote",
					cwd: "/chosen/first",
					baseCwd: "/chosen/first",
					runtimeGeneration: 2,
				}),
			}),
		);
		context = { ...context, cwd: "/chosen/new", revision: 9, contextKey: "next" };
		expect(finishActivity).not.toHaveBeenCalled();
		exitResolvers[0]?.(17);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(finishActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				activityId: `pty:${terminal.id}`,
				outcome: "finished",
				target: expect.objectContaining({ cwd: "/chosen/first", runtimeGeneration: 2 }),
			}),
		);
	});

	test("an already-closed short-lived PTY persists its real exit after insertion", async () => {
		remotePty.mockImplementationOnce(() => ({
			write,
			resize: () => {},
			kill: () => {},
			close: () => {},
			exited: Promise.resolve(3),
		}));
		await terminalService.create({ narratorId: "n", principal });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(records[0]).toMatchObject({ status: "exited", exitCode: 3 });
		expect(finishActivity).toHaveBeenCalledWith(expect.objectContaining({ outcome: "finished" }));
	});

	test("proven pre-dispatch PTY spawn failure releases the lifetime", async () => {
		remotePty.mockImplementationOnce(() => {
			throw new Error("no process dispatched");
		});
		await expect(terminalService.create({ narratorId: "n", principal })).rejects.toThrow(
			"no process",
		);
		expect(finishActivity).toHaveBeenCalledWith(expect.objectContaining({ outcome: "finished" }));
		expect(records).toHaveLength(0);
	});

	test("lifetime admission refusal prevents PTY dispatch", async () => {
		registerActivity.mockRejectedValueOnce(new Error("durable history recovery barrier"));
		await expect(terminalService.create({ narratorId: "n", principal })).rejects.toThrow("barrier");
		expect(remotePty).not.toHaveBeenCalled();
		expect(finishActivity).not.toHaveBeenCalled();
		expect(records).toHaveLength(0);
	});

	test("old terminal authorization rechecks its original device/path after switching", async () => {
		const old = await terminalService.create({ narratorId: "n", principal });
		context = { ...context, cwd: "/chosen/new", contextKey: "new", revision: 9 };
		policyTargets = [];
		await terminalService.authorizeTargetAccess(String(old.id), principal, "read");
		expect(policyTargets).toEqual(["/chosen/first"]);
		authorized = false;
		await expect(
			terminalService.authorizeTargetAccess(String(old.id), principal, "write"),
		).rejects.toThrow("denied");
		authorized = true;
		denied = true;
		await expect(
			terminalService.authorizeTargetAccess(String(old.id), principal, "write"),
		).rejects.toThrow("denied");
	});

	for (const group of ["global", "selfRegistered"] as const) {
		test(`OAuth ${group} directory selectors deny creation and old-terminal access before effects`, async () => {
			const old = await terminalService.create({ narratorId: "n", principal });
			oauth = {
				clientId: "client",
				grantId: "grant",
				deviceIds: ["remote"],
				allowLocalExecution: false,
				allowedTools: new Set(["Terminal"]),
				policy: {
					deviceAccess: { host: "denied", global: "readWrite", selfRegistered: "readWrite" },
				},
			};
			selfRegistered = group === "selfRegistered";
			groupDeny = group;
			remotePty.mockClear();
			records = [old];
			await expect(terminalService.create({ narratorId: "n", principal })).rejects.toThrow(
				"denied",
			);
			await expect(
				terminalService.authorizeTargetAccess(String(old.id), principal, "read"),
			).rejects.toThrow("denied");
			expect(remotePty).not.toHaveBeenCalled();
			expect(records).toHaveLength(1);
		});
	}

	test("stale revision/key, offline, actor and path denial all refuse before PTY or insert", async () => {
		await expect(
			terminalService.create({ narratorId: "n", principal, expectedRevision: 7 }),
		).rejects.toThrow("stale");
		await expect(
			terminalService.create({ narratorId: "n", principal, contextKey: "old" }),
		).rejects.toThrow("changed");
		await expect(terminalService.create({ narratorId: "n" })).rejects.toThrow("authenticated");
		online = false;
		await expect(terminalService.create({ narratorId: "n", principal })).rejects.toThrow("offline");
		online = true;
		authorized = false;
		await expect(terminalService.create({ narratorId: "n", principal })).rejects.toThrow("denied");
		authorized = true;
		denied = true;
		await expect(terminalService.create({ narratorId: "n", principal })).rejects.toThrow("denied");
		expect(remotePty).not.toHaveBeenCalled();
		expect(localPty).not.toHaveBeenCalled();
		expect(records).toHaveLength(0);
	});
});
