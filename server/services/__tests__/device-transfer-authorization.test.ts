import { afterEach, expect, mock, test } from "bun:test";
import type { ExecutionBackend } from "../../lib/agent/execution/backend";
import { targetPathSemantics } from "../../lib/agent/execution/path-semantics";
import type { ToolContext } from "../../lib/agent/types";
import type { LoadedExecutionPolicy } from "../execution-policy/repository";

let permissionMode = "default";
mock.module("../../db", () => ({
	db: {
		query: {
			narrators: {
				findFirst: async () => ({ permissionMode, planMode: false, relaxedPlan: false }),
			},
		},
	},
}));
let denyDevice = "fixture";
let denyPath = "/remote/private";
let denyLevel: "denyAll" | "denyWrite" = "denyAll";
let rules = true;
mock.module("../execution-policy/repository", () => ({
	executionPolicyRepository: {
		load: async (narratorId: string): Promise<LoadedExecutionPolicy> => ({
			narratorId,
			ownerNarratorId: narratorId,
			projectId: null,
			projectGitPath: null,
			settingsRevision: 0,
			directoryWhitelist: [],
			commandWhitelist: [],
			commandBlacklist: [],
			directoryBlacklist: rules
				? [
						{
							id: "child-deny",
							enabled: true,
							source: "narrator",
							selector: { kind: "device", deviceId: denyDevice },
							ruleType: "directoryBlacklist",
							path: denyPath,
							pathKey: denyPath,
							pathFlavor: "posix",
							denyLevel,
						},
					]
				: [],
		}),
	},
}));
const { executionPolicyEngine } = await import("../execution-policy/engine");
const { createRecursiveTransferAuthorization } = await import("../device-transfer-authorization");
let driftPath: string | undefined;
let generation = 1;
function backend(deviceId: string): ExecutionBackend {
	const paths = targetPathSemantics("posix");
	const unexpectedIO = async (): Promise<never> => {
		throw new Error("Authorization must not access file bytes or execute commands");
	};
	return {
		statFile: unexpectedIO,
		readFileBytes: unexpectedIO,
		writeFileBytes: unexpectedIO,
		removeFile: unexpectedIO,
		mkdirp: unexpectedIO,
		listDir: unexpectedIO,
		fileExists: unexpectedIO,
		glob: unexpectedIO,
		grep: unexpectedIO,
		execCommand: unexpectedIO,
		gitStatus: unexpectedIO,
		gitDiff: unexpectedIO,
		deviceId,
		kind: deviceId === "local" ? "local" : "remote",
		pathFlavor: "posix",
		paths,
		get runtimeGeneration() {
			return generation;
		},
		resolvePathIdentity: async (path: string) => ({
			deviceId,
			backendKind: deviceId === "local" ? "local" : "remote",
			lexicalPath: path,
			canonicalPath: driftPath === path ? "/outside/private" : path,
			exists: true,
			runtimeGeneration: generation,
		}),
	};
}
const host = backend("local");
const remote = backend("fixture");
let rechecks = 0;
let fences = 0;
function context(direction: "upload" | "download"): ToolContext {
	return {
		narratorId: "transfer-auth-fixture",
		cwd: "/local",
		locale: "en",
		requestPermission: async () => {
			throw new Error("Unexpected interactive permission request");
		},
		signal: new AbortController().signal,
		recheckAuthorization: async () => {
			rechecks++;
		},
		assertWorkspaceCurrent: () => {
			fences++;
		},
		resolveBackend: (deviceId) => (deviceId === "local" ? host : remote),
		executionPlan: {
			kind: "multi",
			primaryKey: "remote",
			endpoints: [
				{
					key: "local",
					operation: direction === "upload" ? "read" : "write",
					target: {
						deviceId: "local",
						backendKind: "local",
						cwd: "/local",
						lexicalPath: "/local",
						canonicalPath: "/local",
						pathFlavor: "posix",
						runtimeGeneration: 1,
						selectionSource: "explicit",
					},
				},
				{
					key: "remote",
					operation: direction === "upload" ? "write" : "read",
					target: {
						deviceId: "fixture",
						backendKind: "remote",
						cwd: "/remote",
						lexicalPath: "/remote",
						canonicalPath: "/remote",
						pathFlavor: "posix",
						runtimeGeneration: 1,
						selectionSource: "explicit",
					},
				},
			],
		},
	};
}
afterEach(() => {
	permissionMode = "default";
	denyDevice = "fixture";
	denyPath = "/remote/private";
	denyLevel = "denyAll";
	rules = true;
	driftPath = undefined;
	generation = 1;
	rechecks = 0;
	fences = 0;
	executionPolicyEngine.invalidate("transfer-auth-fixture");
});

test.each([
	"upload",
	"download",
] as const)("%s rejects denyAll descendant on the remote endpoint", async (direction) => {
	const authorization = await createRecursiveTransferAuthorization(
		context(direction),
		direction,
		"fixture",
	);
	await expect(
		authorization.authorizeFile("/local/private/a.txt", "/remote/private/a.txt"),
	).rejects.toThrow("execution policy");
	expect(rechecks).toBeGreaterThan(0);
});

test.each([
	"upload",
	"download",
] as const)("%s rejects denyAll descendant on the host endpoint", async (direction) => {
	denyDevice = "local";
	denyPath = "/local/private";
	const authorization = await createRecursiveTransferAuthorization(
		context(direction),
		direction,
		"fixture",
	);
	await expect(
		authorization.authorizeFile("/local/private/a.txt", "/remote/private/a.txt"),
	).rejects.toThrow("execution policy");
});

test("denyWrite prevents upload but does not deny the same remote download read", async () => {
	denyLevel = "denyWrite";
	const write = await createRecursiveTransferAuthorization(context("upload"), "upload", "fixture");
	await expect(write.authorizeFile("/local/a.txt", "/remote/private/a.txt")).rejects.toThrow(
		"execution policy",
	);
	const read = await createRecursiveTransferAuthorization(
		context("download"),
		"download",
		"fixture",
	);
	await read.authorizeFile("/local/a.txt", "/remote/private/a.txt");
	expect(fences).toBeGreaterThan(0);
});

test("new live deny and the originally frozen deny both remain effective", async () => {
	rules = false;
	const live = await createRecursiveTransferAuthorization(context("upload"), "upload", "fixture");
	rules = true;
	executionPolicyEngine.invalidate("transfer-auth-fixture");
	await expect(live.authorizeFile("/local/a.txt", "/remote/private/a.txt")).rejects.toThrow(
		"execution policy",
	);
	const frozen = await createRecursiveTransferAuthorization(context("upload"), "upload", "fixture");
	rules = false;
	executionPolicyEngine.invalidate("transfer-auth-fixture");
	await expect(frozen.authorizeFile("/local/a.txt", "/remote/private/a.txt")).rejects.toThrow(
		"execution policy",
	);
});

test("secret descendants, canonical escapes, and a reconnected backend fail closed", async () => {
	const authorization = await createRecursiveTransferAuthorization(
		context("upload"),
		"upload",
		"fixture",
	);
	await expect(authorization.authorizeFile("/local/.ssh/id", "/remote/a.txt")).rejects.toThrow(
		"secret",
	);
	await expect(
		authorization.authorizeFile("/local/a.txt", "/remote/.aws/credentials"),
	).rejects.toThrow("secret");
	driftPath = "/remote/a.txt";
	await expect(authorization.authorizeFile("/local/a.txt", "/remote/a.txt")).rejects.toThrow(
		"canonical",
	);
	driftPath = undefined;
	generation = 2;
	await expect(authorization.authorizeFile("/local/a.txt", "/remote/a.txt")).rejects.toThrow(
		"generation",
	);
	expect(authorization.assertCurrent).toThrow("generation");
});

test("live read-only mode and dontAsk without a descendant allow cannot inherit root approval", async () => {
	const authorization = await createRecursiveTransferAuthorization(
		context("upload"),
		"upload",
		"fixture",
	);
	permissionMode = "readOnly";
	await expect(authorization.authorizeFile("/local/a.txt", "/remote/a.txt")).rejects.toThrow(
		"read-only",
	);
	permissionMode = "dontAsk";
	await expect(authorization.authorizeFile("/local/a.txt", "/remote/a.txt")).rejects.toThrow(
		"execution policy",
	);
});
