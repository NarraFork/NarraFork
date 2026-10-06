import {
	HUMAN_ATTENTION_DEFAULT_PAGE_SIZE,
	HUMAN_ATTENTION_DETAIL_MAX_BYTES,
	HUMAN_ATTENTION_MAX_PAGE_SIZE,
	type HumanAttentionItem,
	type HumanAttentionPage,
} from "@shared/human-attention";
import { and, eq, type SQLWrapper, sql } from "drizzle-orm";
import { db } from "../db";
import { narratorQuestions, narrators, narratorToolCalls } from "../db/schema";
import {
	getTaskReflectionAwaitingUser,
	iterateTaskReflectionsAwaitingUser,
} from "../lib/agent/tools/task-reflection";
import { NotFoundError, ValidationError } from "../lib/errors";
import { logger } from "../lib/logger";
import {
	type ApiExecutionTarget,
	toolCallWithExecutionTargets,
} from "../lib/tool-execution-target-projection";
import { canWriteNarrator, type NarratorPrincipal, narratorReadableWhere } from "./narrator-acl";
import {
	type AsyncQuestionRecord,
	getBoundedOpenAsyncQuestion,
	isAsyncQuestionAwaited,
	listAwaitedAsyncQuestionIds,
} from "./narrator-question-service";
import { pendingDangerReflections, pendingPermissions } from "./narrator-session-state";

const SUMMARY_CHARS = 240;
const TITLE_CHARS = 160;
const CANDIDATE_BUDGET = 400;
const LIST_TIME_BUDGET_MS = 2_000;
const CURSOR_MAX_CHARS = 1_024;

/** Structurally compatible with the UI's PendingPermission, without importing frontend code. */
export interface HumanAttentionPermission {
	id: string;
	toolName: string;
	toolUseId: string;
	ownerNarratorId: string;
	parentToolUseId?: string | null;
	subagentNarratorId?: string | null;
	inputJson: Record<string, unknown>;
	decisionReason?: string;
	suggestions?: unknown[];
	executionDeviceId?: string | null;
	executionCwd?: string | null;
	resolvedFilePath?: string | null;
	executionTarget?: ApiExecutionTarget | null;
	executionTargets?: ApiExecutionTarget[];
	executionPlan?: Record<string, unknown> | null;
	deviceSelectionSource?: "explicit" | "session_default" | "local_default" | null;
	reflectionDeadline?: number;
}

export interface HumanAttentionDetail {
	item: HumanAttentionItem;
	question?: AsyncQuestionRecord;
	permission?: HumanAttentionPermission;
	/** Never accompanied by a partially readable/approvable payload. */
	tooLarge?: boolean;
}

type Cursor =
	| { v: 1; phase: "live"; after: string }
	| { v: 1; phase: "questions"; narratorId: string; questionId: string };

function encodeCursor(cursor: Cursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value?: string): Cursor {
	if (!value) return { v: 1, phase: "live", after: "" };
	if (value.length <= CURSOR_MAX_CHARS && /^[A-Za-z0-9_-]+$/.test(value)) {
		try {
			const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
			if (parsed && typeof parsed === "object") {
				const c = parsed as Record<string, unknown>;
				const key = (v: unknown): v is string => typeof v === "string" && v.length <= 256;
				if (c.v === 1 && c.phase === "live" && key(c.after)) {
					return { v: 1, phase: "live", after: c.after };
				}
				if (c.v === 1 && c.phase === "questions" && key(c.narratorId) && key(c.questionId)) {
					return { v: 1, phase: "questions", narratorId: c.narratorId, questionId: c.questionId };
				}
			}
		} catch {
			/* Invalid cursors never silently restart at the first page. */
		}
	}
	throw new ValidationError("Invalid human attention cursor");
}

function parseId(id: string): { source: "question" | "permission"; requestId: string } | null {
	const match = /^(question|permission):([A-Za-z0-9_-]{1,200})$/.exec(id);
	return match
		? { source: match[1] as "question" | "permission", requestId: match[2] as string }
		: null;
}

const narratorColumns = {
	id: narrators.id,
	title: sql<string | null>`substr(${narrators.title}, 1, ${TITLE_CHARS})`,
	parentNarratorId: narrators.parentNarratorId,
	aclRootNarratorId: narrators.aclRootNarratorId,
	chapterId: narrators.chapterId,
	contextProjectId: narrators.contextProjectId,
	type: narrators.type,
	ownerUserId: narrators.ownerUserId,
	visibility: narrators.visibility,
	writeAudience: narrators.writeAudience,
};

async function loadNarrator(narratorId: string, principal: NarratorPrincipal) {
	return db
		.select(narratorColumns)
		.from(narrators)
		.where(and(eq(narrators.id, narratorId), narratorReadableWhere(principal)))
		.limit(1)
		.get();
}

type VisibleNarrator = {
	row: NonNullable<Awaited<ReturnType<typeof loadNarrator>>>;
	canAct: boolean;
};

/** One read check and at most one write check per owner per request (not per item). */
function requestContext(principal: NarratorPrincipal, signal?: AbortSignal) {
	const narratorsById = new Map<string, Promise<VisibleNarrator | null>>();
	const started = performance.now();
	return {
		started,
		check() {
			signal?.throwIfAborted();
		},
		expired() {
			return performance.now() - started >= LIST_TIME_BUDGET_MS;
		},
		narrator(id: string) {
			let cached = narratorsById.get(id);
			if (!cached) {
				cached = (async () => {
					const row = await loadNarrator(id, principal);
					if (!row) return null;
					return { row, canAct: await canWriteNarrator(row, principal) };
				})();
				narratorsById.set(id, cached);
			}
			return cached;
		},
	};
}

type RequestContext = ReturnType<typeof requestContext>;

function baseItem(owner: VisibleNarrator) {
	return {
		narratorId: owner.row.id,
		narratorTitle: owner.row.title,
		parentNarratorId: owner.row.type === "subagent" ? owner.row.parentNarratorId : null,
		rootNarratorId: owner.row.type === "subagent" ? owner.row.aclRootNarratorId : null,
		chapterId: owner.row.chapterId,
		canAct: owner.canAct,
	};
}

/** Live references only; no input walking/copying and no status-based discovery. */
function livePermission(requestId: string) {
	const pending = pendingPermissions.get(requestId);
	if (pending) {
		if (pending.signal.aborted) return null;
		if (
			pending.toolName === "AskUserQuestion" &&
			pending.questionReflectionAbort &&
			!pending.questionReflectionStoppedByUser
		)
			return null;
		return {
			narratorId: pending.narratorId,
			toolCallId: requestId,
			toolUseId: pending.toolUseId,
			toolName: pending.toolName,
			parentToolUseId: pending.parentToolUseId,
			input: pending.input,
			kind:
				pending.toolName === "AskUserQuestion"
					? ("blocking_question" as const)
					: pending.toolName === "ExitPlanMode"
						? ("plan_approval" as const)
						: ("permission" as const),
			pending,
			reflection: undefined,
		};
	}
	const danger = pendingDangerReflections.get(requestId);
	if (danger?.reflectionStoppedByUser) {
		return {
			...danger,
			kind: "reflection" as const,
			pending: undefined,
			reflection: {
				type: "danger_reflection",
				status: "awaiting_user",
				requestId,
				danger: danger.danger,
			},
		};
	}
	const task = getTaskReflectionAwaitingUser(requestId);
	if (task) {
		return {
			...task,
			input: task.inputJson,
			kind: "reflection" as const,
			pending: undefined,
			reflection: {
				type: "task_reflection",
				status: "awaiting_user",
				requestId,
				mutations: task.mutations,
			},
		};
	}
	// exit_plan_* is deliberately absent: takeover creates a REAL ExitPlanMode permission.
	return null;
}

type LivePermission = NonNullable<ReturnType<typeof livePermission>>;

function stillLive(requestId: string, expected: LivePermission): boolean {
	const current = livePermission(requestId);
	return (
		!!current &&
		current.narratorId === expected.narratorId &&
		current.toolUseId === expected.toolUseId &&
		current.toolCallId === expected.toolCallId &&
		current.input === expected.input &&
		current.kind === expected.kind
	);
}

/** Bounded memory selection over the live registries; historical rows are never enumerated. */
function liveIdsAfter(after: string): string[] {
	const ids: string[] = [];
	const insert = (id: string) => {
		if (id <= after) return;
		let lo = 0;
		let hi = ids.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if ((ids[mid] ?? "") < id) lo = mid + 1;
			else hi = mid;
		}
		if (ids[lo] === id || lo > CANDIDATE_BUDGET) return;
		ids.splice(lo, 0, id);
		if (ids.length > CANDIDATE_BUDGET + 1) ids.pop();
	};
	for (const [id, pending] of pendingPermissions) {
		if (
			!pending.signal.aborted &&
			!(
				pending.toolName === "AskUserQuestion" &&
				pending.questionReflectionAbort &&
				!pending.questionReflectionStoppedByUser
			)
		)
			insert(`permission:${id}`);
	}
	for (const [id, pending] of pendingDangerReflections) {
		if (pending.reflectionStoppedByUser) insert(`permission:${id}`);
	}
	for (const pending of iterateTaskReflectionsAwaitingUser())
		insert(`permission:${pending.requestId}`);
	for (const id of listAwaitedAsyncQuestionIds()) insert(`question:${id}`);
	return ids;
}

const toolColumns = {
	id: narratorToolCalls.id,
	narratorId: narratorToolCalls.narratorId,
	toolUseId: narratorToolCalls.toolUseId,
	toolName: narratorToolCalls.toolName,
	createdAt: sql<string>`substr(coalesce(${narratorToolCalls.permissionStartedAt}, ${narratorToolCalls.createdAt}), 1, 40)`,
	summary: sql<
		string | null
	>`substr(${narratorToolCalls.permissionDecisionReason}, 1, ${SUMMARY_CHARS})`,
};

async function permissionItem(requestId: string, context: RequestContext) {
	const live = livePermission(requestId);
	if (!live) return null;
	const owner = await context.narrator(live.narratorId);
	if (!owner) return null;
	const row = await db
		.select(toolColumns)
		.from(narratorToolCalls)
		.where(
			and(
				live.toolCallId ? eq(narratorToolCalls.id, live.toolCallId) : undefined,
				eq(narratorToolCalls.narratorId, live.narratorId),
				eq(narratorToolCalls.toolUseId, live.toolUseId),
				eq(narratorToolCalls.toolName, live.toolName),
				eq(narratorToolCalls.status, "pending"),
			),
		)
		.limit(1)
		.get();
	if (!row || !stillLive(requestId, live)) return null;
	const item: HumanAttentionItem = {
		...baseItem(owner),
		id: `permission:${requestId}`,
		source: "permission",
		requestId,
		toolCallId: row.id,
		toolName: row.toolName,
		kind: live.kind,
		createdAt: row.createdAt,
		blocking: true,
		// Only stored context belongs here; generic labels are localized by the client.
		summary: row.summary ?? "",
	};
	return { item, live, owner };
}

type QuestionSummary = { id: string; narratorId: string; toolCallId: string; createdAt: string };
const questionColumns = {
	id: narratorQuestions.id,
	narratorId: narratorQuestions.narratorId,
	toolCallId: narratorQuestions.toolCallId,
	createdAt: narratorQuestions.createdAt,
};

async function questionItem(
	row: QuestionSummary,
	context: RequestContext,
): Promise<HumanAttentionItem | null> {
	const owner = await context.narrator(row.narratorId);
	if (!owner) return null;
	const blocking = isAsyncQuestionAwaited(row.id);
	return {
		...baseItem(owner),
		id: `question:${row.id}`,
		kind: "async_question",
		source: "question",
		requestId: row.id,
		toolCallId: row.toolCallId,
		toolName: "AskUserQuestion",
		createdAt: row.createdAt,
		blocking,
		// Do not put English-only interface copy into a locale-independent projection.
		summary: "",
	};
}

async function readQuestionSummary(id: string) {
	return db
		.select(questionColumns)
		.from(narratorQuestions)
		.where(and(eq(narratorQuestions.id, id), eq(narratorQuestions.status, "open")))
		.limit(1)
		.get();
}

/**
 * CROSS JOIN fixes the loop order. The existing (narrator_id,status) index probes only
 * open questions of readable narrators; neither JSON bodies nor historical questions
 * are scanned. Sorting the right side of the join is limited to one owner's OPEN set.
 */
function questionPageQuery(
	principal: NarratorPrincipal,
	cursor: Extract<Cursor, { phase: "questions" }>,
	limit: number,
) {
	return sql`select ${narratorQuestions.id} as id, ${narratorQuestions.narratorId} as narratorId,
		${narratorQuestions.toolCallId} as toolCallId, ${narratorQuestions.createdAt} as createdAt
		from ${narrators} cross join ${narratorQuestions} indexed by idx_narrator_questions_narrator_status
		where ${narratorQuestions.narratorId} = ${narrators.id}
			and ${narratorQuestions.status} = 'open'
			and ${narrators.id} >= ${cursor.narratorId}
			and (${narrators.id} > ${cursor.narratorId} or ${narratorQuestions.id} > ${cursor.questionId})
			and ${narratorReadableWhere(principal) ?? sql`1`}
		order by ${narrators.id}, ${narratorQuestions.id} limit ${limit}`;
}

/**
 * Live human gates (including awaited async questions) precede ordinary async inbox
 * rows. Stable ID keysets, not offset or narrator.status, define each phase. Cursors
 * are not snapshots: a change event/reconnect starts a fresh traversal.
 *
 * SQL work is capped at 400 candidates and 2s of cooperative work per call. A short
 * or empty page can therefore have nextCursor; this resumes AFTER the checked hidden
 * or stale candidates instead of letting another user's first 200 hide your inbox.
 */
export async function listHumanAttentionForPrincipal(
	principal: NarratorPrincipal,
	options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<HumanAttentionPage> {
	const limit = Number.isFinite(options.limit)
		? Math.max(1, Math.min(HUMAN_ATTENTION_MAX_PAGE_SIZE, Math.floor(options.limit ?? 0)))
		: HUMAN_ATTENTION_DEFAULT_PAGE_SIZE;
	let cursor = decodeCursor(options.cursor);
	const context = requestContext(principal, options.signal);
	context.check();
	const entries: { item: HumanAttentionItem; cursor: Cursor }[] = [];
	let checked = 0;
	const finish = (more: boolean): HumanAttentionPage => {
		const page = entries.slice(0, limit);
		const resume = entries.length > limit ? page.at(-1)?.cursor : cursor;
		return {
			items: page.map((entry) => entry.item),
			nextCursor: more && resume ? encodeCursor(resume) : null,
		};
	};
	try {
		if (cursor.phase === "live") {
			const ids = liveIdsAfter(cursor.after);
			for (const id of ids) {
				context.check();
				if (checked >= CANDIDATE_BUDGET || context.expired()) return finish(true);
				checked++;
				cursor = { v: 1, phase: "live", after: id };
				const parsed = parseId(id);
				if (!parsed) continue;
				let item: HumanAttentionItem | null;
				if (parsed.source === "permission") {
					item = (await permissionItem(parsed.requestId, context))?.item ?? null;
				} else {
					const row = await readQuestionSummary(parsed.requestId);
					item = row && isAsyncQuestionAwaited(row.id) ? await questionItem(row, context) : null;
				}
				if (item) entries.push({ item, cursor });
				if (entries.length > limit) return finish(true);
			}
			cursor = { v: 1, phase: "questions", narratorId: "", questionId: "" };
		}
		while (true) {
			context.check();
			if (checked >= CANDIDATE_BUDGET || context.expired()) return finish(true);
			const take = Math.min(CANDIDATE_BUDGET - checked, limit + 1 - entries.length);
			const rows: QuestionSummary[] = db.all<QuestionSummary>(
				questionPageQuery(principal, cursor, take),
			);
			for (const row of rows) {
				context.check();
				checked++;
				cursor = { v: 1, phase: "questions", narratorId: row.narratorId, questionId: row.id };
				if (isAsyncQuestionAwaited(row.id)) continue;
				const item = await questionItem(row, context);
				if (item) entries.push({ item, cursor });
				if (entries.length > limit) return finish(true);
			}
			if (rows.length < take) return finish(false);
		}
	} finally {
		const elapsedMs = performance.now() - context.started;
		if (elapsedMs > 250)
			logger.warn("Slow human attention list", { elapsedMs: Math.round(elapsedMs), checked });
	}
}

/**
 * Copy only bounded JSON data. Never stringify a huge input to find out it is huge.
 * String escaping is counted before copying; depth/node caps also reject cyclic,
 * exotic or excessively fragmented inputs. A refusal returns NO partial decision.
 */
function boundedJsonCopy<T>(value: T): { value: T } | null {
	let remaining = HUMAN_ATTENTION_DETAIL_MAX_BYTES;
	let nodes = 32_768;
	const ancestors = new Set<object>();
	const spend = (bytes: number) => {
		remaining -= bytes;
		if (remaining < 0) throw new Error("Detail budget exceeded");
	};
	const string = (text: string) => {
		if (text.length > remaining) throw new Error("Detail budget exceeded");
		spend(2);
		for (let i = 0; i < text.length; i++) {
			const c = text.charCodeAt(i);
			if (c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c)) spend(2);
			else if (c < 32) spend(6);
			else if (c < 128) spend(1);
			else if (c < 2048) spend(2);
			else if (
				c >= 0xd800 &&
				c <= 0xdbff &&
				text.charCodeAt(i + 1) >= 0xdc00 &&
				text.charCodeAt(i + 1) <= 0xdfff
			) {
				spend(4);
				i++;
			} else if (c >= 0xd800 && c <= 0xdfff) spend(6);
			else spend(3);
		}
		return text;
	};
	const copy = (input: unknown, depth: number): unknown => {
		if (--nodes < 0 || depth > 64) throw new Error("Detail structure budget exceeded");
		if (input === null) {
			spend(4);
			return null;
		}
		if (typeof input === "string") return string(input);
		if (typeof input === "boolean") {
			spend(input ? 4 : 5);
			return input;
		}
		if (typeof input === "number") {
			const n = Number.isFinite(input) ? input : null;
			spend(n === null ? 4 : String(n).length);
			return n;
		}
		if (typeof input !== "object" || ancestors.has(input)) throw new Error("Not plain JSON");
		const array = Array.isArray(input);
		if (
			!array &&
			Object.getPrototypeOf(input) !== Object.prototype &&
			Object.getPrototypeOf(input) !== null
		)
			throw new Error("Not plain JSON");
		ancestors.add(input);
		spend(2);
		if (array) {
			if (input.length > remaining + 1) throw new Error("Detail budget exceeded");
			const out: unknown[] = [];
			for (let i = 0; i < input.length; i++) {
				if (i) spend(1);
				out.push(copy(input[i] === undefined ? null : input[i], depth + 1));
			}
			ancestors.delete(input);
			return out;
		}
		const out: Record<string, unknown> = {};
		let first = true;
		for (const key in input) {
			if (!Object.hasOwn(input, key)) continue;
			const descriptor = Object.getOwnPropertyDescriptor(input, key);
			if (!descriptor || descriptor.get || descriptor.set) throw new Error("Not plain JSON");
			if (descriptor.value === undefined) continue;
			if (!first) spend(1);
			first = false;
			string(key);
			spend(1);
			Object.defineProperty(out, key, {
				value: copy(descriptor.value, depth + 1),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		ancestors.delete(input);
		return out;
	};
	try {
		return { value: copy(value, 0) as T };
	} catch {
		return null;
	}
}

function safeJson(value: string | null): unknown {
	try {
		return value === null ? null : JSON.parse(value);
	} catch {
		return null;
	}
}

async function permissionDetail(
	item: HumanAttentionItem,
	live: LivePermission,
	owner: VisibleNarrator,
): Promise<HumanAttentionDetail> {
	const jsonBytes = sql`coalesce(length(cast(${narratorToolCalls.permissionSuggestions} as blob)), 0)
		+ coalesce(length(cast(${narratorToolCalls.executionTargetsJson} as blob)), 0)
		+ coalesce(length(cast(${narratorToolCalls.permissionDecisionReason} as blob)), 0)
		+ coalesce(length(cast(${narratorToolCalls.executionDeviceId} as blob)), 0)
		+ coalesce(length(cast(${narratorToolCalls.executionCwd} as blob)), 0)
		+ coalesce(length(cast(${narratorToolCalls.resolvedFilePath} as blob)), 0)
		+ coalesce(length(cast(${narratorToolCalls.canonicalFilePath} as blob)), 0)`;
	const bounded = (column: SQLWrapper) =>
		sql<
			string | null
		>`case when ${jsonBytes} <= ${HUMAN_ATTENTION_DETAIL_MAX_BYTES} then ${column} else null end`;
	const row = await db
		.select({
			withinBudget: sql<number>`${jsonBytes} <= ${HUMAN_ATTENTION_DETAIL_MAX_BYTES}`,
			suggestions: bounded(narratorToolCalls.permissionSuggestions),
			targets: bounded(narratorToolCalls.executionTargetsJson),
			decisionReason: bounded(narratorToolCalls.permissionDecisionReason),
			executionDeviceId: bounded(narratorToolCalls.executionDeviceId),
			executionCwd: bounded(narratorToolCalls.executionCwd),
			executionPathFlavor: narratorToolCalls.executionPathFlavor,
			resolvedFilePath: bounded(narratorToolCalls.resolvedFilePath),
			canonicalFilePath: bounded(narratorToolCalls.canonicalFilePath),
			runtimeGeneration: narratorToolCalls.runtimeGeneration,
			deviceSelectionSource: narratorToolCalls.deviceSelectionSource,
		})
		.from(narratorToolCalls)
		.where(and(eq(narratorToolCalls.id, item.toolCallId), eq(narratorToolCalls.status, "pending")))
		.limit(1)
		.get();
	if (!row || !stillLive(item.requestId, live)) throw new NotFoundError("Human attention", item.id);
	if (!row.withinBudget) return { item, tooLarge: true };
	const targets = toolCallWithExecutionTargets({
		...row,
		executionTargetsJson: safeJson(row.targets),
	});
	const frozen = live.pending?.executionTarget ?? targets.executionTarget;
	const storedSuggestions = safeJson(row.suggestions);
	let suggestions: unknown[] | undefined = Array.isArray(storedSuggestions)
		? storedSuggestions
		: undefined;
	if (live.reflection) {
		const persisted = suggestions?.find(
			(value) =>
				value &&
				typeof value === "object" &&
				(value as Record<string, unknown>).type === live.reflection?.type,
		);
		suggestions = [
			{ ...(persisted && typeof persisted === "object" ? persisted : {}), ...live.reflection },
		];
	}
	const permission: HumanAttentionPermission = {
		id: item.requestId,
		toolName: item.toolName,
		toolUseId: live.toolUseId,
		ownerNarratorId: item.narratorId,
		parentToolUseId: owner.row.type === "subagent" ? (live.parentToolUseId ?? null) : null,
		subagentNarratorId: owner.row.type === "subagent" ? item.narratorId : null,
		inputJson: live.input,
		decisionReason: row.decisionReason ?? item.summary,
		suggestions,
		executionDeviceId: frozen?.deviceId ?? row.executionDeviceId,
		executionCwd: frozen?.cwd ?? row.executionCwd,
		resolvedFilePath:
			frozen?.canonicalPath ??
			frozen?.lexicalPath ??
			frozen?.resolvedFilePath ??
			row.resolvedFilePath,
		deviceSelectionSource: frozen?.selectionSource ?? row.deviceSelectionSource,
		executionTarget: frozen,
		executionTargets: targets.executionTargets.length
			? targets.executionTargets
			: frozen
				? [frozen]
				: [],
		executionPlan: targets.executionPlan,
		reflectionDeadline: live.pending?.questionReflectionStoppedByUser
			? undefined
			: live.pending?.questionReflectionDeadline,
	};
	return boundedJsonCopy({ item, permission })?.value ?? { item, tooLarge: true };
}

export async function getHumanAttentionForPrincipal(
	principal: NarratorPrincipal,
	attentionId: string,
	options: { signal?: AbortSignal } = {},
): Promise<HumanAttentionDetail> {
	const parsed = parseId(attentionId);
	if (!parsed) throw new NotFoundError("Human attention", attentionId);
	const context = requestContext(principal, options.signal);
	context.check();
	try {
		if (parsed.source === "permission") {
			const found = await permissionItem(parsed.requestId, context);
			if (!found) throw new NotFoundError("Human attention", attentionId);
			context.check();
			return await permissionDetail(found.item, found.live, found.owner);
		}
		const row = await readQuestionSummary(parsed.requestId);
		const item = row ? await questionItem(row, context) : null;
		if (!item) throw new NotFoundError("Human attention", attentionId);
		context.check();
		const { record, tooLarge } = await getBoundedOpenAsyncQuestion(
			parsed.requestId,
			HUMAN_ATTENTION_DETAIL_MAX_BYTES,
		);
		if (tooLarge) return { item, tooLarge: true };
		if (!record) throw new NotFoundError("Human attention", attentionId);
		return boundedJsonCopy({ item, question: record })?.value ?? { item, tooLarge: true };
	} finally {
		const elapsedMs = performance.now() - context.started;
		if (elapsedMs > 250)
			logger.warn("Slow human attention detail", { elapsedMs: Math.round(elapsedMs) });
	}
}
