/**
 * Questions put to people (`Ask`, outline P2 PR 7; design §3.3, §4.1, §4.5): asking, answering,
 * telling the asker, and what the inbox, the page and the task source read of them.
 *
 * A question is a block under the task (or any block) it is about: its content is the question,
 * its `ask_json` holds who is asked, the choices, the asker's recommendation and later the answer
 * (versioned, so the time machine and reverts see it). Its routing row (`outline_questions`) is
 * derived by the write path in the same commit. Questions under the same block are one thing in
 * the inbox (D20), answered at once in one `answer` commit.
 *
 *   - ASK ({@link outlineAsk}, the `Ask` tool): one commit as the asking session. Never blocks
 *     (owner decision Q4): the nearest task above the question waits for people until it is
 *     answered (`findTasksWaitingForPeople`), and the session does other work meanwhile; with
 *     `proceed` it went ahead with its recommendation, and nothing waits.
 *   - WHO IS ASKED (Q2): `to` when given (a person who may write the space); otherwise the task's
 *     manager when that is a person; otherwise the person this turn runs for; otherwise the
 *     session's owner.
 *   - ANSWER ({@link answerOutlineQuestions}): only the person asked, while they may write the
 *     space: one `answer` commit written as them, their confirmation (§2.3). The asking session
 *     may also write down what that person answered in its own conversation (Q3: `answered`,
 *     relayed, the person still responsible); nobody else answers.
 *   - TELLING THE ASKER ({@link deliverOutlineAnswers}): one user message per answering commit and
 *     asking session, waking it when idle (a running loop reads it on its next pass). The wake
 *     runs as the person the asking turn ran for, never as the person who answered. A session that
 *     is gone or archived is not woken: the session now doing the task is, if any. A question it
 *     went ahead with (`proceed`) answered as recommended tells nobody. Delivery is marked on the
 *     row; a background sweep retries what a crash left undelivered.
 *
 * Every read is indexed and bounded; nothing here scans a space.
 */
import { AppError } from "@server/lib/errors";
import { eventBus } from "@server/lib/event-bus";
import { logger } from "@server/lib/logger";
import { blockTitle } from "@shared/outline";
import type {
	OutlineAnswerInput,
	OutlineQuestionGroupResponse,
	OutlineQuestionView,
} from "@shared/outline-api";
import { canWriteSpace, type OutlinePrincipal } from "./access";
import {
	readDisplayNames,
	readNarrator,
	readNonAdminUserIds,
	readUserExists,
	readUserIdByName,
} from "./access-reads";
import type { OutlineAgentScope } from "./agent-scope";
import { isOutlineEnabled } from "./feature";
import { OUTLINE_LIMITS, type OutlineAskAnswerJson, type OutlineAskJson } from "./model";
import { outlineStore } from "./store";
import type {
	OutlineBlockMeta,
	OutlineBlockRow,
	OutlineQuestionRow,
	OutlineSpaceRow,
	OutlineStore,
} from "./store/port";
import type { OutlineTaskSubject } from "./tasks";
import { type OutlineOp, writeOutline } from "./write";

export const OUTLINE_QUESTION_LIMITS = {
	/** Questions one `Ask` call asks, sub-questions included. */
	perCall: 10,
	/** Choices of one question. */
	options: 6,
	/** UTF-8 bytes of a question. */
	questionBytes: 2048,
	/** UTF-8 bytes of a choice, a recommendation or its reason. */
	textBytes: 1024,
	/** UTF-8 bytes of an answer in words. */
	answerBytes: 4096,
	/** Open questions of a session past which `Ask` reminds it to decide more itself. */
	openPerSessionWarn: 20,
	/** Open questions a session may have; past it `Ask` refuses. */
	openPerSession: 50,
	/** Questions one group shows, and one answer answers. */
	group: 50,
	/** Open questions of a person one inbox read takes. */
	inboxScan: 500,
	/** Open questions of a space one wait derivation reads. */
	waitScan: 500,
	/** Undelivered answers one sweep retries. */
	sweepBatch: 50,
	/** An answer younger than this is left to the delivery that follows its commit. */
	sweepAfterMs: 2 * 60_000,
	/** Aliases `Qn` read to number new questions; past it questions get no alias. */
	aliasScan: 5000,
	/** Messages of the conversation read to find the one a relayed answer came from. */
	relayMessageScan: 200,
} as const;

/** The system actor of the commits that withdraw an archived session's questions. */
export const OUTLINE_QUESTION_ACTOR = "outline-questions";

export type OutlineQuestionErrorCode =
	| "OUTLINE_QUESTION_NOT_FOUND"
	| "OUTLINE_QUESTION_DECIDED"
	| "OUTLINE_QUESTION_NOT_YOURS"
	| "OUTLINE_QUESTION_INVALID";

/** An answer that could not be written; nothing was. */
export class OutlineQuestionError extends AppError {
	constructor(
		message: string,
		readonly questionCode: OutlineQuestionErrorCode,
	) {
		super(
			message,
			questionCode === "OUTLINE_QUESTION_NOT_FOUND"
				? 404
				: questionCode === "OUTLINE_QUESTION_NOT_YOURS"
					? 403
					: questionCode === "OUTLINE_QUESTION_DECIDED"
						? 409
						: 400,
			questionCode,
		);
		this.name = "OutlineQuestionError";
	}
}

/** Agent- and API-facing text (English, like the rest of the outline's). */
export const OUTLINE_QUESTION_TEXT = {
	oneMode: "give exactly one of questions, withdraw or answered",
	noQuestions: "questions is empty",
	tooMany: (n: number) =>
		`one call asks at most ${OUTLINE_QUESTION_LIMITS.perCall} questions, sub-questions included (got ${n})`,
	emptyQuestion: (n: number) => `question ${n} has no text`,
	tooLong: (n: number, what: string, max: number) => `question ${n}: ${what} is over ${max} bytes`,
	tooManyOptions: (n: number) =>
		`question ${n} has more than ${OUTLINE_QUESTION_LIMITS.options} options`,
	noRecommendation: (n: number) =>
		`question ${n} has no recommendation: say which option you recommend (its number) or what you would do, and why`,
	badRecommendation: (n: number, count: number) =>
		`question ${n}: recommend names option ${count === 0 ? "numbers, but it has no options" : `1 to ${count}`}`,
	nestedItems: (n: number) =>
		`question ${n}: sub-questions (items) cannot have sub-questions of their own`,
	noTask:
		"this session has no task in progress to put the question under: name the block it is about with under",
	notFound: (ref: string) => `${ref}: no such block this session can read`,
	ambiguous: (ref: string, candidates: string[]) =>
		`${ref} names several blocks: ${candidates.join(", ")}; use an address`,
	underQuestion: (address: string) =>
		`${address} is a question: put sub-questions in items when asking, or ask under the block it is about`,
	underTask: (address: string) => `${address} is deleted`,
	cannotWrite: (key: string, why: string) => `cannot ask in space ${key}: ${why}`,
	noPerson:
		"nobody to ask: this turn runs for no person and the session has no owner; write it as a note instead",
	unknownPerson: (name: string) => `${name}: no such person`,
	personCannotWrite: (name: string) =>
		`${name} cannot write this space, so they could not answer; ask someone who can`,
	tooManyOpen: (open: number) =>
		`this session has ${open} unanswered questions; at most ${OUTLINE_QUESTION_LIMITS.openPerSession}. Decide more yourself (reversible decisions with proceed), or withdraw ones that no longer matter`,
	notQuestion: (address: string) => `${address} is not a question`,
	notOpen: (address: string, state: string) => `${address} is not open (${state})`,
	notAsker: (address: string) => `${address} was not asked by this session`,
	notTheirs: (address: string) =>
		`${address} was not put to the person this turn runs for: only their own answer, given in this conversation, can be written down here`,
	badOption: (address: string, count: number) =>
		count === 0 ? `${address} has no options` : `${address}: option is 1 to ${count}`,
	noAnswer: (address: string) =>
		`${address}: answer with option, text or adopt (adopt takes the recommendation)`,
	noRecommendationToAdopt: (address: string) =>
		`${address} has no recommendation to adopt: choose an option or answer in words`,
	answerTooLong: (address: string) =>
		`${address}: the answer is over ${OUTLINE_QUESTION_LIMITS.answerBytes} bytes`,
	oneSpace: "answer questions of one space at a time",
	groupTooBig: `answer at most ${OUTLINE_QUESTION_LIMITS.group} questions at a time`,
	notYours: "these questions were put to someone else",
	cannotWriteSpace: "you can no longer write this space, so you cannot answer its questions",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** The state of a question as its block holds it. */
export function questionState(
	ask: OutlineAskJson | null,
	deleted = false,
): "open" | "answered" | "withdrawn" {
	if (!ask || deleted || ask.withdrawn) return "withdrawn";
	return ask.answer ? "answered" : "open";
}

/** A principal for a person, with their role read. */
async function principalOf(userId: string): Promise<OutlinePrincipal> {
	const nonAdmins = await readNonAdminUserIds([userId]);
	return { userId, isAdmin: !nonAdmins.has(userId) };
}

/** Blocks by id (live or deleted). */
async function blocksById(store: OutlineStore, ids: readonly string[]) {
	return new Map((await store.getBlocks([...new Set(ids)])).map((b) => [b.id, b]));
}

/**
 * The nearest task at or above each block (by id), walking up level by level within one space,
 * at most {@link OUTLINE_LIMITS.maxDepth} levels. A block with no task above it is left out.
 */
async function nearestTasks(
	store: OutlineStore,
	spaceId: string,
	starts: readonly OutlineBlockMeta[],
	options: { includeSelf: boolean },
): Promise<Map<string, OutlineBlockMeta>> {
	const known = new Map<string, OutlineBlockMeta>(starts.map((m) => [m.id, m]));
	const at = new Map<string, string | null>();
	for (const m of starts) at.set(m.id, options.includeSelf ? m.id : m.parentId);
	const out = new Map<string, OutlineBlockMeta>();
	for (let depth = 0; depth <= OUTLINE_LIMITS.maxDepth && at.size > 0; depth++) {
		const missing = [...new Set([...at.values()])].filter(
			(id): id is string => id !== null && !known.has(id),
		);
		if (missing.length > 0) {
			for (const meta of await store.getBlockMetas(spaceId, { ids: missing }))
				known.set(meta.id, meta);
		}
		for (const [start, id] of [...at]) {
			const meta = id === null ? undefined : known.get(id);
			if (!meta || meta.deleted) at.delete(start);
			else if (meta.taskJson) {
				out.set(start, meta);
				at.delete(start);
			} else at.set(start, meta.parentId);
		}
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Waiting (`tasks.ts`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Of the given tasks, those an unanswered question waits under (D27b): the question's nearest
 * task above it waits, unless the asker went ahead with its recommendation (`proceed`). One read
 * of the space's open questions (at most {@link OUTLINE_QUESTION_LIMITS.waitScan}), then the
 * questions' ancestors level by level.
 */
export async function questionWaits(
	tasks: readonly OutlineTaskSubject[],
	options: { store?: OutlineStore } = {},
): Promise<Set<string>> {
	const store = options.store ?? outlineStore;
	const out = new Set<string>();
	const bySpace = new Map<string, Set<string>>();
	for (const task of tasks) {
		const set = bySpace.get(task.spaceId) ?? new Set<string>();
		set.add(task.id);
		bySpace.set(task.spaceId, set);
	}
	for (const [spaceId, wanted] of bySpace) {
		const open = (
			await store.listOpenQuestionsBySpace(spaceId, OUTLINE_QUESTION_LIMITS.waitScan)
		).filter((q) => !q.proceed);
		if (open.length === 0) continue;
		const metas = await store.getBlockMetas(spaceId, { ids: open.map((q) => q.blockId) });
		const live = metas.filter((m) => !m.deleted && m.askJson !== null);
		for (const task of (await nearestTasks(store, spaceId, live, { includeSelf: false })).values())
			if (wanted.has(task.id)) out.add(task.id);
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Asking (the `Ask` tool)
// ─────────────────────────────────────────────────────────────────────────────

export interface OutlineAskQuestionInput {
	question: string;
	options?: string[];
	/** An option's number (1-based), or what the asker would do. */
	recommend?: number | string;
	reason?: string;
	/** Sub-questions (one level): with the question, one thing to decide. */
	items?: OutlineAskQuestionInput[];
}

export interface OutlineAskRequest {
	questions?: OutlineAskQuestionInput[];
	/** The block the questions are about; the session's task in progress by default. */
	under?: string;
	/** `human:name` (or a name): who is asked. */
	to?: string;
	/** The asker went ahead with its recommendations (reversible decisions). */
	proceed?: boolean;
	/** Questions of this session to withdraw. */
	withdraw?: string[];
	/** Answers the person asked gave in this conversation, written down for them. */
	answered?: Array<{ question: string; option?: number; text?: string; adopt?: boolean }>;
}

export interface OutlineAskProvenance {
	messageId: string | null;
	toolCallId: string | null;
}

export interface OutlineAskOutput {
	output: string;
	isError?: boolean;
	metadata: Record<string, unknown>;
}

function failed(lines: string[], metadata: Record<string, unknown> = {}): OutlineAskOutput {
	return {
		output: ["Nothing was written.", ...lines.map((l) => `- ${l}`)].join("\n"),
		isError: true,
		metadata: { tool: "Ask", ...metadata },
	};
}

/** Check the questions of a call; the problems, or none. */
function checkQuestions(questions: readonly OutlineAskQuestionInput[]): string[] {
	const problems: string[] = [];
	let n = 0;
	const check = (q: OutlineAskQuestionInput, nested: boolean) => {
		n++;
		const text = typeof q.question === "string" ? q.question.trim() : "";
		if (!text) problems.push(OUTLINE_QUESTION_TEXT.emptyQuestion(n));
		else if (bytes(text) > OUTLINE_QUESTION_LIMITS.questionBytes)
			problems.push(
				OUTLINE_QUESTION_TEXT.tooLong(n, "the question", OUTLINE_QUESTION_LIMITS.questionBytes),
			);
		const options = q.options ?? [];
		if (options.length > OUTLINE_QUESTION_LIMITS.options)
			problems.push(OUTLINE_QUESTION_TEXT.tooManyOptions(n));
		for (const option of options) {
			if (typeof option !== "string" || !option.trim())
				problems.push(OUTLINE_QUESTION_TEXT.tooLong(n, "an empty option", 0));
			else if (bytes(option) > OUTLINE_QUESTION_LIMITS.textBytes)
				problems.push(
					OUTLINE_QUESTION_TEXT.tooLong(n, "an option", OUTLINE_QUESTION_LIMITS.textBytes),
				);
		}
		const rec = q.recommend;
		if (rec === undefined || rec === null || (typeof rec === "string" && !rec.trim()))
			problems.push(OUTLINE_QUESTION_TEXT.noRecommendation(n));
		else if (typeof rec === "number") {
			if (!Number.isInteger(rec) || rec < 1 || rec > options.length)
				problems.push(OUTLINE_QUESTION_TEXT.badRecommendation(n, options.length));
		} else if (bytes(rec) > OUTLINE_QUESTION_LIMITS.textBytes)
			problems.push(
				OUTLINE_QUESTION_TEXT.tooLong(n, "the recommendation", OUTLINE_QUESTION_LIMITS.textBytes),
			);
		if (q.reason !== undefined && bytes(q.reason) > OUTLINE_QUESTION_LIMITS.textBytes)
			problems.push(
				OUTLINE_QUESTION_TEXT.tooLong(n, "the reason", OUTLINE_QUESTION_LIMITS.textBytes),
			);
		if (q.items?.length) {
			if (nested) problems.push(OUTLINE_QUESTION_TEXT.nestedItems(n));
			else for (const item of q.items) check(item, true);
		}
	};
	for (const q of questions) check(q, false);
	if (n === 0) problems.push(OUTLINE_QUESTION_TEXT.noQuestions);
	if (n > OUTLINE_QUESTION_LIMITS.perCall) problems.push(OUTLINE_QUESTION_TEXT.tooMany(n));
	return problems;
}

function askOf(q: OutlineAskQuestionInput, to: string, proceed: boolean): OutlineAskJson {
	const options = (q.options ?? []).map((o) => o.trim());
	const rec = q.recommend as number | string;
	const reason = q.reason?.trim();
	return {
		to: { kind: "human", id: to },
		...(options.length > 0 ? { options } : {}),
		recommend: {
			...(typeof rec === "number" ? { option: rec } : { text: rec.trim() }),
			...(reason ? { reason } : {}),
		},
		...(proceed ? { proceed: true } : {}),
	};
}

type ResolvedRef = { block: OutlineBlockRow; space: OutlineSpaceRow; address: string };

/** Resolve a reference the session may read to its block, or the problem. */
async function resolveRef(scope: OutlineAgentScope, ref: string): Promise<ResolvedRef | string> {
	const found = await scope.resolve(ref);
	if (found.status === "not_found") return OUTLINE_QUESTION_TEXT.notFound(ref);
	if (found.status === "ambiguous")
		return OUTLINE_QUESTION_TEXT.ambiguous(
			ref,
			found.candidates.slice(0, 5).map((c) => c.address),
		);
	const block = await scope.store.getBlock(found.block.id);
	const space = block ? await scope.store.getSpace(block.spaceId) : null;
	if (!block || !space || block.deleted) return OUTLINE_QUESTION_TEXT.notFound(ref);
	return { block, space, address: scope.addressIn(space)(block.sid) };
}

/** The session's task in progress: the first it holds, in document order. */
async function currentTask(scope: OutlineAgentScope): Promise<ResolvedRef | null> {
	const { findContinuationCandidates } = await import("./tasks");
	const session = scope.rootNarratorId ?? scope.narratorId;
	const read = await findContinuationCandidates({
		narratorId: session,
		sessionSpaceId: scope.session?.id ?? null,
		limit: 5,
	});
	const doing = read.ordered.find(
		(t) => t.status === "doing" && t.claim?.holderNarratorId === session,
	);
	if (!doing) return null;
	const block = await scope.store.getBlock(doing.blockId);
	const space = await scope.store.getSpace(doing.spaceId);
	if (!block || !space || block.deleted) return null;
	return { block, space, address: scope.addressIn(space)(block.sid) };
}

/** Who is asked (owner decision Q2), or the problem. */
async function recipientOf(
	scope: OutlineAgentScope,
	space: OutlineSpaceRow,
	task: OutlineBlockMeta | null,
	to: string | undefined,
): Promise<string | { problem: string }> {
	const mayWrite = async (userId: string) =>
		(await readUserExists(userId)) && (await canWriteSpace(await principalOf(userId), space));
	if (to?.trim()) {
		const name = to
			.trim()
			.replace(/^@/, "")
			.replace(/^human:/, "");
		const userId = await readUserIdByName(name);
		if (!userId) return { problem: OUTLINE_QUESTION_TEXT.unknownPerson(name) };
		if (!(await mayWrite(userId)))
			return { problem: OUTLINE_QUESTION_TEXT.personCannotWrite(name) };
		return userId;
	}
	const manager = task?.taskJson?.manager;
	if (manager?.kind === "human" && (await mayWrite(manager.id))) return manager.id;
	if (scope.ctx.userId && (await readUserExists(scope.ctx.userId))) return scope.ctx.userId;
	const root = scope.rootNarratorId ?? scope.narratorId;
	const owner = (await readNarrator(root))?.ownerUserId ?? null;
	if (owner && (await readUserExists(owner))) return owner;
	return { problem: OUTLINE_QUESTION_TEXT.noPerson };
}

/** The next free `Qn` aliases of a space, or nulls when there are too many to number. */
async function nextAliases(
	store: OutlineStore,
	spaceId: string,
	count: number,
): Promise<Array<string | null>> {
	const existing = await store.listAliasRange(
		spaceId,
		{ from: "Q0", to: "Q:" },
		OUTLINE_QUESTION_LIMITS.aliasScan + 1,
	);
	if (existing.length > OUTLINE_QUESTION_LIMITS.aliasScan) return Array(count).fill(null);
	let max = 0;
	for (const alias of existing) {
		const m = /^Q(\d+)$/.exec(alias);
		if (m) max = Math.max(max, Number(m[1]));
	}
	return Array.from({ length: count }, (_, i) => `Q${max + i + 1}`);
}

/** Tell inboxes their questions changed (data-free; they read again). */
function questionsChanged(): void {
	eventBus.emit({ type: "human_attention:changed" });
}

/**
 * The `Ask` tool: ask questions (under the session's task in progress by default), withdraw this
 * session's questions, or write down an answer the person gave in this conversation.
 */
export async function outlineAsk(
	scope: OutlineAgentScope,
	request: OutlineAskRequest,
	provenance: OutlineAskProvenance,
	options: { now?: () => Date } = {},
): Promise<OutlineAskOutput> {
	const modes = [request.questions, request.withdraw, request.answered].filter(
		(m) => m !== undefined,
	);
	if (modes.length !== 1) return failed([OUTLINE_QUESTION_TEXT.oneMode]);
	if (request.withdraw)
		return await withdrawQuestions(scope, request.withdraw, provenance, options);
	if (request.answered) return await relayAnswers(scope, request.answered, provenance, options);
	return await askQuestions(scope, request, provenance, options);
}

async function askQuestions(
	scope: OutlineAgentScope,
	request: OutlineAskRequest,
	provenance: OutlineAskProvenance,
	options: { now?: () => Date },
): Promise<OutlineAskOutput> {
	const questions = request.questions ?? [];
	const problems = checkQuestions(questions);
	if (problems.length > 0) return failed(problems);

	let anchor: ResolvedRef;
	if (request.under?.trim()) {
		const found = await resolveRef(scope, request.under);
		if (typeof found === "string") return failed([found]);
		anchor = found;
	} else {
		const task = await currentTask(scope);
		if (!task) return failed([OUTLINE_QUESTION_TEXT.noTask]);
		anchor = task;
	}
	if (anchor.block.askJson) return failed([OUTLINE_QUESTION_TEXT.underQuestion(anchor.address)]);
	const { space } = anchor;
	const refusal = await scope.writeRefusal(space);
	if (refusal) return failed([OUTLINE_QUESTION_TEXT.cannotWrite(space.key, refusal)]);

	const store = scope.store;
	const task = (await nearestTasks(store, space.id, [anchor.block], { includeSelf: true })).get(
		anchor.block.id,
	);
	const to = await recipientOf(scope, space, task ?? null, request.to);
	if (typeof to !== "string") return failed([to.problem]);

	const session = scope.rootNarratorId ?? scope.narratorId;
	const count = questions.reduce((n, q) => n + 1 + (q.items?.length ?? 0), 0);
	const open = (
		await store.listOpenQuestionsByAsker(session, OUTLINE_QUESTION_LIMITS.openPerSession + 1)
	).length;
	if (open + count > OUTLINE_QUESTION_LIMITS.openPerSession)
		return failed([OUTLINE_QUESTION_TEXT.tooManyOpen(open)]);

	const aliases = await nextAliases(store, space.id, count);
	const proceed = request.proceed === true;
	const ops: OutlineOp[] = [];
	const tempIds: string[] = [];
	let k = 0;
	const add = (q: OutlineAskQuestionInput, parent: { id: string } | { tempId: string }) => {
		const tempId = `q${k}`;
		const alias = aliases[k] ?? null;
		k++;
		ops.push({
			op: "insert",
			tempId,
			parent,
			content: q.question.trim(),
			...(alias ? { alias } : {}),
			ask: askOf(q, to, proceed),
		});
		tempIds.push(tempId);
		return tempId;
	};
	for (const q of questions) {
		const id = add(q, { id: anchor.block.id });
		for (const item of q.items ?? []) add(item, { tempId: id });
	}
	const responsible = scope.ctx.userId ?? to;
	const result = await writeOutline(
		{
			spaceId: space.id,
			ops,
			actor: { kind: "agent", id: scope.narratorId },
			responsibleUserId: responsible,
			narratorId: scope.narratorId,
			messageId: provenance.messageId,
			toolCallId: provenance.toolCallId,
			summary: `Ask ${aliases.filter((a) => a !== null).join(", ") || `${count} questions`}`.slice(
				0,
				OUTLINE_LIMITS.maxSummaryChars,
			),
		},
		{
			question: {
				askerNarratorId: session,
				askerUserId: scope.ctx.userId,
				askerToolCallId: provenance.toolCallId,
			},
			...(options.now ? { now: options.now } : {}),
		},
	);
	questionsChanged();

	const label = scope.labelIn(space);
	const names = await readDisplayNames({ userIds: [to] });
	const who = names.users.get(to) ?? to;
	const asked = result.results.slice(0, ops.length).map((r, i) => {
		const alias = aliases[i];
		return alias ? `${alias} ${label(r.sid)}` : label(r.sid);
	});
	const lines = [`Asked ${asked.join(", ")} under ${label(anchor.block.sid)} for ${who}.`];
	if (proceed) {
		lines.push(
			"You went ahead with your recommendations: nothing waits for the answer. If the answer differs from a recommendation, it comes back to this session as a message (waking it when idle); change what you did then.",
		);
	} else if (task) {
		lines.push(
			`${label(task.sid)} now waits for the answer, and continuation skips it: do the work it does not affect meanwhile. The answer comes back to this session as a message (waking it when idle).`,
		);
	} else {
		lines.push(
			"No task is above it, so nothing waits for it. The answer comes back to this session as a message (waking it when idle).",
		);
	}
	if (open + count >= OUTLINE_QUESTION_LIMITS.openPerSessionWarn) {
		lines.push(
			`This session has ${open + count} unanswered questions: decide reversible things yourself (proceed), and withdraw questions that no longer matter.`,
		);
	}
	return {
		output: lines.join("\n"),
		metadata: {
			tool: "Ask",
			space: { key: space.key, kind: space.kind },
			under: `${space.key}/${anchor.block.sid}`,
			addresses: result.results.slice(0, ops.length).map((r) => r.address),
			spaceId: space.id,
			groupBlockId: anchor.block.id,
			blockIds: result.results.slice(0, ops.length).map((r) => r.blockId),
			to,
			proceed,
		},
	};
}

/** Questions named by the agent, each its own question asked by this session and still open. */
async function ownOpenQuestions(
	scope: OutlineAgentScope,
	refs: readonly string[],
): Promise<
	| { problems: string[] }
	| { found: Array<ResolvedRef & { ask: OutlineAskJson; row: OutlineQuestionRow }> }
> {
	const problems: string[] = [];
	const found: Array<ResolvedRef & { ask: OutlineAskJson; row: OutlineQuestionRow }> = [];
	const session = scope.rootNarratorId ?? scope.narratorId;
	for (const ref of refs.slice(0, OUTLINE_QUESTION_LIMITS.group)) {
		const r = await resolveRef(scope, ref);
		if (typeof r === "string") {
			problems.push(r);
			continue;
		}
		const ask = r.block.askJson;
		if (!ask) {
			problems.push(OUTLINE_QUESTION_TEXT.notQuestion(r.address));
			continue;
		}
		const state = questionState(ask, r.block.deleted);
		if (state !== "open") {
			problems.push(OUTLINE_QUESTION_TEXT.notOpen(r.address, state));
			continue;
		}
		const [row] = await scope.store.getQuestions([r.block.id]);
		if (!row || row.askerNarratorId !== session) {
			problems.push(OUTLINE_QUESTION_TEXT.notAsker(r.address));
			continue;
		}
		found.push({ ...r, ask, row });
	}
	if (refs.length > OUTLINE_QUESTION_LIMITS.group) problems.push(OUTLINE_QUESTION_TEXT.groupTooBig);
	return problems.length > 0 ? { problems } : { found };
}

/** One commit per space of `items`, each with its own ops. */
async function writePerSpace<T extends ResolvedRef>(
	items: readonly T[],
	write: (space: OutlineSpaceRow, items: T[]) => Promise<void>,
): Promise<void> {
	const bySpace = new Map<string, { space: OutlineSpaceRow; items: T[] }>();
	for (const item of items) {
		const entry = bySpace.get(item.space.id) ?? { space: item.space, items: [] };
		entry.items.push(item);
		bySpace.set(item.space.id, entry);
	}
	for (const { space, items: list } of bySpace.values()) await write(space, list);
}

async function withdrawQuestions(
	scope: OutlineAgentScope,
	refs: readonly string[],
	provenance: OutlineAskProvenance,
	options: { now?: () => Date },
): Promise<OutlineAskOutput> {
	if (refs.length === 0) return failed([OUTLINE_QUESTION_TEXT.noQuestions]);
	const own = await ownOpenQuestions(scope, refs);
	if ("problems" in own) return failed(own.problems);
	const at = (options.now?.() ?? new Date()).toISOString();
	await writePerSpace(own.found, async (space, list) => {
		await writeOutline(
			{
				spaceId: space.id,
				ops: list.map((q) => ({
					op: "update" as const,
					block: { id: q.block.id },
					baseVersionSeq: q.block.versionSeq,
					ask: { ...q.ask, withdrawn: { by: { kind: "agent", id: scope.narratorId }, at } },
				})),
				actor: { kind: "agent", id: scope.narratorId },
				responsibleUserId: scope.ctx.userId,
				narratorId: scope.narratorId,
				messageId: provenance.messageId,
				toolCallId: provenance.toolCallId,
				summary: `Withdraw ${list.map((q) => q.block.alias ?? q.block.sid).join(", ")}`.slice(
					0,
					OUTLINE_LIMITS.maxSummaryChars,
				),
			},
			options.now ? { now: options.now } : {},
		);
	});
	questionsChanged();
	return {
		output: `Withdrew ${own.found.map((q) => q.address).join(", ")}; the tasks they held up no longer wait for them.`,
		metadata: { tool: "Ask", withdrawn: own.found.map((q) => q.block.id) },
	};
}

/** The id of the latest message the person sent in this conversation, when it can be found. */
async function latestMessageOf(narratorId: string, userId: string): Promise<string | null> {
	try {
		const { getNarratorMessageRefsPort } = await import("../narrator-refs/store");
		if (getNarratorMessageRefsPort()) return null;
		const [{ db }, { narratorMessages }, { and, desc, eq }] = await Promise.all([
			import("@server/db"),
			import("@server/db/schema"),
			import("drizzle-orm"),
		]);
		const rows = db
			.select({
				id: narratorMessages.id,
				role: narratorMessages.role,
				createdBy: narratorMessages.createdBy,
			})
			.from(narratorMessages)
			.where(and(eq(narratorMessages.narratorId, narratorId)))
			.orderBy(desc(narratorMessages.createdAt))
			.limit(OUTLINE_QUESTION_LIMITS.relayMessageScan)
			.all();
		return rows.find((r) => r.role === "user" && r.createdBy === userId)?.id ?? null;
	} catch {
		return null;
	}
}

/** The answer an input gives to a question, or the problem. */
function answerFor(
	ask: OutlineAskJson,
	address: string,
	input: { option?: number; text?: string; adopt?: boolean },
	by: OutlineAskAnswerJson["by"],
	at: string,
): OutlineAskAnswerJson | string {
	const count = ask.options?.length ?? 0;
	const text = typeof input.text === "string" ? input.text.trim() : "";
	if (input.adopt) {
		if (ask.recommend.option === undefined && !ask.recommend.text)
			return OUTLINE_QUESTION_TEXT.noRecommendationToAdopt(address);
		return {
			...(ask.recommend.option !== undefined ? { option: ask.recommend.option } : {}),
			...(text ? { text } : {}),
			adopted: true,
			by,
			at,
		};
	}
	if (input.option !== undefined && input.option !== null) {
		if (!Number.isInteger(input.option) || input.option < 1 || input.option > count)
			return OUTLINE_QUESTION_TEXT.badOption(address, count);
	}
	if (input.option === undefined && !text) return OUTLINE_QUESTION_TEXT.noAnswer(address);
	if (bytes(text) > OUTLINE_QUESTION_LIMITS.answerBytes)
		return OUTLINE_QUESTION_TEXT.answerTooLong(address);
	const adopted = input.option !== undefined && input.option === ask.recommend.option;
	return {
		...(input.option !== undefined ? { option: input.option } : {}),
		...(text ? { text } : {}),
		...(adopted ? { adopted: true } : {}),
		by,
		at,
	};
}

async function relayAnswers(
	scope: OutlineAgentScope,
	answered: NonNullable<OutlineAskRequest["answered"]>,
	provenance: OutlineAskProvenance,
	options: { now?: () => Date },
): Promise<OutlineAskOutput> {
	if (answered.length === 0) return failed([OUTLINE_QUESTION_TEXT.noQuestions]);
	const person = scope.ctx.userId;
	const own = await ownOpenQuestions(
		scope,
		answered.map((a) => a.question),
	);
	if ("problems" in own) return failed(own.problems);
	const at = (options.now?.() ?? new Date()).toISOString();
	const session = scope.rootNarratorId ?? scope.narratorId;
	const messageId = person ? await latestMessageOf(session, person) : null;
	const problems: string[] = [];
	const updates: Array<ResolvedRef & { ask: OutlineAskJson }> = [];
	own.found.forEach((q, i) => {
		if (!person || q.ask.to.kind !== "human" || q.ask.to.id !== person) {
			problems.push(OUTLINE_QUESTION_TEXT.notTheirs(q.address));
			return;
		}
		const input = answered[i] as (typeof answered)[number];
		const answer = answerFor(q.ask, q.address, input, { kind: "human", id: person }, at);
		if (typeof answer === "string") {
			problems.push(answer);
			return;
		}
		answer.relayed = { narratorId: scope.narratorId, messageId };
		updates.push({ ...q, ask: { ...q.ask, answer } });
	});
	if (problems.length > 0) return failed(problems);
	await writePerSpace(updates, async (space, list) => {
		await writeOutline(
			{
				spaceId: space.id,
				ops: list.map((q) => ({
					op: "update" as const,
					block: { id: q.block.id },
					baseVersionSeq: q.block.versionSeq,
					ask: q.ask,
				})),
				actor: { kind: "agent", id: scope.narratorId },
				responsibleUserId: person,
				narratorId: scope.narratorId,
				messageId: provenance.messageId,
				toolCallId: provenance.toolCallId,
				summary:
					`Relayed the answer to ${list.map((q) => q.block.alias ?? q.block.sid).join(", ")}`.slice(
						0,
						OUTLINE_LIMITS.maxSummaryChars,
					),
			},
			{
				kind: "answer",
				// The session wrote it down itself: nobody needs telling.
				question: {
					askerNarratorId: null,
					askerUserId: null,
					askerToolCallId: null,
					delivered: true,
				},
				...(options.now ? { now: options.now } : {}),
			},
		);
	});
	questionsChanged();
	return {
		output: `Wrote down the answer to ${updates.map((q) => q.address).join(", ")} as the person's (relayed from this conversation); the tasks they held up no longer wait for them.`,
		metadata: { tool: "Ask", relayed: updates.map((q) => q.block.id) },
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Answering (people)
// ─────────────────────────────────────────────────────────────────────────────

export interface OutlineAnswerResult {
	spaceId: string;
	commitId: string | null;
	answered: string[];
}

/**
 * A person answers questions put to them: all in one space, one `answer` commit written as them.
 * Throws {@link OutlineQuestionError} (nothing written): not found, not open any more, not theirs
 * (or they can no longer write the space), or an answer that does not fit the question. The
 * askers are told afterwards ({@link deliverOutlineAnswers}); a failure there is left to the
 * sweep.
 */
export async function answerOutlineQuestions(args: {
	userId: string;
	answers: readonly OutlineAnswerInput[];
	store?: OutlineStore;
	now?: () => Date;
	/** Tell the askers (default); tests turn it off to look at the undelivered rows. */
	deliver?: boolean;
}): Promise<OutlineAnswerResult> {
	const store = args.store ?? outlineStore;
	if (args.answers.length === 0)
		throw new OutlineQuestionError(OUTLINE_QUESTION_TEXT.noQuestions, "OUTLINE_QUESTION_INVALID");
	if (args.answers.length > OUTLINE_QUESTION_LIMITS.group)
		throw new OutlineQuestionError(OUTLINE_QUESTION_TEXT.groupTooBig, "OUTLINE_QUESTION_INVALID");
	const blocks = await blocksById(
		store,
		args.answers.map((a) => a.blockId),
	);
	const spaceIds = new Set([...blocks.values()].map((b) => b.spaceId));
	if (spaceIds.size > 1)
		throw new OutlineQuestionError(OUTLINE_QUESTION_TEXT.oneSpace, "OUTLINE_QUESTION_INVALID");
	const [spaceId] = [...spaceIds];
	const space = spaceId ? await store.getSpace(spaceId) : null;
	const at = (args.now?.() ?? new Date()).toISOString();
	const ops: OutlineOp[] = [];
	const seen = new Set<string>();
	for (const input of args.answers) {
		const block = blocks.get(input.blockId);
		if (!block || !space || !block.askJson || seen.has(block.id))
			throw new OutlineQuestionError(
				OUTLINE_QUESTION_TEXT.notFound(input.blockId),
				"OUTLINE_QUESTION_NOT_FOUND",
			);
		seen.add(block.id);
		const address = `${space.key}/${block.sid}`;
		const state = questionState(block.askJson, block.deleted);
		if (state !== "open")
			throw new OutlineQuestionError(
				OUTLINE_QUESTION_TEXT.notOpen(address, state),
				"OUTLINE_QUESTION_DECIDED",
			);
		if (block.askJson.to.kind !== "human" || block.askJson.to.id !== args.userId)
			throw new OutlineQuestionError(OUTLINE_QUESTION_TEXT.notYours, "OUTLINE_QUESTION_NOT_YOURS");
		const answer = answerFor(block.askJson, address, input, { kind: "human", id: args.userId }, at);
		if (typeof answer === "string")
			throw new OutlineQuestionError(answer, "OUTLINE_QUESTION_INVALID");
		ops.push({
			op: "update",
			block: { id: block.id },
			baseVersionSeq: block.versionSeq,
			ask: { ...block.askJson, answer },
		});
	}
	if (!space)
		throw new OutlineQuestionError(
			OUTLINE_QUESTION_TEXT.notFound("?"),
			"OUTLINE_QUESTION_NOT_FOUND",
		);
	if (!(await canWriteSpace(await principalOf(args.userId), space)))
		throw new OutlineQuestionError(
			OUTLINE_QUESTION_TEXT.cannotWriteSpace,
			"OUTLINE_QUESTION_NOT_YOURS",
		);
	const labels = [...blocks.values()].map((b) => b.alias ?? b.sid);
	const result = await writeOutline(
		{
			spaceId: space.id,
			ops,
			actor: { kind: "human", id: args.userId },
			responsibleUserId: args.userId,
			summary: `Answered ${labels.join(", ")}`.slice(0, OUTLINE_LIMITS.maxSummaryChars),
		},
		{ store, kind: "answer", ...(args.now ? { now: args.now } : {}) },
	);
	questionsChanged();
	const answered = [...seen];
	if (args.deliver !== false) {
		try {
			await deliverOutlineAnswers(answered, { store, ...(args.now ? { now: args.now } : {}) });
		} catch (error) {
			logger.warn("Outline answers committed; telling the askers failed (left to the sweep)", {
				error: String(error),
			});
		}
	}
	return { spaceId: space.id, commitId: result.commit?.id ?? null, answered };
}

// ─────────────────────────────────────────────────────────────────────────────
// Telling the asker
// ─────────────────────────────────────────────────────────────────────────────

/** What delivering needs from the session layer: a seam tests replace. */
export interface OutlineAnswerDelivery {
	/** Write the message (as the person's turn) and wake the session when idle. */
	deliver(
		narratorId: string,
		message: { content: string; createdBy: string | null; executionUserId: string | null },
	): Promise<void>;
}

let deliverySeam: OutlineAnswerDelivery | null = null;

/** Replace the delivery (tests); null restores the real one. Returns the previous. */
export function setOutlineAnswerDelivery(
	next: OutlineAnswerDelivery | null,
): OutlineAnswerDelivery | null {
	const previous = deliverySeam;
	deliverySeam = next;
	return previous;
}

const realDelivery: OutlineAnswerDelivery = {
	async deliver(narratorId, message) {
		const { deliverInjection } = await import("../narrator-injection");
		await deliverInjection(narratorId, {
			content: message.content,
			source: "outline_answer",
			role: "user",
			schedule: "wakeIfIdle",
			createdBy: message.createdBy,
			...(message.executionUserId
				? { executionPrincipal: { version: 1 as const, userId: message.executionUserId } }
				: {}),
		});
	},
};

function describeAnswer(ask: OutlineAskJson): string {
	const answer = ask.answer;
	if (!answer) return "";
	const parts: string[] = [];
	if (answer.option !== undefined) {
		const option = ask.options?.[answer.option - 1];
		parts.push(`option ${answer.option}${option ? ` (${option})` : ""}`);
	}
	if (answer.text) parts.push(`"${answer.text}"`);
	const choice = parts.join(": ") || "your recommendation";
	return answer.adopted ? `${choice}, your recommendation` : choice;
}

/** The message an asking session reads: its questions and their answers. */
function answerMessage(
	entries: ReadonlyArray<{ block: OutlineBlockRow; spaceKey: string; ask: OutlineAskJson }>,
	who: string,
): string {
	const lines = [`${who} answered your questions in the outline:`];
	for (const { block, spaceKey, ask } of entries) {
		const name = `${block.alias ? `${block.alias} ` : ""}[${spaceKey}/${block.sid}]`;
		const title = blockTitle(block.content).slice(0, 200);
		const differs = ask.proceed && !ask.answer?.adopted;
		lines.push(
			`- ${name} ${title} → ${describeAnswer(ask)}${differs ? " (you went ahead with your recommendation: change what you did)" : ""}`,
		);
	}
	lines.push(
		"Tasks that waited only for these can continue. Note the decisions under their tasks if they matter later.",
	);
	return lines.join("\n");
}

/**
 * Tell the asking sessions of the answers to these questions: one message per asking session,
 * waking it when idle. Only answered rows not delivered yet are taken; each is marked once told
 * (or when there is nobody to tell). Errors leave the rows for the sweep.
 */
export async function deliverOutlineAnswers(
	blockIds: readonly string[],
	options: { store?: OutlineStore; now?: () => Date } = {},
): Promise<{ delivered: number; told: string[] }> {
	const store = options.store ?? outlineStore;
	const delivery = deliverySeam ?? realDelivery;
	const rows = (await store.getQuestions(blockIds)).filter(
		(r) => r.state === "answered" && r.deliveredAt === null,
	);
	if (rows.length === 0) return { delivered: 0, told: [] };
	const blocks = await blocksById(
		store,
		rows.map((r) => r.blockId),
	);
	const spaces = new Map<string, OutlineSpaceRow | null>();
	const spaceOf = async (id: string) => {
		if (!spaces.has(id)) spaces.set(id, await store.getSpace(id));
		return spaces.get(id) ?? null;
	};
	const groups = new Map<string, OutlineQuestionRow[]>();
	for (const row of rows) {
		const key = row.askerNarratorId ?? "";
		groups.set(key, [...(groups.get(key) ?? []), row]);
	}
	const now = () => (options.now?.() ?? new Date()).toISOString();
	const told: string[] = [];
	let delivered = 0;
	for (const [asker, list] of groups) {
		const tell = list.filter((r) => {
			const ask = blocks.get(r.blockId)?.askJson;
			return !(r.proceed && ask?.answer?.adopted);
		});
		let target: string | null = null;
		if (tell.length > 0) target = await answerTarget(store, asker || null, tell, blocks);
		if (target && tell.length > 0) {
			const entries: Array<{ block: OutlineBlockRow; spaceKey: string; ask: OutlineAskJson }> = [];
			for (const r of tell) {
				const block = blocks.get(r.blockId);
				if (!block?.askJson) continue;
				entries.push({
					block,
					spaceKey: (await spaceOf(block.spaceId))?.key ?? "?",
					ask: block.askJson,
				});
			}
			const by = entries[0]?.ask.answer?.by.id ?? null;
			const names = by ? await readDisplayNames({ userIds: [by] }) : null;
			await delivery.deliver(target, {
				content: answerMessage(entries, (by && names?.users.get(by)) || "A person"),
				createdBy: by,
				// The asking turn's person runs the wake; another session doing the task runs as it is.
				executionUserId: target === asker ? (tell[0]?.askerUserId ?? null) : null,
			});
			told.push(target);
		}
		delivered += await store.markQuestionsDelivered(
			list.map((r) => r.blockId),
			now(),
		);
	}
	return { delivered, told };
}

/**
 * Who to tell: the asking session while it exists and is not archived; otherwise a live session
 * holding the task one of the questions is under (it took the task over); otherwise nobody.
 */
async function answerTarget(
	store: OutlineStore,
	asker: string | null,
	rows: readonly OutlineQuestionRow[],
	blocks: ReadonlyMap<string, OutlineBlockRow>,
): Promise<string | null> {
	if (asker) {
		const session = (await store.getNarratorRoots([asker])).get(asker);
		if (session && !session.archived && !session.sessionArchived) return asker;
	}
	const now = new Date().toISOString();
	for (const row of rows) {
		const block = blocks.get(row.blockId);
		if (!block) continue;
		const task = (await nearestTasks(store, block.spaceId, [block], { includeSelf: false })).get(
			block.id,
		);
		if (!task) continue;
		const [claim] = await store.getTaskClaims([task.id]);
		const holder = claim?.holderNarratorId;
		if (!holder || (claim.expiresAt !== null && claim.expiresAt <= now)) continue;
		const session = (await store.getNarratorRoots([holder])).get(holder);
		if (session && !session.archived && !session.sessionArchived) return session.root;
	}
	return null;
}

/**
 * Deliver answers a crash left undelivered: those answered at least
 * {@link OUTLINE_QUESTION_LIMITS.sweepAfterMs} ago (younger ones are the commit's own delivery's),
 * at most {@link OUTLINE_QUESTION_LIMITS.sweepBatch} per run.
 */
export async function sweepOutlineAnswerDeliveries(
	options: { store?: OutlineStore; now?: () => Date } = {},
): Promise<number> {
	const store = options.store ?? outlineStore;
	const nowMs = (options.now?.() ?? new Date()).getTime();
	const rows = await store.listUndeliveredAnswers(OUTLINE_QUESTION_LIMITS.sweepBatch);
	const due = rows.filter(
		(r) =>
			r.answeredAt !== null &&
			Date.parse(r.answeredAt) <= nowMs - OUTLINE_QUESTION_LIMITS.sweepAfterMs,
	);
	if (due.length === 0) return 0;
	return (
		await deliverOutlineAnswers(
			due.map((r) => r.blockId),
			options,
		)
	).delivered;
}

// ─────────────────────────────────────────────────────────────────────────────
// Archived sessions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An archived session's unanswered questions in its own session space are withdrawn (nobody
 * continues those tasks): one system commit. Questions it asked in shared spaces stay: they are
 * about the team's tasks, and whoever takes those up is told the answer.
 */
export async function withdrawArchivedSessionQuestions(
	narratorId: string,
	options: { store?: OutlineStore; now?: () => Date } = {},
): Promise<number> {
	const store = options.store ?? outlineStore;
	const space = await store.findSpace({ kind: "session", narratorId });
	if (!space) return 0;
	const rows = (
		await store.listOpenQuestionsByAsker(narratorId, OUTLINE_QUESTION_LIMITS.openPerSession)
	).filter((r) => r.spaceId === space.id);
	if (rows.length === 0) return 0;
	const metas = await store.getBlockMetas(space.id, { ids: rows.map((r) => r.blockId) });
	const at = (options.now?.() ?? new Date()).toISOString();
	const ops: OutlineOp[] = metas
		.filter((m) => !m.deleted && m.askJson && questionState(m.askJson) === "open")
		.map((m) => ({
			op: "update" as const,
			block: { id: m.id },
			baseVersionSeq: m.versionSeq,
			ask: {
				...(m.askJson as OutlineAskJson),
				withdrawn: {
					by: { kind: "system", id: OUTLINE_QUESTION_ACTOR },
					at,
					reason: "the session was archived",
				},
			},
		}));
	if (ops.length === 0) return 0;
	await writeOutline(
		{
			spaceId: space.id,
			ops,
			actor: { kind: "system", id: OUTLINE_QUESTION_ACTOR },
			responsibleUserId: null,
			summary: "Session archived: its questions withdrawn",
		},
		{ store, ...(options.now ? { now: options.now } : {}) },
	);
	questionsChanged();
	return ops.length;
}

/**
 * Withdraw an archived session's own questions when it is archived (on the narrator events),
 * while the outline is on; failures are logged. Returns a handle that stops listening and waits
 * for withdrawals in progress.
 */
export function watchArchivedSessionQuestions(
	options: { store?: OutlineStore; enabled?: () => boolean } = {},
): { stop(): Promise<void> } {
	const enabled = options.enabled ?? isOutlineEnabled;
	const pending = new Set<Promise<void>>();
	const onStatus = (event: { narratorId: string; status: string }) => {
		if (event.status !== "archived" || !enabled()) return;
		const run: Promise<void> = withdrawArchivedSessionQuestions(event.narratorId, options)
			.then(() => undefined)
			.catch((error) =>
				logger.warn("Outline questions of an archived session were not withdrawn", {
					narratorId: event.narratorId,
					error: String(error),
				}),
			)
			.finally(() => {
				pending.delete(run);
			});
		pending.add(run);
	};
	eventBus.on("narrator:status_changed", onStatus);
	return {
		async stop() {
			eventBus.off("narrator:status_changed", onStatus);
			while (pending.size > 0) await Promise.allSettled([...pending]);
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads: the inbox and the page
// ─────────────────────────────────────────────────────────────────────────────

/** One thing in a person's inbox: open questions put to them under the same block (D20). */
export interface OutlineQuestionGroup {
	/** The block they are under (a question, for a question asked at the top of a page). */
	groupBlockId: string;
	spaceId: string;
	pageId: string;
	title: string;
	questionIds: string[];
	/** The asking sessions, oldest question's first. */
	askers: string[];
	createdAt: string;
}

/**
 * A person's open questions, grouped by the block they are under (sub-questions with their
 * question), oldest group first. At most {@link OUTLINE_QUESTION_LIMITS.inboxScan} questions are
 * read; `truncated` when there were more.
 */
export async function listQuestionGroupsForUser(
	userId: string,
	options: { store?: OutlineStore } = {},
): Promise<{ groups: OutlineQuestionGroup[]; truncated: boolean }> {
	const store = options.store ?? outlineStore;
	const rows = await store.listOpenQuestionsForUser(userId, OUTLINE_QUESTION_LIMITS.inboxScan + 1);
	const truncated = rows.length > OUTLINE_QUESTION_LIMITS.inboxScan;
	const taken = rows.slice(0, OUTLINE_QUESTION_LIMITS.inboxScan);
	const bySpace = new Map<string, OutlineQuestionRow[]>();
	for (const row of taken) bySpace.set(row.spaceId, [...(bySpace.get(row.spaceId) ?? []), row]);
	const groups = new Map<string, OutlineQuestionGroup>();
	for (const [spaceId, list] of bySpace) {
		const metas = new Map(
			(await store.getBlockMetas(spaceId, { ids: list.map((r) => r.blockId) })).map((m) => [
				m.id,
				m,
			]),
		);
		const parentIds = [...metas.values()].flatMap((m) =>
			m.parentId !== null && !metas.has(m.parentId) ? [m.parentId] : [],
		);
		for (const meta of await store.getBlockMetas(spaceId, { ids: [...new Set(parentIds)] }))
			metas.set(meta.id, meta);
		for (const row of list) {
			const meta = metas.get(row.blockId);
			if (!meta || meta.deleted) continue;
			const parent = meta.parentId === null ? undefined : metas.get(meta.parentId);
			// A sub-question goes with its question's group; a page-level question is its own.
			const key = parent?.askJson ? (parent.parentId ?? parent.id) : (meta.parentId ?? meta.id);
			const group = groups.get(key) ?? {
				groupBlockId: key,
				spaceId,
				pageId: meta.pageId,
				title: "",
				questionIds: [],
				askers: [],
				createdAt: row.createdAt,
			};
			group.questionIds.push(row.blockId);
			if (row.askerNarratorId && !group.askers.includes(row.askerNarratorId))
				group.askers.push(row.askerNarratorId);
			if (row.createdAt < group.createdAt) group.createdAt = row.createdAt;
			groups.set(key, group);
		}
	}
	const heads = await blocksById(store, [...groups.keys()]);
	for (const group of groups.values())
		group.title = blockTitle(heads.get(group.groupBlockId)?.content ?? "").slice(0, 240);
	return {
		groups: [...groups.values()].sort((a, b) =>
			a.createdAt !== b.createdAt
				? a.createdAt < b.createdAt
					? -1
					: 1
				: a.groupBlockId < b.groupBlockId
					? -1
					: 1,
		),
		truncated,
	};
}

/**
 * The questions under a block (and their sub-questions), or the question itself with its
 * sub-questions, as the inbox, the page's side panel and the `Ask` card show them, for `viewer`
 * (who may answer which). The caller has checked the viewer may read the space.
 */
export async function readQuestionsUnder(
	blockId: string,
	viewer: OutlinePrincipal,
	options: { store?: OutlineStore } = {},
): Promise<OutlineQuestionGroupResponse | null> {
	const store = options.store ?? outlineStore;
	const head = await store.getBlock(blockId);
	if (!head) return null;
	const space = await store.getSpace(head.spaceId);
	if (!space) return null;
	const limit = OUTLINE_QUESTION_LIMITS.group;
	const firstLevel = head.askJson
		? [head]
		: (await store.listChildren(space.id, head.id, OUTLINE_LIMITS.maxSiblings)).filter(
				(b) => b.askJson,
			);
	const questions: OutlineBlockRow[] = [];
	let truncated = false;
	for (const q of firstLevel) {
		if (questions.length >= limit) {
			truncated = true;
			break;
		}
		questions.push(q);
		const items = (await store.listChildren(space.id, q.id, limit + 1)).filter((b) => b.askJson);
		for (const item of items) {
			if (questions.length >= limit) {
				truncated = true;
				break;
			}
			questions.push(item);
		}
	}
	const rows = new Map(
		(await store.getQuestions(questions.map((q) => q.id))).map((r) => [r.blockId, r]),
	);
	const userIds = new Set<string>();
	const narratorIds = new Set<string>();
	for (const q of questions) {
		const ask = q.askJson as OutlineAskJson;
		if (ask.to.kind === "human") userIds.add(ask.to.id);
		if (ask.answer) userIds.add(ask.answer.by.id);
		const asker = rows.get(q.id)?.askerNarratorId;
		if (asker) narratorIds.add(asker);
	}
	const names = await readDisplayNames({ userIds: [...userIds], narratorIds: [...narratorIds] });
	const canWrite = await canWriteSpace(viewer, space);
	const views: OutlineQuestionView[] = questions.map((q) => {
		const ask = q.askJson as OutlineAskJson;
		const row = rows.get(q.id);
		const state = questionState(ask, q.deleted);
		const toId = ask.to.kind === "human" ? ask.to.id : null;
		return {
			blockId: q.id,
			spaceId: space.id,
			sid: q.sid,
			address: `${space.key}/${q.sid}`,
			parentId: q.parentId,
			alias: q.alias,
			text: q.content,
			options: ask.options ?? [],
			recommend: {
				option: ask.recommend.option ?? null,
				text: ask.recommend.text ?? null,
				reason: ask.recommend.reason ?? null,
			},
			proceed: ask.proceed === true,
			state,
			to: { userId: toId, name: toId ? (names.users.get(toId) ?? null) : null },
			answer: ask.answer
				? {
						option: ask.answer.option ?? null,
						text: ask.answer.text ?? null,
						adopted: ask.answer.adopted === true,
						by: { userId: ask.answer.by.id, name: names.users.get(ask.answer.by.id) ?? null },
						at: ask.answer.at,
						relayed: ask.answer.relayed !== undefined,
					}
				: null,
			askedBy: {
				narratorId: row?.askerNarratorId ?? null,
				title: row?.askerNarratorId ? (names.narrators.get(row.askerNarratorId) ?? null) : null,
			},
			createdAt: row?.createdAt ?? null,
			canAnswer: state === "open" && toId === viewer.userId && canWrite,
		};
	});
	return {
		group: {
			blockId: head.id,
			spaceId: space.id,
			spaceKey: space.key,
			pageId: head.pageId,
			title: blockTitle(head.content).slice(0, 240),
			isQuestion: head.askJson !== null,
		},
		questions: views,
		truncated,
	};
}
