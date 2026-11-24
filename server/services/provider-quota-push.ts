import {
	type CustomApiQuotaTargetDirectory,
	customApiQuotaTargets,
} from "./provider-quota-targets";
export interface CustomApiQuotaPushTarget {
	providerId: string;
	generation: string;
	keyId?: string;
}

/** Capture the primary subject; per-request credential metadata can refine it before publishing. */
export function captureCustomApiQuotaPushTarget(
	prefix: string,
	directory: CustomApiQuotaTargetDirectory = customApiQuotaTargets,
): CustomApiQuotaPushTarget | null {
	const candidate = directory.list().find((entry) => entry.target.prefix === prefix);
	if (!candidate) return null;
	const connection = directory.get(candidate.target.providerId);
	return {
		providerId: candidate.target.providerId,
		...(connection?.target.keyId ? { keyId: connection.target.keyId } : {}),
		generation:
			connection?.valid && !connection.target.siteQuota
				? connection.target.generation
				: crypto.randomUUID(),
	};
}
export function captureCustomApiQuotaKeyPushTarget(
	providerId: string,
	keyId: string,
	directory: CustomApiQuotaTargetDirectory = customApiQuotaTargets,
): CustomApiQuotaPushTarget {
	const connection = directory.getKey(keyId);
	return {
		providerId,
		keyId,
		generation:
			connection?.valid &&
			connection.target.providerId === providerId &&
			!connection.target.siteQuota
				? connection.target.generation
				: crypto.randomUUID(),
	};
}
export function customApiQuotaPushPrefix(
	target: CustomApiQuotaPushTarget,
	directory: CustomApiQuotaTargetDirectory = customApiQuotaTargets,
): string | null {
	const current = directory.get(target.providerId);
	return current?.valid &&
		!current.target.siteQuota &&
		current.target.generation === target.generation
		? (current.target.prefix ?? null)
		: null;
}
