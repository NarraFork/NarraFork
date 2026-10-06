import type { PlatformFileInfo, ZstdPatchMeta } from "../types";

export interface ReleaseFileIdentity {
	filename: string;
	size: number;
	sha512: string;
}

export function getReleaseIdentityMismatch(
	existing: ReleaseFileIdentity,
	incoming: ReleaseFileIdentity,
): string | null {
	if (
		existing.filename === incoming.filename &&
		existing.size === incoming.size &&
		existing.sha512 === incoming.sha512
	) {
		return null;
	}
	return [
		`existing filename=${existing.filename}, size=${existing.size}, sha512=${existing.sha512}`,
		`incoming filename=${incoming.filename}, size=${incoming.size}, sha512=${incoming.sha512}`,
	].join("; ");
}

export function getPatchSourceMismatch(
	patchMeta: ZstdPatchMeta,
	sourcePlatform: PlatformFileInfo | undefined,
): string | null {
	if (!patchMeta.oldFileSize || !patchMeta.oldFileSha512) {
		return "Patch metadata must include oldFileSize and oldFileSha512";
	}
	if (!sourcePlatform) {
		return `Published source platform is missing for v${patchMeta.fromVersion}`;
	}
	if (
		patchMeta.oldFileSize === sourcePlatform.size &&
		patchMeta.oldFileSha512 === sourcePlatform.sha512
	) {
		return null;
	}
	return [
		`Patch source does not match published v${patchMeta.fromVersion}`,
		`expected size=${sourcePlatform.size}, sha512=${sourcePlatform.sha512}`,
		`actual size=${patchMeta.oldFileSize}, sha512=${patchMeta.oldFileSha512}`,
	].join("; ");
}
