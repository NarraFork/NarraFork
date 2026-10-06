import { specVfsService } from "../../../services/spec-vfs-service";
import { hotSafe } from "../../hot-safe";

/** Whether a spec:// path (any URI form) resolves to the behavior_fence file. */
export function isBehaviorFencePath(filePath: string): boolean {
	if (!specVfsService.isSpecUri(filePath)) return false;
	try {
		return specVfsService.normalizeSpecPath(filePath) === "behavior_fence";
	} catch {
		return false;
	}
}

/**
 * One-shot grant that lets the assistant write `spec://behavior_fence`.
 *
 * The behavior fence is agent-readonly by default. When a real user turn starts,
 * the session grants a single edit window (keyed by narratorId). The window is
 * consumed by the first behavior_fence write and is cleared as soon as the first
 * tool call of the turn completes, so later tool calls in the same turn cannot
 * write the fence. Continuation / background / subagent turns never grant it.
 */
const behaviorFenceEditGrants = hotSafe<Set<string>>(
	"narrafork.behaviorFenceEditGrants",
	() => new Set(),
);

/** Open the edit window for a narrator (call at the start of a real user turn). */
export function grantBehaviorFenceEdit(narratorId: string): void {
	behaviorFenceEditGrants.add(narratorId);
}

/**
 * Consume the edit window: returns true (and clears it) if the narrator currently
 * holds a grant. Called by Write/Edit when the target is spec://behavior_fence.
 */
export function consumeBehaviorFenceEditGrant(narratorId: string): boolean {
	const granted = behaviorFenceEditGrants.has(narratorId);
	if (granted) behaviorFenceEditGrants.delete(narratorId);
	return granted;
}

/** Close the edit window without consuming it (call once the first tool completes). */
export function clearBehaviorFenceEditGrant(narratorId: string): void {
	behaviorFenceEditGrants.delete(narratorId);
}

/** Whether the narrator currently holds an edit grant (no side effect). */
export function hasBehaviorFenceEditGrant(narratorId: string): boolean {
	return behaviorFenceEditGrants.has(narratorId);
}
