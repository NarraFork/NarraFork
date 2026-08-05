/**
 * sidecar.ts — Pure, DOM-free sidecar vocabulary for the vlist layout kernel.
 *
 * A "sidecar" is a system-injected record attached to a narrator message or a
 * tool result (progress reminders, background-task notifications, group-chat
 * deliveries, spec injections…). The exact vlist renders each one as its own
 * small collapsible card, replacing the chunked path's aggregated SideCarNotice.
 *
 * This module holds only the parts the pure adapter + measure layers need:
 * the source→colour map, the record shape, the visible-filter and the preview
 * composer. i18n labels are NOT here — they flow through `ctx.labels` like every
 * other adapter string (the render layer paints them from the measured payload).
 *
 * Zero DOM, zero React. Picked up automatically by shared-core.guard.test.ts.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Record shape (structural minimum the adapter reads)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Explicit discriminant stamped on every `SidecarSpecData` the adapter builds.
 *
 * Why a marker instead of a shape test: the measure cache has to tell a STANDALONE
 * sidecar element's data apart from a tool card's `sidecars` ARRAY, because the two
 * take different revision branches (own text vs. per-item texts). Recognizing the
 * standalone shape by "has `fullText` and `source`" happens to work today, but any
 * future payload carrying those two field names would silently fall into that
 * branch and be keyed by the wrong revision — i.e. served a stale HEIGHT. A literal
 * marker is a positive identification that cannot be collided into by accident.
 */
export const SIDECAR_PAYLOAD_KIND = "sidecar" as const;

/** Where the sidecar is attached: into a tool result, or into a user message. */
export type SidecarTarget = "tool_result" | "user_message";

/**
 * The structural subset of `SideCarRecord` (frontend/lib/api) the adapter
 * consumes. Kept interface-local so the pure kernel never imports the API type.
 */
export interface AdapterSidecar {
	/** Attachment point; drives whether it renders on a message or a tool card. */
	target: SidecarTarget | string;
	/** Free-form source tag (see SIDECAR_SOURCE_META for the known values). */
	source: string;
	/** The injected body. Empty/whitespace-only content is never rendered. */
	content: string;
	/** Owning tool call when target === "tool_result". */
	toolUseId?: string | null;
	/** Ordering within one attachment point. */
	orderIndex?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Source metadata (colour + i18n label key)
// ─────────────────────────────────────────────────────────────────────────────

export interface SidecarSourceMeta {
	/** Mantine colour name for the accent rail + badge. */
	color: string;
	/**
	 * Key into `ctx.labels` (the adapter's injected i18n map) AND into the
	 * `SIDECAR_LABEL_FALLBACKS` table below. The shell maps these onto the
	 * existing `sidecar.sources.*` narrator strings.
	 */
	labelKey: string;
}

/**
 * Known source tags → colour + label key. Mirrors the chunked SideCarNotice's
 * SOURCE_META; `living_work_spec` reuses the todo_reminder wording there, so it
 * maps to the same label key here too.
 */
export const SIDECAR_SOURCE_META: Record<string, SidecarSourceMeta> = {
	silent_progress: { color: "indigo", labelKey: "sidecarSourceSilentProgress" },
	todo_reminder: { color: "gray", labelKey: "sidecarSourceTodoReminder" },
	living_work_spec: { color: "indigo", labelKey: "sidecarSourceTodoReminder" },
	relaxed_plan: { color: "gray", labelKey: "sidecarSourceRelaxedPlan" },
	knowledge_base_hint: { color: "teal", labelKey: "sidecarSourceKnowledgeBaseHint" },
	bg_agent: { color: "blue", labelKey: "sidecarSourceBgAgent" },
	bg_bash: { color: "blue", labelKey: "sidecarSourceBgBash" },
	team_message: { color: "grape", labelKey: "sidecarSourceTeamMessage" },
	buffered_user: { color: "gray", labelKey: "sidecarSourceBufferedUser" },
	group_message: { color: "grape", labelKey: "sidecarSourceGroupMessage" },
	subagent_message: { color: "cyan", labelKey: "sidecarSourceSubagentMessage" },
	spec_update: { color: "indigo", labelKey: "sidecarSourceSpecUpdate" },
};

/** Accent colour for a source tag; unknown sources fall back to gray. */
export function sidecarSourceColor(source: string): string {
	return SIDECAR_SOURCE_META[source]?.color ?? "gray";
}

/** Label key for a source tag (undefined when the source is unknown). */
export function sidecarSourceLabelKey(source: string): string | undefined {
	return SIDECAR_SOURCE_META[source]?.labelKey;
}

// ─────────────────────────────────────────────────────────────────────────────
// Visibility filter + preview
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The visible subset of a sidecar list for one attachment target: non-empty
 * content, sorted by orderIndex (stable for entries without one). Mirrors the
 * chunked `hasVisibleSideCars` filter plus the target split its call sites do.
 */
export function collectVisibleSidecars(
	sideCars: readonly AdapterSidecar[] | null | undefined,
	target: SidecarTarget,
): AdapterSidecar[] {
	if (!sideCars || sideCars.length === 0) return [];
	const out: AdapterSidecar[] = [];
	for (const sc of sideCars) {
		if (!sc || sc.target !== target) continue;
		if (typeof sc.content !== "string" || !sc.content.trim()) continue;
		out.push(sc);
	}
	out.sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));
	return out;
}

/** Max chars the expanded card measures/paints (mirrors the chunked detail cap). */
export const SIDECAR_DETAIL_MAX_CHARS = 120_000;

/**
 * Single-line collapsed preview: whitespace-collapsed, hard-truncated. The
 * collapsed card is a fixed single-line row, so the preview is height-neutral
 * chrome — the measured height never depends on its length.
 */
export function sidecarPreviewText(content: string): string {
	const compact = content.replace(/\s+/g, " ").trim();
	if (!compact) return "";
	return compact.length > 120 ? `${compact.slice(0, 120)}…` : compact;
}

/** Expanded body text, capped so a pathological record cannot blow up measure. */
export function sidecarDetailText(content: string, truncatedLabel: string): string {
	if (content.length <= SIDECAR_DETAIL_MAX_CHARS) return content;
	return `${content.slice(0, SIDECAR_DETAIL_MAX_CHARS)}\n\n${truncatedLabel}`;
}

/**
 * True when the message carries at least one visible CONTENT block (text /
 * image / reasoning…), i.e. it yields its own message segment whose bubble
 * already renders the message-level sidecars. Tool-only messages never reach
 * the bubble path, so the tool-run surfaces their sidecars instead — this is
 * the exact predicate the chunked MessageRenderer uses for the same decision.
 *
 * Duplicated here (rather than imported) because the pure kernel cannot reach
 * into frontend/message-segments.
 */
export function adapterMessageHasVisibleContent(msg: {
	role?: string;
	contentJson?: readonly { type: string; text?: string | null }[];
}): boolean {
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	for (const b of blocks) {
		if (!b) continue;
		switch (b.type) {
			case "text":
				if (b.text?.trim()) return true;
				break;
			case "image":
			case "text_file":
			case "web_search":
			case "image_generation":
				return true;
			case "reasoning":
			case "thinking":
				// An empty reasoning block is not visible; treat any non-empty as visible.
				if ((b as { thinking?: string | null }).thinking?.trim()) return true;
				if (b.text?.trim()) return true;
				break;
			default:
				break;
		}
	}
	return false;
}
