import type { NarratorRestoreMapping, NarratorRestorePreview } from "@shared/narrator-backup";

export function canExportPrivateBackup(
	actor: { id?: unknown; role?: unknown } | null | undefined,
	narrator: { ownerUserId?: unknown; type?: unknown; variant?: unknown } | null | undefined,
): boolean {
	if (!actor?.id || !narrator) return false;
	if (narrator.type === "subagent" || String(narrator.variant ?? "").startsWith("subagent"))
		return false;
	return (
		actor.role === "admin" ||
		(typeof narrator.ownerUserId === "string" && narrator.ownerUserId === actor.id)
	);
}

export function canApplyBackupState(
	preview: NarratorRestorePreview | null | undefined,
	confirmed: boolean,
): boolean {
	return (
		!!preview &&
		confirmed &&
		preview.verifiedSameInstance === true &&
		preview.sameInstanceStateRestoreAllowed === true &&
		preview.blockers.length === 0 &&
		preview.crossInstanceApplySupported === false &&
		preview.productionDiskRestoreAllowed === false &&
		preview.manualActivationRequired === true
	);
}

/** Explicit mappings only: never infer remote device/path/account/project identities. */
export function parseBackupMapping(text: string): NarratorRestoreMapping | undefined {
	if (!text.trim()) return undefined;
	if (text.length > 100_000) throw new Error("Mapping exceeds size limit");
	const parsed: unknown = JSON.parse(text);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("Mapping must be an object");
	for (const [key, value] of Object.entries(parsed)) {
		if (
			!["users", "devices", "paths", "projects"].includes(key) ||
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			Object.entries(value).some(
				([source, target]) => !source || typeof target !== "string" || !target,
			)
		) {
			throw new Error("Mapping must contain explicit users/devices/paths/projects string pairs");
		}
	}
	return parsed as NarratorRestoreMapping;
}
