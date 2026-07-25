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
import { findPendingForKey, PERMISSION_HOST_KINDS } from "./vlist-permission-match";
import type { VListItem } from "./vlist-pipeline";

export { findPendingForKey, toolUseIdFromSpecKey } from "./vlist-permission-match";

interface UsePermissionSlotsArgs {
	renderItems: readonly VListItem[];
	permCb?: PermissionCallbacks;
}

/**
 * Build a `spec.key → live permission node` map for every pending-permission
 * tool / subagent card currently in the document. Empty when `permCb` is absent
 * or nothing is pending — in which case every row renders with its normal
 * zero-DOM body.
 */
export function usePermissionSlots({
	renderItems,
	permCb,
}: UsePermissionSlotsArgs): Map<string, ReactNode> {
	const pendingPermissions = permCb?.pendingPermissions;
	const onPermissionDecision = permCb?.onPermissionDecision;
	const onQuestionSubmit = permCb?.onQuestionSubmit;
	const onQuestionReflect = permCb?.onQuestionReflect;
	const onQuestionDeny = permCb?.onQuestionDeny;

	return useMemo(() => {
		const map = new Map<string, ReactNode>();
		if (!pendingPermissions || pendingPermissions.length === 0) return map;
		for (const item of renderItems) {
			if (!item || !PERMISSION_HOST_KINDS.has(item.spec.kind)) continue;
			const permission = findPendingForKey(item.spec.key, pendingPermissions);
			if (!permission) continue;
			map.set(
				item.spec.key,
				buildPermissionNode(permission, {
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
