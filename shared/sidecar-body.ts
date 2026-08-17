/**
 * sidecar-body.ts — Structured payload for a system injection (side-car).
 *
 * ## Why this exists
 *
 * A side-car is a block the server injects into what the model reads: a progress
 * reminder, a Dynamic Spec task digest, a background task's result, a message from
 * a teammate. Historically each of the ~12 injection points assembled its own
 * STRING (`content`) out of local variables it already had in structured form —
 * XML wrappers, `[System]` prefixes, `- ` bullet markers, `join("\n")` — and that
 * string was the only thing persisted.
 *
 * That made the UI's job impossible in the right way: to show anything better than
 * a wall of pre-wrap text it had to parse the wall back apart with regexes, one
 * per injection point, guessing at the structure the producer had just discarded.
 *
 * So the producers now ALSO emit a `SideCarBody`: the same information, still
 * structured. `content` stays exactly as it was (the model-facing snapshot, still
 * produced by each source's existing formatter — see the note below), and the UI
 * reads `body` instead of parsing `content`.
 *
 * ## content vs body — two projections, one truth
 *
 *   `content`  the model-facing text. Frozen at write time, byte-for-byte what the
 *              model saw. Read by `appendSideCarsForApi` and every provider's
 *              buildHistory. NEVER re-derived at read time: re-rendering it later
 *              would let a copy-tweak retroactively rewrite historical context.
 *   `body`     the structured truth. Read by the UI, which projects it to lines via
 *              `sideCarBodyToMarkdown`.
 *
 * Both are produced at the SAME call site from the SAME locals, which is what keeps
 * them consistent. `body` is optional: a row written before this existed (or by a
 * source not yet structured) has `body === undefined`, and the UI falls back to
 * showing `content` verbatim. There is deliberately NO compatibility parsing —
 * old rows look exactly as they always did.
 *
 * ## What the two audiences get
 *
 * They are NOT the same text, and that is the point. A Dynamic Spec reminder tells
 * the model "keep tasks.json to only text/status/protected, do not add IDs…" —
 * prompt engineering the reader has no use for. So `sideCarBodyToMarkdown` projects
 * only the parts worth READING (the heading, the tasks, the sender, the result) and
 * drops the model-facing boilerplate. That is why the body carries semantic
 * discriminants (`variant`, `flavor`, `role`) rather than pre-worded strings: each
 * side words it for its own audience, and no string needs duplicating across the
 * server/frontend boundary.
 *
 * Zero DOM, zero React, no `server/` imports (this type is reachable from
 */

import { knowledgeExcerpt } from "./knowledge-excerpt";

// ─────────────────────────────────────────────────────────────────────────────
// Body payloads
// ─────────────────────────────────────────────────────────────────────────────

/** One open task in a Dynamic Spec digest. */
export interface SideCarTaskEntry {
	/** Why this task is in the digest (its position, not its raw status). */
	role: "doing" | "next" | "todo" | "blocked";
	text: string;
	protected?: boolean;
}

/** One knowledge-base entry the injection surfaced. */
export interface SideCarKnowledgeHit {
	entryId: string;
	title: string;
	summary: string;
}

/** One finished background task (subagent or bash). */
export interface SideCarDoneTask {
	id: string;
	/** Human-facing alias, when the task was launched with one (bash). */
	alias?: string | null;
	title: string;
	status: string;
	/** Short result/output preview (already capped by the producer). */
	preview: string;
	/** The producer clipped the preview. */
	truncated?: boolean;
	/**
	 * The message INSIDE the agent's own session that produced this result — the
	 * navigation target when the reader opens that session from this row.
	 *
	 * Agent flavour only, and only when one could be resolved: a `bash` task has no
	 * session to open, and an agent that produced no assistant text has no message
	 * to aim at (see `getSubagentResultMessageId`). Absent means "open the session
	 * at its tail", never "jump somewhere arbitrary".
	 *
	 * NOT model-facing: the projections ignore it (a message id is meaningless to
	 * the model, which addresses agents by alias).
	 */
	resultMessageId?: string | null;
}

/** One message delivered from another narrator (subagent / team / buffered user). */
export interface SideCarInboundMessage {
	fromId?: string;
	fromTitle?: string | null;
	/** Readable alias of the sender, preferred over the id when untitled. */
	fromLabel?: string | null;
	fromType?: string | null;
	/**
	 * Where this message sits in the SENDER's own session — the navigation target
	 * when the reader opens that session from this row.
	 *
	 * Recorded at send time as the sender's latest message, because a `Send` is not
	 * itself a message in the sender's history: the closest thing to "where the
	 * sender was when it said this" is what it had just written. Absent when the
	 * sender had written nothing yet, or for senders that are not narrators —
	 * absence means "open at the tail", never "jump somewhere arbitrary".
	 *
	 * NOT model-facing: the projections ignore it.
	 */
	fromMessageId?: string | null;
	/** Team channel only: the message went to everyone. */
	isBroadcast?: boolean;
	text: string;
}

/** One spec file the user changed through the UI. */
export interface SideCarSpecUpdate {
	uri: string;
	timestamp: string;
	updatedBy: string;
	/** tasks.json only: compiled digest of the open tasks after the save. */
	taskSummary?: string | null;
	/** Other files: short content preview. */
	preview?: string | null;
}

/**
 * The structured form of a side-car's content.
 *
 * A discriminated union so adding a shape is a compile error at every consumer
 * (`projectSideCarBody` switches exhaustively) rather than a silent fallthrough.
 */
export type SideCarBody =
	/**
	 * A fixed reminder whose wording lives in each side's own copy tables, keyed by
	 * the side-car's `source`. `params` carries the only variable parts.
	 */
	| { kind: "notice"; params?: Record<string, string | number> }
	/** A block of prose the user or the system authored (behaviour fence, buffered message). */
	| { kind: "prose"; text: string }
	/**
	 * A Dynamic Spec task digest. `variant` says WHICH digest this is, so each side
	 * can word its own heading (the model gets instructions, the reader gets a
	 * one-line summary).
	 */
	| {
			kind: "tasks";
			variant: "current" | "emptyNever" | "emptyDone" | "tooMany";
			tasks?: SideCarTaskEntry[];
			/** `tooMany` only: how many tasks tripped the threshold. */
			taskCount?: number;
			/** `tooMany` only: the threshold that was exceeded. */
			threshold?: number;
			/**
			 * Periodic digests only: the cadence (in completed tool calls) that raised
			 * this reminder. Lets the reader-facing header say "每 N 次工具调用" so a
			 * routine digest is distinguishable from a turn-end continuation at a
			 * glance. Persisted with the block; absent on continuation/task rows.
			 */
			cadenceInterval?: number;
	  }
	/** Knowledge-base entries matched against recent output. */
	| { kind: "knowledge"; hits: SideCarKnowledgeHit[] }
	/** Background tasks that finished while the narrator was working. */
	| { kind: "tasksDone"; flavor: "agent" | "bash"; items: SideCarDoneTask[] }
	/** Messages delivered from other narrators. */
	| { kind: "messages"; items: SideCarInboundMessage[] }
	/** Spec files the user edited through the UI. */
	| { kind: "specUpdates"; items: SideCarSpecUpdate[] };

/** Every `kind` value, for runtime validation of persisted JSON. */
const SIDECAR_BODY_KINDS = new Set([
	"notice",
	"prose",
	"tasks",
	"knowledge",
	"tasksDone",
	"messages",
	"specUpdates",
]);

/**
 * Narrow a value read back from `body_json` (or a WS payload) to a `SideCarBody`.
 *
 * Structural, not exhaustive: it checks the discriminant and that the shape's
 * collection field is an array. A row whose JSON predates a field simply projects
 * fewer lines; the point is that a malformed / unknown payload falls back to the
 * verbatim `content` path instead of throwing inside a render pass.
 */
export function coerceSideCarBody(value: unknown): SideCarBody | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const kind = (value as { kind?: unknown }).kind;
	if (typeof kind !== "string" || !SIDECAR_BODY_KINDS.has(kind)) return undefined;
	const body = value as SideCarBody;
	switch (body.kind) {
		case "prose":
			return typeof body.text === "string" ? body : undefined;
		case "knowledge":
			return Array.isArray(body.hits) ? body : undefined;
		case "tasksDone":
		case "messages":
		case "specUpdates":
			return Array.isArray(body.items) ? body : undefined;
		case "tasks":
			// `tasks` is optional (the empty/tooMany variants carry none), so only its
			// presence-as-a-non-array is disqualifying.
			return body.tasks === undefined || Array.isArray(body.tasks) ? body : undefined;
		case "notice":
			return body;
	}
}

/**
 * Read the structured body off a side-car record, whichever shape it arrived in.
 *
 * Two wire shapes reach the frontend and neither is worth normalizing away at the
 * source:
 *   - `body`      — the WS event payload, which mirrors `AgentSideCar`.
 *   - `bodyJson`  — an HTTP-loaded row, where the field is the DB column name and
 *                   the whole row is spread through several passthrough layers
 *                   (`hydrateToolUseSideCars`, `truncateToolIO`,
 *                   `enrichToolUseBlocks`) that deliberately do not reshape rows.
 *
 * Renaming the column on the way out would mean teaching every one of those layers
 * about this one field; reading both here costs one `??`.
 */
export function readSideCarBody(record: unknown): SideCarBody | undefined {
	if (!record || typeof record !== "object") return undefined;
	const row = record as { body?: unknown; bodyJson?: unknown };
	return coerceSideCarBody(row.body ?? row.bodyJson);
}

// ─────────────────────────────────────────────────────────────────────────────
// UI projection (an intermediate line form, consumed only by the Markdown pass)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A projected line's role, mapped to Markdown by `presentationToMarkdown`.
 *
 * Deliberately NOT exported: it is a private staging vocabulary between the body
 * switch and the Markdown emitter. The one thing outside this module ever sees is
 * the Markdown string.
 *
 * `verbatim` is the one kind that is NOT prose: it carries preformatted machine output
 * (a background command's stdout/stderr) that must reach the reader byte-for-byte, so
 * the emitter fences it instead of escaping it line by line. The distinction cannot be
 * recovered later — by the time the emitter sees a `text` line, whether its leading
 * spaces were a linter's gutter or an accident of prose is unknowable.
 */
type SideCarLineKind = "heading" | "text" | "bullet" | "meta" | "verbatim";

interface SideCarLine {
	kind: SideCarLineKind;
	text: string;
}

interface SideCarPresentation {
	/** The injection's title line. Never empty for a structured body. */
	headline: string;
	/** The body lines. Empty when the headline says everything. */
	lines: SideCarLine[];
}

/**
 * Copy the projection needs, injected the same way every other adapter string is
 * (`ctx.labels`). Keys are resolved through {@link SIDECAR_PRESENTATION_FALLBACKS}
 * when absent, so a hand-written fixture never renders blank.
 */
export type SideCarLabels = Readonly<Record<string, string>>;

/**
 * English fallbacks for the projection's copy.
 *
 * These are USER-FACING and deliberately short — the model-facing instruction
 * boilerplate that shares an injection with them is not projected at all (see the
 * module header on the two audiences), so it never needs an entry here.
 *
 * `{n}` / `{name}` / `{uri}` are interpolated by `fill` below.
 */
export const SIDECAR_PRESENTATION_FALLBACKS: Readonly<Record<string, string>> = {
	// Per-source headline for the fixed reminders.
	noticeSilentProgress: "You have made {count} tool calls without a visible reply",
	noticeRelaxedPlan: "Still planning — write the plan to {planFile}, do not implement yet",
	noticePipelineExit: "Pipeline is still active — confirm whether it is still needed",
	// Dynamic Spec digests.
	tasksCurrent: "Dynamic Spec — {n} open task(s)",
	tasksEmptyNever: "Dynamic Spec — no tasks created yet",
	tasksEmptyDone: "Dynamic Spec — all tasks done, time to reorganize",
	tasksTooMany: "Dynamic Spec — {n} tasks, over the reorganize threshold",
	taskRoleDoing: "doing",
	taskRoleNext: "next",
	taskRoleTodo: "todo",
	taskRoleBlocked: "blocked",
	taskProtected: "protected",
	// Knowledge base.
	knowledgeHeading: "{n} relevant knowledge entr(y/ies)",
	// Background tasks.
	tasksDoneAgentHeading: "{n} background agent(s) finished",
	tasksDoneBashHeading: "{n} background command(s) finished",
	tasksDoneTruncated: "result truncated",
	// Inbound messages.
	messagesHeading: "{n} message(s)",
	messageFromUnknown: "unknown sender",
	messageBroadcast: "broadcast",
	// Spec updates.
	specUpdatesHeading: "{n} spec file(s) updated by you",
	// Behaviour fence.
	proseFenceHeading: "Behaviour fence",
	// Generic.
	empty: "(empty)",
};

function label(labels: SideCarLabels | undefined, key: string): string {
	return labels?.[key] ?? SIDECAR_PRESENTATION_FALLBACKS[key] ?? key;
}

function fill(
	template: string,
	params: Readonly<Record<string, string | number>> | undefined,
): string {
	if (!params) return template;
	let out = template;
	for (const [k, v] of Object.entries(params)) out = out.replaceAll(`{${k}}`, String(v));
	return out;
}

function labelWith(
	labels: SideCarLabels | undefined,
	key: string,
	params: Readonly<Record<string, string | number>>,
): string {
	return fill(label(labels, key), params);
}

/**
 * Collapse a value to one readable line (used for headlines derived from prose).
 *
 * The slice comes BEFORE the whitespace collapse on purpose. `replace(/\s+/g, " ")`
 * over a multi-megabyte body would allocate a multi-megabyte intermediate string only
 * to throw all but `max` chars of it away. A prefix of `max * 2` cannot change the
 * result: collapsing only ever shortens, so any run of whitespace past that prefix
 * lands beyond the cut anyway.
 */
function flatten(text: string, max = 160): string {
	const cut = max * 2;
	if (text.length <= cut) {
		const compact = text.replace(/\s+/g, " ").trim();
		return compact.length <= max ? compact : `${compact.slice(0, max)}…`;
	}
	const compact = text.slice(0, cut).replace(/\s+/g, " ").trim();
	if (compact.length > max) return `${compact.slice(0, max)}…`;
	// A whitespace-heavy prefix can collapse to under `max` even though the input was
	// long, so the ellipsis has to be decided by whether real text survives past the
	// cut. Probed by searching forward FROM the cut position (a `g` regex resumes at
	// `lastIndex`; note this is not `y`/sticky, which would require a match exactly AT
	// that index) rather than with `slice(cut).trim()`, so the discarded tail is never
	// materialized.
	const probe = /\S/g;
	probe.lastIndex = cut;
	return probe.test(text) ? `${compact}…` : compact;
}

/**
 * Hard ceiling on the lines ONE projection may emit.
 *
 * The measure layer already refuses to lay out more than `SIDECAR_DETAIL_MAX_LINES`
 * (40) rows, but it reaches that decision AFTER this projection has built the whole
 * array — so an item carrying a 200k-line preview used to cost a 200k-element array
 * per measure pass to then draw 40 of them. Capping here keeps the cost proportional
 * to what can ever be painted. Deliberately above the measure ceiling: `lines` also
 * feeds `totalLineCount`, and a projection clipped at exactly 40 would report "40
 * lines" for a body of thousands.
 *
 * `fullText` (the copy control) is unaffected — the complete text stays one click away.
 */
export const SIDECAR_PROJECTION_MAX_LINES = 200;

/**
 * Split prose into `text` lines, collapsing blank runs.
 *
 * Blank lines become nothing rather than an empty line: the render layer expresses
 * the separation with block spacing, and an actually-painted blank line inside a
 * fixed-height body lane is one measured row of nothing (the `spec_update`
 * `header\n\nbody` shape used to draw exactly that).
 *
 * `budget` bounds how many lines this call may contribute, so a projection that
 * concatenates several prose runs (messages, tasksDone, specUpdates) stays under
 * `SIDECAR_PROJECTION_MAX_LINES` in total rather than per item.
 */
function proseLines(text: string, budget = SIDECAR_PROJECTION_MAX_LINES): SideCarLine[] {
	const out: SideCarLine[] = [];
	if (budget <= 0) return out;
	for (const raw of text.split("\n")) {
		if (out.length >= budget) break;
		const line = raw.trimEnd();
		if (!line.trim()) continue;
		out.push({ kind: "text", text: line });
	}
	return out;
}

/** Remaining line budget for a projection that has already emitted `lines`. */
function remainingBudget(lines: readonly SideCarLine[]): number {
	return SIDECAR_PROJECTION_MAX_LINES - lines.length;
}

/** Headline for the fixed-copy reminders, keyed by side-car source. */
function noticeHeadline(
	source: string,
	params: Readonly<Record<string, string | number>> | undefined,
	labels: SideCarLabels | undefined,
): string {
	switch (source) {
		case "silent_progress":
			return labelWith(labels, "noticeSilentProgress", { count: params?.count ?? 0 });
		case "relaxed_plan":
			// A row written before the reminder named the plan file has no `planFile`
			// param, so the placeholder would render literally. Fall back to the
			// directory, which is where every plan file lives anyway.
			return labelWith(labels, "noticeRelaxedPlan", {
				planFile: params?.planFile ?? ".narrafork/plans/",
			});
		case "pipeline_exit_confirmation":
			return label(labels, "noticePipelineExit");
		default:
			// An unmapped notice source: the caller's own source label is the best we
			// can say, and it is already painted beside the headline.
			return "";
	}
}

/** Sender prefix for one inbound message. */
function senderLabel(message: SideCarInboundMessage, labels: SideCarLabels | undefined): string {
	const name = message.fromTitle?.trim() || message.fromId?.slice(0, 8) || "";
	const base = name || label(labels, "messageFromUnknown");
	const type = message.fromType?.trim();
	const suffix = message.isBroadcast ? ` · ${label(labels, "messageBroadcast")}` : "";
	return type ? `${base} (${type})${suffix}` : `${base}${suffix}`;
}

/**
 * Project a structured body to the lines the reader sees.
 *
 * Exhaustive over `SideCarBody["kind"]` — adding a shape without teaching this
 * function about it is a compile error, which is the whole reason the payload is a
 * discriminated union.
 *
 * Private: the only consumer is {@link sideCarBodyToMarkdown}. The lines are a
 * staging form, not an API.
 */
function projectSideCarBody(
	source: string,
	body: SideCarBody,
	labels?: SideCarLabels,
): SideCarPresentation {
	switch (body.kind) {
		case "notice": {
			// A fixed reminder is one sentence: it belongs entirely in the headline, so
			// the folded row already shows everything and there is nothing to unfold.
			return { headline: noticeHeadline(source, body.params, labels), lines: [] };
		}

		case "prose": {
			// The fence is a named thing, so it gets a stable heading; any other prose
			// (a buffered user message) has no name and its own first line is the best
			// headline. Either way the full text stays in `lines`, because the headline
			// is a one-line flattening and the reader must be able to see the rest.
			const headline =
				source === "behavior_fence" ? label(labels, "proseFenceHeading") : flatten(body.text);
			return { headline, lines: proseLines(body.text) };
		}

		case "tasks": {
			const tasks = body.tasks ?? [];
			const headline =
				body.variant === "current"
					? labelWith(labels, "tasksCurrent", { n: tasks.length })
					: body.variant === "emptyNever"
						? label(labels, "tasksEmptyNever")
						: body.variant === "emptyDone"
							? label(labels, "tasksEmptyDone")
							: labelWith(labels, "tasksTooMany", { n: body.taskCount ?? 0 });
			// Only the tasks are projected. The digest's other half — "keep tasks.json to
			// only text/status/protected", "do not add IDs" — is instruction aimed at the
			// model; showing it to the reader is the noise this redesign removes.
			// A `todo` task used to also carry `dimmed: true` here. It was dead on arrival:
			// `SideCarLine` has no such field (the spread of an object literal is how it got
			// past the excess-property check), and the only consumer of these lines —
			// `presentationToMarkdown` — has no Markdown to map it to and says so. The role
			// prefix already in the text ("todo: …") is what carries that distinction.
			const lines: SideCarLine[] = tasks.slice(0, SIDECAR_PROJECTION_MAX_LINES).map((task) => ({
				kind: "bullet" as const,
				text: `${label(labels, taskRoleKey(task.role))}: ${task.text}${
					task.protected ? ` · ${label(labels, "taskProtected")}` : ""
				}`,
			}));
			return { headline, lines };
		}

		case "knowledge": {
			return {
				headline: labelWith(labels, "knowledgeHeading", { n: body.hits.length }),
				lines: body.hits.slice(0, SIDECAR_PROJECTION_MAX_LINES).map((hit) => {
					// `summary` is a flattened slice of the entry's Markdown body, so it can
					// still carry `#` / `>` / backtick debris (rows written before the server
					// stripped it hold raw Markdown outright). Strip it to prose here too —
					// the transform is idempotent, so a clean excerpt passes through — and
					// drop a first line that only repeats the title this bullet already shows.
					const excerpt = knowledgeExcerpt(hit.summary ?? "", { title: hit.title });
					return {
						kind: "bullet" as const,
						text: excerpt ? `${hit.title} — ${excerpt}` : hit.title,
					};
				}),
			};
		}

		case "tasksDone": {
			const key = body.flavor === "bash" ? "tasksDoneBashHeading" : "tasksDoneAgentHeading";
			const lines: SideCarLine[] = [];
			for (const item of body.items) {
				if (remainingBudget(lines) <= 0) break;
				const name = item.title?.trim() || item.alias?.trim() || item.id;
				lines.push({ kind: "heading", text: `${name} · ${item.status}` });
				// A bash task's preview is verbatim stdout/stderr, so it stays ONE
				// preformatted run rather than one paragraph per line: `proseLines` drops
				// blank lines and trims nothing else, and the emitter then escapes each
				// line independently — which loses exactly the column alignment that makes
				// a compiler or linter diagnostic readable. An agent task's preview is a
				// report the subagent authored as Markdown, so it keeps the prose path.
				const preview = item.preview?.trim();
				if (preview && body.flavor === "bash") {
					lines.push({ kind: "verbatim", text: preview });
				} else {
					lines.push(...proseLines(preview || label(labels, "empty"), remainingBudget(lines)));
				}
				if (item.truncated) lines.push({ kind: "meta", text: label(labels, "tasksDoneTruncated") });
			}
			return {
				headline: labelWith(labels, key, { n: body.items.length }),
				lines,
			};
		}

		case "messages": {
			const lines: SideCarLine[] = [];
			for (const message of body.items) {
				if (remainingBudget(lines) <= 0) break;
				const from = senderLabel(message, labels);
				if (from) lines.push({ kind: "heading", text: from });
				lines.push(...proseLines(message.text, remainingBudget(lines)));
			}
			// One message from a named sender reads better with the sender on the folded
			// row than a bare "1 message".
			const single = body.items.length === 1 ? body.items[0] : undefined;
			const headline =
				single && senderLabel(single, labels)
					? senderLabel(single, labels)
					: labelWith(labels, "messagesHeading", { n: body.items.length });
			return { headline, lines };
		}

		case "specUpdates": {
			const single = body.items.length === 1 ? body.items[0] : undefined;
			const lines: SideCarLine[] = [];
			for (const item of body.items) {
				if (remainingBudget(lines) <= 0) break;
				// A SINGLE update already names the file in the headline, so repeating the
				// uri as a body heading printed `spec://tasks.json` twice — once as the
				// title and once as the only body line. Only a multi-file delivery needs
				// per-item headings to tell the entries apart.
				if (!single) lines.push({ kind: "heading", text: item.uri });
				const detail = item.taskSummary ?? item.preview;
				if (detail) lines.push(...proseLines(detail, remainingBudget(lines)));
			}
			return {
				headline: single
					? single.uri
					: labelWith(labels, "specUpdatesHeading", { n: body.items.length }),
				lines,
			};
		}
	}
}

function taskRoleKey(role: SideCarTaskEntry["role"]): string {
	switch (role) {
		case "doing":
			return "taskRoleDoing";
		case "next":
			return "taskRoleNext";
		case "blocked":
			return "taskRoleBlocked";
		case "todo":
			return "taskRoleTodo";
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Model projection — the ONE place a body becomes model-facing text
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The model-facing copy a body needs, injected by the server.
 *
 * Every value is a TEMPLATE with `{placeholder}` slots, resolved from
 * `server/lib/i18n.ts` (see `sideCarModelTemplates`). They live there rather than
 * here because they are prompt copy — localized, versioned and edited alongside the
 * rest of the model-facing strings — while this module owns only the assembly.
 *
 * Keys are grouped by body kind; each renderer below documents the ones it reads.
 */
export type SideCarModelTemplates = Readonly<Record<string, string>>;

function tpl(
	templates: SideCarModelTemplates,
	key: string,
	params?: Readonly<Record<string, string | number>>,
): string {
	return fill(templates[key] ?? "", params);
}

/**
 * Assemble the model-facing text for a structured body.
 *
 * ## Byte-for-byte parity is the contract
 *
 * This replaces twelve hand-rolled `join("\n")` sites, and the text it produces goes
 * straight into the model's context. So every branch below reproduces its
 * predecessor's output EXACTLY — same wrappers, same prefixes, same blank lines,
 * same trailing hints. `shared/__tests__/sidecar-body.test.ts` pins that against the
 * original formatters, which are all still exported (they have non-side-car callers
 * too, e.g. the compact-context builder).
 *
 * That is also why the shapes below look more verbose than the UI projection: the
 * model gets the instruction boilerplate ("do not add IDs…", "Use Await(…)") that
 * the reader-facing projection deliberately drops.
 */
export function renderSideCarBodyToText(
	source: string,
	body: SideCarBody,
	templates: SideCarModelTemplates,
): string {
	switch (body.kind) {
		case "notice":
			// One fixed string per source, parameterized. `noticeKey` maps the source to
			// its template so an unmapped source yields "" rather than a wrong reminder.
			return tpl(templates, noticeModelKey(source), body.params);

		case "prose":
			// `proseHeading` is optional: the fence prefixes a heading line, a buffered
			// user message is emitted bare (it is the user's own words).
			return joinHeading(tpl(templates, `${source}Heading`), body.text);

		case "tasks":
			return renderTasksToText(body, templates);

		case "knowledge": {
			// `formatInjectionsBare`: heading, one `- [id] title: summary` per hit, then a
			// blank line and the read-more hint.
			const lines = body.hits.map((hit) => `- [${hit.entryId}] ${hit.title}: ${hit.summary}`);
			return `${tpl(templates, "knowledgeHeading")}\n${lines.join("\n")}\n\n${tpl(
				templates,
				"knowledgeReadHint",
			)}`;
		}

		case "tasksDone":
			return body.items
				.map((item) =>
					body.flavor === "bash"
						? // `[System] Background bash "title" (ID: alias) status.` + preview line.
							tpl(templates, "bgBashEntry", {
								title: item.title || item.id,
								id: item.alias ?? item.id,
								status: item.status,
								preview: item.preview || tpl(templates, "emptyResult"),
							})
						: // Agent flavour additionally tells the model how to follow up, so its
							// id slot is an Await/Send selector — the alias, like bash above.
							tpl(templates, "bgAgentEntry", {
								title: item.title,
								id: item.alias ?? item.id,
								status: item.status,
								preview: item.preview || tpl(templates, "emptyResult"),
							}),
				)
				.join("\n\n");

		case "messages":
			return body.items
				.map((message) => {
					if (source === "buffered_user") return message.text;
					const isTeam = source === "team_message";
					// An untitled sender is named by its readable alias when the producer
					// supplied one. The id fallbacks behind it are what the two channels
					// historically used (team: the FULL id; parent report: an 8-char prefix)
					// and are kept for rows persisted before `fromLabel` existed.
					const name = isTeam
						? (message.fromTitle ?? message.fromLabel ?? message.fromId ?? "")
						: message.fromTitle?.trim() ||
							message.fromLabel?.trim() ||
							message.fromId?.slice(0, 8) ||
							"";
					return tpl(templates, isTeam ? "teamMessageEntry" : "subagentMessageEntry", {
						name,
						type: message.fromType ?? "",
						channel: tpl(templates, message.isBroadcast ? "teamBroadcast" : "teamDirect"),
						text: message.text,
					});
				})
				.join(source === "team_message" ? "\n" : "\n\n");

		case "specUpdates": {
			// `formatSpecUpdateSideCars`: one heading, a blank line, then per-file blocks.
			const blocks = body.items.map((item) => {
				const head = tpl(templates, "specUpdateEntry", {
					uri: item.uri,
					timestamp: item.timestamp,
				});
				if (item.taskSummary) return `${head}\n${item.taskSummary}`;
				if (item.preview) return `${head}\n${tpl(templates, "specUpdatePreview")}\n${item.preview}`;
				return head;
			});
			return `${tpl(templates, "specUpdateHeading")}\n\n${blocks.join("\n\n")}`;
		}
	}
}

/** Prefix `text` with `heading` when there is one (the fence shape). */
function joinHeading(heading: string, text: string): string {
	return heading ? `${heading}\n${text}` : text;
}

/** Model template key for a fixed reminder, by side-car source. */
function noticeModelKey(source: string): string {
	switch (source) {
		case "silent_progress":
			return "noticeSilentProgress";
		case "relaxed_plan":
			return "noticeRelaxedPlan";
		case "pipeline_exit_confirmation":
			return "noticePipelineExit";
		default:
			return "";
	}
}

/**
 * The Dynamic Spec digest, in its four variants.
 *
 * A heading, the task lines (`- role: text [protected]`), then ONE situation-specific
 * instruction line. The wording arrives as templates so it stays in the server's i18n
 * table.
 *
 * ## Why this is deliberately short
 *
 * This digest is injected MID-TURN, on a tool-call cadence (every 15 by default), so
 * its cost is paid over and over inside a single piece of work. The rules that used to
 * ride along with it — how `tasks.json` may be shaped, what makes a task finite, when
 * `protected` is allowed, what to do about a blocked entry — are all already in the
 * system prompt (`getDynamicSpecSystemReminder`, which embeds
 * `blockedTaskActionInstructions` verbatim). Repeating them here bought nothing: the
 * model had read them at position zero and would read them again on the next request.
 *
 * So each variant now carries only what the SYSTEM PROMPT CANNOT say — the live task
 * state and the one action this particular situation calls for. The turn-end
 * continuation prompts (`maybeStartSpecContinuation`) are a separate, rarer surface and
 * stay as verbose as they need to be.
 */
function renderTasksToText(
	body: Extract<SideCarBody, { kind: "tasks" }>,
	templates: SideCarModelTemplates,
): string {
	const lines: string[] = [];
	switch (body.variant) {
		case "current": {
			lines.push(tpl(templates, "tasksCurrentHeading"));
			for (const task of body.tasks ?? []) {
				lines.push(`- ${task.role}: ${task.text}${task.protected ? " [protected]" : ""}`);
			}
			lines.push(tpl(templates, "tasksCurrentUpdateNote"));
			break;
		}
		case "emptyNever":
			lines.push(
				tpl(templates, "tasksEmptyHeading"),
				tpl(templates, "tasksEmptyNeverCreate"),
				tpl(templates, "tasksEmptyNeverSkip"),
			);
			break;
		case "emptyDone":
			lines.push(
				tpl(templates, "tasksEmptyHeading"),
				tpl(templates, "tasksEmptyDoneReorganize"),
				tpl(templates, "tasksEmptyDoneContinue"),
			);
			break;
		case "tooMany":
			lines.push(
				tpl(templates, "tasksTooManyHeading", {
					count: body.taskCount ?? 0,
					threshold: body.threshold ?? 0,
				}),
				tpl(templates, "tasksTooManyReorganize"),
			);
			break;
	}
	return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown projection — the reader-facing form for a `system_injection` message
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Project a body to Markdown — the reader-facing form of an injection.
 *
 * An injection lives on its own message row, and `heading` / `text` / `bullet` /
 * `meta` are a strict subset of Markdown, so this targets Markdown and the row reuses
 * the `markdown` element kind's existing measure/render machinery (headings, lists,
 * wrapping, prepared-block cache) instead of carrying geometry of its own.
 *
 * ## The two projections of one body
 *
 *   `renderSideCarBodyToText`  → model-facing. Carries the instruction boilerplate.
 *   `sideCarBodyToMarkdown`    → reader-facing, THIS one. Drops that boilerplate.
 *
 * Both read the SAME `SideCarBody`, so the reader and the model can never be shown
 * contradictory facts — only differently edited ones.
 *
 * Returns `""` when there is nothing worth showing; the caller should then fall back
 * to the verbatim `content` via {@link rawSideCarToMarkdown}.
 */
export function sideCarBodyToMarkdown(
	source: string,
	body: SideCarBody,
	labels?: SideCarLabels,
): string {
	const presentation = projectSideCarBody(source, body, labels);
	return presentationToMarkdown(presentation);
}

/**
 * Markdown for an injection with no structured body: the raw text, verbatim.
 *
 * Deliberately NOT parsed: no XML unwrapping, no `[System]` stripping, no bullet
 * detection. Guessing at structure a producer discarded is complexity this design does
 * not take on. The text is emitted inside a fenced block so that a
 * historical `<side_car source="…">` wrapper renders as visible characters instead of
 * being eaten by the Markdown renderer as an HTML tag.
 */
export function rawSideCarToMarkdown(content: string): string {
	const trimmed = content.trim();
	if (!trimmed) return "";
	return looksLikeMarkup(trimmed) ? fence(trimmed) : trimmed;
}

/**
 * Markdown for VERBATIM machine output — always a fenced block.
 *
 * For a background command's stdout/stderr, {@link rawSideCarToMarkdown} is the wrong
 * projection: it only fences text that looks like a TAG, so everything else is handed
 * to the Markdown parser as if a human had authored it. Real tool output is full of
 * characters Markdown owns, and each one silently restructures the block:
 *
 *   `! This variable is unused`   → nothing special, but `> `/`#` lines become quotes
 *                                  and headings
 *   `  55 │ it("…", async () => {` → a leading-indent line becomes an INDENTED CODE
 *                                  block, so one diagnostic renders as prose and the
 *                                  next as a code card
 *   `|  a  |  b  |`               → a GFM table
 *
 * That is exactly what a reader saw from `bunx biome check`: alternating prose and
 * code cards, the alignment that carried the meaning gone. Output from a compiler,
 * linter or test runner is preformatted text whose columns and whitespace ARE the
 * content, so it goes in a code block unconditionally — no sniffing, because the
 * heuristic can only ever be wrong in the direction of mangling it.
 *
 * Returns `""` for blank content so the caller can decide what "it finished with no
 * output" should say; an empty fence would just be a hollow card.
 */
export function verbatimOutputToMarkdown(content: string): string {
	const trimmed = content.trim();
	if (!trimmed) return "";
	return fence(trimmed);
}

/**
 * Turn a projected presentation into Markdown.
 *
 * Kept separate from {@link sideCarBodyToMarkdown} so the mapping from line kinds to
 * Markdown is testable on hand-built presentations.
 */
function presentationToMarkdown(presentation: SideCarPresentation): string {
	const blocks: string[] = [];
	const headline = presentation.headline.trim();
	// `######`, i.e. the SMALLEST heading level, which is 14px bold — the same size as
	// body text, differing only in weight (see `HEADING` in pretext-fonts).
	//
	// This started at `###` on the reasoning that an injection is a note rather than a
	// document. Right direction, stopped too early: `###` is 22px against a 14px body, so
	// in a bubble only a few lines tall the title took ~44% of the content height. Worse,
	// it is largely REDUNDANT — the bubble's own header row already names the producer, so
	// the big heading restated at display size what the chrome had just said.
	//
	// Weight, not size, is what separates a title from its body at this scale.
	if (headline) blocks.push(`###### ${escapeMarkdown(headline)}`);

	// Consecutive bullets must land in ONE block to form a single list; a blank line
	// between them would make each its own one-item list.
	let bullets: string[] = [];
	const flushBullets = () => {
		if (bullets.length === 0) return;
		blocks.push(bullets.join("\n"));
		bullets = [];
	};

	for (const line of presentation.lines) {
		// A verbatim run keeps its own whitespace: `trim()` would strip the indentation
		// of its FIRST and LAST lines only, silently de-aligning one row of a diagnostic
		// against the rest. The emptiness check still runs on a trimmed copy, since a
		// whitespace-only block is nothing to show either way.
		const text = line.kind === "verbatim" ? line.text : line.text.trim();
		if (!text.trim()) continue;
		switch (line.kind) {
			case "bullet":
				// Every bullet is emitted the same way. A secondary bullet (a `todo` task)
				// has no Markdown equivalent worth inventing — italics would fight the
				// surrounding text — so the distinction lives in the text itself, as the
				// role prefix ("todo: …") the tasks projection writes.
				bullets.push(`- ${escapeMarkdown(text)}`);
				break;
			case "heading":
				flushBullets();
				// Body headings (a finished task's name, an inbound sender) sit UNDER the
				// headline, but there is no smaller level left than `######` — and none is
				// needed: at 14px the distinction that matters is bold-vs-regular, which both
				// already have. Keeping `####` (18px) here would reintroduce the same
				// oversized-title problem one level down, and a background delivery with five
				// tasks would carry five of them.
				blocks.push(`###### ${escapeMarkdown(text)}`);
				break;
			case "meta":
				flushBullets();
				// Secondary annotation ("result truncated"). Italic is the lightest
				// Markdown that reads as an aside.
				blocks.push(`*${escapeMarkdown(text)}*`);
				break;
			case "text":
				flushBullets();
				blocks.push(looksLikeMarkup(text) ? fence(text) : escapeMarkdown(text));
				break;
			case "verbatim":
				flushBullets();
				// Preformatted machine output: fenced whole, never escaped line by line.
				// Escaping would preserve the CHARACTERS but not the layout — the
				// alignment is what a diagnostic's gutter and indentation mean.
				blocks.push(fence(text));
				break;
		}
	}
	flushBullets();

	return blocks.join("\n\n");
}

/** Wrap text in a fence wide enough that its own backticks cannot close it. */
function fence(text: string): string {
	let longest = 0;
	// Scan for the longest backtick run so the fence can always outgrow it.
	const runs = text.match(/`+/g);
	if (runs) for (const run of runs) longest = Math.max(longest, run.length);
	const ticks = "`".repeat(Math.max(3, longest + 1));
	return `${ticks}\n${text}\n${ticks}`;
}

/**
 * True when the text carries markup that a Markdown renderer would consume.
 *
 * Only an XML/HTML-ish tag qualifies. This is aimed at exactly one real case: the
 * `<side_car>` / `<tasks_reminder>` / `<progress_update_request>` wrappers that the
 * MODEL-facing copy uses. Those strings reach this projection whenever a producer
 * puts pre-wrapped text into a `prose` body, and rendering them as tags would make
 * the injection appear empty.
 */
function looksLikeMarkup(text: string): boolean {
	return /<\/?[a-zA-Z][\w-]*(\s[^<>]*)?>/.test(text);
}

/**
 * Escape the Markdown constructs that would misread injected text.
 *
 * Restricted on purpose to the leading markers that turn a line into a structure it
 * was not meant to be (`- ` into a list, `#` into a heading, `>` into a quote, `1.`
 * into an ordered list) plus the inline emphasis characters. Escaping every special
 * character would litter ordinary prose — task texts and teammate messages are
 * written by humans and read as prose, not as source.
 */
/**
 * Escape the characters that would otherwise be parsed as Markdown syntax.
 *
 * ⚠️ Underscores are deliberately NOT escaped, and that is a fix rather than an
 * oversight. Two independent reasons, both verified against the real parser:
 *
 *  1. It is unnecessary. CommonMark only opens emphasis at a word boundary, so an
 *     in-word `_` never becomes emphasis: `marked.parse("ask_in_passing")` and
 *     `marked.parse("ask\\_in\\_passing")` produce the identical `<p>ask_in_passing</p>`.
 *  2. It actively leaked. `marked` turns `\_` into an `escape` token whose `text` is
 *     `_`, but the list-item path here reads `item.text` — the RAW string, backslash
 *     included — so every `snake_case` identifier inside a bullet rendered as
 *     `ask\_in\_passing`. Task digests are almost entirely identifiers, so the
 *     "protection" cost a screenful of stray backslashes and bought nothing.
 *
 * So underscores are escaped only where they can ACTUALLY open or close emphasis: at a
 * word boundary (`_kwargs_` → escaped) but not between word characters
 * (`ask_in_passing` → left alone). Verified against `marked`: `_kwargs_` yields `<em>`,
 * while `snake_case_name`, `_leading` and `trailing_` all stay literal.
 *
 * The rest of the set genuinely changes the parse in every position: `*` (emphasis works
 * mid-word), backticks, link brackets, and line-leading list / quote / heading markers.
 */
export function escapeMarkdown(text: string): string {
	return (
		text
			.replace(/([*`[\]])/g, "\\$1")
			// A boundary underscore: not preceded by a word char, or not followed by one.
			.replace(/(?<![0-9A-Za-z])_|_(?![0-9A-Za-z])/g, "\\_")
			.replace(/^(\s*)([-+>#])/gm, "$1\\$2")
			.replace(/^(\s*)(\d+)\./gm, "$1$2\\.")
	);
}
