import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type {
	WorkspaceAttachmentBinding,
	WorkspaceAttachmentCreationProof,
	WorkspaceAttachmentIntent,
} from "@shared/workspace-attachment-protocol";
import { testEnvironment } from "../../tests/preload";
import { db } from "../db";
import { narrators, users } from "../db/schema";
import { localBackend } from "../lib/agent/execution/local-backend";
import { deleteWorkspaceAttachmentFiles, saveTextFileToWorkspace } from "../lib/uploads";
import {
	cleanupWorkspaceAttachmentByProof,
	createWorkspaceAttachmentFromStagedFile,
} from "../lib/workspace-attachment-io";
import { localDirectoryIdentity } from "./file-change-local-io";
import {
	getDefaultLocalFileChangeRuntime,
	localFileChangeRuntimeBinding,
} from "./file-change-runtime";
import { withFileHistoryWrite } from "./file-history-locks";
import {
	createLocalWorkspaceAttachmentBackend,
	type LocalWorkspaceAttachmentProvider,
} from "./local-workspace-attachment";
import { createNarratorWorkspaceAttachmentAccess } from "./workspace-artifact-access";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
async function fixture<T>(
	body: (input: {
		root: string;
		directory: string;
		binding: WorkspaceAttachmentBinding;
		provider: LocalWorkspaceAttachmentProvider;
		setAuthorized(value: boolean): void;
	}) => Promise<T>,
) {
	const directory = await mkdtemp(join(testEnvironment.isolatedHome, "local-attachment-native-"));
	const root = join(directory, "workspace");
	await mkdir(root, { mode: 0o700 });
	const runtime = await getDefaultLocalFileChangeRuntime();
	const activity = await runtime.registerBashActivity({
		backend: localBackend,
		cwd: root,
		signal: AbortSignal.timeout(10_000),
	});
	activity.end("finished");
	const scope = runtime.evidence.getScope(activity.scope.id);
	const physical = localFileChangeRuntimeBinding();
	if (!scope || !physical || !scope.rootIdentityJson?.object)
		throw new Error("Actual local scope/root/runtime fixture unavailable");
	let authorized = true;
	try {
		return await runtime.coordinator.withWrite(
			{
				scope,
				runtime: physical,
				signal: AbortSignal.timeout(10_000),
				executionClass: "local_file_io",
			},
			async (lease) => {
				const binding: WorkspaceAttachmentBinding = {
					sourceInstanceId: scope.sourceInstanceId,
					workspaceInstanceId: scope.workspaceInstanceId,
					scopeId: scope.id,
					root,
					rootIdentity: scope.rootIdentityJson?.object ?? "",
					fence: lease.executionBinding.fencingToken,
				};
				expect(binding.rootIdentity).toBe(await localDirectoryIdentity(root));
				const provider = await createLocalWorkspaceAttachmentBackend({
					binding,
					privateRoot: join(directory, "private"),
					assertCurrent: async (signal) => {
						signal.throwIfAborted();
						lease.assertCurrent();
					},
					authorizePath: async (path, signal) => {
						signal.throwIfAborted();
						if (!authorized || !localBackend.paths.contains(root, path))
							throw new Error("Actor write revoked");
					},
				});
				try {
					return await body({
						root,
						directory,
						binding,
						provider,
						setAuthorized: (value) => {
							authorized = value;
						},
					});
				} finally {
					await provider.close();
				}
			},
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
async function create(
	input: { provider: LocalWorkspaceAttachmentProvider; binding: WorkspaceAttachmentBinding },
	name = "notes.txt",
	content = "owned by publisher\n",
) {
	const bytes = Buffer.from(content);
	const operationId = crypto.randomUUID();
	const path = `.narrafork/attached/${operationId}/${name}`;
	const digest = hash(bytes);
	const requestDigest = hash(`${operationId}:${path}:${digest}`);
	const intent: WorkspaceAttachmentIntent = {
		binding: input.binding,
		operationId,
		requestDigest,
		path,
		sizeBytes: bytes.byteLength,
		digest,
		expected: "absent",
		noOverwrite: true,
	};
	const signal = AbortSignal.timeout(10_000);
	await input.provider.workspaceAttachment("begin", intent, signal);
	await input.provider.workspaceAttachment(
		"append",
		{
			binding: input.binding,
			operationId,
			requestDigest,
			offset: 0,
			contentBase64: bytes.toString("base64"),
			chunkDigest: digest,
		},
		signal,
	);
	const status = await input.provider.workspaceAttachment(
		"commit",
		{ binding: input.binding, operationId, requestDigest },
		signal,
	);
	if (!status.proof || status.state !== "committed")
		throw new Error("Native publication did not return actual creation proof");
	return { proof: status.proof, path: join(input.binding.root, path), intent };
}
async function cleanup(
	input: { provider: LocalWorkspaceAttachmentProvider; binding: WorkspaceAttachmentBinding },
	proof: WorkspaceAttachmentCreationProof,
) {
	const operationId = `cleanup-${proof.operationId}`;
	const requestDigest = hash(JSON.stringify({ operationId, proof }));
	return input.provider.workspaceAttachment(
		"cleanup",
		{ binding: input.binding, operationId, requestDigest, proof },
		AbortSignal.timeout(10_000),
	);
}
// Bun's async .rejects matcher can starve Worker message callbacks; await the promise ourselves.
async function rejected(promise: Promise<unknown>, message: string) {
	let captured: unknown;
	try {
		await promise;
	} catch (error) {
		captured = error;
	}
	expect(captured instanceof Error ? captured.message : "NO ERROR").toContain(message);
}

test.skipIf(process.platform !== "linux")(
	"local native exclusive creation and ORIGINAL proof cleanup are positive and idempotent",
	async () =>
		fixture(async (input) => {
			const created = await create(input);
			expect(await readFile(created.path, "utf8")).toBe("owned by publisher\n");
			expect(created.proof.incarnation).toBeTruthy();
			expect(created.proof.nativeMetadataDigest).toMatch(/^[a-f0-9]{64}$/);
			expect(created.proof.creationProof).toHaveLength(64);
			const result = await cleanup(input, created.proof);
			expect(result.outcome).toBe("deleted");
			await expect(lstat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await cleanup(input, created.proof)).toEqual(result);
		}),
	30_000,
);

for (const kind of ["bytes", "incarnation", "mode"] as const)
	test.skipIf(process.platform !== "linux")(
		`local cleanup retains foreign ${kind} changes without plain deletion`,
		async () =>
			fixture(async (input) => {
				const created = await create(input);
				if (kind === "bytes") await writeFile(created.path, "human edited\n");
				else if (kind === "incarnation") {
					const replacement = `${created.path}.replacement`;
					await writeFile(replacement, "owned by publisher\n", { mode: 0o600 });
					await rename(replacement, created.path);
				} else await chmod(created.path, 0o640);
				const result = await cleanup(input, created.proof);
				expect(result.outcome).toBe("conflict");
				expect((await lstat(created.path)).isFile()).toBe(true);
			}),
		30_000,
	);

test.skipIf(process.platform !== "linux")(
	"missing/forged original creation proofs and actor revocation fail closed",
	async () =>
		fixture(async (input) => {
			const created = await create(input);
			await rejected(
				cleanup(input, { ...created.proof, operationId: "no-original-receipt" }),
				"Original attachment publisher receipt",
			);
			await rejected(
				cleanup(input, { ...created.proof, creationProof: "forged" }),
				"Original creation proof",
			);
			input.setAuthorized(false);
			await rejected(cleanup(input, created.proof), "Actor write revoked");
			expect(await readFile(created.path, "utf8")).toBe("owned by publisher\n");
		}),
	30_000,
);

test.skipIf(process.platform !== "linux")(
	"local pending disk suffix is unknown and retained, never truncated or auto-cleaned",
	async () =>
		fixture(async (input) => {
			const operationId = crypto.randomUUID();
			const intent: WorkspaceAttachmentIntent = {
				binding: input.binding,
				operationId,
				requestDigest: hash(operationId),
				path: "attached.txt",
				sizeBytes: 3,
				digest: hash("abc"),
				expected: "absent",
				noOverwrite: true,
			};
			await input.provider.workspaceAttachment("begin", intent);
			const key = hash(`${input.binding.scopeId}\0${operationId}`);
			const part = join(input.directory, "private", `${key}.part`);
			await writeFile(part, "unacknowledged");
			await rejected(
				input.provider.workspaceAttachment("append", {
					binding: input.binding,
					operationId,
					requestDigest: intent.requestDigest,
					offset: 0,
					contentBase64: Buffer.from("abc").toString("base64"),
					chunkDigest: hash("abc"),
				}),
				"Unacknowledged stage suffix",
			);
			expect(
				(
					await input.provider.workspaceAttachment("status", {
						binding: input.binding,
						operationId,
						requestDigest: intent.requestDigest,
					})
				).state,
			).toBe("unknown");
			expect(await readFile(part, "utf8")).toBe("unacknowledged");
		}),
	30_000,
);

test.skipIf(process.platform !== "linux")(
	"local native 100MiB upload streams in a worker and returns the publisher's original proof",
	async () =>
		fixture(async (input) => {
			const size = 100 * 1024 * 1024;
			const staged = join(input.directory, "staged-100MiB");
			const file = await open(staged, "wx", 0o600);
			await file.truncate(size);
			await file.close();
			const operationId = crypto.randomUUID();
			let ticks = 0;
			const ticker = setInterval(() => {
				ticks++;
			}, 5);
			try {
				const proof = await createWorkspaceAttachmentFromStagedFile({
					target: { backend: input.provider, binding: input.binding, deviceId: "local" },
					operationId,
					path: `.narrafork/attached/${operationId}/large.txt`,
					stagedFilePath: staged,
					sizeBytes: size,
					signal: AbortSignal.timeout(60_000),
					authorize: async () => {},
				});
				expect(proof.sizeBytes).toBe(size);
				expect((await lstat(join(input.root, proof.path))).size).toBe(size);
				expect(ticks).toBeGreaterThan(5);
				const result = await cleanupWorkspaceAttachmentByProof({
					target: { backend: input.provider, binding: input.binding, deviceId: "local" },
					proof,
					operationId: `cleanup-${operationId}`,
					signal: AbortSignal.timeout(20_000),
					authorize: async () => {},
				});
				expect(result.outcome).toBe("deleted");
			} finally {
				clearInterval(ticker);
			}
		}),
	90_000,
);

test.skipIf(process.platform !== "linux")(
	"production human factory creates native local proof and cleans it under a fresh real lease",
	async () => {
		const directory = await mkdtemp(
			join(testEnvironment.isolatedHome, "local-attachment-production-"),
		);
		const root = join(directory, "workspace");
		await mkdir(root, { mode: 0o700 });
		const userId = crypto.randomUUID();
		const narratorId = crypto.randomUUID();
		const createdAt = new Date().toISOString();
		const workspace = {
			revision: 0,
			contextKey: crypto.randomUUID(),
			deviceId: "local",
			cwd: root,
			pathFlavor: "posix" as const,
			capabilities: { switchDirectory: true },
		};
		db.insert(users)
			.values({
				id: userId,
				username: userId,
				passwordHash: "fixture-not-a-credential",
				role: "user",
				createdAt,
			})
			.run();
		db.insert(narrators)
			.values({
				id: narratorId,
				ownerUserId: userId,
				cwd: root,
				workspaceContext: workspace,
				permissionMode: "readOnly",
				createdAt,
				updatedAt: createdAt,
			})
			.run();
		try {
			const access = createNarratorWorkspaceAttachmentAccess(narratorId, workspace, {
				userId,
				signal: AbortSignal.timeout(20_000),
			});
			const ref = await saveTextFileToWorkspace(
				new File(["real human local native receipt\n"], "notes.txt", { type: "text/plain" }),
				access,
			);
			expect(ref.attachmentCreationProof).toBeDefined();
			expect(ref.attachmentCreationProof?.binding.rootIdentity).toBe(
				await localDirectoryIdentity(root),
			);
			expect(await readFile(ref.filePath, "utf8")).toBe("real human local native receipt\n");
			const original = structuredClone(ref.attachmentCreationProof);
			await deleteWorkspaceAttachmentFiles([ref], access);
			expect(ref.attachmentCleanupUnavailableReason).toBeUndefined();
			await expect(lstat(ref.filePath)).rejects.toMatchObject({ code: "ENOENT" });
			expect(ref.attachmentCreationProof).toEqual(original);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
	30_000,
);

test.skipIf(process.platform !== "linux")(
	"local cleanup takes its real observation AFTER waiting for the shared file mutation lock",
	async () =>
		fixture(async (input) => {
			const created = await create(input);
			let entered: (() => void) | undefined;
			let release: (() => void) | undefined;
			const held = new Promise<void>((resolveHeld) => {
				entered = resolveHeld;
			});
			const unlock = new Promise<void>((resolveUnlock) => {
				release = resolveUnlock;
			});
			const blocker = withFileHistoryWrite(
				{ deviceId: "local", pathFlavor: "posix", canonicalPath: input.root },
				async () => {
					entered?.();
					await unlock;
				},
			);
			await held;
			const pending = cleanup(input, created.proof);
			const foreign = `${created.path}.foreign`;
			await writeFile(foreign, "owned by publisher\n", { mode: 0o600 });
			await rename(foreign, created.path);
			release?.();
			await blocker;
			const outcome = await pending;
			expect(outcome.outcome).toBe("conflict");
			expect(await readFile(created.path, "utf8")).toBe("owned by publisher\n");
		}),
	30_000,
);

test.skipIf(process.platform !== "linux")(
	"local creation refuses overwrite and changed original workspace incarnation",
	async () =>
		fixture(async (input) => {
			const operationId = crypto.randomUUID();
			const intent: WorkspaceAttachmentIntent = {
				binding: input.binding,
				operationId,
				requestDigest: hash(operationId),
				path: "foreign.txt",
				sizeBytes: 4,
				digest: hash("ours"),
				expected: "absent",
				noOverwrite: true,
			};
			await writeFile(join(input.root, intent.path), "foreign human data\n");
			await rejected(input.provider.workspaceAttachment("begin", intent), "already exists");
			expect(await readFile(join(input.root, intent.path), "utf8")).toBe("foreign human data\n");
			const originalRoot = `${input.root}.original`;
			await rename(input.root, originalRoot);
			await mkdir(input.root, { mode: 0o700 });
			await rejected(
				input.provider.workspaceAttachment("begin", {
					...intent,
					operationId: `${operationId}-changed-root`,
					requestDigest: hash("changed root"),
					path: "new.txt",
				}),
				"root incarnation changed",
			);
			expect(await readFile(join(originalRoot, intent.path), "utf8")).toBe("foreign human data\n");
		}),
	30_000,
);

test.skipIf(process.platform !== "linux")(
	"local cancelled admission does not create a stage or a target",
	async () =>
		fixture(async (input) => {
			const controller = new AbortController();
			controller.abort(new Error("cancelled before admission"));
			const intent: WorkspaceAttachmentIntent = {
				binding: input.binding,
				operationId: crypto.randomUUID(),
				requestDigest: hash("cancel before"),
				path: "cancelled.txt",
				sizeBytes: 1,
				digest: hash("x"),
				expected: "absent",
				noOverwrite: true,
			};
			await rejected(
				input.provider.workspaceAttachment("begin", intent, controller.signal),
				"cancelled before admission",
			);
			await expect(lstat(join(input.root, intent.path))).rejects.toMatchObject({ code: "ENOENT" });
		}),
	30_000,
);
