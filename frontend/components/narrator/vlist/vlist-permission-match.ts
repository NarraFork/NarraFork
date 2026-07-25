/**
 * vlist-permission-match.ts — Pure matching helpers for the permission bridge.
 *
 * Kept free of any heavy component imports (ToolCallCard / AskUserQuestionBanner
 * pull in shiki + markdown machinery) so this logic is unit-testable in isolation.
 * vlist-permission-bridge.tsx re-exports these and adds the React node building.
 */

import type { PendingPermission } from "../narrator-panel-types";

/** Kinds whose card can host a pending-permission form. */
export const PERMISSION_HOST_KINDS: ReadonlySet<string> = new Set(["tool-call", "subagent-card"]);

/**
 * Extract the tool_use id a `tool-<id>` / `tool-<id>#dupN` spec.key encodes.
 * Returns null for keys that are not tool-item keys.
 */
export function toolUseIdFromSpecKey(specKey: string): string | null {
	if (!specKey.startsWith("tool-")) return null;
	const rest = specKey.slice("tool-".length);
	// Deduped keys carry a `#dupN` suffix (see pretext-layout-manifest); strip it.
	const hashIndex = rest.indexOf("#");
	return (hashIndex >= 0 ? rest.slice(0, hashIndex) : rest) || null;
}

/**
 * Find the pending permission whose toolUseId matches this row's tool use.
 * The WS-sourced list is authoritative (full untruncated inputJson) — it is the
 * only source available while a permission is actually pending (the narrator is
 * "waiting" with a live socket).
 */
export function findPendingForKey(
	specKey: string,
	pendingPermissions: readonly PendingPermission[],
): PendingPermission | null {
	const toolUseId = toolUseIdFromSpecKey(specKey);
	if (!toolUseId) return null;
	for (const perm of pendingPermissions) {
		if (perm.toolUseId === toolUseId) return perm;
	}
	return null;
}
