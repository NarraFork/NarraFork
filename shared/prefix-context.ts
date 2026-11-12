import { OUTLINE_TASKS_VIEW_KEY } from "./outline-task-notice";

/** Model-facing context is an immutable baseline followed by named replacements. */
export interface PromptPart {
	key: string;
	text: string;
}

/**
 * A part a session's task source contributes. `unreadable`: its value could not be read for this
 * request, so the request keeps the previous value instead of removing the part (a transient read
 * failure must not tell the model a section was removed).
 */
export interface ContextPart extends PromptPart {
	unreadable?: true;
	/**
	 * A small, bounded summary of the part for the READER (the transcript's update row), written
	 * beside a `context_update` that changes it. Never compared (the change key is `text`), never
	 * hashed into the prefix and never sent to the model.
	 */
	display?: unknown;
}

export interface ContextChange {
	key: string;
	value: string | null;
}

export interface ContextUpdate {
	type: "context_update";
	epochId: string;
	changes: ContextChange[];
	/** Stored updates can keep large replacement bodies out of their message envelope. */
	snapshotRef?: string;
	/**
	 * Reader-only summaries of the changed parts that have one (`ContextPart.display`), by key;
	 * `null` for a changed part that was removed. Absent on rows written before it existed.
	 */
	display?: Record<string, unknown>;
}

/** Reader summaries above this many bytes of JSON are not stored (they are bounded at source). */
export const CONTEXT_UPDATE_DISPLAY_MAX_BYTES = 8192;

/**
 * Parts whose removal the transcript shows (as `null` in a row's `display`): an outline session's
 * current-tasks view, which goes away when no task is open. Any other part's removal stores
 * nothing, so rows of sessions without such parts are written exactly as before.
 */
export const DISPLAYED_CONTEXT_PARTS: ReadonlySet<string> = new Set([OUTLINE_TASKS_VIEW_KEY]);

/**
 * The `display` a `context_update` row stores for `changes`: the summary each changed part
 * supplied (`ContextPart.display`), and `null` for each removed part of
 * {@link DISPLAYED_CONTEXT_PARTS}. Undefined when there is none, or when it would exceed
 * {@link CONTEXT_UPDATE_DISPLAY_MAX_BYTES}.
 */
export function contextUpdateDisplay(
	changes: readonly ContextChange[],
	displays: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
	return boundContextUpdateDisplay(contextUpdateDisplayEntries(changes, displays));
}

/** {@link contextUpdateDisplay} before its size limit: the summaries by key, possibly none. */
export function contextUpdateDisplayEntries(
	changes: readonly ContextChange[],
	displays: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
	const display: Record<string, unknown> = {};
	for (const change of changes) {
		if (change.value === null) {
			if (DISPLAYED_CONTEXT_PARTS.has(change.key)) display[change.key] = null;
		} else if (displays?.[change.key] !== undefined) {
			display[change.key] = displays[change.key];
		}
	}
	return display;
}

/** Bytes of a reader summary as stored (its JSON, UTF-8). */
export function contextDisplayBytes(display: unknown): number {
	return new TextEncoder().encode(JSON.stringify(display) ?? "").length;
}

/** The summaries a row stores: undefined when there are none, or they exceed the limit. */
export function boundContextUpdateDisplay(
	display: Record<string, unknown>,
): Record<string, unknown> | undefined {
	if (Object.keys(display).length === 0) return undefined;
	return contextDisplayBytes(display) <= CONTEXT_UPDATE_DISPLAY_MAX_BYTES ? display : undefined;
}

/** How the host's `context_update` notice row starts (`narrator-epochs.ts`). */
export const CONTEXT_UPDATE_NOTICE = "Context updated: ";

export interface ContextUpdateBlockLike {
	type: string;
	text?: string | null;
	[key: string]: unknown;
}

/**
 * The part keys a host `context_update` row names in its notice text, or null when the row is
 * not one (no `context_update` block, or a notice that does not start the host's way). The
 * stored row names the keys in English; the update itself is in its snapshot.
 */
export function contextUpdateKeys(blocks: readonly ContextUpdateBlockLike[]): string[] | null {
	if (!blocks.some((block) => block.type === "context_update")) return null;
	const notice = blocks.find((block) => block.type === "text")?.text ?? "";
	if (!notice.startsWith(CONTEXT_UPDATE_NOTICE)) return null;
	return notice
		.slice(CONTEXT_UPDATE_NOTICE.length)
		.split(",")
		.map((key) => key.trim())
		.filter(Boolean);
}

/**
 * The prefix as an epoch marker records it: content references only (large bodies are shared
 * snapshots). The marker may also carry small reader-only summaries of the baseline's parts
 * (`EpochRecord.baselineDisplays`, at most {@link CONTEXT_UPDATE_DISPLAY_MAX_BYTES}); those are
 * no part of this snapshot or its hashes.
 */
export interface PrefixSnapshot {
	contract: string;
	parts: Array<{ key: string; hash: string }>;
	tools: string;
}

export function contextChanges(
	previous: ReadonlyMap<string, string>,
	current: readonly PromptPart[],
): ContextChange[] {
	const next = new Map(current.map((part) => [part.key, part.text]));
	const changes: ContextChange[] = [];
	for (const [key, value] of next) {
		if (previous.get(key) !== value) changes.push({ key, value });
	}
	for (const key of previous.keys()) {
		if (!next.has(key)) changes.push({ key, value: null });
	}
	return changes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function applyContextChanges(
	state: Map<string, string>,
	changes: readonly ContextChange[],
): void {
	for (const change of changes) {
		if (change.value === null) state.delete(change.key);
		else state.set(change.key, change.value);
	}
}

export function contextUpdateOf(block: unknown): ContextUpdate | undefined {
	if (!block || typeof block !== "object") return;
	const value = block as Partial<ContextUpdate>;
	if (
		value.type !== "context_update" ||
		typeof value.epochId !== "string" ||
		!Array.isArray(value.changes)
	)
		return;
	if (
		!value.changes.every(
			(part) =>
				part &&
				typeof part.key === "string" &&
				(part.value === null || typeof part.value === "string"),
		)
	)
		return;
	return value as ContextUpdate;
}

/** Generated once when a change is persisted, never re-rendered during history replay. */
export function renderContextUpdate(changes: readonly ContextChange[]): string {
	return [
		"<context_update>",
		"The host has updated the following named context sections. Replace their previous values; sections not listed remain unchanged. This does not change execution permissions or fixed safety rules.",
		...changes.map(
			({ key, value }) =>
				`\n[${key}]\n${value === null ? "This section has been removed." : value}`,
		),
		"</context_update>",
	].join("\n");
}

export function renderPrefixPrompt(contract: string, parts: readonly PromptPart[]): string {
	return [contract, ...parts.map(({ key, text }) => `## Context: ${key}\n\n${text}`)]
		.filter(Boolean)
		.join("\n\n");
}
