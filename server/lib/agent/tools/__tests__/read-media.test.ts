import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_MEDIA_FILE_SIZE } from "@shared/media-attachments";
import * as mediaUploads from "../../../media-uploads";
import { narraforkDir } from "../../../settings";
import type { ExecutionBackend, ReadBytesResult } from "../../execution/backend";
import { LocalBackend } from "../../execution/local-backend";
import { posixPathSemantics, windowsPathSemantics } from "../../execution/path-semantics";
import type { ToolContext } from "../../types";
import { readTool } from "../read";

const roots: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];

function root(): string {
	const path = mkdtempSync(join(tmpdir(), "narrafork-read-media-"));
	roots.push(path);
	return path;
}

function wav(): Buffer {
	const bytes = Buffer.alloc(46);
	bytes.write("RIFF", 0);
	bytes.writeUInt32LE(38, 4);
	bytes.write("WAVEfmt ", 8);
	bytes.writeUInt32LE(16, 16);
	bytes.writeUInt16LE(1, 20);
	bytes.writeUInt16LE(1, 22);
	bytes.writeUInt32LE(8000, 24);
	bytes.writeUInt32LE(16000, 28);
	bytes.writeUInt16LE(2, 32);
	bytes.writeUInt16LE(16, 34);
	bytes.write("data", 36);
	bytes.writeUInt32LE(2, 40);
	bytes.writeInt16LE(1234, 44);
	return bytes;
}

function mp4(brand = "isom"): Buffer {
	const bytes = Buffer.alloc(16);
	bytes.writeUInt32BE(16, 0);
	bytes.write("ftyp", 4);
	bytes.write(brand, 8);
	return bytes;
}

function webm(trackType = 1): Buffer {
	return Buffer.from([
		0x1a,
		0x45,
		0xdf,
		0xa3,
		0x87,
		0x42,
		0x82,
		0x84,
		0x77,
		0x65,
		0x62,
		0x6d,
		0x18,
		0x53,
		0x80,
		0x67,
		0x8a,
		0x16,
		0x54,
		0xae,
		0x6b,
		0x85,
		0xae,
		0x83,
		0x83,
		0x81,
		trackType,
	]);
}

function ogg(): Buffer {
	const header = Buffer.alloc(28);
	header.write("OggS");
	header[5] = 2;
	header[26] = 1;
	header[27] = 8;
	return Buffer.concat([header, Buffer.from("OpusHead")]);
}

function mp4Audio(): Buffer {
	const box = (type: string, payload: Buffer) => {
		const header = Buffer.alloc(8);
		header.writeUInt32BE(payload.length + 8);
		header.write(type, 4);
		return Buffer.concat([header, payload]);
	};
	const handler = box("hdlr", Buffer.concat([Buffer.alloc(8), Buffer.from("soun")]));
	return Buffer.concat([mp4(), box("moov", box("trak", box("mdia", handler)))]);
}

function context(backend: ExecutionBackend): ToolContext {
	return {
		narratorId: "read-media-test",
		cwd: backend.defaultCwd || "/remote",
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" }),
		resolveBackend: () => backend,
	};
}

function remote(bytes: Uint8Array = wav(), windows = false) {
	const paths = windows ? windowsPathSemantics : posixPathSemantics;
	const backend = {
		kind: "remote",
		deviceId: "media-device",
		paths,
		pathFlavor: paths.flavor,
		runtimeGeneration: 1,
		defaultCwd: windows ? "C:\\remote" : "/remote",
		statFile: async () => ({ isFile: true, isDirectory: false, size: bytes.byteLength }),
		readFileBytes: async (): Promise<ReadBytesResult> => ({
			bytes,
			truncated: false,
			totalSize: bytes.byteLength,
		}),
	} as unknown as ExecutionBackend;
	const read = spyOn(backend, "readFileBytes");
	spies.push(read);
	return { backend, ctx: context(backend), read };
}

function expectMediaError(result: Awaited<ReturnType<typeof readTool.execute>>, pattern: RegExp) {
	expect(result.isError).toBe(true);
	expect(result.output).toMatch(pattern);
	expect(result.media).toBeUndefined();
	expect(result.mediaRefs).toBeUndefined();
	expect(result.images).toBeUndefined();
}

afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Read native audio/video", () => {
	test("local bounded read preserves actual WAV bytes and a durable replay asset", async () => {
		const dir = root();
		const path = join(dir, "speech.wav");
		const bytes = wav();
		writeFileSync(path, bytes);
		const backend = new LocalBackend();
		const ctx = context(backend);
		const canonicalPath = realpathSync(path);
		ctx.executionTarget = {
			deviceId: "local",
			backendKind: "local",
			cwd: dir,
			lexicalPath: path,
			canonicalPath,
			selectionSource: "explicit",
		};
		const read = spyOn(backend, "readFileBytes");
		spies.push(read);
		const result = await readTool.execute({ file_path: path, offset: 2, limit: 1 }, ctx);
		expect(result.isError).not.toBe(true);
		expect(read).toHaveBeenCalledWith(canonicalPath, {
			maxBytes: MAX_MEDIA_FILE_SIZE,
			expectedResolvedPath: canonicalPath,
			signal: ctx.signal,
		});
		expect(result.media).toEqual([
			{
				type: "audio",
				mediaType: "audio/wav",
				base64: bytes.toString("base64"),
				filename: "speech.wav",
			},
		]);
		expect(result.mediaRefs).toHaveLength(1);
		const ref = result.mediaRefs?.[0];
		if (!ref) throw new Error("Read returned no durable media reference");
		expect(ref).toMatchObject({
			type: "audio",
			filename: "speech.wav",
			size: bytes.length,
			uploadNarratorId: ctx.narratorId,
		});
		const stored = mediaUploads.getMediaPath(ctx.narratorId, ref.mediaId);
		expect(stored).not.toBeNull();
		if (!stored) throw new Error("Read media replay asset was not persisted");
		expect(Buffer.from(await Bun.file(stored).arrayBuffer()).toString("base64")).toBe(
			bytes.toString("base64"),
		);
		expect(result.output).toContain("Native audio");
		expect(result.images).toBeUndefined();
	});

	const formats: Array<[string, Buffer, string, "audio" | "video"]> = [
		["clip.wav", wav(), "audio/wav", "audio"],
		["clip.mp3", Buffer.from([0xff, 0xfb, 0x90, 0]), "audio/mpeg", "audio"],
		["clip.m4a", mp4("M4A "), "audio/mp4", "audio"],
		["book.m4b", mp4("M4A "), "audio/mp4", "audio"],
		["clip.aac", Buffer.from([0xff, 0xf1, 0x50, 0x80, 0, 0, 0]), "audio/aac", "audio"],
		["clip.flac", Buffer.from("fLaC\0\0\0\0"), "audio/flac", "audio"],
		["clip.ogg", ogg(), "audio/ogg", "audio"],
		["audio-only.mp4", mp4Audio(), "audio/mp4", "audio"],
		["audio-only.webm", webm(2), "audio/webm", "audio"],
		["clip.mp4", mp4(), "video/mp4", "video"],
		["clip.webm", webm(), "video/webm", "video"],
		["clip.mov", mp4("qt  "), "video/quicktime", "video"],
		["clip.mpeg", Buffer.from([0, 0, 1, 0xba, 0, 0, 0, 0, 0, 0, 0, 0]), "video/mpeg", "video"],
	];
	for (const [filename, bytes, mediaType, type] of formats) {
		test(`validates and transports original ${filename} bytes, not text or frames`, async () => {
			const { ctx } = remote(bytes);
			const result = await readTool.execute({ file_path: filename }, ctx);
			expect(result.isError).not.toBe(true);
			expect(result.media).toEqual([
				{ type, mediaType, filename, base64: bytes.toString("base64") },
			]);
			expect(result.mediaRefs?.[0]).toMatchObject({
				type,
				mediaType,
				filename,
				size: bytes.length,
			});
			expect(result.images).toBeUndefined();
		});
	}

	test("remote Windows filename and frozen canonical path use target semantics", async () => {
		const { ctx, backend, read } = remote(wav(), true);
		const lexicalPath = "C:\\remote\\speech.WAV";
		const canonicalPath = "C:\\allowed\\asset.bin";
		ctx.executionTarget = {
			deviceId: backend.deviceId,
			backendKind: "remote",
			cwd: "C:\\remote",
			lexicalPath,
			canonicalPath,
			selectionSource: "explicit",
		};
		const resolve = spyOn(ctx, "resolveBackend");
		spies.push(resolve);
		const result = await readTool.execute(
			{ file_path: "ignored.wav", device: "media-device" },
			ctx,
		);
		expect(result.isError).not.toBe(true);
		expect(resolve).toHaveBeenCalledWith("media-device");
		expect(read).toHaveBeenCalledWith(canonicalPath, {
			maxBytes: MAX_MEDIA_FILE_SIZE,
			expectedResolvedPath: canonicalPath,
			signal: ctx.signal,
		});
		expect(result.media?.[0].filename).toBe("speech.WAV");
	});

	for (const kind of ["local", "remote"] as const) {
		test(`${kind} authorization identity rejection never returns media`, async () => {
			const { ctx, backend, read } = remote();
			Object.assign(backend, { kind });
			read.mockRejectedValueOnce(new Error("Resolved path identity mismatch"));
			const result = await readTool.execute({ file_path: "speech.wav" }, ctx);
			expectMediaError(result, /identity mismatch/i);
		});
	}

	test("media reads retain main's private platform path refusal before byte IO", async () => {
		const backend = new LocalBackend();
		const ctx = context(backend);
		ctx.executionTarget = {
			deviceId: "local",
			backendKind: "local",
			cwd: narraforkDir,
			lexicalPath: join(narraforkDir, "editor-native", "private.wav"),
			canonicalPath: join(narraforkDir, "editor-native", "private.wav"),
			selectionSource: "explicit",
		};
		const read = spyOn(backend, "readFileBytes");
		spies.push(read);
		expectMediaError(
			await readTool.execute({ file_path: "private.wav" }, ctx),
			/platform secrets.*not permitted/i,
		);
		expect(read).not.toHaveBeenCalled();
	});

	test("unavailable remote cannot fall back to an existing local file", async () => {
		const dir = root();
		const path = join(dir, "speech.wav");
		writeFileSync(path, wav());
		const ctx = context(new LocalBackend());
		delete ctx.resolveBackend;
		ctx.defaultDeviceId = "offline-media-test-device";
		const result = await readTool.execute({ file_path: path }, ctx);
		expectMediaError(result, /offline|unavailable|not found|unknown/i);
	});

	test("frozen device cannot be changed by tool args", async () => {
		const ctx = context(new LocalBackend());
		delete ctx.resolveBackend;
		ctx.executionTarget = {
			deviceId: "frozen-device",
			backendKind: "remote",
			cwd: "/remote",
			selectionSource: "explicit",
		};
		const result = await readTool.execute({ file_path: "speech.wav", device: "local" }, ctx);
		expectMediaError(result, /frozen execution device/i);
	});

	test("truncated prefixes fail even when smaller than the media cap", async () => {
		const { ctx, read } = remote();
		read.mockResolvedValueOnce({ bytes: wav(), truncated: true, totalSize: 1000 });
		const result = await readTool.execute({ file_path: "speech.wav" }, ctx);
		expectMediaError(result, /incomplete|truncated/i);
	});

	test("missing bytes fail even when a backend incorrectly omits the truncated flag", async () => {
		const { ctx, read } = remote();
		read.mockResolvedValueOnce({ bytes: wav(), truncated: false, totalSize: 1000 });
		expectMediaError(await readTool.execute({ file_path: "speech.wav" }, ctx), /incomplete/i);
	});

	test("reported oversize fails before validation or encoding", async () => {
		const { ctx, read } = remote();
		read.mockResolvedValueOnce({
			bytes: wav(),
			truncated: true,
			totalSize: MAX_MEDIA_FILE_SIZE + 1,
		});
		expectMediaError(
			await readTool.execute({ file_path: "speech.wav" }, ctx),
			/too large.*100 MiB/i,
		);
	});

	for (const [label, bytes, pattern] of [
		["empty", Buffer.alloc(0), /empty/i],
		["text disguised as audio", Buffer.from("this is not audio"), /does not match/i],
		["truncated header", Buffer.from("RIFF"), /does not match/i],
	] as const) {
		test(`rejects ${label} with no payload`, async () => {
			const { ctx } = remote(bytes);
			expectMediaError(await readTool.execute({ file_path: "speech.wav" }, ctx), pattern);
		});
	}

	test("unsupported container extensions follow the ordinary file read path", async () => {
		const { ctx, read } = remote(Buffer.from("first line\nsecond line\n"));
		const result = await readTool.execute({ file_path: "clip.avi", offset: 2, limit: 1 }, ctx);
		expect(result.isError).not.toBe(true);
		expect(result.output).toContain("second line");
		expect(result.output).not.toContain("first line");
		expect(result.media).toBeUndefined();
		expect(read).toHaveBeenCalled();
	});

	test("an already cancelled read never dispatches byte IO", async () => {
		const { ctx, read } = remote();
		const controller = new AbortController();
		controller.abort(new Error("media read cancelled"));
		ctx.signal = controller.signal;
		expectMediaError(await readTool.execute({ file_path: "speech.wav" }, ctx), /cancelled/i);
		expect(read).not.toHaveBeenCalled();
	});

	test("cancellation during IO is checked before persistence and encoding", async () => {
		const { ctx, read } = remote();
		const controller = new AbortController();
		ctx.signal = controller.signal;
		read.mockImplementationOnce(async (_path, options) => {
			expect(options?.signal).toBe(controller.signal);
			controller.abort(new Error("media read cancelled"));
			return { bytes: wav(), truncated: false, totalSize: wav().length };
		});
		const save = spyOn(mediaUploads, "saveUploadedMedia");
		spies.push(save);
		expectMediaError(await readTool.execute({ file_path: "speech.wav" }, ctx), /cancelled/i);
		expect(save).not.toHaveBeenCalled();
	});

	test("cancellation during persistence removes the otherwise orphaned replay asset", async () => {
		const { ctx } = remote();
		const controller = new AbortController();
		ctx.signal = controller.signal;
		const saveOriginal = mediaUploads.saveUploadedMedia;
		let mediaId: string | undefined;
		const save = spyOn(mediaUploads, "saveUploadedMedia").mockImplementationOnce(
			async (owner, file) => {
				const ref = await saveOriginal(owner, file);
				mediaId = ref.mediaId;
				controller.abort(new Error("media read cancelled during persistence"));
				return ref;
			},
		);
		spies.push(save);
		expectMediaError(await readTool.execute({ file_path: "speech.wav" }, ctx), /cancelled/i);
		if (!mediaId) throw new Error("Persistence did not produce an asset for cancellation cleanup");
		expect(mediaUploads.getMediaPath(ctx.narratorId, mediaId)).toBeNull();
	});

	test("missing replay owner fails explicitly instead of returning memory-only media", async () => {
		const { ctx, read } = remote();
		ctx.narratorId = "";
		expectMediaError(
			await readTool.execute({ file_path: "speech.wav" }, ctx),
			/narratorId.*persist.*replay/i,
		);
		expect(read).not.toHaveBeenCalled();
	});

	test("persistence failures never leak an apparently successful in-memory result", async () => {
		const { ctx } = remote();
		const save = spyOn(mediaUploads, "saveUploadedMedia").mockRejectedValueOnce(
			new Error("storage unavailable"),
		);
		spies.push(save);
		expectMediaError(
			await readTool.execute({ file_path: "speech.wav" }, ctx),
			/storage unavailable/i,
		);
	});

	test("TypeScript source retains text behavior, not MPEG transport stream handling", async () => {
		const { ctx } = remote(Buffer.from("export const value = 1;\n"));
		const result = await readTool.execute({ file_path: "example.ts" }, ctx);
		expect(result.isError).not.toBe(true);
		expect(result.output).toContain("export const value = 1;");
		expect(result.media).toBeUndefined();
	});
});
