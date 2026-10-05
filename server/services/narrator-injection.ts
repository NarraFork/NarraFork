/**
 * narrator-injection.ts — the ONE way the server puts its own words into a
 * narrator's conversation.
 *
 * ## What this replaces
 *
 * Injected content historically travelled two unrelated roads:
 *
 *   1. **A side-car** (`narrator_sidecars`) — a row attached to somebody ELSE's
 *      message, reassembled into `tool_result` output or the next user turn at API
 *      call time by a hand-written state machine in each of seven `buildHistory`
 *      implementations.
 *   2. **A message row** (`persistSystemMessage`) — an ordinary `role: "sys"` row
 *      that every provider already knows how to replay.
 *
 * Road 1 existed to solve a problem road 2 also solves. NarraFork sends the FULL
 * history on every request (`store: false`; see the comment at
 * `openai-provider.ts:758`), so what the model receives is a pure function of the
 * message rows. A side-car and a `sys` row carrying the same words are the same
 * bytes on the wire — the side-car just paid for a table, a `body_json` column, seven
 * flush state machines and a `<side_car>` wrapper to get there.
 *
 * So this module offers road 2 to every producer, and road 1 is gone: the table, the
 * `body_json` column, the seven flush state machines and the `<side_car>` wrapper have
 * all been removed. Everything below describes the only remaining road.
 *
 * ## The two axes, kept apart
 *
 * The old design conflated them. `role` decided the protocol角色 AND (via each
 * provider's "pop the trailing user row as the current turn" rule) whether the row
 * would be treated as something to answer. That is why "inject without scheduling a
 * turn" had no clean spelling, and why the side-car was invented to sidestep `role`
 * entirely.
 *
 *   `role`      what this content IS.
 *               `sys`  — a system fact (a container came up, a task finished). On
 *                        Anthropic official-API this becomes a真
 *                        mid-conversation `system` message; elsewhere it maps to
 *                        `user` (see each provider's buildHistory).
 *               `user` — content that speaks FOR the user. Costs more weight and it
 *                        should: `taskReflection` reads the parent history and can
 *                        only recognize a task the user actually asked for if the
 *                        request arrived as a user turn. This is the whole reason
 *                        `spec-edit-interject.ts` exists.
 *
 *   `schedule`  what should HAPPEN because of it. Fully independent of `role`; every
 *               combination is meaningful and reachable.
 *
 * ## Why `schedule` is a parameter and not a column
 *
 * It is consumed by the act of delivering. Persisting it would make a fork or a
 * history replay re-trigger a wake-up that already happened months ago. The row is
 * permanent; the intent is not.
 *
 * NOTE: this leaves the providers' "trailing `user` row is the current turn" rule
 * untouched — `buildHistory` still infers scheduling from row shape. Removing that
 * inference needs a persisted marker and is deliberately out of scope here.
 */

import { formatOriginLabel, type MessageOriginSource } from "@shared/message-origin";
import type { NativeInjectionBlock } from "@shared/native-injection";
import type { SideCarBody } from "@shared/sidecar-body";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { narratorMessages } from "../db/schema";
import { projectMessageSenderText } from "../lib/agent/sender-projection";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { dualBroadcastToNarrator } from "../websocket/narrator-dual-broadcast";
import type { MessagePlacementOptions } from "./narrator-persistence";
import type { QuestionExecutionPrincipal } from "./narrator-question-service";
import { narratorService } from "./narrator-service";

/**
 * Content block carried by an injected message row.
 *
 * New rows store one self-contained `system_injection` block. Its `modelText` is the
 * exact model-facing projection and its `body` is the structured reader-facing payload.
 * Legacy rows may still have `[{ type: "text", text }, system_injection]`; the shared
 * logical-block mapper handles that shape only when the association is explicit.
 *
 * Keeping both projections inside one logical block is load-bearing: deleting the
 * injection cannot leave a model-text sibling that falls back into a gray system card.
 *
 * ## Why the block stores `body` and not Markdown
 *
 * The reader-facing wording lives in the FRONTEND message tables
 * (`sidecar.body.*` in each locale's `narrator.json`), reached through
 * `ctx.labels`; the server's `sidecar.*` table holds only the model-facing copy. The
 * existing side-car respects that split by projecting at render time
 * (`presentSideCarBody`), and this block keeps it: rendering Markdown here would mean
 * duplicating ~22 reader-facing strings into the server, and freezing them at write
 * time so a translation fix could never reach an existing row.
 *
 * `sideCarBodyToMarkdown` therefore runs in the UI, off this `body`. The two
 * projections still cannot drift, because both derive from the same payload written
 * in one place.
 */
export type SystemInjectionBlock = NativeInjectionBlock;

/** What should happen to the narrator as a result of this injection. */
export type InjectionSchedule =
	/**
	 * Write the row, change nothing else. The row is read on whatever request happens
	 * next — seconds later or never. This is what the seven existing "notify but do
	 * not wake" call sites do today (container ready, review feedback, merge summary,
	 * browser session lost).
	 */
	| "none"
	/**
	 * Write the row AND surface it inside the RUNNING loop's next turn.
	 *
	 * Needed because a loop rebuilds its in-memory history only at pass start, so a
	 * row written mid-turn is invisible until the next pass. The caller therefore also
	 * receives the text back (`turnText`) to append to the loop's own next-turn
	 * buffer. Not a double delivery: the current pass reads the in-memory copy, later
	 * passes read the row, and the two never apply to the same request.
	 */
	| "onNextTurn"
	/**
	 * Write the row and ask the running loop to stop at the next tool boundary so the
	 * content is taken up promptly. Used when the content changes what the narrator
	 * should be doing (a plan edit), not merely what it knows.
	 */
	| "interject"
	/**
	 * Write the row and, if the narrator is idle, start a turn. When it is busy this
	 * degrades to `none`: the row is already in place and the running loop will pick
	 * it up on its next pass.
	 *
	 * For a SUBAGENT recipient the turn is started through `resumeSubagent` rather
	 * than a bare loop — see `startInjectionContinuationIfPossible`, which owns that
	 * dispatch. Callers do not choose between the two.
	 */
	| "wakeIfIdle";

/**
 * Where the recipient sits, when it is a subagent.
 *
 * ## Why the caller states this instead of the module looking it up
 *
 * The origin tool_use id is not derivable from `narratorId` cheaply or unambiguously —
 * `resolveSubagentOriginToolUseId` scans for the first linked user row and THROWS for a
 * never-started subagent, while a running executor already holds the exact id for the
 * call it is inside. A lookup here would be a second, weaker answer to a question the
 * caller has already answered correctly, and getting it wrong writes the row under
 * somebody else's tool card.
 *
 * ## What passing it changes
 *
 * Two things, and they are one decision:
 *
 *   - the row is written with `parentToolUseId`, so it belongs to that tool_use subtree.
 *     The subagent's OWN page loads it (its loader drops the `isNull(parentToolUseId)`
 *     filter and nulls the field for display), while the parent's page does not draw it
 *     inline — subagent children are represented by a bounded activity snapshot.
 *   - delivery becomes DUAL: the parent gets a copy addressed to the tool card, the
 *     subagent gets a stripped copy addressed to itself. That is the existing convention
 *     for every subagent row (`persistSubagentUserMessage`'s two broadcasts), and a
 *     single broadcast would leave one of the two pages stale.
 *
 * Note the row still does NOT enter the model history through this field: every
 * provider's `buildHistory` filters `!m.parentToolUseId`, and a subagent's own history
 * is loaded through `loadSubagentHistory`, which clears the field first. So the field
 * decides READERS, not what the model sees.
 */
export interface InjectionRecipientPlacement {
	/** The Agent/Task `tool_use` id that owns the recipient subagent. */
	parentToolUseId: string;
	/**
	 * The parent narrator, i.e. where the tool-card copy goes.
	 *
	 * Required rather than looked up for the same reason as above, and because a
	 * broadcast to the wrong parent is silent: nothing errors, one page just never
	 * updates.
	 */
	parentNarratorId: string;
}

export interface DeliverInjectionOptions {
	/** Exact recipient row reserved by an inbound agent delivery. */
	messageId?: string;
	/** Model-facing text. Stored verbatim inside the native injection block. */
	content: string;
	/** Producer tag. */
	source: string;
	/** Structured payload; projected to Markdown for the reader. */
	body?: SideCarBody;
	/** Protocol semantics + weight. Defaults to `sys`. */
	role?: "sys" | "user";
	/** Scheduling effect. Defaults to `none`. */
	schedule?: InjectionSchedule;
	/** Locale for the reader-facing projection. */
	locale?: Locale;
	/** Attribution label source (`review`, `autoContinuation`, …). */
	originSource?: MessageOriginSource;
	/** Free-form detail for the attribution label (a task name, a handle). */
	originDetail?: string | null;
	/** Human who triggered this, when there is one (audit, not execution authority). */
	createdBy?: string | null;
	/** Trusted source execution identity; an explicit anonymous userId must remain anonymous. */
	executionPrincipal?: QuestionExecutionPrincipal;
	/**
	 * Set when the recipient is a SUBAGENT — see {@link InjectionRecipientPlacement}.
	 * Omitted means a primary narrator: a top-level row and a single broadcast, which
	 * is what every pre-existing producer does.
	 */
	subagent?: InjectionRecipientPlacement;
	/** Atomically commit related state with the message, before any broadcast or wake. */
	onPersist?: MessagePlacementOptions["onPersist"];
	/**
	 * Extra content blocks appended after the injection block, for producers that
	 * already have a richer card (`background_agents_completed`, `review_feedback`).
	 * Preserved so migrating a producer does not have to give up its existing UI.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: content blocks are dynamic JSON
	extraBlocks?: any[];
}

export interface DeliverInjectionResult {
	/** The persisted row id, or null when nothing was written. */
	messageId: string | null;
	/**
	 * Model-facing text the caller must ALSO feed to the running loop
	 * (`schedule: "onNextTurn"` only). Null otherwise — a caller that appends this
	 * unconditionally would double-deliver.
	 */
	turnText: string | null;
	/** A turn was started (`wakeIfIdle` on an idle narrator). */
	started: boolean;
	/** A soft stop was requested (`interject` on a running narrator). */
	interjected: boolean;
}

const EMPTY_RESULT: DeliverInjectionResult = {
	messageId: null,
	turnText: null,
	started: false,
	interjected: false,
};

/**
 * Build the reader-facing block for an injection.
 *
 * Exported for the migration: a producer can build its block and assert on it without
 * touching the database.
 */
export function buildSystemInjectionBlock(
	source: string,
	body: SideCarBody | undefined,
	modelText?: string,
): SystemInjectionBlock {
	return {
		type: "system_injection",
		source,
		...(typeof modelText === "string" ? { modelText } : {}),
		...(body ? { body } : {}),
	};
}

/**
 * Deliver injected content to a narrator as a message row, applying `schedule`.
 *
 * Scheduling helpers are imported lazily: `narrator-session` is this module's
 * consumer as well as its collaborator, and a static import would close a cycle.
 */
export async function deliverInjection(
	...args: Parameters<typeof deliverInjectionUnlocked>
): ReturnType<typeof deliverInjectionUnlocked> {
	if (!args[1].content.trim()) return EMPTY_RESULT;
	const { withNarratorWorkAdmission } = await import("./narrator-session-state");
	return withNarratorWorkAdmission(args[0], () => deliverInjectionUnlocked(...args));
}

async function deliverInjectionUnlocked(
	narratorId: string,
	options: DeliverInjectionOptions,
): Promise<DeliverInjectionResult> {
	const content = options.content.trim();
	// An injection with nothing to say must not produce a row. Callers drain queues
	// and hit cadences that legitimately come up empty, and an empty row would be a
	// blank card for the reader plus a wasted turn for the model.
	if (!content) return EMPTY_RESULT;

	const locale = options.locale ?? "en";
	const existingRole = options.messageId
		? db
				.select({ role: narratorMessages.role })
				.from(narratorMessages)
				.where(
					and(
						eq(narratorMessages.id, options.messageId),
						eq(narratorMessages.narratorId, narratorId),
					),
				)
				.get()?.role
		: undefined;
	const role =
		options.role ?? (existingRole === "user" || existingRole === "sys" ? existingRole : "sys");
	const schedule = options.schedule ?? "none";
	const block = buildSystemInjectionBlock(options.source, options.body, content);
	const blocks = [block, ...(options.extraBlocks ?? [])];
	const origin = {
		origin: role === "user" ? ("user" as const) : ("system" as const),
		originLabel: options.originSource
			? formatOriginLabel(options.originSource, options.originDetail)
			: null,
	};

	const placement =
		options.subagent || options.onPersist || options.messageId
			? {
					...(options.messageId ? { messageId: options.messageId } : {}),
					...(options.subagent ? { parentToolUseId: options.subagent.parentToolUseId } : {}),
					...(options.onPersist ? { onPersist: options.onPersist } : {}),
				}
			: undefined;

	const message =
		role === "user"
			? await narratorService.persistUserMessage(
					narratorId,
					content,
					// Native injection blocks carry their model-facing projection themselves;
					// legacy user rows keep the historical sibling text block.
					blocks[0]?.type === "system_injection"
						? blocks
						: [{ type: "text", text: content }, ...blocks],
					null,
					options.createdBy ?? null,
					origin,
					placement,
				)
			: await narratorService.persistSystemMessage(
					narratorId,
					content,
					// persistSystemMessage prepends `{type:"text"}` itself.
					blocks,
					options.createdBy ?? undefined,
					origin,
					placement,
				);

	// One frame, addressed by the shared subagent convention: the parent copy keeps
	// `parentToolUseId` so it attaches to the tool card, and the self copy is stripped
	// so the subagent's page reads it as a top-level row. Degrades to a single
	// broadcast for a primary narrator, which is what this used to do unconditionally.
	try {
		dualBroadcastToNarrator(
			{
				narratorId,
				broadcastTargetId: options.subagent?.parentNarratorId ?? narratorId,
				parentToolUseId: options.subagent?.parentToolUseId,
			},
			{
				type: "message",
				narratorId,
				message: {
					id: message.id,
					narratorId,
					role: message.role,
					contentJson: message.contentJson,
					contentText: message.contentText,
					createdAt: message.createdAt,
					seq: message.seq,
					parentToolUseId: options.subagent?.parentToolUseId ?? null,
					children: [],
				},
			},
		);
	} catch (error) {
		// Persistence is already committed. A missing WS frame must not prevent the
		// answer scheduler (or another producer) from supplying this durable event.
		logger.warn("Injection notification deferred after persistence", {
			narratorId,
			messageId: message.id,
			error: String(error),
		});
	}

	const result: DeliverInjectionResult = {
		messageId: message.id,
		turnText: schedule === "onNextTurn" ? projectMessageSenderText(message, content) : null,
		started: false,
		interjected: false,
	};

	if (schedule === "interject") {
		result.interjected = await requestSoftStop(narratorId);
	} else if (schedule === "wakeIfIdle") {
		// No recipient kind is passed: the scheduler resolves it and routes a subagent to
		// `resumeSubagent` itself. Deciding it HERE would put a second copy of "what is a
		// subagent, and what may start one" in a module that reaches the session layer only
		// through a lazy import — and would leave the route-level caller of the same
		// scheduler entry unprotected.
		result.started = await wakeIfIdle(narratorId, locale, options.executionPrincipal);
	}

	return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduling seam
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The scheduling operations this module needs from the session layer.
 *
 * An explicit, replaceable seam rather than a `mock.module` target. Two reasons:
 *
 *  - `narrator-session` is both this module's collaborator and its consumer, so the
 *    import has to be lazy to avoid closing a cycle at module-init time.
 *  - `mock.module` is PROCESS-wide in Bun. Replacing `narrator-session` for one test
 *    file hands the replacement to every later file in the same run, and because
 *    several sibling services hold module-level lazy maps, that silently reset state
 *    other suites depend on (it broke nine narrator-buffer assertions). A seam the test
 *    sets and restores keeps the blast radius inside the test.
 */
export interface InjectionScheduler {
	requestSoftStop: (narratorId: string) => boolean;
	wakeIfIdle: (
		narratorId: string,
		locale: Locale,
		executionPrincipal?: QuestionExecutionPrincipal,
	) => Promise<{ started: boolean }>;
}

/** Lazily bound to the real session module; replaced only by tests. */
let scheduler: InjectionScheduler | null = null;

/**
 * Install a scheduler, returning the previous one so a test can restore it.
 *
 * Pass `null` to fall back to the real session module.
 */
export function setInjectionScheduler(next: InjectionScheduler | null): InjectionScheduler | null {
	const previous = scheduler;
	scheduler = next;
	return previous;
}

/** Resolve the scheduler, binding the real session module on first use. */
async function resolveScheduler(): Promise<InjectionScheduler> {
	if (scheduler) return scheduler;
	const session = await import("./narrator-session");
	return {
		requestSoftStop: session.requestBufferedMessageSoftStop,
		wakeIfIdle: (narratorId, locale, executionPrincipal) =>
			executionPrincipal
				? session.startInjectionContinuationIfPossible(
						narratorId,
						locale,
						undefined,
						executionPrincipal,
					)
				: session.startInjectionContinuationIfPossible(narratorId, locale),
	};
}

/**
 * Ask the running loop to stop at its next tool boundary.
 *
 * Failure is logged, not thrown: the row is already persisted, so the worst case is
 * that the content is taken up at the end of the turn instead of the next boundary.
 */
async function requestSoftStop(narratorId: string): Promise<boolean> {
	try {
		return (await resolveScheduler()).requestSoftStop(narratorId);
	} catch (err) {
		logger.warn("Injection delivered but requesting a soft stop failed", {
			narratorId,
			error: String(err),
		});
		return false;
	}
}

/**
 * Start a turn when the narrator is idle.
 *
 * Delegates to `startInjectionContinuationIfPossible`, which owns the gating (the
 * continuation lock, the idle check, the plan-mode check) so that this module never
 * holds a second, subtly different copy of those rules. That delegation now also
 * covers the recipient KIND: a subagent is resumed through `resumeSubagent` there,
 * which is the only way to start one safely (resume lock, origin tool_use id,
 * conclusion publication back into the parent's open tool call).
 *
 * A failure here is logged, not thrown: the row is already persisted, so the content
 * is not lost — it simply waits for the next request instead of getting one now.
 */
async function wakeIfIdle(
	narratorId: string,
	locale: Locale,
	executionPrincipal?: QuestionExecutionPrincipal,
): Promise<boolean> {
	try {
		const seam = await resolveScheduler();
		const { started } = executionPrincipal
			? await seam.wakeIfIdle(narratorId, locale, executionPrincipal)
			: await seam.wakeIfIdle(narratorId, locale);
		return started;
	} catch (err) {
		logger.warn("Injection delivered but waking the narrator failed", {
			narratorId,
			error: String(err),
		});
		return false;
	}
}
