import { compareReleaseVersions, isValidReleaseVersion } from "./release-version";

export const MAX_RELEASE_PATCH_BYTES = 512 * 1024 * 1024;
/** Legacy dictionary decoding needs buffers; large updates must use streaming patch-from. */
export const MAX_RELEASE_LEGACY_BYTES = 8 * 1024 * 1024;
export const MAX_RELEASE_BINARY_BYTES = 1024 * 1024 * 1024;
export const MAX_RELEASE_PATCH_STEPS = 16;
export const MAX_RELEASE_PATCH_METADATA = 32;
export const RELEASE_SHA512_RE = /^[A-Za-z0-9+/]{86}==$/;

/** Existing zstd patch sidecar format, with mandatory base identity for GitHub delivery. */
export interface ReleasePatchMetadata {
	fromVersion: string;
	toVersion: string;
	oldFileSize: number;
	oldFileSha512: string;
	stableEnd: number;
	newTailSize: number;
	patchSize: number;
	newFileSize: number;
	newFileSha512: string;
	mode?: "patch-from" | "dictionary";
}

/** Server-resolved GitHub descriptor; never accept this structure from a client. */
export interface GithubPatchStep {
	fromVersion: string;
	toVersion: string;
	patchSize: number;
	url: string;
	metaUrl: string;
	/** Optional GitHub asset SHA256 digest. Final reconstructed SHA512 is always verified. */
	sha256?: string;
	meta: ReleasePatchMetadata;
}

export function parseReleasePatchName(
	binaryFilename: string,
	filename: string,
): { fromVersion?: string } | null {
	if (filename === `${binaryFilename}.zstd-patch`) return {};
	const prefix = `${binaryFilename}.from-`;
	const suffix = ".zstd-patch";
	if (!filename.startsWith(prefix) || !filename.endsWith(suffix)) return null;
	const version = filename.slice(prefix.length, -suffix.length);
	return isValidReleaseVersion(version) ? { fromVersion: version } : null;
}

export function validateReleasePatchMetadata(
	value: unknown,
	expected: {
		fromVersion?: string;
		toVersion?: string;
		patchSize?: number;
		newFileSize?: number;
		newFileSha512?: string;
	} = {},
): ReleasePatchMetadata {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid patch metadata object");
	}
	const meta = value as Record<string, unknown>;
	const boundedSize = (size: unknown, maximum: number): size is number =>
		typeof size === "number" && Number.isSafeInteger(size) && size > 0 && size <= maximum;
	if (
		typeof meta.fromVersion !== "string" ||
		!isValidReleaseVersion(meta.fromVersion) ||
		typeof meta.toVersion !== "string" ||
		!isValidReleaseVersion(meta.toVersion) ||
		compareReleaseVersions(meta.fromVersion, meta.toVersion) >= 0 ||
		!boundedSize(meta.oldFileSize, MAX_RELEASE_BINARY_BYTES) ||
		!boundedSize(meta.newFileSize, MAX_RELEASE_BINARY_BYTES) ||
		!boundedSize(meta.patchSize, MAX_RELEASE_PATCH_BYTES) ||
		typeof meta.oldFileSha512 !== "string" ||
		!RELEASE_SHA512_RE.test(meta.oldFileSha512) ||
		typeof meta.newFileSha512 !== "string" ||
		!RELEASE_SHA512_RE.test(meta.newFileSha512) ||
		typeof meta.stableEnd !== "number" ||
		!Number.isSafeInteger(meta.stableEnd) ||
		meta.stableEnd < 0 ||
		meta.stableEnd > Math.min(meta.oldFileSize, meta.newFileSize) ||
		typeof meta.newTailSize !== "number" ||
		!Number.isSafeInteger(meta.newTailSize) ||
		meta.newTailSize !== meta.newFileSize - meta.stableEnd ||
		(meta.mode !== undefined && meta.mode !== "patch-from" && meta.mode !== "dictionary")
	)
		throw new Error("Invalid patch versions, sizes, mode or SHA512 identity");
	if (
		(expected.fromVersion !== undefined && expected.fromVersion !== meta.fromVersion) ||
		(expected.toVersion !== undefined && expected.toVersion !== meta.toVersion) ||
		(expected.patchSize !== undefined && expected.patchSize !== meta.patchSize) ||
		(expected.newFileSize !== undefined && expected.newFileSize !== meta.newFileSize) ||
		(expected.newFileSha512 !== undefined && expected.newFileSha512 !== meta.newFileSha512)
	)
		throw new Error("Patch metadata does not match its release asset identity");
	return {
		fromVersion: meta.fromVersion,
		toVersion: meta.toVersion,
		oldFileSize: meta.oldFileSize,
		oldFileSha512: meta.oldFileSha512,
		stableEnd: meta.stableEnd,
		newTailSize: meta.newTailSize,
		patchSize: meta.patchSize,
		newFileSize: meta.newFileSize,
		newFileSha512: meta.newFileSha512,
		mode: meta.mode as ReleasePatchMetadata["mode"],
	};
}
