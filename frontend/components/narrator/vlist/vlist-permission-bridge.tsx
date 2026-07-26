/**
 * vlist-permission-bridge.tsx — Live permission-form bridge for the exact vlist.
 *
 * The pretext vlist measures/renders every row with zero DOM. Permission prompts
 * (InlinePermission / AskUserQuestionBanner), however, are strongly interactive
 * and dynamically sized (feedback textarea, ExitPlanMode plan edit, custom
 * answers, reflection countdown, keyboard nav, sessionStorage drafts). Rather
 * than reimplement all of that as a zero-DOM copy, a pending-permission tool /
 * subagent card mounts the REAL component from the chunked path, and the shell
 * corrects its row height after paint (see PretextExactMessageList's
 * onUnknownHeight / heightOverrides).
 *
 * The same slot also hosts the REFLECTION notice: when a danger / plan / task /
 * question reflection gate is running or has resolved, the chunked card renders
 * `ReflectionNotice` INSTEAD of the permission form (ToolCallCard.tsx:5419). The
 * precedence itself lives in the pure `decidePermissionSlot`; this module only
 * turns a decision into the matching node.
 *
 * This bridge is an integration-layer module (it lives in vlist/ so the isolation
 * guard permits it to import outer app components; it is only ever used by
 * PretextExactMessageList). It maps each pending-permission row's spec.key to the
 * ready-to-mount React node. The required contexts (PermEnterHintCtx,
 * useNarratorPermissionsCapability) are already provided by NarratorPanel above
 * the vlist, so the mounted component behaves exactly like the chunked path.
 */

import { type ReactNode, useMemo } from "react";
import { AskUserQuestionBanner, coerceQuestions } from "../AskUserQuestionBanner";
import type { PendingPermission, PermissionCallbacks } from "../narrator-panel-types";
import { InlinePermission } from "../ToolCallCard";
import { decidePermissionSlot } from "./vlist-permission-match";
import type { VListItem } from "./vlist-pipeline";
import type { VListReflectionSource } from "./vlist-reflection-index";

export { findPendingForKey, toolUseIdFromSpecKey } from "./vlist-permission-match";

interface UsePermissionSlotsArgs {
	renderItems: readonly VListItem[];
	permCb?: PermissionCallbacks;
	/** `toolUseId → reflection source`, derived from the loaded message tree. */
	reflections?: ReadonlyMap<string, VListReflectionSource>;
}

/**
 * Build a `spec.key → live permission node` map for the pending-permission tool /
 * subagent cards currently in the document. Empty when nothing is pending — in
 * which case every row renders with its normal zero-DOM body.
 *
 * REFLECTIONS ARE NOT HERE ANY MORE. They used to be bridged like a permission
 * form (mount the real `ReflectionNotice`, measure the row after paint), which
 * made every reflection row dynamic: its height settled one frame after mounting
 * and pushed everything below it while the reader was merely scrolling. The gate's
 * state already ships with the message tree, so the notice is now MEASURED and
 * rendered on the pure path (measure-reflection-notice + RenderReflectionNotice)
 * and its height is final on first paint.
 *
 * `reflections` is still accepted because it decides PRECEDENCE: a row showing a
 * reflection notice must NOT also mount a permission form, exactly as the chunked
 * card resolves it (ToolCallCard.tsx:5419).
 */
export function usePermissionSlots({
	renderItems,
	permCb,
	reflections,
}: UsePermissionSlotsArgs): Map<string, ReactNode> {
	const pendingPermissions = permCb?.pendingPermissions;
	const onPermissionDecision = permCb?.onPermissionDecision;
	const onQuestionSubmit = permCb?.onQuestionSubmit;
	const onQuestionReflect = permCb?.onQuestionReflect;
	const onQuestionDeny = permCb?.onQuestionDeny;

	return useMemo(() => {
		const map = new Map<string, ReactNode>();
		// No pending request → nothing to mount. A row carrying only a reflection
		// needs no slot at all now that the notice is measured.
		if (!pendingPermissions || pendingPermissions.length === 0) return map;
		for (const item of renderItems) {
			if (!item) continue;
			const decision = decidePermissionSlot(
				item.spec.kind,
				item.spec.key,
				pendingPermissions,
				reflections,
			);
			// A "reflection" decision means the measured notice owns this row's
			// permission area; mounting a form would double it up.
			if (decision.kind !== "permission" || !decision.pending) continue;
			map.set(
				item.spec.key,
				buildPermissionNode(decision.pending, {
					onPermissionDecision,
					onQuestionSubmit,
					onQuestionReflect,
					onQuestionDeny,
				}),
			);
		}
		return map;
	}, [
		renderItems,
		pendingPermissions,
		reflections,
		onPermissionDecision,
		onQuestionSubmit,
		onQuestionReflect,
		onQuestionDeny,
	]);
}

interface PermissionNodeHandlers {
	onPermissionDecision?: PermissionCallbacks["onPermissionDecision"];
	onQuestionSubmit?: PermissionCallbacks["onQuestionSubmit"];
	onQuestionReflect?: PermissionCallbacks["onQuestionReflect"];
	onQuestionDeny?: PermissionCallbacks["onQuestionDeny"];
}

/**
 * Build the ready-to-mount permission node for a pending permission. AskUserQuestion
 * uses the full question banner; every other tool uses InlinePermission (which
 * itself internally renders the AskUserQuestion banner only when appropriate, but
 * we short-circuit here for parity with the chunked path's card body).
 */
export function buildPermissionNode(
	permission: PendingPermission,
	handlers: PermissionNodeHandlers,
): ReactNode {
	if (permission.toolName === "AskUserQuestion") {
		const questions = coerceQuestions(permission.inputJson?.questions);
		if (questions.length > 0) {
			return (
				<AskUserQuestionBanner
					requestId={permission.id}
					questions={questions}
					reflectionDeadline={permission.reflectionDeadline}
					onSubmit={(reqId, answers) => handlers.onQuestionSubmit?.(reqId, answers)}
					onReflect={(reqId) => handlers.onQuestionReflect?.(reqId)}
					onDeny={(reqId) => handlers.onQuestionDeny?.(reqId)}
				/>
			);
		}
	}
	return (
		<InlinePermission
			permission={permission}
			onDecision={handlers.onPermissionDecision}
			onQuestionSubmit={handlers.onQuestionSubmit}
			onQuestionReflect={handlers.onQuestionReflect}
			onQuestionDeny={handlers.onQuestionDeny}
		/>
	);
}
