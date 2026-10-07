import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { deleteShare, getShare } from "../../../shares";
import type { ExecutionBackend } from "../../execution/backend";
import { posixPathSemantics, windowsPathSemantics } from "../../execution/path-semantics";
import type { ShareArchiveRequest, ShareArchiveResult } from "../../execution/share-archive-rpc";
import type { ToolContext } from "../../types";
import { shareFileTool, type WorkspaceShareReadAuthorizer } from "../share-file";

const published: string[] = [];
const temporary: string[] = [];
afterEach(() => {
	for (const id of published.splice(0)) deleteShare(id);
	for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture(options: { windows?: boolean; directory?: boolean; bytes?: Uint8Array } = {}) {
	const paths = options.windows ? windowsPathSemantics : posixPathSemantics;
	const cwd = options.windows ? "D:\\selected\\repo" : "/remote/selected/repo";
	const bytes = options.bytes ?? new TextEncoder().encode("remote, not host\n");
	const digest = createHash("sha256").update(bytes).digest("hex");
	let operationId = "";
	let format: ShareArchiveResult["format"] = "raw";
	let root = paths.resolve(cwd, options.directory ? "docs" : "notes.txt");
	const shareArchive = mock(async (request: ShareArchiveRequest): Promise<ShareArchiveResult> => {
		operationId = request.operationId;
		if (request.operation === "inspect") {
			root = request.paths?.[0] ?? root;
			const entries = options.directory
				? [
						{ path: root, sizeBytes: 0, isDirectory: true },
						{ path: paths.resolve(root, "notes.txt"), sizeBytes: bytes.length, isDirectory: false },
					]
				: [{ path: root, sizeBytes: bytes.length, isDirectory: false }];
			return {
				operationId,
				entries,
				entryCount: entries.length,
				expandedBytes: bytes.length,
				manifestHash: "a".repeat(64),
				isDirectory: !!options.directory,
				originalName: options.directory ? "docs" : "notes.txt",
			};
		}
		if (request.operation === "prepare") {
			format = request.format ?? "raw";
			return {
				operationId,
				artifactId: "artifact-scoped-id",
				archiveSizeBytes: bytes.length,
				archiveDigest: digest,
				format,
				filename: format === "raw" ? "notes.txt" : `docs.${format}`,
				originalName: options.directory ? "docs" : "notes.txt",
			};
		}
		if (request.operation === "readChunk") {
			const offset = request.offset ?? 0;
			const chunk = bytes.slice(offset, offset + (request.maxChunkBytes ?? 1024 * 1024));
			return {
				operationId,
				artifactId: "artifact-scoped-id",
				offset,
				contentBase64: Buffer.from(chunk).toString("base64"),
				eof: offset + chunk.length === bytes.length,
			};
		}
		return { operationId, released: true };
	});
	const backend = {
		deviceId: "remote",
		kind: "remote",
		defaultCwd: "/decoy",
		paths,
		pathFlavor: paths.flavor,
		runtimeGeneration: 3,
		supportsShareArchive: true,
		shareArchive,
	} as unknown as ExecutionBackend;
	const authorize = mock(
		async (_path: string, _backend: ExecutionBackend, _signal?: AbortSignal) => true,
	);
	const ctx: ToolContext & { authorizeWorkspaceRead?: WorkspaceShareReadAuthorizer } = {
		narratorId: "share-remote",
		cwd: "/host/decoy",
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" }),
		resolveBackend: () => backend,
		workspaceContext: {
			cwd,
			deviceId: "remote",
			pathFlavor: options.windows ? "windows" : "posix",
			contextKey: "chosen-remote",
			revision: 4,
			capabilities: { switchDirectory: true },
		},
		authorizeWorkspaceRead: authorize,
	};
	return { backend, ctx, shareArchive, authorize, bytes, paths, cwd };
}
async function run(f: ReturnType<typeof fixture>, args: Record<string, unknown>) {
	const result = await shareFileTool.execute(args, f.ctx);
	if (typeof result.metadata?.shareId === "string") published.push(result.metadata.shareId);
	return result;
}
describe("remote ShareFile", () => {
	for (const windows of [false, true])
		test(`shares selected ${windows ? "Windows" : "POSIX"} source without touching host cwd`, async () => {
			const f = fixture({ windows });
			const result = await run(f, { path: "notes.txt", preview: true });
			expect(result.isError, result.output).not.toBe(true);
			expect(f.shareArchive.mock.calls[0][0].paths).toEqual([f.paths.resolve(f.cwd, "notes.txt")]);
			expect(f.authorize).toHaveBeenCalledTimes(3);
			const share = getShare(result.metadata?.shareId as string);
			expect(share).not.toBeNull();
			expect(await Bun.file(share?.storagePath as string).text()).toBe("remote, not host\n");
			expect(result.metadata?.deviceId).toBe("remote");
			expect(result.metadata?.previewType).toBe("text");
			expect(f.shareArchive.mock.calls.at(-1)?.[0].operation).toBe("release");
		});
	test("directory materialization uses executor archive, not host recursive enumeration", async () => {
		const f = fixture({ directory: true });
		const result = await run(f, { path: "docs", preview: true });
		expect(result.isError, result.output).not.toBe(true);
		expect(
			f.shareArchive.mock.calls.find(([request]) => request.operation === "prepare")?.[0].format,
		).toBe("tar.gz");
		expect(result.metadata).toMatchObject({
			isDirectory: true,
			compressed: true,
			format: "tar.gz",
		});
	});
	test("server chunk collection is bounded and preserves a file larger than one chunk", async () => {
		const bytes = new Uint8Array(1024 * 1024 + 17).fill(65);
		const f = fixture({ bytes });
		const result = await run(f, { path: "notes.txt" });
		expect(result.isError, result.output).not.toBe(true);
		const requests = f.shareArchive.mock.calls.filter(
			([request]) => request.operation === "readChunk",
		);
		expect(requests).toHaveLength(2);
		expect(requests[0][0].maxChunkBytes).toBe(1024 * 1024);
		expect(requests[1][0].maxChunkBytes).toBe(17);
		const share = getShare(result.metadata?.shareId as string);
		expect(share?.size).toBe(bytes.length);
	});
	test("a denied child never reaches prepare or chunk publication", async () => {
		const f = fixture({ directory: true });
		f.authorize.mockImplementation(async (path) => !path.endsWith("notes.txt"));
		const result = await run(f, { path: "docs" });
		expect(result.isError).toBe(true);
		expect(result.metadata?.shareId).toBeUndefined();
		expect(f.shareArchive.mock.calls.some(([request]) => request.operation === "prepare")).toBe(
			false,
		);
	});
	test("missing actor read guard and legacy executor fail closed, not against host decoys", async () => {
		const f = fixture();
		f.ctx.authorizeWorkspaceRead = undefined;
		const result = await run(f, { path: "notes.txt" });
		expect(result.isError).toBe(true);
		expect(result.output).toContain("authorization");
		expect(f.shareArchive.mock.calls.some(([request]) => request.operation === "inspect")).toBe(
			false,
		);
		const old = fixture();
		(old.backend as unknown as { supportsShareArchive: boolean }).supportsShareArchive = false;
		const unsupported = await run(old, { path: "docs" });
		expect(unsupported.isError).toBe(true);
		expect(unsupported.output).toContain("upgrade");
	});
	test("digest, source escape, and artifact filename failures never publish", async () => {
		for (const bad of ["digest", "source", "filename"] as const) {
			const f = fixture();
			const original = f.shareArchive.getMockImplementation() as (
				request: ShareArchiveRequest,
			) => Promise<ShareArchiveResult>;
			f.shareArchive.mockImplementation(async (request) => {
				const result = await original(request);
				if (bad === "source" && request.operation === "inspect")
					result.entries = [
						{ path: "/unapproved/secret", sizeBytes: f.bytes.length, isDirectory: false },
					];
				if (bad === "filename" && request.operation === "prepare")
					result.filename = "../escape.txt";
				if (bad === "digest" && request.operation === "prepare")
					result.archiveDigest = "f".repeat(64);
				return result;
			});
			const result = await run(f, { path: "notes.txt" });
			expect(result.isError).toBe(true);
			expect(result.metadata?.shareId).toBeUndefined();
			expect(f.shareArchive.mock.calls.at(-1)?.[0].operation).toBe("release");
		}
	});
	test("Spec paths are rejected before backend resolution", async () => {
		const f = fixture();
		const resolveBackend = mock(() => {
			throw new Error("unexpected physical IO");
		});
		f.ctx.resolveBackend = resolveBackend;
		for (const path of ["spec://notes.md", "/spec://notes.md"]) {
			const result = await run(f, { path });
			expect(result.isError).toBe(true);
			expect(result.output).toContain("spec://");
		}
		expect(resolveBackend).not.toHaveBeenCalled();
	});
	test("same-named host decoy is never used for a remote share", async () => {
		const root = mkdtempSync(resolve(tmpdir(), "nf-remote-share-decoy-"));
		temporary.push(root);
		await Bun.write(resolve(root, "notes.txt"), "HOST DECOY");
		const f = fixture();
		if (!f.ctx.workspaceContext) throw new Error("missing fixture context");
		f.ctx.workspaceContext = { ...f.ctx.workspaceContext, cwd: root };
		const result = await run(f, { path: "notes.txt" });
		expect(result.isError, result.output).not.toBe(true);
		const share = getShare(result.metadata?.shareId as string);
		expect(await Bun.file(share?.storagePath as string).text()).toBe("remote, not host\n");
		expect(await Bun.file(resolve(root, "notes.txt")).text()).toBe("HOST DECOY");
	});

	test("uses admitted canonical source rather than reapplying a relative path", async () => {
		const f = fixture();
		f.ctx.executionTarget = {
			deviceId: "remote",
			backendKind: "remote",
			cwd: f.cwd,
			lexicalPath: "/remote/selected/repo/link.txt",
			canonicalPath: "/remote/selected/repo/actual.txt",
			selectionSource: "explicit",
			pathFlavor: "posix",
			runtimeGeneration: 3,
		};
		const result = await run(f, { path: "link.txt" });
		expect(result.isError, result.output).not.toBe(true);
		expect(f.shareArchive.mock.calls[0][0].paths).toEqual(["/remote/selected/repo/actual.txt"]);
	});
});
