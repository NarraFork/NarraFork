import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type {
	WorkspaceAttachmentBackend,
	WorkspaceAttachmentCreationProof,
	WorkspaceAttachmentIntent,
	WorkspaceAttachmentOperation,
	WorkspaceAttachmentOperations,
} from "@shared/workspace-attachment-protocol";
import type { WorkspaceContext } from "@shared/workspace-context";
import type { ExecutionBackend } from "../agent/execution/backend";
import { posixPathSemantics, windowsPathSemantics } from "../agent/execution/path-semantics";
import type { WorkspaceAttachmentAccess } from "../uploads";

const files = new Map<string, Uint8Array>();
const upload = mock(
	async (args: {
		deviceId: string;
		localPath: string;
		remoteDest: string;
		signal?: AbortSignal;
	}) => {
		args.signal?.throwIfAborted();
		const bytes = new Uint8Array(await Bun.file(args.localPath).arrayBuffer());
		files.set(args.remoteDest, bytes);
		return { transferId: "fixture-transfer", bytes: bytes.length };
	},
);
const download = mock(
	async (args: { remotePath: string; localDest: string; signal?: AbortSignal }) => {
		args.signal?.throwIfAborted();
		await Bun.write(args.localDest, files.get(args.remotePath) ?? new Uint8Array());
		return { transferId: "fixture-download", bytes: files.get(args.remotePath)?.length ?? 0 };
	},
);
mock.module("../../services/device-transfer-service", () => ({
	uploadFile: upload,
	downloadFile: download,
	statRemote: async (_id: string, path: string) => ({
		exists: files.has(path),
		isDirectory: false,
		size: files.get(path)?.length ?? 0,
		mtimeMs: 1,
	}),
}));
const {
	saveTextFileToWorktree,
	saveTextFileToWorkspace,
	copyTextFileToWorktree,
	setUploadsDirForTests,
	deleteWorkspaceAttachmentFiles,
	MAX_TEXT_FILE_SIZE,
} = await import("../uploads");
let staging: string;
beforeEach(() => {
	staging = mkdtempSync(resolve(tmpdir(), "nf-workspace-uploads-"));
	setUploadsDirForTests(staging);
	files.clear();
	upload.mockClear();
	download.mockClear();
});
afterEach(() => {
	setUploadsDirForTests(null);
	rmSync(staging, { recursive: true, force: true });
});
function fixture(windows = false) {
	const paths = windows ? windowsPathSemantics : posixPathSemantics;
	const cwd = windows ? "D:\\selected\\repo" : "/remote/selected/repo";
	const context: WorkspaceContext = {
		deviceId: "remote",
		cwd,
		pathFlavor: windows ? "windows" : "posix",
		revision: 4,
		contextKey: "remote-selected-4",
		capabilities: { switchDirectory: true },
	};
	const backend = {
		deviceId: "remote",
		kind: "remote" as const,
		paths,
		pathFlavor: paths.flavor,
		runtimeGeneration: 3,
		defaultCwd: windows ? "C:\\decoy" : "/remote/decoy",
		platform: { os: windows ? "windows" : "linux", arch: "amd64" },
		resolvePathIdentity: mock(async (path: string) => ({
			lexicalPath: paths.normalize(path),
			canonicalPath: paths.normalize(path),
			exists: path === cwd || files.has(path),
			runtimeGeneration: 3,
		})),
		mkdirp: mock(async (_path: string) => {}),
		statFile: mock(async (path: string) =>
			files.has(path)
				? { isFile: true, isDirectory: false, size: files.get(path)?.length ?? 0 }
				: null,
		),
		removeFile: mock(async (path: string) => {
			files.delete(path);
		}),
	};
	const authorizeWrite = mock(
		async (_path: string, _backend: ExecutionBackend, _signal?: AbortSignal) => true,
	);
	const access: WorkspaceAttachmentAccess = {
		backend: backend as unknown as ExecutionBackend,
		workspaceContext: context,
		authorizeWrite,
	};
	return { backend, context, authorizeWrite, access };
}
for (const windows of [false, true])
	describe(`workspace attachment ${windows ? "Windows" : "POSIX"}`, () => {
		test("streams staging, uses binary transfer, and returns device-qualified selected path", async () => {
			const { backend, context, authorizeWrite, access } = fixture(windows);
			const file = new File(["approved attachment\n"], "notes.txt");
			const arrayBuffer = spyOn(file, "arrayBuffer").mockImplementation(async () => {
				throw new Error("whole input arrayBuffer forbidden");
			});
			try {
				const ref = await saveTextFileToWorktree(context.cwd, file, access);
				expect(ref).toMatchObject({
					deviceId: "remote",
					contextKey: context.contextKey,
					filename: "notes.txt",
					size: file.size,
				});
				expect(ref.attachmentId).toHaveLength(21);
				expect(ref.filePath).toBe(
					backend.paths.resolve(context.cwd, `.narrafork/attached/${ref.attachmentId}/notes.txt`),
				);
				expect(upload.mock.calls[0][0].remoteDest).toBe(ref.filePath);
				expect(new TextDecoder().decode(files.get(ref.filePath))).toBe("approved attachment\n");
				expect(authorizeWrite).toHaveBeenCalledTimes(7);
				expect(arrayBuffer).not.toHaveBeenCalled();
				expect(readdirSync(resolve(staging, ".workspace-staging"))).toEqual([]);
			} finally {
				arrayBuffer.mockRestore();
			}
		});
	});
test("missing or denied write authorization creates no target directories or transfers", async () => {
	const { backend, access } = fixture();
	await expect(
		saveTextFileToWorkspace(new File(["x"], "notes.txt"), {
			...access,
			authorizeWrite: undefined,
		} as unknown as WorkspaceAttachmentAccess),
	).rejects.toThrow("explicit authorization");
	await expect(
		saveTextFileToWorkspace(new File(["x"], "notes.txt"), {
			...access,
			authorizeWrite: async () => false,
		}),
	).rejects.toThrow("write denied");
	expect(backend.mkdirp).not.toHaveBeenCalled();
	expect(upload).not.toHaveBeenCalled();
});
test("modern executor cannot fall back to unproved transfer when trusted lease adapter is missing", async () => {
	const { access, backend } = fixture();
	await expect(
		saveTextFileToWorkspace(new File(["native"], "notes.txt"), {
			...access,
			backend: { ...access.backend, supportsWorkspaceAttachment: true },
		}),
	).rejects.toThrow("trusted actor/native resolver");
	expect(backend.mkdirp).not.toHaveBeenCalled();
	expect(upload).not.toHaveBeenCalled();
	expect(files.size).toBe(0);
	expect(existsSync(resolve(staging, ".workspace-staging"))).toBe(false);
});

test("aborts and oversized uploads stop before metadata or staging", async () => {
	const { backend, access } = fixture();
	const controller = new AbortController();
	controller.abort();
	await expect(
		saveTextFileToWorkspace(new File(["x"], "notes.txt"), { ...access, signal: controller.signal }),
	).rejects.toThrow();
	await expect(
		saveTextFileToWorkspace({ name: "huge.txt", size: MAX_TEXT_FILE_SIZE + 1 } as File, access),
	).rejects.toThrow("too large");
	expect(backend.resolvePathIdentity).not.toHaveBeenCalled();
	expect(upload).not.toHaveBeenCalled();
});
test("unconfirmed remote materialization leaves unknown results untouched but clears staging", async () => {
	const { backend, access, context } = fixture();
	const sibling = `${context.cwd}/.narrafork/attached/existing.txt`;
	files.set(sibling, new TextEncoder().encode("other operation"));
	upload.mockImplementationOnce(async (args) => {
		files.set(args.remoteDest, new Uint8Array([1]));
		throw new Error("connection failed");
	});
	await expect(saveTextFileToWorkspace(new File(["abc"], "notes.txt"), access)).rejects.toThrow(
		"connection failed",
	);
	expect(files.has(sibling)).toBe(true);
	for (const [path] of backend.removeFile.mock.calls) expect(path).not.toBe(sibling);
	expect(backend.removeFile).not.toHaveBeenCalled();
	expect(readdirSync(resolve(staging, ".workspace-staging"))).toEqual([]);
});
test("an escaped or existing destination is refused before write authorization", async () => {
	const { backend, access, authorizeWrite } = fixture();
	backend.resolvePathIdentity.mockImplementation(async (path) => ({
		lexicalPath: path,
		canonicalPath: path.includes("attached") ? "/outside/secret.txt" : path,
		exists: false,
		runtimeGeneration: 3,
	}));
	await expect(saveTextFileToWorkspace(new File(["x"], "notes.txt"), access)).rejects.toThrow(
		"escaped",
	);
	expect(authorizeWrite).not.toHaveBeenCalled();
	expect(upload).not.toHaveBeenCalled();
});
test("remote source is never interpreted as a host pathname", async () => {
	const host = resolve(staging, "source.txt");
	await Bun.write(host, "host decoy");
	await expect(
		copyTextFileToWorktree(staging, {
			filename: "source.txt",
			filePath: host,
			deviceId: "remote",
			size: 10,
		}),
	).rejects.toThrow("host pathname");
	expect(await Bun.file(host).text()).toBe("host decoy");
});
test("remote-source copy authorizes source then streams bounded download and upload", async () => {
	const { backend, access, context } = fixture();
	const source = `${context.cwd}/source.txt`;
	files.set(source, new TextEncoder().encode("original source"));
	const authorizeRead = mock(async () => true);
	const ref = await copyTextFileToWorktree(
		context.cwd,
		{ filename: "source.txt", filePath: source, deviceId: "remote", size: 15 },
		{
			...access,
			sourceAccess: {
				backend: backend as unknown as ExecutionBackend,
				workspaceContext: context,
				authorizeRead,
			},
		},
	);
	expect(authorizeRead).toHaveBeenCalledTimes(2);
	expect(download).toHaveBeenCalledTimes(1);
	expect(upload).toHaveBeenCalledTimes(1);
	expect(new TextDecoder().decode(files.get(ref.filePath))).toBe("original source");
	expect(readdirSync(resolve(staging, ".workspace-staging"))).toEqual([]);
});
test("write revocation before dispatch never uploads and releases staging", async () => {
	const { access } = fixture();
	let checks = 0;
	await expect(
		saveTextFileToWorkspace(new File(["x"], "notes.txt"), {
			...access,
			authorizeWrite: async () => ++checks <= 4,
		}),
	).rejects.toThrow("authority changed");
	expect(upload).not.toHaveBeenCalled();
	expect(existsSync(resolve(staging, ".workspace-staging"))).toBe(false);
});
test("even matching device/context/nonce cannot authorize cleanup without original proof", async () => {
	const { access, context, backend } = fixture();
	const ref = await saveTextFileToWorkspace(new File(["owned"], "notes.txt"), access);
	const sibling = `${context.cwd}/existing.txt`;
	files.set(sibling, new Uint8Array([1]));
	await deleteWorkspaceAttachmentFiles(
		[
			{ ...ref, deviceId: "other" },
			{ ...ref, contextKey: "other" },
			{ ...ref, filePath: sibling },
		],
		access,
	);
	expect(backend.removeFile).not.toHaveBeenCalled();
	await deleteWorkspaceAttachmentFiles([ref], access);
	expect(files.has(ref.filePath)).toBe(true);
	expect(ref.attachmentCleanupUnavailableReason).toContain("original conditional creation proof");
	expect(backend.removeFile).not.toHaveBeenCalled();
	expect(files.has(sibling)).toBe(true);
});

test("native create/copy/cleanup I/O settles inside held lease; nonce never invokes plain removal", async () => {
	const { access, backend, context } = fixture();
	let lease = false;
	let admittedOperationId = "";
	let intent: WorkspaceAttachmentIntent | undefined;
	let proof: WorkspaceAttachmentCreationProof | undefined;
	let payload = Buffer.alloc(0);
	let cleanupCount = 0;
	const native: WorkspaceAttachmentBackend = {
		supportsWorkspaceAttachment: true,
		async workspaceAttachment<K extends WorkspaceAttachmentOperation>(
			operation: K,
			request: WorkspaceAttachmentOperations[K]["request"],
		): Promise<WorkspaceAttachmentOperations[K]["result"]> {
			expect(lease).toBe(true);
			expect(request.operationId).toBe(admittedOperationId);
			await new Promise<void>((done) => queueMicrotask(done));
			expect(lease).toBe(true);
			if (operation === "cleanup") {
				cleanupCount++;
				const input = request as WorkspaceAttachmentOperations["cleanup"]["request"];
				const path = backend.paths.resolve(context.cwd, input.proof.path);
				const current = files.get(path);
				const matches =
					proof &&
					JSON.stringify(input.proof) === JSON.stringify(proof) &&
					current &&
					createHash("sha256").update(current).digest("hex") === proof.digest;
				if (matches) files.delete(path);
				return {
					binding: input.binding,
					operationId: input.operationId,
					requestDigest: input.requestDigest,
					outcome: matches ? "deleted" : "conflict",
				} as WorkspaceAttachmentOperations[K]["result"];
			}
			if (operation === "begin") {
				intent = request as WorkspaceAttachmentIntent;
				payload = Buffer.alloc(0);
				proof = undefined;
			}
			if (!intent) throw new Error("No creation intent");
			if (operation === "append")
				payload = Buffer.concat([
					payload,
					Buffer.from(
						(request as WorkspaceAttachmentOperations["append"]["request"]).contentBase64,
						"base64",
					),
				]);
			if (operation === "commit") {
				proof = {
					version: 1,
					binding: intent.binding,
					operationId: intent.operationId,
					requestDigest: intent.requestDigest,
					path: intent.path,
					sizeBytes: payload.length,
					digest: createHash("sha256").update(payload).digest("hex"),
					incarnation: "private-native-created-inode",
					nativeMetadataDigest: "b".repeat(64),
					creationProof: "private-publisher-object-proof",
					state: "committed",
					createdAt: new Date().toISOString(),
				};
				files.set(backend.paths.resolve(context.cwd, intent.path), payload);
			}
			return {
				binding: intent.binding,
				operationId: intent.operationId,
				requestDigest: intent.requestDigest,
				path: intent.path,
				writtenBytes: payload.length,
				state: proof ? "committed" : "pending",
				...(proof ? { proof } : {}),
			} as WorkspaceAttachmentOperations[K]["result"];
		},
	};
	access.attachmentTarget = async () => {
		throw new Error("production may not escape the held callback");
	};
	access.withAttachmentTarget = async (_signal, body, admitted) => {
		expect(admitted.canonicalPath).toBe(admitted.lexicalPath);
		admittedOperationId = admitted.operationId;
		expect(lease).toBe(false);
		lease = true;
		try {
			return await body({
				deviceId: "remote",
				backend: native,
				binding: {
					sourceInstanceId: "actual-source",
					workspaceInstanceId: "actual-workspace",
					scopeId: "scope",
					root: context.cwd,
					rootIdentity: "native-root",
					fence: 3,
				},
			});
		} finally {
			lease = false;
		}
	};
	backend.statFile.mockImplementation(async (path) => {
		expect(lease).toBe(path.includes(".narrafork/attached"));
		return files.has(path)
			? { isFile: true, isDirectory: false, size: files.get(path)?.length ?? 0 }
			: null;
	});
	const ref = await saveTextFileToWorkspace(new File(["native-original"], "notes.txt"), access);
	expect(ref.attachmentCreationProof?.operationId).toBe(ref.attachmentId);
	expect(lease).toBe(false);
	expect(upload).not.toHaveBeenCalled();
	expect(backend.mkdirp).not.toHaveBeenCalled();
	files.set(ref.filePath, new TextEncoder().encode("external-change"));
	await deleteWorkspaceAttachmentFiles([ref], access);
	expect(files.has(ref.filePath)).toBe(true);
	expect(ref.attachmentCleanupUnavailableReason).toContain("conflict");
	files.set(ref.filePath, new TextEncoder().encode("native-original"));
	await deleteWorkspaceAttachmentFiles([ref], access);
	expect(files.has(ref.filePath)).toBe(false);
	expect(ref.attachmentCleanupUnavailableReason).toBeUndefined();
	expect(cleanupCount).toBe(2);
	expect(lease).toBe(false);
	const sourcePath = `${context.cwd}/copy-source.txt`;
	files.set(sourcePath, new TextEncoder().encode("copied-native"));
	const copied = await copyTextFileToWorktree(
		context.cwd,
		{ filename: "copied.txt", filePath: sourcePath, deviceId: "remote", size: 13 },
		{
			...access,
			sourceAccess: {
				backend: access.backend,
				workspaceContext: context,
				authorizeRead: async () => true,
			},
		},
	);
	expect(copied.attachmentCreationProof?.operationId).toBe(copied.attachmentId);
	expect(upload).not.toHaveBeenCalled();
	expect(download).toHaveBeenCalledTimes(1);
	await deleteWorkspaceAttachmentFiles([copied], access);
	expect(files.has(copied.filePath)).toBe(false);
	expect(lease).toBe(false);
	expect(backend.removeFile).not.toHaveBeenCalled();
});

test("legacy local callers remain local and stream File without arrayBuffer", async () => {
	const file = new File(["legacy text"], "notes.txt");
	const spy = spyOn(file, "arrayBuffer").mockImplementation(async () => {
		throw new Error("not streamed");
	});
	try {
		const ref = await saveTextFileToWorktree(staging, file);
		expect(existsSync(ref.filePath)).toBe(true);
		expect(await Bun.file(ref.filePath).text()).toBe("legacy text");
		expect(upload).not.toHaveBeenCalled();
	} finally {
		spy.mockRestore();
	}
});
