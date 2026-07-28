/**
 * message-origin.ts — who actually authored a narrator message.
 *
 * `narrator_messages.role` is overloaded: it drives the provider protocol (the
 * trailing `user` message becomes the current turn) AND the continuation
 * scheduler (`getLastContinuableTopLevelMessage` only accepts user/assistant).
 * That forces every system-injected turn to be persisted as `role: "user"`, so
 * the UI could not tell a human message from an auto-continuation prompt.
 *
 * `origin` is the orthogonal attribution axis: it never affects protocol or
 * scheduling, only how a message is attributed in the UI. `role` semantics stay
 * exactly as they were.
 */

/** Who wrote the message content. */
export type MessageOrigin =
	/** A human wrote it (including IM-gateway humans and OAuth-authorized users). */
	| "user"
	/** NarraFork generated it (auto-continuation, review kickoff, rebase prompts). */
	| "system"
	/** An AI initiated it (ForkNarrator, chat-group injection). */
	| "assistant";

/**
 * Closed set of source keys used in `originLabel`.
 *
 * These are stable machine tokens, never prose: the frontend maps them through
 * i18n at render time. Storing localized prose instead would freeze the label in
 * whatever language the sender happened to use, and these rows outlive any one
 * session's locale.
 */
export type MessageOriginSource =
	| "autoContinuation"
	| "review"
	| "rebase"
	| "batchMerge"
	| "scheduledTask"
	| "forkNarrator"
	| "chatGroup"
	| "gateway"
	| "oauth"
	| "recovery";

/**
 * Build an `originLabel`. The stored format is `sourceKey` or
 * `sourceKey:detail`, where `detail` carries dynamic identity that must not be
 * translated (a platform handle, an OAuth client name, a task name).
 */
export function formatOriginLabel(source: MessageOriginSource, detail?: string | null): string {
	const trimmed = detail?.trim();
	return trimmed ? `${source}:${trimmed}` : source;
}

/** Parsed form of an `originLabel`, for rendering. */
export interface ParsedOriginLabel {
	/** Recognized source key, or null when the label is unrecognized free text. */
	source: MessageOriginSource | null;
	/** Dynamic detail (handle / client / task name), if any. */
	detail: string | null;
	/** The raw stored label, for fallback display. */
	raw: string;
}

const ORIGIN_SOURCES = new Set<string>([
	"autoContinuation",
	"review",
	"rebase",
	"batchMerge",
	"scheduledTask",
	"forkNarrator",
	"chatGroup",
	"gateway",
	"oauth",
	"recovery",
]);

/**
 * Parse a stored `originLabel`. Unrecognized labels come back with
 * `source: null` so callers can fall back to showing the raw string rather than
 * dropping information.
 */
export function parseOriginLabel(label: string | null | undefined): ParsedOriginLabel | null {
	if (!label) return null;
	const sep = label.indexOf(":");
	const head = sep === -1 ? label : label.slice(0, sep);
	const detail = sep === -1 ? null : label.slice(sep + 1).trim() || null;
	if (!ORIGIN_SOURCES.has(head)) return { source: null, detail: null, raw: label };
	return { source: head as MessageOriginSource, detail, raw: label };
}

/**
 * Attribution metadata accepted by the persistence layer and `sendMessage`.
 *
 * Grouped into an options object on purpose: `sendMessage` already takes nine
 * positional parameters, and that is exactly how `routes/narrators.ts` ended up
 * passing a userId into the `commandText` slot.
 */
export interface MessageOriginOptions {
	/** Defaults to `"user"` when omitted. */
	origin?: MessageOrigin;
	/**
	 * Source label built by `formatOriginLabel`. Display-only metadata; never
	 * sent to the model.
	 */
	originLabel?: string | null;
}

/**
 * Normalize a persisted origin. Rows written before this column existed have
 * `null`, and those were all real user messages, so `null` means `"user"`.
 */
export function normalizeMessageOrigin(origin: string | null | undefined): MessageOrigin {
	return origin === "system" || origin === "assistant" ? origin : "user";
}

/** True when the message was authored by a human (the default). */
export function isHumanOrigin(origin: string | null | undefined): boolean {
	return normalizeMessageOrigin(origin) === "user";
}
