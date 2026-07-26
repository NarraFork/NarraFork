/**
 * reflection.ts — Shared parsing + height model for reflection gates.
 *
 * A reflection gate (danger / plan / task / question) parks its state in a tool
 * call's `permissionSuggestions` array. The chunked path renders it as
 * `ReflectionNotice` INSTEAD of the permission form (ToolCallCard.tsx:5419), so
 * the exact vlist must reserve the same box.
 *
 * WHY THIS LIVES IN shared/
 *
 * The vlist first shipped reflections through the integration bridge: the real
 * `ReflectionNotice` component was mounted into the row and its height measured
 * after paint (ResizeObserver → heightOverrides). That broke the list's core
 * invariant — a row's height must never change unless the USER acted — because a
 * reflection row settles its height one frame AFTER it mounts, shifting every row
 * below it while the reader is only scrolling.
 *
 * The data was never the problem: `enrichToolUseBlocks` already ships
 * `permissionSuggestions` on every `tool_use` block, so the notice's content is
 * fully known at layout time. The gap was purely that nothing MEASURED it. This
 * module closes that gap: parsing lives here (pure, DOM-free, shared with the
 * frontend helper so the two paths cannot drift) and the measure layer derives an
 * exact arithmetic height from it.
 *
 * Reflection kinds/statuses mirror `narrator-message-helpers.ts` exactly; that
 * module re-exports these so there is a single parser.
 */

export type ReflectionKind =
	| "danger_reflection"
	| "plan_reflection"
	| "question_reflection"
	| "task_reflection";

export type ReflectionStatus = "running" | "awaiting_user" | "confirmed" | "cancelled" | "aborted";

export interface ReflectionSuggestion {
	kind: ReflectionKind;
	status: ReflectionStatus;
	reason?: string;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic suggestion payload
	danger?: any;
	nextSteps?: string;
	requestId?: string;
}

const REFLECTION_KINDS = new Set<ReflectionKind>([
	"danger_reflection",
	"plan_reflection",
	"question_reflection",
	"task_reflection",
]);

export const ACTIVE_REFLECTION_STATUSES = new Set<ReflectionStatus>(["running", "awaiting_user"]);

/**
 * Parse the first reflection entry out of a `permissionSuggestions` array.
 *
 * Legacy rows spell the resolved states as `allow` / `deny`; anything
 * unrecognized degrades to `running` (the gate is presumed still in flight),
 * which matches the chunked reader's behaviour.
 */
export function getReflectionSuggestion(
	suggestions: unknown[] | null | undefined,
): ReflectionSuggestion | null {
	if (!Array.isArray(suggestions)) return null;
	for (const suggestion of suggestions) {
		if (!suggestion || typeof suggestion !== "object") continue;
		const record = suggestion as {
			type?: unknown;
			status?: unknown;
			reason?: unknown;
			danger?: unknown;
			nextSteps?: unknown;
			requestId?: unknown;
		};
		const kind = String(record.type ?? "");
		if (!REFLECTION_KINDS.has(kind as ReflectionKind)) continue;
		const rawStatus = typeof record.status === "string" ? record.status : "running";
		const status = ACTIVE_REFLECTION_STATUSES.has(rawStatus as ReflectionStatus)
			? (rawStatus as ReflectionStatus)
			: rawStatus === "allow"
				? "confirmed"
				: rawStatus === "deny"
					? "cancelled"
					: rawStatus === "confirmed" || rawStatus === "cancelled" || rawStatus === "aborted"
						? (rawStatus as ReflectionStatus)
						: "running";
		return {
			kind: kind as ReflectionKind,
			status,
			reason: typeof record.reason === "string" ? record.reason : undefined,
			danger: record.danger,
			nextSteps: typeof record.nextSteps === "string" ? record.nextSteps : undefined,
			requestId: typeof record.requestId === "string" ? record.requestId : undefined,
		};
	}
	return null;
}

/** Live permission suggestions win over the persisted tool-call ones. */
export function getPermissionReflectionSuggestion(value: {
	suggestions?: unknown[] | null;
	permissionSuggestions?: unknown[] | null;
}): ReflectionSuggestion | null {
	return getReflectionSuggestion(value.suggestions ?? value.permissionSuggestions);
}

/**
 * A resolved permission normally writes the reflection result before the tool
 * switches to running. If the two are observed in the opposite order, only a
 * FAILED tool call is evidence that an active reflection was interrupted; a
 * running tool means the gate was approved and execution is under way.
 */
export function normalizeReflectionAfterToolStatus(
	reflection: ReflectionSuggestion | null,
	toolStatus: string | undefined,
	hasPendingPermission: boolean,
): ReflectionSuggestion | null {
	if (
		reflection &&
		!hasPendingPermission &&
		(reflection.status === "running" || reflection.status === "awaiting_user") &&
		toolStatus === "fail"
	) {
		return { ...reflection, status: "aborted" };
	}
	return reflection;
}

export function isReflectionPermissionLike(value: {
	suggestions?: unknown[] | null;
	permissionSuggestions?: unknown[] | null;
}): boolean {
	return getPermissionReflectionSuggestion(value) !== null;
}

export function isActiveReflectionPermissionLike(value: {
	suggestions?: unknown[] | null;
	permissionSuggestions?: unknown[] | null;
}): boolean {
	const reflection = getPermissionReflectionSuggestion(value);
	return reflection ? ACTIVE_REFLECTION_STATUSES.has(reflection.status) : false;
}

/**
 * The measurable shape of one reflection notice — everything that decides its
 * height, and nothing else.
 *
 * `title` and `takeOverLabel` are LOCALIZED strings resolved by the shell (the
 * pure layers hold no i18n). Both sit in single rows, but the title still wraps
 * at narrow widths, so it is measured rather than assumed.
 */
export interface ReflectionNoticeData {
	/** Localized status title (single logical line; wraps when narrow). */
	title: string;
	/** Summary line: reason / danger summary / decision reason. Wraps. */
	summary?: string;
	/** "next steps" advisory line. Wraps. */
	nextSteps?: string;
	/**
	 * Whether the manual-takeover button row is present. Only a RUNNING gate
	 * offers it, so the row appears while the gate is in flight and disappears
	 * once it resolves.
	 */
	hasTakeOver?: boolean;
	/** Reflection kind (render-only: picks the icon/colour). Height-neutral. */
	kind?: ReflectionKind;
	/** Reflection status (render-only: picks the icon/colour). Height-neutral. */
	status?: ReflectionStatus;
	/**
	 * Gate request id the takeover call targets (render-only, height-neutral).
	 * Mirrors the chunked notice's chain: the reflection's own requestId, else the
	 * pending permission's id, else the tool-call id.
	 */
	requestId?: string;
}

/**
 * Reduce a parsed reflection to its measurable data.
 *
 * `summary` mirrors the chunked notice's fallback chain
 * (reason → danger.summary → the tool call's permissionDecisionReason).
 */
export function buildReflectionNoticeData(
	reflection: ReflectionSuggestion,
	title: string,
	permissionDecisionReason?: string,
	requestIdFallback?: string,
): ReflectionNoticeData {
	const summary =
		reflection.reason ||
		(typeof reflection.danger?.summary === "string" ? reflection.danger.summary : undefined) ||
		permissionDecisionReason ||
		undefined;
	const requestId = reflection.requestId || requestIdFallback || undefined;
	return {
		title,
		...(summary ? { summary } : {}),
		...(reflection.nextSteps ? { nextSteps: reflection.nextSteps } : {}),
		// Only a running gate can still be taken over manually.
		...(reflection.status === "running" ? { hasTakeOver: true } : {}),
		kind: reflection.kind,
		status: reflection.status,
		...(requestId ? { requestId } : {}),
	};
}

/**
 * i18n key suffix for a reflection kind, so the shell can build
 * `${prefix}Reflection${State}` without duplicating the mapping.
 */
export function reflectionTitleKeyPrefix(kind: ReflectionKind): string {
	switch (kind) {
		case "danger_reflection":
			return "danger";
		case "plan_reflection":
			return "plan";
		case "question_reflection":
			return "question";
		default:
			return "task";
	}
}

/** i18n key suffix for a reflection status (mirrors ToolCallCard's title chain). */
export function reflectionTitleKeySuffix(status: ReflectionStatus): string {
	switch (status) {
		case "running":
			return "Running";
		case "awaiting_user":
			return "AwaitingUser";
		case "confirmed":
			return "Confirmed";
		case "cancelled":
			return "Cancelled";
		case "aborted":
			return "Aborted";
		default:
			return "Resolved";
	}
}
