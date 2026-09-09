/**
 * narrator-question-service.ts — asynchronous AskUserQuestion: questions the agent
 * asked WITHOUT stopping, and the path their answers take back into the conversation.
 *
 * ## The problem this exists for
 *
 * A long task throws up small design decisions whose answers are useful but not worth
 * halting the implementation for. The synchronous tool has only one gear: the
 * permission gate suspends the loop (`ALWAYS_ASK_TOOLS`) and the narrator sits in
 * `waiting` until somebody replies. So an agent's only options were to block itself or
 * to silently guess. This module is the third option: ask, keep working with a sensible
 * default, and let the answer arrive later.
 *
 * ## Why answers come back as a MESSAGE ROW
 *
 * NarraFork replays the full history on every request (`store: false`), so what the
 * model sees is a pure function of the message rows. Patching the historical tool
 * call's output would therefore change nothing for a running loop — the tool result it
 * already consumed is in its in-memory history. The answer has to become a row, which
 * is exactly what `deliverInjection` is for, so this module owns no delivery mechanics
 * of its own.
 *
 * `role: "user"` and not `sys`: this IS the user speaking. `taskReflection` and friends
 * can only recognise an instruction the user actually gave when it arrives as a user
 * turn (see the `role` note in narrator-injection.ts), and an answer to "which auth
 * method?" is precisely such an instruction.
 *
 * ## Why the state lives in a table
 *
 * Decisions do not depend on process memory. The unique index on `tool_call_id`
 * makes creation idempotent. Answer/dismiss commit their conditional status update,
 * message and history ref in one synchronous transaction: failed writes leave the
 * question open for retry, and committed decisions already have a model-visible row.
 * Withdraw uses the same `status = 'open'` condition, so first writer wins.
 */

import type { SideCarAsyncQuestionAnswer, SideCarBody } from "@shared/sidecar-body";
import { and, desc, eq, inArray, lt, or, type SQLWrapper, sql } from "drizzle-orm";
import { db } from "../db";
import { narratorQuestions, narrators, narratorToolCalls } from "../db/schema";
import { eventBus } from "../lib/event-bus";
import { hotSafe } from "../lib/hot-safe";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { getSubagentType, isSubagentVariant } from "../lib/narrator-utils";
import type { Locale } from "../lib/prompt-i18n";
import { sideCarBodyWithText } from "../lib/sidecar-templates";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import {
	assertRuntimeCanAskQuestion,
	type RuntimePolicy,
	resolveRuntimePolicy,
} from "./agent-runtime/policy";
import { customSubagentService } from "./custom-subagent-service";
import { notifyHumanAttentionChanged } from "./human-attention-events";
import { type DeliverInjectionOptions, deliverInjection } from "./narrator-injection";

/** One question as the tool defined it. Structurally the tool's own input shape. */
export interface AsyncQuestionDefinition {
	/** Stable answer key the model chose (`auth-method`). */
	question: string;
	/** The prompt the user actually reads. */
	header: string;
	multiSelect?: boolean;
	options?: { label: string; description?: string; preview?: string }[];
}

export interface AsyncQuestionAnnotation {
	preview?: string;
	notes?: string;
}

export type AsyncQuestionStatus = "open" | "answered" | "dismissed" | "withdrawn";
export type AsyncQuestionOrigin = "agent_async" | "user_deferred";

/** A captured execution identity, independent of the user who eventually answers.
 * Outer null/absence means legacy unknown; {userId:null} is a real anonymous principal. */
export interface QuestionExecutionPrincipal {
	version: 1;
	userId: string | null;
}

export function parseQuestionExecutionPrincipal(value: unknown): QuestionExecutionPrincipal | null {
	if (!value || typeof value !== "object") return null;
	const snapshot = value as Record<string, unknown>;
	if (
		snapshot.version !== 1 ||
		(snapshot.userId !== null &&
			(typeof snapshot.userId !== "string" || snapshot.userId.length === 0))
	)
		return null;
	return { version: 1, userId: snapshot.userId as string | null };
}

/**
 * What a pushed change tells the client.
 *
 * The first four mirror `status`. The last two are WAIT transitions, which are not
 * status changes at all: the question stays `open` while the agent blocks on it, but
 * its urgency flips (see `awaitAsyncQuestion`), and the inbox has to reflect that.
 */
export type AsyncQuestionChange =
	| "opened"
	| "answered"
	| "dismissed"
	| "withdrawn"
	| "awaited"
	| "await_ended";

/** A question row as the API and the WS event expose it. */
export interface AsyncQuestionRecord {
	id: string;
	narratorId: string;
	toolCallId: string;
	toolUseId: string;
	questions: AsyncQuestionDefinition[];
	answers: Record<string, string> | null;
	annotations: Record<string, AsyncQuestionAnnotation> | null;
	status: AsyncQuestionStatus;
	origin: AsyncQuestionOrigin;
	answerMessageId: string | null;
	decidedBy: string | null;
	decidedAt: string | null;
	createdAt: string;
	/**
	 * True while at least one `Await` call is blocked on this question.
	 *
	 * Derived from live in-memory state, not stored: see `awaitedQuestions`. Carried on
	 * the record so a client learns it from the list endpoint and the pushed event
	 * alike, rather than only from whichever one it happened to see.
	 */
	awaited: boolean;
}

/**
 * Upper bound on how many open questions one narrator may accumulate.
 *
 * Not a safety limit — a bound on the ASK. Past this many unanswered questions the
 * inbox has stopped being a place a user can realistically work through, so the tool
 * tells the agent to stop deferring and either decide itself or ask synchronously.
 * Creation still succeeds: silently dropping a question the agent believes it asked is
 * strictly worse than a crowded inbox.
 */
export const ASYNC_QUESTION_SOFT_LIMIT = 20;

/** Result of a terminal transition. `stale` means somebody else got there first. */
export type AsyncQuestionTransition =
	| { ok: true; record: AsyncQuestionRecord }
	| { ok: false; reason: "not_found" | "stale" };

// ─────────────────────────────────────────────────────────────────────────────
// Row projection
// ─────────────────────────────────────────────────────────────────────────────

type QuestionRow = typeof narratorQuestions.$inferSelect;

/**
 * Questions currently being awaited, by id → number of live waits.
 *
 * In memory rather than a column, and deliberately so: "somebody is blocked on this
 * right now" is a property of a live wait, not of the question. Persisting it would mean
 * a crash mid-wait leaves a row claiming an awaiter that no longer exists, and the UI
 * would show a permanent "the agent is waiting" badge nobody can clear. A restart drops
 * the waits along with the loops that owned them, which is correct: the question
 * survives, the wait does not.
 *
 * A COUNT rather than a flag: two turns can legitimately await the same question (a
 * retried Await after a timeout, or a subagent and its parent), and a plain flag would
 * let the first one to finish clear the badge while the second is still blocked.
 *
 * Declared here, above `toRecord`, because that projection reads it — the alternative
 * relied on the map being initialized before any row is projected, which is true today
 * but only by accident of call ordering.
 */
const awaitedQuestions = hotSafe(
	"narrafork:awaitedAsyncQuestions",
	() => new Map<string, number>(),
);

/** True while at least one `Await` call is blocked on this question. */
export function isAsyncQuestionAwaited(questionId: string): boolean {
	return (awaitedQuestions.get(questionId) ?? 0) > 0;
}

/** All awaited question ids, for list / inbox projections. */
export function listAwaitedAsyncQuestionIds(): string[] {
	return [...awaitedQuestions.keys()];
}

/**
 * Read `questions_json` back defensively.
 *
 * The column is written from validated tool input, but a row can also be older than a
 * shape change. A malformed payload must not throw inside a list request that other,
 * healthy questions are part of, so the bad row degrades to "no questions" (the UI
 * shows it as unanswerable) rather than failing the whole page.
 */
function coerceDefinitions(value: unknown): AsyncQuestionDefinition[] {
	if (!Array.isArray(value)) return [];
	const out: AsyncQuestionDefinition[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object") continue;
		const item = raw as Record<string, unknown>;
		const key = typeof item.question === "string" ? item.question : "";
		const header = typeof item.header === "string" ? item.header : "";
		if (!key || !header) continue;
		out.push({
			question: key,
			header,
			...(typeof item.multiSelect === "boolean" ? { multiSelect: item.multiSelect } : {}),
			options: Array.isArray(item.options)
				? item.options.flatMap((opt) => {
						if (!opt || typeof opt !== "object") return [];
						const o = opt as Record<string, unknown>;
						if (typeof o.label !== "string" || !o.label) return [];
						return [
							{
								label: o.label,
								...(typeof o.description === "string" ? { description: o.description } : {}),
								...(typeof o.preview === "string" ? { preview: o.preview } : {}),
							},
						];
					})
				: [],
		});
	}
	return out;
}

function coerceAnswers(value: unknown): Record<string, string> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const out: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (typeof raw === "string") out[key] = raw;
		// Multi-select answers may have been stored as arrays by an older client.
		else if (Array.isArray(raw)) out[key] = raw.filter((v) => typeof v === "string").join(", ");
	}
	return Object.keys(out).length > 0 ? out : null;
}

function coerceAnnotations(value: unknown): Record<string, AsyncQuestionAnnotation> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const out: Record<string, AsyncQuestionAnnotation> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (!raw || typeof raw !== "object") continue;
		const item = raw as Record<string, unknown>;
		const entry: AsyncQuestionAnnotation = {};
		if (typeof item.preview === "string") entry.preview = item.preview;
		if (typeof item.notes === "string") entry.notes = item.notes;
		if (Object.keys(entry).length > 0) out[key] = entry;
	}
	return Object.keys(out).length > 0 ? out : null;
}

function toRecord(row: Omit<QuestionRow, "executionPrincipalJson">): AsyncQuestionRecord {
	return {
		id: row.id,
		narratorId: row.narratorId,
		toolCallId: row.toolCallId,
		toolUseId: row.toolUseId,
		questions: coerceDefinitions(row.questionsJson),
		answers: coerceAnswers(row.answersJson),
		annotations: coerceAnnotations(row.annotationsJson),
		status: row.status,
		origin: row.origin,
		answerMessageId: row.answerMessageId,
		decidedBy: row.decidedBy,
		decidedAt: row.decidedAt,
		createdAt: row.createdAt,
		awaited: isAsyncQuestionAwaited(row.id),
	};
}

/**
 * Announce a state change to the narrator's subscribers.
 *
 * Routed through the seam (rather than importing `broadcastToNarrator` at the call
 * site) so a test can observe it without module-mocking the websocket layer — see
 * `QuestionServiceSeam` for what that mock did to unrelated suites.
 */
async function broadcastChange(
	record: AsyncQuestionRecord,
	change: AsyncQuestionChange,
): Promise<void> {
	// Global discovery must not depend on a narrator subscription or successful local delivery.
	notifyHumanAttentionChanged();
	const seam = await resolveSeam();
	// `awaited` is re-read here rather than taken from `record`: a record captured before
	// the wait started (which is what the `awaited` / `await_ended` transitions carry)
	// would report the state from before the very transition being announced.
	const awaited = isAsyncQuestionAwaited(record.id);
	const event = {
		type: "async_question_changed" as const,
		narratorId: record.narratorId,
		change,
		question: { ...record, awaited },
		awaited,
	};
	seam.broadcastToNarrator(record.narratorId, event);
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, record.narratorId),
		columns: { variant: true, parentNarratorId: true },
	});
	if (narrator && isSubagentVariant(narrator.variant) && narrator.parentNarratorId) {
		// Parent visibility is an event about the child, never a synthetic user answer
		// in the parent's history. The actual answer remains owned by the child.
		seam.broadcastToNarrator(narrator.parentNarratorId, event);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Creation
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve question authority from persisted identity, never a model-supplied parent hint. */
export async function resolveNarratorQuestionPolicy(narratorId: string): Promise<RuntimePolicy> {
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { variant: true },
	});
	if (!narrator) throw new Error("Question narrator not found.");
	const subagentType = getSubagentType(narrator.variant);
	const builtin = ["explore", "plan", "review", "search", "general"];
	const customDefinition =
		subagentType && !builtin.includes(subagentType)
			? await customSubagentService.loadByName(subagentType)
			: undefined;
	return resolveRuntimePolicy({
		variant: isSubagentVariant(narrator.variant) ? "subagent" : "primary",
		subagentType: subagentType ?? undefined,
		customDefinition,
	});
}

export async function assertNarratorCanAskQuestion(
	narratorId: string,
	input: unknown,
): Promise<RuntimePolicy> {
	const policy = await resolveNarratorQuestionPolicy(narratorId);
	assertRuntimeCanAskQuestion(policy, input);
	return policy;
}

/** Exact question ownership is required; the snapshot is intentionally not in public records. */
export async function getAsyncQuestionExecutionPrincipal(
	questionId: string,
	narratorId: string,
): Promise<QuestionExecutionPrincipal | null> {
	const row = await db.query.narratorQuestions.findFirst({
		where: and(eq(narratorQuestions.id, questionId), eq(narratorQuestions.narratorId, narratorId)),
		columns: { executionPrincipalJson: true },
	});
	return parseQuestionExecutionPrincipal(row?.executionPrincipalJson);
}

export interface CreateAsyncQuestionArgs {
	narratorId: string;
	toolCallId: string;
	toolUseId: string;
	questions: AsyncQuestionDefinition[];
	origin?: AsyncQuestionOrigin;
	/** Trusted server execution snapshot; never inferred from answers or tool arguments. */
	executionPrincipal?: QuestionExecutionPrincipal;
}

/**
 * Record an asynchronous question, idempotently.
 *
 * A tool execution can be replayed (recovery, a retried call), and the unique index on
 * `tool_call_id` is what keeps that from producing a second question. Returning the
 * EXISTING row on conflict rather than throwing matters: the caller's job is to tell
 * the model "your question is recorded", which is true either way.
 */
export async function createAsyncQuestion(
	args: CreateAsyncQuestionArgs,
): Promise<{ record: AsyncQuestionRecord; created: boolean }> {
	await assertNarratorCanAskQuestion(args.narratorId, {
		async: true,
		questions: args.questions,
		...(args.origin === "user_deferred" ? { deferredByUser: true } : {}),
	});
	const call = await db.query.narratorToolCalls.findFirst({
		where: and(
			eq(narratorToolCalls.id, args.toolCallId),
			eq(narratorToolCalls.narratorId, args.narratorId),
			eq(narratorToolCalls.toolUseId, args.toolUseId),
			eq(narratorToolCalls.toolName, "AskUserQuestion"),
		),
		columns: { id: true },
	});
	if (!call) throw new Error("Question tool call does not belong to this narrator.");
	const existing = await db.query.narratorQuestions.findFirst({
		where: eq(narratorQuestions.toolCallId, args.toolCallId),
	});
	if (existing) return { record: toRecord(existing), created: false };

	const row = {
		id: generateId(),
		narratorId: args.narratorId,
		toolCallId: args.toolCallId,
		toolUseId: args.toolUseId,
		questionsJson: args.questions,
		executionPrincipalJson: parseQuestionExecutionPrincipal(args.executionPrincipal),
		answersJson: null,
		annotationsJson: null,
		status: "open" as const,
		origin: args.origin ?? ("agent_async" as const),
		answerMessageId: null,
		decidedBy: null,
		decidedAt: null,
		createdAt: new Date().toISOString(),
	};

	try {
		await db.insert(narratorQuestions).values(row);
	} catch (err) {
		// Lost the insert race against a concurrent replay of the same tool call: the
		// unique index did its job, so read the winner back instead of failing.
		const winner = await db.query.narratorQuestions.findFirst({
			where: eq(narratorQuestions.toolCallId, args.toolCallId),
		});
		if (winner) return { record: toRecord(winner), created: false };
		throw err;
	}

	const record = toRecord(row as QuestionRow);
	await broadcastChange(record, "opened");
	return { record, created: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

export interface ListAsyncQuestionsArgs {
	narratorId: string;
	status?: AsyncQuestionStatus;
	/** Keyset cursor: `createdAt|id` of the last row of the previous page. */
	cursor?: string;
	limit?: number;
}

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 100;

/**
 * List a narrator's questions, newest first.
 *
 * Keyset pagination with `LIMIT n + 1` and no `COUNT(*)`, per the main-thread SQLite
 * rules: a count would scan rows the caller never displays. `questions_json` is
 * bounded by the tool's own schema (at most 4 questions), so it is safe to return in
 * the list rather than deferring to a detail request.
 */
export async function listAsyncQuestions(args: ListAsyncQuestionsArgs): Promise<{
	items: AsyncQuestionRecord[];
	nextCursor: string | null;
}> {
	const limit = Math.min(Math.max(args.limit ?? LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT);
	const conditions = [eq(narratorQuestions.narratorId, args.narratorId)];
	if (args.status) conditions.push(eq(narratorQuestions.status, args.status));

	if (args.cursor) {
		const sep = args.cursor.lastIndexOf("|");
		if (sep > 0) {
			const createdAt = args.cursor.slice(0, sep);
			const id = args.cursor.slice(sep + 1);
			// Row-value comparison over (createdAt, id) — the same shape the index orders
			// by, so the seek stays a single descending walk.
			conditions.push(
				or(
					lt(narratorQuestions.createdAt, createdAt),
					and(eq(narratorQuestions.createdAt, createdAt), lt(narratorQuestions.id, id)),
				) as ReturnType<typeof eq>,
			);
		}
	}

	const rows = await db.query.narratorQuestions.findMany({
		where: and(...conditions),
		orderBy: [desc(narratorQuestions.createdAt), desc(narratorQuestions.id)],
		limit: limit + 1,
	});

	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	const last = page[page.length - 1];
	// AWAITED questions float to the front of the page: the agent is blocked on those,
	// so they are the ones worth answering first.
	//
	// Applied after paging, not as an ORDER BY, and that limit is deliberate: the flag
	// lives in memory (see `awaitedQuestions`), so SQL cannot see it. The cursor stays
	// keyed on `(createdAt, id)` — the stable, sortable pair — because ordering pages by
	// a value that changes while the user reads would let a question shift between pages
	// and be seen twice or not at all.
	const items = page.map(toRecord);
	items.sort((a, b) => {
		if (a.awaited !== b.awaited) return a.awaited ? -1 : 1;
		return b.createdAt.localeCompare(a.createdAt);
	});
	return {
		items,
		nextCursor: hasMore && last ? `${last.createdAt}|${last.id}` : null,
	};
}

/** How many questions are still open for this narrator (badge + soft-limit check). */
export async function countOpenAsyncQuestions(narratorId: string): Promise<number> {
	// A narrow `COUNT(*)` over the `(narrator_id, status)` index. The exception to the
	// no-count rule is deliberate: this is an index-only probe of a set the soft limit
	// keeps small, and the number itself is the product feature (the inbox badge).
	const [row] = await db
		.select({ n: sql<number>`count(*)` })
		.from(narratorQuestions)
		.where(and(eq(narratorQuestions.narratorId, narratorId), eq(narratorQuestions.status, "open")));
	return row?.n ?? 0;
}

export async function getAsyncQuestion(id: string): Promise<AsyncQuestionRecord | null> {
	const row = await db.query.narratorQuestions.findFirst({
		where: eq(narratorQuestions.id, id),
	});
	return row ? toRecord(row) : null;
}

/** Single-item lazy read. CASE prevents SQLite/Drizzle from materializing oversized JSON. */
export async function getBoundedOpenAsyncQuestion(
	id: string,
	maxBytes: number,
): Promise<{ record: AsyncQuestionRecord | null; tooLarge: boolean }> {
	const bytes = sql`coalesce(length(cast(${narratorQuestions.questionsJson} as blob)), 0)
		+ coalesce(length(cast(${narratorQuestions.answersJson} as blob)), 0)
		+ coalesce(length(cast(${narratorQuestions.annotationsJson} as blob)), 0)`;
	const bounded = (column: SQLWrapper) =>
		sql<string | null>`case when ${bytes} <= ${maxBytes} then ${column} else null end`;
	const row = await db
		.select({
			id: narratorQuestions.id,
			narratorId: narratorQuestions.narratorId,
			toolCallId: narratorQuestions.toolCallId,
			toolUseId: narratorQuestions.toolUseId,
			questionsJson: bounded(narratorQuestions.questionsJson),
			answersJson: bounded(narratorQuestions.answersJson),
			annotationsJson: bounded(narratorQuestions.annotationsJson),
			withinBudget: sql<number>`${bytes} <= ${maxBytes}`,
			status: narratorQuestions.status,
			origin: narratorQuestions.origin,
			answerMessageId: narratorQuestions.answerMessageId,
			decidedBy: narratorQuestions.decidedBy,
			decidedAt: narratorQuestions.decidedAt,
			createdAt: narratorQuestions.createdAt,
		})
		.from(narratorQuestions)
		.where(and(eq(narratorQuestions.id, id), eq(narratorQuestions.status, "open")))
		.limit(1)
		.get();
	if (!row) return { record: null, tooLarge: false };
	if (!row.withinBudget) return { record: null, tooLarge: true };
	const parse = (value: string | null): unknown => {
		try {
			return value === null ? null : JSON.parse(value);
		} catch {
			return null;
		}
	};
	return {
		record: toRecord({
			...row,
			questionsJson: parse(row.questionsJson),
			answersJson: parse(row.answersJson),
			annotationsJson: parse(row.annotationsJson),
		}),
		tooLarge: false,
	};
}

/** An open question plus the narrator context the global inbox needs to label it. */
export interface AsyncQuestionWithContext extends AsyncQuestionRecord {
	narratorTitle: string | null;
	chapterId: string | null;
}

/**
 * Every open question the caller may see, across all narrators.
 *
 * The cross-session view: a user runs several sessions and cannot be expected to open
 * each one to discover it is waiting on them. Awaited questions come first (an agent is
 * blocked on those), then newest.
 *
 * ## Bounded on purpose
 *
 * `HARD_LIMIT` caps the candidate scan, and the reason is the main-thread rule rather
 * than pagination taste: this runs on the same thread as every other request, ACL
 * filtering is per-row, and an unbounded `.all()` over a table that grows with every
 * question asked is exactly the shape that turns into "all requests hang". A user with
 * more than 200 waiting questions has a problem the inbox cannot solve anyway.
 */
export async function listAllOpenAsyncQuestionsForPrincipal(principal: {
	userId: string;
	isAdmin: boolean;
}): Promise<AsyncQuestionWithContext[]> {
	const HARD_LIMIT = 200;
	const rows = await db
		.select({
			question: narratorQuestions,
			narratorTitle: narrators.title,
			chapterId: narrators.chapterId,
			// The ACL columns, so the filter below needs no second query per row.
			narratorId: narrators.id,
			ownerUserId: narrators.ownerUserId,
			visibility: narrators.visibility,
			writeAudience: narrators.writeAudience,
			type: narrators.type,
			aclRootNarratorId: narrators.aclRootNarratorId,
			contextProjectId: narrators.contextProjectId,
		})
		.from(narratorQuestions)
		.innerJoin(narrators, eq(narratorQuestions.narratorId, narrators.id))
		.where(eq(narratorQuestions.status, "open"))
		.orderBy(desc(narratorQuestions.createdAt), desc(narratorQuestions.id))
		.limit(HARD_LIMIT);

	const { canReadNarrator } = await import("./narrator-acl");
	const visible: AsyncQuestionWithContext[] = [];
	for (const row of rows) {
		const allowed = await canReadNarrator(
			{
				id: row.narratorId,
				ownerUserId: row.ownerUserId,
				visibility: row.visibility,
				writeAudience: row.writeAudience,
				type: row.type,
				aclRootNarratorId: row.aclRootNarratorId,
				chapterId: row.chapterId,
				contextProjectId: row.contextProjectId,
			},
			principal,
		);
		if (!allowed) continue;
		visible.push({
			...toRecord(row.question),
			narratorTitle: row.narratorTitle,
			chapterId: row.chapterId,
		});
	}

	visible.sort((a, b) => {
		if (a.awaited !== b.awaited) return a.awaited ? -1 : 1;
		return b.createdAt.localeCompare(a.createdAt);
	});
	return visible;
}

// ─────────────────────────────────────────────────────────────────────────────
// Terminal transitions
// ─────────────────────────────────────────────────────────────────────────────

/** A lost decision race aborts the message transaction as well as the status update. */
class QuestionAlreadyDecidedError extends Error {
	constructor() {
		super("Question already decided");
	}
}

/**
 * Mirror the answers onto the historical tool call's stored input.
 *
 * This is what makes the answered card render with zero frontend work: the read-only
 * replay path already paints `inputJson.answers` for a synchronous AskUserQuestion, so
 * writing the same field means an async question's history looks identical.
 *
 * Failure is logged, never fatal: the answers are already committed on the question
 * row (which the inbox reads), so the worst case is a history card that shows the
 * question without its answer.
 */
async function mirrorAnswersToToolCall(
	toolCallId: string,
	answers: Record<string, string>,
	annotations: Record<string, AsyncQuestionAnnotation> | null,
): Promise<void> {
	try {
		const call = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.id, toolCallId),
			columns: { id: true, inputJson: true },
		});
		if (!call) return;
		const input =
			call.inputJson && typeof call.inputJson === "object" && !Array.isArray(call.inputJson)
				? (call.inputJson as Record<string, unknown>)
				: {};
		await db
			.update(narratorToolCalls)
			.set({
				inputJson: { ...input, answers, ...(annotations ? { annotations } : {}) },
			})
			.where(eq(narratorToolCalls.id, toolCallId));
	} catch (err) {
		logger.warn("Failed to mirror async question answers onto the tool call", {
			toolCallId,
			error: String(err),
		});
	}
}

/** Flatten one question's answer for the injected message. */
function buildAnswerItems(record: AsyncQuestionRecord): SideCarAsyncQuestionAnswer[] {
	const answers = record.answers ?? {};
	const items: SideCarAsyncQuestionAnswer[] = [];
	for (const question of record.questions) {
		const answer = answers[question.question];
		if (answer === undefined) continue;
		const notes = record.annotations?.[question.question]?.notes ?? null;
		items.push({ header: question.header, answer, ...(notes ? { notes } : {}) });
	}
	// Answers whose key matches no known question (a repaired/renamed key) still have
	// to reach the model: dropping them would silently discard something the user typed.
	for (const [key, answer] of Object.entries(answers)) {
		if (record.questions.some((q) => q.question === key)) continue;
		items.push({ header: key, answer });
	}
	return items;
}

/**
 * Deliver a decided question back into the conversation.
 *
 * `interject` while a loop is running, `wakeIfIdle` when it is not — the two halves of
 * "take this up promptly": a running loop is asked to stop at its next tool boundary
 * (it would otherwise not rebuild its history until the next pass), and an idle one is
 * started so the answer is not left sitting until the user happens to send something.
 *
 * Waking IS wanted here, unlike `file-edit-interject`'s deliberate no-wake: the user
 * just answered a question the agent asked, so acting on it is the whole point.
 */
async function deliverDecision(
	record: AsyncQuestionRecord,
	outcome: "answered" | "dismissed",
	locale: Locale,
	userId: string | null,
	seam: QuestionServiceSeam,
	onPersist: NonNullable<DeliverInjectionOptions["onPersist"]>,
): Promise<string> {
	const body: SideCarBody = {
		kind: "asyncQuestionAnswers",
		outcome,
		items:
			outcome === "answered"
				? buildAnswerItems(record)
				: record.questions.map((q) => ({ header: q.header, answer: "" })),
	};
	const { content } = sideCarBodyWithText("async_question", body, locale);
	const executionPrincipal = await getAsyncQuestionExecutionPrincipal(record.id, record.narratorId);
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, record.narratorId),
		columns: { variant: true },
	});
	const unknownChildPrincipal =
		!!narrator && isSubagentVariant(narrator.variant) && !executionPrincipal;
	if (unknownChildPrincipal)
		logger.warn(
			"Automatic wake withheld for legacy child question: execution principal is unknown",
			{ narratorId: record.narratorId, questionId: record.id },
		);

	const result = await seam.deliverInjection(record.narratorId, {
		content,
		source: "async_question",
		body,
		role: "user",
		schedule: unknownChildPrincipal
			? "none"
			: seam.isLoopRunning(record.narratorId)
				? "interject"
				: "wakeIfIdle",
		...(executionPrincipal ? { executionPrincipal } : {}),
		locale,
		createdBy: userId,
		onPersist,
	});
	if (!result.messageId) throw new Error("Async question delivery did not persist a message");
	return result.messageId;
}

/**
 * The collaborators this module reaches OUT to, as one replaceable seam.
 *
 * Same reasoning as `narrator-injection.ts`'s scheduler seam, and it covers delivery
 * and broadcast too rather than only the session probe — because `mock.module` is
 * PROCESS-wide in Bun. A test that replaces `narrator-injection` or `narrator-ws` to
 * observe this module hands that replacement to every later file in the same run;
 * doing exactly that broke 139 unrelated assertions (buffered messages, attachments)
 * whose suites legitimately use the real modules. A seam the test sets and restores
 * keeps the blast radius inside the test.
 */
export interface QuestionServiceSeam {
	isLoopRunning: (narratorId: string) => boolean;
	deliverInjection: typeof deliverInjection;
	broadcastToNarrator: typeof broadcastToNarrator;
	/**
	 * Raise / clear the semantic "this session needs the user" intent while a question
	 * is being awaited. `waiting_permission` is reused rather than coined anew: the
	 * situation is identical from the user's side (the agent is stalled on their input),
	 * and the notification, favicon and sound paths already key on that reason.
	 */
	emitAttention: (narratorId: string, reason: "waiting_permission") => void;
	emitAttentionResolved: (narratorId: string, reason: "waiting_permission") => void;
}

let serviceSeam: Partial<QuestionServiceSeam> | null = null;

export function setQuestionServiceSeam(
	next: Partial<QuestionServiceSeam> | null,
): Partial<QuestionServiceSeam> | null {
	const previous = serviceSeam;
	serviceSeam = next;
	return previous;
}

/** Resolve the seam, falling back to the real collaborators field by field. */
async function resolveSeam(): Promise<QuestionServiceSeam> {
	const session = serviceSeam?.isLoopRunning
		? { isLoopRunning: serviceSeam.isLoopRunning }
		: await import("./narrator-session");
	return {
		isLoopRunning: session.isLoopRunning,
		deliverInjection: serviceSeam?.deliverInjection ?? deliverInjection,
		broadcastToNarrator: serviceSeam?.broadcastToNarrator ?? broadcastToNarrator,
		emitAttention:
			serviceSeam?.emitAttention ??
			((narratorId, reason) => eventBus.emit({ type: "narrator:attention", narratorId, reason })),
		emitAttentionResolved:
			serviceSeam?.emitAttentionResolved ??
			((narratorId, reason) =>
				eventBus.emit({ type: "narrator:attention_resolved", narratorId, reason })),
	};
}

export interface AnswerAsyncQuestionArgs {
	answers: Record<string, string>;
	annotations?: Record<string, AsyncQuestionAnnotation> | null;
	userId?: string | null;
	locale?: Locale;
}

/** Answer an open question, committing the decision with its model-visible message. */
export async function answerAsyncQuestion(
	id: string,
	args: AnswerAsyncQuestionArgs,
): Promise<AsyncQuestionTransition> {
	return decideAsyncQuestion(id, "answered", args);
}

/** Dismissal is also a user instruction and must reach the model durably. */
export async function dismissAsyncQuestion(
	id: string,
	args: { userId?: string | null; locale?: Locale } = {},
): Promise<AsyncQuestionTransition> {
	return decideAsyncQuestion(id, "dismissed", args);
}

/**
 * No terminal state without a message: the conditional UPDATE runs in the message
 * writer's synchronous transaction, after the message and its history ref are inserted.
 * A failed insert or a lost answer/dismiss/withdraw race rolls everything back. A crash
 * cannot leave an answered question that the model has no history row for.
 */
async function decideAsyncQuestion(
	id: string,
	outcome: "answered" | "dismissed",
	args: Partial<AnswerAsyncQuestionArgs>,
): Promise<AsyncQuestionTransition> {
	const existing = await getAsyncQuestion(id);
	if (!existing) return { ok: false, reason: "not_found" };
	if (existing.status !== "open") return { ok: false, reason: "stale" };
	const decided: AsyncQuestionRecord = {
		...existing,
		status: outcome,
		answers: outcome === "answered" ? (args.answers ?? null) : null,
		annotations: args.annotations ?? null,
		decidedBy: args.userId ?? null,
		decidedAt: new Date().toISOString(),
	};
	const seam = await resolveSeam();
	let persistedMessageId: string | null = null;
	try {
		decided.answerMessageId = await deliverDecision(
			decided,
			outcome,
			args.locale ?? "en",
			args.userId ?? null,
			seam,
			(tx, messageId) => {
				const claimed = tx
					.update(narratorQuestions)
					.set({
						status: outcome,
						answersJson: decided.answers,
						annotationsJson: decided.annotations,
						decidedBy: decided.decidedBy,
						decidedAt: decided.decidedAt,
						answerMessageId: messageId,
					})
					.where(and(eq(narratorQuestions.id, id), eq(narratorQuestions.status, "open")))
					.returning({ id: narratorQuestions.id })
					.get();
				if (!claimed) throw new QuestionAlreadyDecidedError();
				persistedMessageId = messageId;
			},
		);
	} catch (error) {
		if (error instanceof QuestionAlreadyDecidedError) {
			return { ok: false, reason: "stale" };
		}
		// Enrichment/broadcast can fail AFTER the transaction commits. Only this exact
		// message id proves our decision is durable; a concurrent winner is not ours.
		const stored = persistedMessageId ? await getAsyncQuestion(id) : null;
		if (!stored?.answerMessageId || stored.answerMessageId !== persistedMessageId) throw error;
		decided.answerMessageId = stored.answerMessageId;
		logger.warn("Async question committed but post-delivery notification failed", {
			questionId: id,
			error: String(error),
		});
	}
	if (decided.answers) {
		await mirrorAnswersToToolCall(decided.toolCallId, decided.answers, decided.annotations);
	}
	try {
		await broadcastChange(decided, outcome);
	} catch (error) {
		logger.warn("Failed to broadcast committed async question decision", {
			questionId: id,
			error: String(error),
		});
	}
	notifyQuestionDecided(decided);
	return { ok: true, record: decided };
}

/**
 * Withdraw questions the AGENT no longer needs answered.
 *
 * Scoped to the calling narrator's own rows: a withdraw is the agent tidying up after
 * itself, never a way to reach another session's inbox. No message is delivered — the
 * agent already knows, and the user does not need a notification that a question they
 * had not answered went away (the inbox simply stops showing it).
 */
export async function withdrawAsyncQuestions(
	narratorId: string,
	ids: string[],
): Promise<{ withdrawn: string[]; skipped: string[] }> {
	const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
	if (unique.length === 0) return { withdrawn: [], skipped: [] };

	const rows = await db
		.update(narratorQuestions)
		.set({ status: "withdrawn", decidedBy: "agent", decidedAt: new Date().toISOString() })
		.where(
			and(
				eq(narratorQuestions.narratorId, narratorId),
				eq(narratorQuestions.status, "open"),
				inArray(narratorQuestions.id, unique),
			),
		)
		.returning();

	const withdrawn = new Set<string>();
	for (const row of rows) {
		const record = toRecord(row);
		withdrawn.add(record.id);
		await broadcastChange(record, "withdrawn");
		// A withdraw also ends a wait: the agent that withdrew may not be the one
		// blocked on it (a withdraw can arrive from a later turn), and leaving that
		// waiter parked until its timeout would strand it on a question that is gone.
		notifyQuestionDecided(record);
	}
	return {
		withdrawn: [...withdrawn],
		skipped: unique.filter((id) => !withdrawn.has(id)),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Awaiting a decision
// ─────────────────────────────────────────────────────────────────────────────

function retainAwait(questionId: string): void {
	awaitedQuestions.set(questionId, (awaitedQuestions.get(questionId) ?? 0) + 1);
}

function releaseAwait(questionId: string): void {
	const next = (awaitedQuestions.get(questionId) ?? 0) - 1;
	if (next > 0) awaitedQuestions.set(questionId, next);
	else awaitedQuestions.delete(questionId);
}

export type AwaitQuestionStatus = "answered" | "dismissed" | "withdrawn" | "timeout" | "aborted";

export interface AwaitAsyncQuestionResult {
	status: AwaitQuestionStatus;
	record: AsyncQuestionRecord;
}

/**
 * Block until an open question is decided.
 *
 * ## Why this changes what the question MEANS
 *
 * An unawaited async question is explicitly not urgent — that is the whole feature, and
 * why it raises no attention and leaves the narrator out of `waiting`. The moment the
 * agent awaits one, that stops being true: it is now stalled on the user exactly like a
 * blocking prompt. So a wait raises `narrator:attention` (the same intent a permission
 * request uses, so the existing notification/favicon/sound path picks it up) and clears
 * it on the way out.
 *
 * Not reused: `narrator.status = "waiting"`. That field is owned by the permission gate
 * and read by consumers that assume an in-memory pending permission exists for it (the
 * composer send gate, the Enter-key binding, the pending-permission REST fallback). An
 * awaited question has no such row, so borrowing the status would make those paths
 * reference a request that does not exist.
 *
 * A timeout ends the WAIT, never the question: the row stays open, and the agent is told
 * it may await again — same contract as a background bash task.
 */
export async function awaitAsyncQuestion(opts: {
	questionId: string;
	narratorId: string;
	timeoutMs: number;
	signal?: AbortSignal;
	/** Distinguishes "the wait timed out" from "the parent was interrupted". */
	timeoutSignal?: AbortSignal;
}): Promise<AwaitAsyncQuestionResult | { status: "not_found" }> {
	const { questionId, narratorId, timeoutMs, signal, timeoutSignal } = opts;
	const existing = await getAsyncQuestion(questionId);
	if (!existing || existing.narratorId !== narratorId) return { status: "not_found" };
	// Already decided → answer immediately. A wait here could only time out, because the
	// event that would end it has already fired.
	if (existing.status !== "open") {
		return { status: existing.status as AwaitQuestionStatus, record: existing };
	}

	if (signal?.aborted || timeoutSignal?.aborted) {
		return { status: signal?.aborted ? "aborted" : "timeout", record: existing };
	}
	const seam = await resolveSeam();
	retainAwait(questionId);
	try {
		// Announce urgency before the attention intent, with cleanup covering both.
		await broadcastChange(existing, "awaited");
		seam.emitAttention(narratorId, "waiting_permission");
		return await new Promise<AwaitAsyncQuestionResult>((resolve, reject) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (result: AwaitAsyncQuestionResult) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(result);
			};

			const onDecided = (event: { questionId: string; record: AsyncQuestionRecord }) => {
				if (event.questionId !== questionId) return;
				finish({
					status: event.record.status as AwaitQuestionStatus,
					record: event.record,
				});
			};

			const onAbort = () => {
				// A parent interrupt and our own timeout arrive on different signals so the
				// two can be reported differently: the agent should keep waiting after a
				// timeout, but must not after being interrupted.
				const timedOut = timeoutSignal?.aborted === true && signal?.aborted !== true;
				finish({
					status: timedOut ? "timeout" : "aborted",
					record: existing,
				});
			};

			const cleanup = () => {
				if (timer !== undefined) clearTimeout(timer);
				questionDecidedListeners.delete(onDecided);
				signal?.removeEventListener("abort", onAbort);
				timeoutSignal?.removeEventListener("abort", onAbort);
			};

			questionDecidedListeners.add(onDecided);
			signal?.addEventListener("abort", onAbort, { once: true });
			timeoutSignal?.addEventListener("abort", onAbort, { once: true });
			// Abort events are not replayed to late listeners. Re-check after registering
			// to cover cancellation during the async reads/broadcast above.
			if (signal?.aborted || timeoutSignal?.aborted) {
				onAbort();
				return;
			}

			// Guard against a decision that landed between the status read above and the
			// listener registration: without this the wait would hang until its timeout on
			// a question that is already answered.
			void getAsyncQuestion(questionId)
				.then((fresh) => {
					if (fresh && fresh.status !== "open") {
						finish({ status: fresh.status as AwaitQuestionStatus, record: fresh });
					}
				})
				.catch((error) => {
					if (settled) return;
					settled = true;
					cleanup();
					reject(error);
				});

			if (timeoutMs > 0 && !timeoutSignal) {
				// Only used by callers that did not bring their own reschedulable deadline
				// (the Await tool does). Kept so the primitive is usable on its own.
				timer = setTimeout(() => finish({ status: "timeout", record: existing }), timeoutMs);
			}
		});
	} finally {
		releaseAwait(questionId);
		seam.emitAttentionResolved(narratorId, "waiting_permission");
		// Re-broadcast so the inbox drops the "agent is waiting" flag even when the wait
		// ended without a decision (timeout / interrupt).
		const latest = (await getAsyncQuestion(questionId)) ?? existing;
		if (latest.status === "open") await broadcastChange(latest, "await_ended");
	}
}

/**
 * In-process listeners for "this question was decided".
 *
 * A local set rather than the shared `eventBus`: the payload is a full question record,
 * and the bus's event union is a cross-service contract that external integrations also
 * consume. Nothing outside this module needs to observe a decision — the WS broadcast
 * already covers clients — so a private notifier keeps the bus free of an event with no
 * second consumer.
 */
type QuestionDecidedListener = (event: { questionId: string; record: AsyncQuestionRecord }) => void;

const questionDecidedListeners = hotSafe(
	"narrafork:asyncQuestionDecidedListeners",
	() => new Set<QuestionDecidedListener>(),
);

/** Wake any waiter blocked on this question. Never throws into the decision path. */
function notifyQuestionDecided(record: AsyncQuestionRecord): void {
	for (const listener of [...questionDecidedListeners]) {
		try {
			listener({ questionId: record.id, record });
		} catch (err) {
			logger.warn("Async question waiter threw while being notified", {
				questionId: record.id,
				error: String(err),
			});
		}
	}
}
