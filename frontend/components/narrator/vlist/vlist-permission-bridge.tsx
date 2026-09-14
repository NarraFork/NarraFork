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
import { InlinePermission } from "../permission/InlinePermission";
import type {
	AsyncQuestionSlot,
	PendingPermission,
	PermissionCallbacks,
} from "../narrator-panel-types";
import { AskUserQuestionBanner, coerceQuestions } from "../question/AskUserQuestionBanner";
import {
	decidePermissionSlot,
	isPermissionHostRow,
	resolveAsyncQuestionHosts,
	toolUseIdFromSpecKey,
} from "./vlist-permission-match";
import type { VListItem } from "./vlist-pipeline";
import type { VListReflectionSource } from "./vlist-reflection-index";
import type { VListToolMeta } from "./vlist-tool-meta";

export { findPendingForKey, toolUseIdFromSpecKey } from "./vlist-permission-match";

interface UsePermissionSlotsArgs {
	renderItems: readonly VListItem[];
	tools?: ReadonlyMap<string, VListToolMeta>;
	permCb?: PermissionCallbacks;
	/** `toolUseId → reflection source`, derived from the loaded message tree. */
	reflections?: ReadonlyMap<string, VListReflectionSource>;
	/**
	 * Open ASYNCHRONOUS questions, keyed by the tool_use id that asked them.
	 *
	 * A second, lower-precedence source for the same slot. Ranking it below a pending
	 * permission is not a style choice: a permission means the session is stopped right
	 * now, while an async question means it is not, and only one form fits in a row. The
	 * asked-without-blocking case must never take the slot from the blocked one.
	 */
	asyncQuestions?: ReadonlyMap<string, AsyncQuestionSlot>;
}

export type { AsyncQuestionSlot } from "../narrator-panel-types";

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
	asyncQuestions,
	tools,
}: UsePermissionSlotsArgs): Map<string, ReactNode> {
	const pendingPermissions = permCb?.pendingPermissions;
	const onPermissionDecision = permCb?.onPermissionDecision;
	const onQuestionSubmit = permCb?.onQuestionSubmit;
	const onQuestionReflect = permCb?.onQuestionReflect;
	const onQuestionDeny = permCb?.onQuestionDeny;
	const onQuestionDefer = permCb?.onQuestionDefer;

	return useMemo(() => {
		const map = new Map<string, ReactNode>();
		const hasPending = !!pendingPermissions && pendingPermissions.length > 0;
		const hasAsync = !!asyncQuestions && asyncQuestions.size > 0;
		// Nothing waiting on either channel → every row renders with its normal
		// zero-DOM body. A row carrying only a reflection needs no slot at all now
		// that the notice is measured.
		if (!hasPending && !hasAsync) return map;
		const hostToolIds = new Set<string>();
		for (const item of renderItems) {
			if (!item || !isPermissionHostRow(item.spec.kind)) continue;
			const id = toolUseIdFromSpecKey(item.spec.key);
			const decision = decidePermissionSlot(
				item.spec.kind,
				item.spec.key,
				pendingPermissions,
				reflections,
			);
			if (id && decision.kind === "none") hostToolIds.add(id);
		}
		const questionHosts = resolveAsyncQuestionHosts(asyncQuestions, tools, hostToolIds);
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
			if (decision.kind === "reflection") continue;
			if (decision.kind === "permission" && decision.pending) {
				map.set(
					item.spec.key,
					buildPermissionNode(decision.pending, {
						onPermissionDecision,
						onQuestionSubmit,
						onQuestionReflect,
						onQuestionDeny,
						onQuestionDefer,
					}),
				);
				continue;
			}
			// No permission claimed this row: an open async question may. The host-kind
			// check is re-applied because `decidePermissionSlot` returns a bare "none" for
			// a non-hosting row, without the toolUseId that would gate it here.
			if (!isPermissionHostRow(item.spec.kind)) continue;
			const toolUseId = decision.toolUseId ?? toolUseIdFromSpecKey(item.spec.key);
			const asyncSlot = toolUseId ? questionHosts?.get(toolUseId) : undefined;
			if (asyncSlot) {
				map.set(item.spec.key, buildAsyncQuestionNode(asyncSlot));
			}
		}
		return map;
	}, [
		renderItems,
		pendingPermissions,
		reflections,
		asyncQuestions,
		tools,
		onPermissionDecision,
		onQuestionSubmit,
		onQuestionReflect,
		onQuestionDeny,
		onQuestionDefer,
	]);
}

/**
 * Mount the answer form for an open asynchronous question.
 *
 * No `onReflect` and no `reflectionDeadline`: an async question arms no automatic
 * answer timer, so offering "let the model answer" here would advertise a mechanism
 * that is not running.
 */
export function buildAsyncQuestionNode(slot: AsyncQuestionSlot): ReactNode {
	if (slot.questions.length === 0) return null;
	const banner = (
		<AskUserQuestionBanner
			requestId={slot.id}
			draftId={slot.draftId}
			questions={slot.questions}
			busy={slot.busy}
			denyLabel={slot.denyLabel}
			onSubmit={(id, answers) => slot.onSubmit(id, answers)}
			onDeny={(id) => slot.onDismiss(id)}
		/>
	);
	if (!slot.awaited || !slot.awaitedLabel) return banner;
	// An awaited question has stopped the session, so the card says so above the form.
	// Both nodes are mounted in the SAME slot, whose height the shell measures after
	// paint, so adding a line here needs no measure-path change.
	return (
		<div>
			<div
				style={{
					fontSize: "var(--mantine-font-size-xs)",
					color: "var(--mantine-color-yellow-6)",
					fontWeight: 500,
					marginBottom: 4,
				}}
			>
				{slot.awaitedLabel}
			</div>
			{banner}
		</div>
	);
}

interface PermissionNodeHandlers {
	onPermissionDecision?: PermissionCallbacks["onPermissionDecision"];
	onQuestionSubmit?: PermissionCallbacks["onQuestionSubmit"];
	onQuestionReflect?: PermissionCallbacks["onQuestionReflect"];
	onQuestionDeny?: PermissionCallbacks["onQuestionDeny"];
	onQuestionDefer?: PermissionCallbacks["onQuestionDefer"];
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
					{...(handlers.onQuestionDefer
						? { onDefer: (reqId: string) => handlers.onQuestionDefer?.(reqId) }
						: {})}
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
			onQuestionDefer={handlers.onQuestionDefer}
		/>
	);
}
