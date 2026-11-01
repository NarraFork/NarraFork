import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import {
	MAX_MEDIA_FILE_SIZE,
	MEDIA_MIME_TO_EXT,
	type MediaRef,
	mediaModality,
	type NativeMediaInput,
} from "@shared/media-attachments";
import { ValidationError } from "./errors";
import { generateShortId } from "./id";
import { getUploadsDir, isWithinDir } from "./uploads";

const EXTENSIONS: Record<string, readonly string[]> = {
	"audio/wav": [".wav"],
	"audio/mpeg": [".mp3"],
	"audio/mp4": [".m4a", ".m4b", ".mp4"],
	"audio/aac": [".aac"],
	"audio/flac": [".flac"],
	"audio/ogg": [".ogg", ".oga"],
	"audio/webm": [".webm"],
	"video/mp4": [".mp4"],
	"video/webm": [".webm"],
	"video/quicktime": [".mov"],
	"video/mpeg": [".mpeg", ".mpg"],
};
const validatedFiles = new WeakMap<File, string>();

/** Walk only structural boxes; never scan payload strings for handler names. */
function mp4Tracks(b: Buffer): { audio: boolean; video: boolean } {
	const tracks = { audio: false, video: false };
	let scans = 0;
	function walk(start: number, end: number, depth: number) {
		if (depth > 8) throw new ValidationError("Media container nesting exceeds limit");
		for (let offset = start; offset + 8 <= end; ) {
			if (++scans > 4096) throw new ValidationError("Media container complexity exceeds limit");
			let size = b.readUInt32BE(offset);
			const type = b.toString("ascii", offset + 4, offset + 8);
			let header = 8;
			if (size === 1) {
				if (offset + 16 > end) throw new ValidationError("Truncated media box");
				const wide = b.readBigUInt64BE(offset + 8);
				if (wide > BigInt(Number.MAX_SAFE_INTEGER))
					throw new ValidationError("Invalid media box size");
				size = Number(wide);
				header = 16;
			}
			if (size === 0) size = end - offset;
			if (size < header || offset + size > end) throw new ValidationError("Truncated media box");
			if (["moov", "trak", "mdia"].includes(type)) walk(offset + header, offset + size, depth + 1);
			if (type === "hdlr" && size >= header + 12) {
				const handler = b.toString("ascii", offset + header + 8, offset + header + 12);
				if (handler === "soun") tracks.audio = true;
				if (handler === "vide") tracks.video = true;
			}
			offset += size;
		}
	}
	walk(0, b.length, 0);
	return tracks;
}

function webmTracks(b: Buffer): { audio: boolean; video: boolean; webm: boolean } {
	const tracks = { audio: false, video: false, webm: false };
	let scans = 0;
	function vint(offset: number, id: boolean): { value: number; end: number; unknown: boolean } {
		if (offset >= b.length || b[offset] === 0) throw new ValidationError("Invalid EBML header");
		let length = 1,
			mask = 0x80;
		while (!(b[offset] & mask)) {
			length++;
			mask >>= 1;
		}
		if (length > (id ? 4 : 8) || offset + length > b.length)
			throw new ValidationError("Invalid EBML size");
		let value = id ? b[offset] : b[offset] & (mask - 1);
		let unknown = !id && value === mask - 1;
		for (let i = 1; i < length; i++) {
			value = value * 256 + b[offset + i];
			unknown = unknown && b[offset + i] === 255;
		}
		return { value, end: offset + length, unknown };
	}
	function walk(start: number, end: number, depth: number) {
		if (depth > 6) throw new ValidationError("EBML nesting exceeds limit");
		for (let offset = start; offset < end; ) {
			if (++scans > 4096) throw new ValidationError("EBML complexity exceeds limit");
			const id = vint(offset, true),
				size = vint(id.end, false);
			const stop = size.unknown ? end : size.end + size.value;
			if (!Number.isSafeInteger(stop) || stop > end || stop < size.end)
				throw new ValidationError("Truncated EBML element");
			if ([0x1a45dfa3, 0x18538067, 0x1654ae6b, 0xae].includes(id.value))
				walk(size.end, stop, depth + 1);
			if (id.value === 0x4282 && b.toString("ascii", size.end, stop) === "webm") tracks.webm = true;
			if (id.value === 0x83 && stop - size.end === 1) {
				if (b[size.end] === 1) tracks.video = true;
				if (b[size.end] === 2) tracks.audio = true;
			}
			if (stop <= offset) throw new ValidationError("Invalid EBML element");
			offset = stop;
		}
	}
	walk(0, b.length, 0);
	return tracks;
}

/** Ogg is a generic container: accept only explicitly recognized audio streams. */
function isAudioOgg(bytes: Buffer): boolean {
	const streams = new Set<number>();
	let offset = 0;
	let pages = 0;
	while (offset < bytes.length) {
		if (++pages > 4096) throw new ValidationError("Ogg complexity exceeds limit");
		if (
			offset + 27 > bytes.length ||
			bytes.toString("ascii", offset, offset + 4) !== "OggS" ||
			bytes[offset + 4] !== 0
		)
			return false;
		const segments = bytes[offset + 26];
		const body = offset + 27 + segments;
		if (body > bytes.length) return false;
		let size = 0;
		for (let i = 0; i < segments; i++) size += bytes[offset + 27 + i];
		if (body + size > bytes.length) return false;
		const serial = bytes.readUInt32LE(offset + 14);
		if (!streams.has(serial)) {
			if (!(bytes[offset + 5] & 2) || !segments) return false;
			const packet = bytes.subarray(body, body + bytes[offset + 27]);
			if (
				!(
					packet.subarray(0, 8).equals(Buffer.from("OpusHead")) ||
					packet.subarray(0, 7).equals(Buffer.from("\u0001vorbis")) ||
					packet.subarray(0, 8).equals(Buffer.from("Speex   ")) ||
					packet.subarray(0, 5).equals(Buffer.from([0x7f, 0x46, 0x4c, 0x41, 0x43]))
				)
			)
				return false;
			streams.add(serial);
		}
		offset = body + size;
	}
	return streams.size > 0;
}

const identity = (id: string) => /^[A-Za-z0-9_-]+$/.test(id);

/** Container signatures, not a decoder: bounded inspection rejects mislabeled executable/text files. */
export function validateMediaBytes(
	bytes: Uint8Array,
	filename: string,
	mediaType?: string,
): string {
	if (!bytes.byteLength) throw new ValidationError("Media file is empty");
	if (bytes.byteLength > MAX_MEDIA_FILE_SIZE)
		throw new ValidationError("Media exceeds 100 MiB limit");
	const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const extension = extname(filename).toLowerCase();
	const rawDeclared = mediaType?.split(";", 1)[0].trim().toLowerCase();
	const aliases: Record<string, string> = {
		"audio/x-wav": "audio/wav",
		"audio/wave": "audio/wav",
		"audio/x-m4a": "audio/mp4",
		"audio/mp3": "audio/mpeg",
		"audio/x-flac": "audio/flac",
	};
	const declared = rawDeclared ? (aliases[rawDeclared] ?? rawDeclared) : undefined;
	const candidates = Object.keys(EXTENSIONS).filter((type) => EXTENSIONS[type].includes(extension));
	let inferred =
		extension === ".mp4" ? "video/mp4" : extension === ".webm" ? "video/webm" : candidates[0];
	let containerTracks: { audio: boolean; video: boolean; webm?: boolean } | undefined;
	if (
		[".mp4", ".m4a", ".m4b", ".mov"].includes(extension) &&
		b.length >= 16 &&
		b.toString("ascii", 4, 8) === "ftyp"
	) {
		containerTracks = mp4Tracks(b);
		const brand = b.toString("ascii", 8, 12);
		if (extension !== ".mov")
			inferred = containerTracks.video
				? "video/mp4"
				: containerTracks.audio || brand === "M4A " || brand === "M4B "
					? "audio/mp4"
					: inferred;
	}
	if (extension === ".webm" && b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3) {
		containerTracks = webmTracks(b);
		inferred = containerTracks.video
			? "video/webm"
			: containerTracks.audio
				? "audio/webm"
				: "video/webm";
	}
	if (declared?.startsWith("audio/") && containerTracks?.video)
		throw new ValidationError("Video tracks cannot be declared as audio");
	// Browsers label .mp4/.webm by extension, even for audio-only containers.
	// Verify the declared container first, then let structural tracks decide modality.
	if (declared && declared !== "application/octet-stream" && !candidates.includes(declared))
		throw new ValidationError("Unsupported media MIME type or filename extension");
	if (
		declared?.startsWith("audio/") &&
		containerTracks &&
		!containerTracks.audio &&
		!(inferred === "audio/mp4" && ["M4A ", "M4B "].includes(b.toString("ascii", 8, 12)))
	)
		throw new ValidationError("Audio container has no verifiable audio tracks");
	const mime = containerTracks
		? inferred
		: declared && declared !== "application/octet-stream"
			? declared
			: inferred;
	if (
		(mime === "audio/webm" || mime === "audio/mp4") &&
		containerTracks &&
		!containerTracks.audio &&
		!(mime === "audio/mp4" && ["M4A ", "M4B "].includes(b.toString("ascii", 8, 12)))
	)
		throw new ValidationError("Audio container has no verifiable audio tracks");
	if (!mime || !candidates.includes(mime))
		throw new ValidationError("Unsupported media MIME type or filename extension");
	const ascii = (start: number, end: number) => b.toString("ascii", start, end);
	let matches = false;
	switch (mime) {
		case "audio/wav":
			matches = b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE";
			break;
		case "audio/flac":
			matches = b.length >= 8 && ascii(0, 4) === "fLaC";
			break;
		case "audio/ogg":
			matches = isAudioOgg(b);
			break;
		case "audio/mpeg":
			matches =
				(b.length >= 10 && ascii(0, 3) === "ID3" && b[3] >= 2 && b[3] <= 4) ||
				(b.length >= 4 &&
					b[0] === 0xff &&
					(b[1] & 0xe0) === 0xe0 &&
					(b[1] & 0x18) !== 0x08 &&
					(b[1] & 6) !== 0 &&
					(b[2] & 0xf0) !== 0xf0 &&
					(b[2] & 0xf0) !== 0);
			break;
		case "audio/aac":
			matches = b.length >= 7 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0 && (b[2] & 0x3c) !== 0x3c;
			break;
		case "audio/webm":
		case "video/webm":
			matches = containerTracks?.webm === true;
			break;
		case "audio/mp4":
		case "video/mp4":
		case "video/quicktime": {
			if (b.length < 16 || ascii(4, 8) !== "ftyp") break;
			const boxSize = b.readUInt32BE(0);
			if (boxSize < 16 || boxSize > b.length || boxSize % 4 !== 0) break;
			const brands = [ascii(8, 12)];
			for (let i = 16; i + 4 <= boxSize; i += 4) brands.push(ascii(i, i + 4));
			matches =
				mime === "video/quicktime"
					? brands.includes("qt  ")
					: brands.some((brand) => /^(isom|iso[2-9]|mp4[12]|avc1|M4[AVB] |dash|MSNV)$/.test(brand));
			break;
		}
		case "video/mpeg":
			matches =
				b.length >= 12 &&
				b[0] === 0 &&
				b[1] === 0 &&
				b[2] === 1 &&
				(b[3] === 0xba || b[3] === 0xb3);
			break;
	}
	if (!matches) throw new ValidationError(`Media content does not match ${mime}`);
	return mime;
}

export async function validateUploadedMedia(file: File): Promise<string> {
	if (!(file instanceof File)) throw new ValidationError("Media attachment must be a file");
	if (file.size === 0 || file.size > MAX_MEDIA_FILE_SIZE)
		throw new ValidationError("Media must contain 1 byte to 100 MiB");
	const existing = validatedFiles.get(file);
	if (existing) return existing;
	const mime = validateMediaBytes(new Uint8Array(await file.arrayBuffer()), file.name, file.type);
	validatedFiles.set(file, mime);
	return mime;
}

function mediaDir(narratorId: string): string | null {
	return identity(narratorId) ? resolve(getUploadsDir(), narratorId, "media") : null;
}

export async function saveUploadedMedia(narratorId: string, file: File): Promise<MediaRef> {
	const mediaType = await validateUploadedMedia(file);
	const dir = mediaDir(narratorId);
	if (!dir) throw new ValidationError("Invalid media owner");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (!isWithinDir(realpathSync(getUploadsDir()), realpathSync(dir)))
		throw new ValidationError("Invalid media storage directory");
	const mediaId = generateShortId();
	const path = resolve(dir, `${mediaId}${MEDIA_MIME_TO_EXT[mediaType]}`);
	try {
		await Bun.write(path, file);
	} catch (error) {
		rmSync(path, { force: true });
		throw error;
	}
	return { mediaId, filename: file.name, mediaType, size: file.size, uploadNarratorId: narratorId };
}

export function getMediaPath(narratorId: string, mediaId: string): string | null {
	const dir = mediaDir(narratorId);
	if (!dir || !identity(mediaId) || !existsSync(dir)) return null;
	for (const extension of new Set(Object.values(MEDIA_MIME_TO_EXT))) {
		const path = resolve(dir, `${mediaId}${extension}`);
		try {
			if (
				statSync(path).isFile() &&
				isWithinDir(realpathSync(getUploadsDir()), realpathSync(path)) &&
				isWithinDir(realpathSync(dir), realpathSync(path))
			)
				return path;
		} catch {
			/* Missing assets are reported by the caller. */
		}
	}
	return null;
}

export function deleteUploadedMedia(narratorId: string, mediaId: string): void {
	const path = getMediaPath(narratorId, mediaId);
	if (path) rmSync(path, { force: true });
}

export async function mediaToBase64(
	media: MediaRef,
	fallbackNarratorId?: string,
): Promise<NativeMediaInput> {
	const owner = media.uploadNarratorId || fallbackNarratorId;
	const path = owner && getMediaPath(owner, media.mediaId);
	if (!path) throw new ValidationError(`Media asset is missing: ${media.mediaId}`);
	const file = Bun.file(path);
	if (file.size !== media.size || file.size > MAX_MEDIA_FILE_SIZE)
		throw new ValidationError("Media asset size does not match reference");
	const bytes = new Uint8Array(await file.arrayBuffer());
	const mediaType = validateMediaBytes(bytes, media.filename, media.mediaType);
	const type = mediaModality(mediaType);
	if (!type) throw new ValidationError("Unsupported media modality");
	return {
		type,
		mediaType,
		base64: Buffer.from(bytes).toString("base64"),
		filename: media.filename,
	};
}
