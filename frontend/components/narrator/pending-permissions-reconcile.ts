import type { PendingPermission } from "@frontend/types/narrator";
import {
	isActiveReflectionPermissionLike,
	isReflectionPermissionLike,
} from "@shared/pretext-layout/reflection";
import { replaceEqualDeep } from "@tanstack/react-query";

/**
 * Compare the entire JSON permission, not a field allowlist: input, suggestions,
 * execution targets and future fields all participate. Structural sharing avoids
 * serializing large inputs and preserves unchanged nested objects as well.
 */
export function upsertPendingPermissionMap(
	previous: Map<string, PendingPermission>,
	permission: PendingPermission,
): Map<string, PendingPermission> {
	const existing = previous.get(permission.id);
	const shared = replaceEqualDeep(existing, permission);
	if (shared === existing) return previous;
	const next = new Map(previous);
	next.set(permission.id, shared);
	return next;
}

/** Preserve snapshot order (including Map's first-position/last-value duplicate semantics). */
export function reconcilePendingPermissions(
	previous: Map<string, PendingPermission>,
	permissions: readonly PendingPermission[],
	resolvedIds: ReadonlySet<string>,
): Map<string, PendingPermission> {
	const next = new Map<string, PendingPermission>();
	for (const permission of permissions) {
		if (resolvedIds.has(permission.id)) continue;
		if (isReflectionPermissionLike(permission) && !isActiveReflectionPermissionLike(permission)) {
			continue;
		}
		next.set(permission.id, replaceEqualDeep(previous.get(permission.id), permission));
	}
	if (next.size !== previous.size) return next;
	const previousEntries = previous.entries();
	for (const [id, permission] of next) {
		const entry = previousEntries.next().value;
		if (!entry || entry[0] !== id || entry[1] !== permission) return next;
	}
	return previous;
}
