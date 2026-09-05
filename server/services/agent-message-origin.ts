/**
 * agent-message-origin.ts — attribution for a message one agent sent to another.
 *
 * ## The problem
 *
 * A `Send` from a parent narrator (or a sibling subagent) to a subagent is
 * delivered through the recipient's USER-message pipeline, because that is what it
 * is: the recipient's next turn. `withSenderPrefix` prepends `[Message from the
 * parent narrator]` so the MODEL knows who spoke, but the row itself carried no
 * attribution — `origin`/`origin_label` were never written — and its `created_by`
 * names the human whose session happened to trigger the send. The subagent's page
 * therefore painted a machine's words as a user bubble signed by a real person,
 * while the reverse direction (subagent → parent) rendered correctly as an
 * injection card. The text prefix stays (the model needs it), but the UI must stop
 * inferring authorship from it.
 *
 * ## Why a registry rather than a parameter
 *
 * The delivered text reaches `persistSubagentUserMessage` through three different
 * routes (in-pass drain at a tool boundary, the pass-restart drain, and
 * `resumeSubagent` for an idle target), two of which live inside the subagent
 * agent-loop body. Threading a new field through the in-memory buffer entry and
 * every one of those call sites would touch code being rewritten concurrently, and
 * would have to be repeated for each future delivery route.
 *
 * Attribution belongs to the DELIVERY, and a delivery is identified by
 * `(recipient, exact delivered text)` — the same pair every route hands to the
 * persistence layer verbatim. So the sender registers here at send time and the
 * persistence layer claims it at write time; a route that never learns about this
 * module still produces correctly attributed rows.
 *
 * Entries are claimed once, capped, and expire: a send that fails, or whose target
 * queue is cleared before it is drained, must not leave attribution behind to be
 * picked up by an unrelated later message.
 */

import { formatOriginLabel, type MessageOriginOptions } from "@shared/message-origin";

/** The sender of an agent-to-agent message, as the recipient's reader sees it. */
export interface AgentMessageSender {
	/** Sender narrator id. Audit/debug only — never rendered from this module. */
	id: string;
	/** The sender's own title, when it has one. */
	title?: string | null;
	/**
	 * Stable alias fallback for an untitled sender (`agentLabelFromNarrator`).
	 * Required: a bare nanoid is not a name, and the header would otherwise show one.
	 */
	label: string;
	/** Subagent type (`explore`/`plan`/`general`/…); absent for a primary narrator. */
	type?: string | null;
	/** True when the sender is the recipient's own parent narrator. */
	isParent: boolean;
}

/**
 * Attribution for a message an agent addressed to another agent.
 *
 * `origin: "assistant"` because an AI authored the text — the same value
 * `ForkNarrator` uses. The label's detail is the sender's display NAME and never
 * localized prose: these rows outlive any one session's locale, so the reader-facing
 * wording ("Agent message") is resolved at render time from the source key while the
 * identity stays verbatim.
 */
export function buildAgentMessageOrigin(sender: AgentMessageSender): MessageOriginOptions {
	const name = sender.title?.trim() || sender.label.trim() || sender.id;
	return { origin: "assistant", originLabel: formatOriginLabel("agentMessage", name) };
}

/**
 * Pending attributions, keyed by recipient + exact delivered text.
 *
 * A LIST per key, drained FIFO: the same text can legitimately be sent twice (a
 * retried instruction, two senders relaying one decision), and collapsing those
 * would attribute the second row to nothing.
 */
const pending = new Map<string, Array<{ origin: MessageOriginOptions; at: number }>>();

/**
 * Total entries retained. A ceiling rather than a target: this map only ever holds
 * attributions awaiting a write that normally follows within milliseconds, so
 * reaching the cap means deliveries are being dropped somewhere and the oldest
 * entries are the ones least likely to still be claimed.
 */
const MAX_PENDING_ENTRIES = 500;

/**
 * How long an unclaimed attribution is kept. Generous because a queued message can
 * legitimately wait for a long tool call to finish, but finite because a send whose
 * message never reached a turn (target archived, queue cleared on finalize) must not
 * leave attribution that a later, unrelated message with identical text could claim.
 */
const PENDING_TTL_MS = 15 * 60 * 1000;

/**
 * The delivered text is part of the key, so it is hashed rather than concatenated:
 * a Send body can be arbitrarily large, and retaining a second copy of every
 * in-flight message just to key a map would double the memory an agent conversation
 * costs. Collisions are harmless here — the value is a display label, and a
 * mismatched claim can only mislabel a row that a real Send produced anyway.
 */
function keyFor(recipientNarratorId: string, text: string): string {
	return `${recipientNarratorId}\u0000${Bun.hash(text).toString(36)}`;
}

/** Drop expired entries, then the oldest ones if the map is still over the cap. */
function sweep(): void {
	const cutoff = Date.now() - PENDING_TTL_MS;
	let total = 0;
	for (const [key, entries] of pending) {
		const live = entries.filter((entry) => entry.at >= cutoff);
		if (live.length === 0) pending.delete(key);
		else {
			if (live.length !== entries.length) pending.set(key, live);
			total += live.length;
		}
	}
	if (total <= MAX_PENDING_ENTRIES) return;
	// Oldest-first eviction across all keys: a key's entries are already in
	// registration order, so the head of each list is its oldest.
	const heads = [...pending.entries()]
		.map(([key, entries]) => ({ key, at: entries[0]?.at ?? 0 }))
		.sort((a, b) => a.at - b.at);
	for (const head of heads) {
		if (total <= MAX_PENDING_ENTRIES) break;
		const entries = pending.get(head.key);
		if (!entries) continue;
		entries.shift();
		total--;
		if (entries.length === 0) pending.delete(head.key);
	}
}

/**
 * Record who sent `text` to `recipientNarratorId`, for the write that follows.
 *
 * Called at send time with the text EXACTLY as delivered (sender prefix included),
 * because that is the string the persistence layer receives.
 */
export function registerAgentMessageOrigin(
	recipientNarratorId: string,
	text: string,
	sender: AgentMessageSender,
): void {
	const key = keyFor(recipientNarratorId, text);
	const entries = pending.get(key) ?? [];
	entries.push({ origin: buildAgentMessageOrigin(sender), at: Date.now() });
	pending.set(key, entries);
	sweep();
}

/**
 * Take the attribution for a message about to be persisted, if one was registered.
 *
 * Consume-once: a claimed attribution must not be reused for the next message that
 * happens to carry the same text. Returns null for ordinary human messages, which
 * is what makes this safe to call unconditionally from the persistence layer.
 */
export function claimAgentMessageOrigin(
	recipientNarratorId: string,
	text: string,
): MessageOriginOptions | null {
	const key = keyFor(recipientNarratorId, text);
	const entries = pending.get(key);
	if (!entries || entries.length === 0) return null;
	const claimed = entries.shift();
	if (entries.length === 0) pending.delete(key);
	return claimed?.origin ?? null;
}

/** Drop every pending attribution. For tests and for a full session teardown. */
export function clearAgentMessageOrigins(): void {
	pending.clear();
}

/** Pending entry count, for tests and diagnostics. */
export function pendingAgentMessageOriginCount(): number {
	let total = 0;
	for (const entries of pending.values()) total += entries.length;
	return total;
}
