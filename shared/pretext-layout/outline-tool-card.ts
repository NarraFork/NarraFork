/**
 * outline-tool-card.ts — what the outline tool cards say, in the reader's words.
 *
 * The cards of `OutlineEdit` (including its `confirm` / `reject` decisions), `OutlineRead`,
 * `OutlineSearch` and `Ask` used to show the call's input and the result the model got: English,
 * bracketed block ids, no titles, nothing that said which task was ticked. They now say what the
 * call did:
 *
 *   - a header line ("勾成完成 修复：… · 记下 3 条", with `✓1 +3 #6` at its right), from
 *     {@link outlineToolSummary} and {@link outlineEditHeaderStats};
 *   - a change list (one line per change: a few words, the block as a titled outline link, status
 *     chips), from {@link outlineEditRows} / {@link outlineDecisionRows} / {@link outlineAskRows};
 *   - the space by its name, the commit as a link to the outline timeline (where it can be
 *     reverted: the card itself has no destructive control).
 *
 * The words come from the server's `metadata.display` (`shared/outline-tool-display.ts`), written
 * when the call ran: titles, a checkbox before and after, the blocks created. A call written
 * before it existed falls back to its input (the references as written, linked where its
 * metadata gives their addresses). Nothing here parses the model-facing result.
 *
 * PURITY: no DOM, no React (shared pretext core). Copy arrives through `labels` (the shell's
 * `ctx.labels`), with English fallbacks.
 */

import { outlineAddressPath, outlineCommitPath } from "../outline-links";
import {
	type OutlineDisplayRef,
	type OutlineDisplaySpace,
	type OutlineDisplayStatus,
	type OutlineEditDisplay,
	outlineEditDisplayCounts,
	readOutlineAskDisplay,
	readOutlineDisplaySpace,
	readOutlineEditDisplay,
} from "../outline-tool-display";
import type { ToolChangePart, ToolChangeRow, ToolStructuredBadge } from "./tool-detail";

type Labels = Readonly<Record<string, string>> | undefined;

/**
 * English copy. `{link}` / `{to}` / `{who}` / `{alias}` / `{label}` / `{commit}` are slots a
 * link or a chip fills; `{n}` / `{seq}` / `{title}` are plain values.
 */
export const OUTLINE_CARD_LABEL_FALLBACKS: Readonly<Record<string, string>> = {
	// Spaces.
	outlineSpaceOwnSession: "This session's notes",
	outlineSpaceSession: "Session notes",
	outlineSpaceProject: "Project",
	outlineSpaceOwnPersonal: "Your personal space",
	outlineSpacePersonal: "Personal space",
	// The commit, and the fold.
	outlineCommitLink: "Commit #{seq} · view in the timeline / revert",
	outlineCommitShort: "commit #{seq}",
	outlineRawFold: "Raw input · result the model saw",
	// Statuses (shared with the task notices).
	taskNoticeStatusTodo: "To do",
	taskNoticeStatusDoing: "In progress",
	taskNoticeStatusDone: "Done",
	taskNoticeStatusCancelled: "Cancelled",
	outlineNoCheckbox: "not a task",
	// Change rows.
	outlineAddedUnder: "Added {n} under {link}",
	outlineAddedPages: "Added {n} page(s)",
	outlineAddedMore: "{n} more",
	outlineMoved: "Moved {link} under {to}",
	outlineMovedToPage: "Made {link} a page",
	outlineReplaced: "Rewrote {link}",
	outlineMerged: "merged with someone's change",
	outlineDeleted: "Deleted {link}",
	outlineDeletedUnder: "Deleted {link} and {n} block(s) under it",
	outlineAssigned: "Handed {link} to {who}",
	outlineUnassigned: "Unassigned {link}",
	outlineAliased: "Gave {link} the alias {alias}",
	outlineUnaliased: "Removed the alias of {link}",
	outlineHeld: "awaiting confirmation",
	outlinePending: "Waiting for {who} to confirm {label}",
	outlinePendingNoWho: "Waiting for confirmation: {label}",
	outlineConfirmed: "Confirmed {label} → {commit}",
	outlineConfirmedNoCommit: "Confirmed {label}",
	outlineRejected: "Rejected {label}",
	outlineWithdrew: "Withdrew {label}",
	outlineMoreChanges: "{n} more change(s) not listed",
	outlineMoreQuestions: "{n} more question(s) not listed",
	outlineConfirmFailed: "Could not confirm {label}",
	outlineConfirming: "Confirm {label}",
	outlineRejecting: "Reject {label}",
	outlineMoreDecisions: "{n} more decision(s) not listed",
	outlineRejectFailed: "Could not reject {label}",
	outlineUntitled: "untitled",
	// Ask.
	outlineAskRecommend: "→ {option}",
	outlineAskWentAhead: "went ahead",
	outlineAskWithdrew: "Withdrew {link}",
	outlineAskRelayed: "Wrote down the answer to {link}",
	// Header summaries.
	outlineSumDone: "Ticked {title} done",
	outlineSumDoing: "Started {title}",
	outlineSumTodo: "Reopened {title}",
	outlineSumCancelled: "Cancelled {title}",
	outlineSumUnchecked: "{title} no longer a task",
	outlineSumAdded: "added {n}",
	outlineSumPages: "{n} new page(s)",
	outlineSumReplaced: "Rewrote {title}",
	outlineSumMoved: "Moved {title}",
	outlineSumDeleted: "Deleted {title}",
	outlineSumAssigned: "Assigned {title}",
	outlineSumAliased: "Aliased {title}",
	outlineSumMore: "+{n}",
	outlineSumConfirmed: "Confirmed {label}",
	outlineSumRejected: "Rejected {label}",
	outlineSumWithdrewChange: "Withdrew {label}",
	outlineSumNoChange: "No change: {what}",
	outlineSumRunning: "Writing: {what}",
	outlineSumFailed: "Not written: {what}",
	outlineSumHeld: "Awaiting confirmation: {what}",
	outlineSumDecisionsFailed: "{n} failed",
	outlineSumAsOfTime: "as of {time}",
	outlineSumBlocks: "{n} blocks",
	outlineSumAsOf: "as of #{n}",
	outlineSumSpaces: "spaces",
	outlineSumAllSpaces: "every space",
	outlineSumResults: "{n} results",
	outlineSearchProcess: "process",
	outlineSumSearch: "Search",
	outlineSumWithdraw: "withdrew {n} question(s)",
	outlineSumRelayed: "wrote down {n} answer(s)",
	outlineSumMoreTruncated: "more not shown",
	outlineSumAsk: "Ask",
	outlineSumEdit: "Edit",
};

function label(labels: Labels, key: string, params?: Record<string, string | number>): string {
	let out = labels?.[key] ?? OUTLINE_CARD_LABEL_FALLBACKS[key] ?? key;
	if (params)
		for (const [k, v] of Object.entries(params)) out = out.replaceAll(`{${k}}`, String(v));
	return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function leaf(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	// A field the server truncated keeps a preview (`{ _truncated, preview }`).
	if (isRecord(value) && typeof value.preview === "string") return value.preview;
	return undefined;
}

/**
 * A row's parts from a template: `{slot}` takes the part given for it, `{value}` its text, and
 * the words between become text parts (trimmed: the row's gap spaces them).
 */
function fill(
	template: string,
	slots: Record<string, ToolChangePart>,
	values: Record<string, string | number> = {},
): ToolChangePart[] {
	const parts: ToolChangePart[] = [];
	const push = (text: string) => {
		const t = text.trim();
		if (t) parts.push({ kind: "text", text: t });
	};
	let last = 0;
	for (const m of template.matchAll(/\{(\w+)\}/g)) {
		const name = m[1] as string;
		const at = m.index ?? 0;
		const slot = slots[name];
		// A value (not a slot) stays in the words around it, filled in below.
		if (!slot) continue;
		push(template.slice(last, at));
		parts.push(slot);
		last = at + m[0].length;
	}
	push(template.slice(last));
	// Values inside text parts.
	return parts.map((part) =>
		part.kind === "text"
			? {
					...part,
					text: part.text.replace(/\{(\w+)\}/g, (all, name: string) =>
						name in values ? String(values[name]) : all,
					),
				}
			: part,
	);
}

/** A block as a titled link (plain text when it has no address). */
function blockLink(ref: OutlineDisplayRef | { address?: string; title: string }): ToolChangePart {
	const href = outlineAddressPath(ref.address);
	const text = ref.title || ref.address || "";
	return {
		kind: "link",
		text,
		...(href ? { href } : {}),
		...(ref.address && ref.address !== text ? { tip: ref.address } : {}),
	};
}

/** A reference as the call wrote it (an id, `key/id`, an alias, a title), linked when known. */
function refLink(ref: string, address?: string): ToolChangePart {
	const href = outlineAddressPath(address ?? ref);
	return {
		kind: "link",
		text: ref.replace(/[[\]`]/g, ""),
		...(href ? { href } : {}),
		...(address && address !== ref ? { tip: address } : {}),
	};
}

const STATUS_COLOR: Record<OutlineDisplayStatus, string> = {
	todo: "gray",
	doing: "blue",
	done: "green",
	cancelled: "gray",
};

const STATUS_KEY: Record<OutlineDisplayStatus, string> = {
	todo: "taskNoticeStatusTodo",
	doing: "taskNoticeStatusDoing",
	done: "taskNoticeStatusDone",
	cancelled: "taskNoticeStatusCancelled",
};

function statusChip(status: OutlineDisplayStatus | null, labels: Labels): ToolChangePart {
	return status
		? { kind: "chip", label: label(labels, STATUS_KEY[status]), color: STATUS_COLOR[status] }
		: { kind: "chip", label: label(labels, "outlineNoCheckbox"), color: "gray" };
}

const CHECKBOX_STATUS: Record<string, OutlineDisplayStatus | null> = {
	" ": "todo",
	"/": "doing",
	x: "done",
	"-": "cancelled",
	todo: "todo",
	doing: "doing",
	done: "done",
	cancelled: "cancelled",
	none: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// Spaces and commits
// ─────────────────────────────────────────────────────────────────────────────

/** The space's name in the reader's words (its key is a chip of its own). */
export function outlineSpaceName(
	space: Pick<OutlineDisplaySpace, "kind"> & Partial<OutlineDisplaySpace>,
	labels: Labels,
): string {
	switch (space.kind) {
		case "session":
			return space.own
				? label(labels, "outlineSpaceOwnSession")
				: space.name || label(labels, "outlineSpaceSession");
		case "project":
			return space.name || label(labels, "outlineSpaceProject");
		case "personal":
			return label(labels, space.own ? "outlineSpaceOwnPersonal" : "outlineSpacePersonal");
		default:
			return space.name || space.kind;
	}
}

/**
 * The chips naming a call's space: its name, and its key as written (verbatim: a key is
 * case-sensitive). From `display.space`, else the bare `metadata.space` of an older call.
 */
export function outlineSpaceChips(
	metadata: Record<string, unknown> | null | undefined,
	labels: Labels,
): ToolStructuredBadge[] {
	const display = readOutlineDisplaySpace(metadata);
	const raw = isRecord(metadata?.space) ? metadata.space : null;
	const key = display?.key ?? leaf(raw?.key);
	const kind = display?.kind ?? leaf(raw?.kind);
	if (!key) return [];
	return [
		...(kind
			? [
					{
						label: outlineSpaceName(display ?? { kind }, labels),
						color: "teal",
						// A project's name or a session's title, as written; it gives way (truncated, in
						// full on hover) so the chips after it stay on the row's one line.
						verbatim: true,
						clip: true,
					},
				]
			: []),
		{ label: key, color: "gray", verbatim: true },
	];
}

/** The commit link's text and path, or null when the call wrote no commit. */
export function outlineCommitLink(
	metadata: Record<string, unknown> | null | undefined,
	labels: Labels,
): { text: string; href: string } | null {
	const commit = isRecord(metadata?.commit) ? metadata.commit : null;
	const seq = typeof commit?.seq === "number" ? commit.seq : undefined;
	const space = isRecord(metadata?.space) ? leaf(metadata.space.key) : undefined;
	const href = space && seq !== undefined ? outlineCommitPath(space, seq) : null;
	return href && seq !== undefined
		? { text: label(labels, "outlineCommitLink", { seq }), href }
		: null;
}

// ─────────────────────────────────────────────────────────────────────────────
// OutlineEdit
// ─────────────────────────────────────────────────────────────────────────────

const HELD_CHIP = (labels: Labels): ToolChangePart => ({
	kind: "chip",
	label: label(labels, "outlineHeld"),
	color: "orange",
});

/** The change list of an edit call that stored its display. */
export function outlineEditRows(display: OutlineEditDisplay, labels: Labels): ToolChangeRow[] {
	// One group of rows per edit: a list too long for the card drops whole edits, and counts them.
	const groups: ToolChangeRow[][] = [];
	for (const op of display.ops) {
		const rows: ToolChangeRow[] = [];
		groups.push(rows);
		const held = op.held ? [HELD_CHIP(labels)] : [];
		switch (op.op) {
			case "set": {
				const link = blockLink(op.target);
				if (op.status) {
					const to = op.status.to;
					rows.push({
						glyph: to === "done" ? "done" : "status",
						parts: [
							link,
							...(op.status.from !== undefined && op.status.from !== to
								? [
										statusChip(op.status.from, labels),
										{ kind: "text" as const, text: "→", tone: "dim" as const },
									]
								: []),
							statusChip(to, labels),
							...held,
						],
					});
				}
				if (op.assignee) {
					const who = op.assignee.to;
					rows.push({
						glyph: "assign",
						parts: [
							...(who
								? fill(label(labels, "outlineAssigned"), {
										link,
										who: { kind: "chip", label: `@${who}`, color: "grape", verbatim: true },
									})
								: fill(label(labels, "outlineUnassigned"), { link })),
							...held,
						],
					});
				}
				if (op.alias) {
					const alias = op.alias.to;
					rows.push({
						glyph: "alias",
						parts: [
							...(alias
								? fill(label(labels, "outlineAliased"), {
										link,
										alias: { kind: "chip", label: alias, color: "teal", verbatim: true },
									})
								: fill(label(labels, "outlineUnaliased"), { link })),
							...held,
						],
					});
				}
				break;
			}
			case "add": {
				const n = op.created.length + (op.more ?? 0);
				rows.push({
					glyph: "add",
					parts: [
						...(op.parent
							? fill(label(labels, "outlineAddedUnder"), { link: blockLink(op.parent) }, { n })
							: fill(label(labels, "outlineAddedPages"), {}, { n })),
						...held,
					],
				});
				for (const created of op.created) {
					rows.push({
						glyph: "child",
						indent: 1,
						parts: [
							blockLink(created),
							...(created.status ? [statusChip(created.status, labels)] : []),
						],
					});
				}
				if (op.more) {
					rows.push({
						glyph: "more",
						indent: 1,
						tone: "dim",
						parts: [{ kind: "text", text: label(labels, "outlineAddedMore", { n: op.more }) }],
					});
				}
				break;
			}
			case "replace":
				rows.push({
					glyph: "edit",
					parts: [
						...fill(label(labels, "outlineReplaced"), { link: blockLink(op.target) }),
						...(op.merged
							? [{ kind: "chip" as const, label: label(labels, "outlineMerged"), color: "yellow" }]
							: []),
						...held,
					],
				});
				break;
			case "move":
				rows.push({
					glyph: "move",
					parts: [
						...(op.to
							? fill(label(labels, "outlineMoved"), {
									link: blockLink(op.target),
									to: blockLink(op.to),
								})
							: fill(label(labels, "outlineMovedToPage"), { link: blockLink(op.target) })),
						...held,
					],
				});
				break;
			case "delete":
				rows.push({
					glyph: "delete",
					tone: "red",
					parts: [
						...(op.under
							? fill(
									label(labels, "outlineDeletedUnder"),
									{ link: blockLink(op.target) },
									{ n: op.under },
								)
							: fill(label(labels, "outlineDeleted"), { link: blockLink(op.target) })),
						...held,
					],
				});
				break;
		}
	}
	return capGroups(
		groups,
		display.more ?? 0,
		display.pending ? [pendingRow(display.pending.label, display.pending.decider, labels)] : [],
		labels,
	);
}

function moreRow(n: number, labels: Labels, key = "outlineMoreChanges"): ToolChangeRow {
	return {
		glyph: "more",
		tone: "dim",
		parts: [{ kind: "text", text: label(labels, key, { n }) }],
	};
}

function pendingRow(pending: string, decider: string | undefined, labels: Labels): ToolChangeRow {
	const chip: ToolChangePart = { kind: "chip", label: pending, color: "orange", verbatim: true };
	return {
		glyph: "pending",
		parts: decider
			? fill(label(labels, "outlinePending"), { label: chip }, { who: decider })
			: fill(label(labels, "outlinePendingNoWho"), { label: chip }),
	};
}

/** Rows a change list draws at most (`CHANGE_ROWS_MAX`). */
const MAX_ROWS = 24;

/**
 * The rows of a change list, at most {@link MAX_ROWS}: whole groups (one change, or one question,
 * each with its rows) while they fit, then a row counting the changes left out (`hidden` more
 * that were never listed), then `tail` (the change held for confirmation), which is always kept.
 */
function capGroups(
	groups: readonly ToolChangeRow[][],
	hidden: number,
	tail: readonly ToolChangeRow[],
	labels: Labels,
	moreKey = "outlineMoreChanges",
): ToolChangeRow[] {
	const listed = groups.filter((group) => group.length > 0);
	const rows = listed.reduce((n, group) => n + group.length, 0);
	if (rows + tail.length + (hidden > 0 ? 1 : 0) <= MAX_ROWS) {
		return [...listed.flat(), ...(hidden > 0 ? [moreRow(hidden, labels, moreKey)] : []), ...tail];
	}
	const budget = MAX_ROWS - tail.length - 1;
	const out: ToolChangeRow[] = [];
	let shown = 0;
	for (const group of listed) {
		if (out.length + group.length > budget) {
			// A first group longer than the whole list (never, at the producers' bounds) still shows.
			if (shown === 0) out.push(...group.slice(0, budget));
			if (shown === 0) shown = 1;
			break;
		}
		out.push(...group);
		shown++;
	}
	return [...out, moreRow(hidden + listed.length - shown, labels, moreKey), ...tail];
}

/** Top-level items of a markdown outline (`- …` at the shallowest indent). */
function topLevelItems(markdown: string): string[] {
	const items: Array<{ indent: number; text: string }> = [];
	for (const line of markdown.split("\n")) {
		const m = /^(\s*)[-*+]\s+(?:\[[ xX/-]\]\s+)?(.*)$/.exec(line);
		if (m) items.push({ indent: (m[1] as string).length, text: (m[2] as string).trim() });
	}
	if (items.length === 0) return [];
	const top = Math.min(...items.map((i) => i.indent));
	return items.filter((i) => i.indent === top).map((i) => i.text);
}

/**
 * The change list of an edit call written before `display` existed: from its input, the
 * references as the call wrote them, linked where its metadata names the block they became.
 */
export function outlineLegacyEditRows(
	inputJson: unknown,
	metadata: Record<string, unknown> | null | undefined,
	labels: Labels,
): ToolChangeRow[] {
	const input = isRecord(inputJson) ? inputJson : null;
	const edits = Array.isArray(input?.edits) ? input.edits : [];
	const done = Array.isArray(metadata?.edits) ? metadata.edits : [];
	const space = isRecord(metadata?.space) ? leaf(metadata.space.key) : undefined;
	/** A reference written as a bare id, in the call's space. */
	const addressOf = (ref: string): string | undefined =>
		ref.includes("/")
			? ref
			: space && /^[A-Za-z0-9][A-Za-z0-9_-]{5,31}$/.test(ref)
				? `${space}/${ref}`
				: undefined;
	const groups: ToolChangeRow[][] = [];
	edits.forEach((raw, index) => {
		if (!isRecord(raw)) return;
		const rows: ToolChangeRow[] = [];
		groups.push(rows);
		const result = isRecord(done[index]) ? done[index] : null;
		const held = result?.pending === true ? [HELD_CHIP(labels)] : [];
		const at = (key: string) => leaf(raw[key]) ?? "";
		const touched = leaf(result?.address);
		if ("set" in raw) {
			const link = refLink(at("set"), touched ?? addressOf(at("set")));
			const box = leaf(raw.checkbox);
			if (box !== undefined && box in CHECKBOX_STATUS) {
				const to = CHECKBOX_STATUS[box] ?? null;
				rows.push({
					glyph: to === "done" ? "done" : "status",
					parts: [link, { kind: "text", text: "→", tone: "dim" }, statusChip(to, labels), ...held],
				});
			}
			if ("assignee" in raw) {
				const who = leaf(raw.assignee);
				rows.push({
					glyph: "assign",
					parts: [
						...(who
							? fill(label(labels, "outlineAssigned"), {
									link,
									who: { kind: "chip", label: `@${who}`, color: "grape", verbatim: true },
								})
							: fill(label(labels, "outlineUnassigned"), { link })),
						...held,
					],
				});
			}
			if ("alias" in raw) {
				const alias = leaf(raw.alias);
				rows.push({
					glyph: "alias",
					parts: [
						...(alias
							? fill(label(labels, "outlineAliased"), {
									link,
									alias: { kind: "chip", label: alias, color: "teal", verbatim: true },
								})
							: fill(label(labels, "outlineUnaliased"), { link })),
						...held,
					],
				});
			}
		} else if ("add" in raw) {
			const parent = at("add");
			const items = topLevelItems(at("markdown"));
			const created = Array.isArray(result?.created) ? result.created : [];
			// `key/`, `project/`, `session/`, `personal/` or `/`: new pages.
			const root = /^(?:[A-Za-z0-9_-]+)?\/$/.test(parent);
			rows.push({
				glyph: "add",
				parts: [
					...(root
						? fill(label(labels, "outlineAddedPages"), {}, { n: items.length })
						: fill(
								label(labels, "outlineAddedUnder"),
								{ link: refLink(parent, addressOf(parent)) },
								{ n: items.length },
							)),
					...held,
				],
			});
			// The created blocks' addresses come in a depth-first order the markdown's own top level
			// does not give; the first one is the first item.
			items.slice(0, 8).forEach((text, i) => {
				const address = i === 0 ? leaf(created[0]) : undefined;
				rows.push({ glyph: "child", indent: 1, parts: [refLink(text, address)] });
			});
			if (items.length > 8) {
				rows.push({
					glyph: "more",
					indent: 1,
					tone: "dim",
					parts: [
						{ kind: "text", text: label(labels, "outlineAddedMore", { n: items.length - 8 }) },
					],
				});
			}
		} else if ("replace" in raw) {
			rows.push({
				glyph: "edit",
				parts: [
					...fill(label(labels, "outlineReplaced"), {
						link: refLink(at("replace"), touched ?? addressOf(at("replace"))),
					}),
					...held,
				],
			});
		} else if ("move" in raw) {
			const to = at("to");
			const root = /\/$/.test(to);
			const link = refLink(at("move"), touched ?? addressOf(at("move")));
			rows.push({
				glyph: "move",
				parts: [
					...(root
						? fill(label(labels, "outlineMovedToPage"), { link })
						: fill(label(labels, "outlineMoved"), { link, to: refLink(to, addressOf(to)) })),
					...held,
				],
			});
		} else if ("delete" in raw) {
			rows.push({
				glyph: "delete",
				tone: "red",
				parts: [
					...fill(label(labels, "outlineDeleted"), {
						link: refLink(at("delete"), touched ?? addressOf(at("delete"))),
					}),
					...held,
				],
			});
		}
	});
	const pending = leaf(metadata?.pending);
	return capGroups(groups, 0, pending ? [pendingRow(pending, undefined, labels)] : [], labels);
}

/** One decision as a call wrote it, and what came of it. */
interface Decision {
	action: "confirm" | "reject";
	label: string;
	/** Its `decided` entry; none when it failed (the result says why). */
	decided?: Record<string, unknown>;
}

/**
 * The decisions of a `confirm` / `reject` call, in the call's order, each matched with what
 * came of it. A decision that failed has no `decided` entry (the server lists only the ones it
 * made, and errs the call only when all of them fail), so it is one of the input's decisions
 * left over once the decided ones are matched.
 */
function decisionsOf(
	inputJson: unknown,
	metadata: Record<string, unknown> | null | undefined,
): Decision[] {
	const decided = (Array.isArray(metadata?.decided) ? metadata.decided : []).filter(isRecord);
	const used = new Set<number>();
	const take = (action: Decision["action"], ref: string) => {
		const want = ref.trim();
		for (const exact of [true, false]) {
			const i = decided.findIndex((entry, k) => {
				const got = leaf(entry[action]);
				return (
					!used.has(k) &&
					got !== undefined &&
					(exact ? got === want : got.toLowerCase() === want.toLowerCase())
				);
			});
			if (i >= 0) {
				used.add(i);
				return decided[i];
			}
		}
		return undefined;
	};
	const input = isRecord(inputJson) ? inputJson : null;
	const out: Decision[] = [];
	for (const raw of Array.isArray(input?.edits) ? input.edits : []) {
		if (!isRecord(raw)) continue;
		const action = "confirm" in raw ? "confirm" : "reject" in raw ? "reject" : null;
		const ref = action ? leaf(raw[action]) : undefined;
		if (!action || ref === undefined) continue;
		const entry = take(action, ref);
		out.push({ action, label: entry ? (leaf(entry[action]) ?? ref) : ref.trim(), decided: entry });
	}
	// Entries no input names (an input cut short): shown as they are.
	decided.forEach((entry, k) => {
		if (used.has(k)) return;
		const action = "confirm" in entry ? "confirm" : "reject";
		const ref = leaf(entry[action]);
		if (ref) out.push({ action, label: ref, decided: entry });
	});
	return out;
}

/**
 * The decisions of a `confirm` / `reject` call: what each confirmed (and the commit it wrote),
 * rejected or withdrew; one that failed in red (its reason is in the call's result).
 *
 * A decision fails only once the call has finished: its `decided` list is the server's answer.
 * Until then (the call waits for approval, or runs) every decision is just what it asks for.
 */
export function outlineDecisionRows(
	inputJson: unknown,
	metadata: Record<string, unknown> | null | undefined,
	labels: Labels,
): ToolChangeRow[] {
	const chip = (text: string): ToolChangePart => ({
		kind: "chip",
		label: text,
		color: "orange",
		verbatim: true,
	});
	const finished = Array.isArray(metadata?.decided);
	const rows: ToolChangeRow[] = [];
	for (const d of decisionsOf(inputJson, metadata)) {
		const entry = d.decided;
		if (!entry && !finished) {
			rows.push({
				glyph: "pending",
				parts: fill(
					label(labels, d.action === "confirm" ? "outlineConfirming" : "outlineRejecting"),
					{
						label: chip(d.label),
					},
				),
			});
		} else if (!entry) {
			rows.push({
				glyph: "failed",
				tone: "red",
				parts: fill(
					label(labels, d.action === "confirm" ? "outlineConfirmFailed" : "outlineRejectFailed"),
					{ label: chip(d.label) },
				),
			});
		} else if (d.action === "confirm") {
			const commit = isRecord(entry.commit) ? entry.commit : null;
			const seq = typeof commit?.seq === "number" ? commit.seq : undefined;
			const space = leaf(entry.space);
			const href = space && seq !== undefined ? outlineCommitPath(space, seq) : null;
			rows.push({
				glyph: "confirm",
				parts:
					seq !== undefined
						? fill(label(labels, "outlineConfirmed"), {
								label: chip(d.label),
								commit: {
									kind: "link",
									text: label(labels, "outlineCommitShort", { seq }),
									...(href ? { href } : {}),
								},
							})
						: fill(label(labels, "outlineConfirmedNoCommit"), { label: chip(d.label) }),
			});
		} else {
			const withdrawn = entry.status === "withdrawn";
			rows.push({
				glyph: withdrawn ? "withdraw" : "reject",
				parts: fill(label(labels, withdrawn ? "outlineWithdrew" : "outlineRejected"), {
					label: chip(d.label),
				}),
			});
		}
	}
	// Past the card's rows: the decisions left out are counted, never dropped silently.
	return capGroups(
		rows.map((row) => [row]),
		0,
		[],
		labels,
		"outlineMoreDecisions",
	);
}

/** Whether an OutlineEdit call's edits are decisions (`confirm` / `reject`). */
export function isOutlineDecisionCall(
	inputJson: unknown,
	metadata: Record<string, unknown> | null | undefined,
): boolean {
	if (Array.isArray(metadata?.decided)) return true;
	const edits = isRecord(inputJson) && Array.isArray(inputJson.edits) ? inputJson.edits : [];
	return edits.length > 0 && edits.every((e) => isRecord(e) && ("confirm" in e || "reject" in e));
}

/**
 * The figures an OutlineEdit's header shows at its right (`✓1 +3 −5 #6`): tasks ticked done,
 * blocks added and deleted, the commit. From the display; an older call shows its commit only.
 */
export function outlineEditHeaderStats(
	metadata: Record<string, unknown> | null | undefined,
): { added: number; removed: number; done?: number; commit?: number } | undefined {
	const commit = isRecord(metadata?.commit) ? metadata.commit : null;
	const seq = typeof commit?.seq === "number" && commit.seq >= 0 ? commit.seq : undefined;
	const display = readOutlineEditDisplay(metadata);
	// The call's totals, counted before the display left any edit out.
	const counts = display ? outlineEditDisplayCounts(display) : { done: 0, added: 0, removed: 0 };
	if (!display && seq === undefined) return undefined;
	return {
		added: counts.added,
		removed: counts.removed,
		...(counts.done > 0 ? { done: counts.done } : {}),
		...(seq !== undefined ? { commit: seq } : {}),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Ask
// ─────────────────────────────────────────────────────────────────────────────

/** The questions an Ask call put (each linked to its block), or what it withdrew / wrote down. */
export function outlineAskRows(
	inputJson: unknown,
	metadata: Record<string, unknown> | null | undefined,
	labels: Labels,
): ToolChangeRow[] {
	const input = isRecord(inputJson) ? inputJson : {};
	const display = readOutlineAskDisplay(metadata);
	const rows: ToolChangeRow[] = [];
	if (Array.isArray(input.withdraw) || Array.isArray(input.answered)) {
		const withdraw = Array.isArray(input.withdraw);
		const refs: string[] = withdraw
			? (input.withdraw as unknown[]).map((r) => leaf(r) ?? "")
			: (input.answered as unknown[]).map((a) => (isRecord(a) ? (leaf(a.question) ?? "") : ""));
		const named = display?.questions ?? [];
		const list =
			named.length > 0 ? named : refs.filter(Boolean).map((ref) => ({ address: ref, title: ref }));
		for (const q of list.slice(0, 24)) {
			const link = blockLink(q);
			rows.push({
				glyph: withdraw ? "withdraw" : "answer",
				parts: [
					...("alias" in q && q.alias
						? [{ kind: "chip" as const, label: q.alias as string, color: "teal", verbatim: true }]
						: []),
					...fill(label(labels, withdraw ? "outlineAskWithdrew" : "outlineAskRelayed"), { link }),
				],
			});
		}
		return rows;
	}
	const questions = Array.isArray(input.questions) ? input.questions : [];
	const addresses = Array.isArray(metadata?.addresses) ? metadata.addresses.map(leaf) : [];
	let k = 0;
	const push = (raw: unknown, sub: boolean) => {
		const q = isRecord(raw) ? raw : {};
		const address = addresses[k++];
		const options = Array.isArray(q.options) ? q.options.map((o) => leaf(o) ?? "") : [];
		const rec = q.recommend;
		const recommended = typeof rec === "number" ? options[rec - 1] : (leaf(rec) ?? undefined);
		rows.push({
			glyph: sub ? "child" : "question",
			...(sub ? { indent: 1 as const } : {}),
			parts: [
				blockLink({ address, title: leaf(q.question) ?? "" }),
				...(recommended
					? [
							{
								kind: "chip" as const,
								label: label(labels, "outlineAskRecommend", { option: recommended.slice(0, 40) }),
								color: "teal",
								verbatim: true,
							},
						]
					: []),
				...(options.length > 0
					? [
							{
								kind: "text" as const,
								text: options.map((o, i) => `${i + 1}. ${o}`).join("  "),
								tone: "dim" as const,
							},
						]
					: []),
			],
		});
	};
	// One group per question, with its sub-questions: a list too long drops whole questions.
	const groups: ToolChangeRow[][] = [];
	for (const raw of questions.slice(0, 10)) {
		const from = rows.length;
		push(raw, false);
		const items = isRecord(raw) ? raw.items : undefined;
		if (Array.isArray(items)) for (const item of items.slice(0, 10)) push(item, true);
		groups.push(rows.slice(from));
	}
	return capGroups(groups, Math.max(0, questions.length - 10), [], labels, "outlineMoreQuestions");
}

// ─────────────────────────────────────────────────────────────────────────────
// Header summaries
// ─────────────────────────────────────────────────────────────────────────────

/** Characters of a title in a header summary. */
const SUMMARY_TITLE_CHARS = 40;

function short(text: string, max = SUMMARY_TITLE_CHARS): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const chars = Array.from(flat);
	return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
}

const STATUS_SUMMARY: Record<string, string> = {
	done: "outlineSumDone",
	doing: "outlineSumDoing",
	todo: "outlineSumTodo",
	cancelled: "outlineSumCancelled",
	none: "outlineSumUnchecked",
};

/**
 * One phrase per change: what the header line says. A task's new status comes first (it is what
 * the reader looks for: "勾成完成 X · 记下 3 条"), then the rest in the call's order; an edit
 * held for confirmation wrote nothing yet, so it comes last and says so ("待确认：…").
 */
function editPhrases(display: OutlineEditDisplay, labels: Labels): string[] {
	const out: string[] = [];
	const ticks = (op: OutlineEditDisplay["ops"][number]) => op.op === "set" && !!op.status;
	const order = [
		...display.ops.filter((op) => !op.held && ticks(op)),
		...display.ops.filter((op) => !op.held && !ticks(op)),
		...display.ops.filter((op) => op.held),
	];
	for (const op of order) {
		const said: string[] = [];
		switch (op.op) {
			case "set": {
				const title = short(op.target.title || op.target.address);
				if (op.status)
					said.push(label(labels, STATUS_SUMMARY[op.status.to ?? "none"] as string, { title }));
				if (op.assignee) said.push(label(labels, "outlineSumAssigned", { title }));
				if (op.alias) said.push(label(labels, "outlineSumAliased", { title }));
				break;
			}
			case "add":
				said.push(
					label(labels, op.parent ? "outlineSumAdded" : "outlineSumPages", {
						n: op.created.length + (op.more ?? 0),
					}),
				);
				break;
			case "replace":
				said.push(label(labels, "outlineSumReplaced", { title: short(op.target.title) }));
				break;
			case "move":
				said.push(label(labels, "outlineSumMoved", { title: short(op.target.title) }));
				break;
			case "delete":
				said.push(label(labels, "outlineSumDeleted", { title: short(op.target.title) }));
				break;
		}
		for (const phrase of said)
			out.push(op.held ? label(labels, "outlineSumHeld", { what: phrase }) : phrase);
	}
	return out;
}

/**
 * The same phrases for an older call, from its input (references as written). An edit its result
 * says was held for confirmation (`metadata.edits[i].pending`) comes last and says so.
 */
function legacyEditPhrases(
	inputJson: unknown,
	labels: Labels,
	metadata?: Record<string, unknown> | null,
): string[] {
	const all = isRecord(inputJson) && Array.isArray(inputJson.edits) ? inputJson.edits : [];
	const results = Array.isArray(metadata?.edits) ? metadata.edits : [];
	const held = new Set(
		all.filter(
			(_, i) => isRecord(results[i]) && (results[i] as { pending?: unknown }).pending === true,
		),
	);
	// A task's new status first, as for a call with its display; held edits last.
	const ticks = (e: unknown) => isRecord(e) && "set" in e && "checkbox" in e;
	const edits = [
		...all.filter((e) => !held.has(e) && ticks(e)),
		...all.filter((e) => !held.has(e) && !ticks(e)),
		...all.filter((e) => held.has(e)),
	];
	const out: string[] = [];
	for (const raw of edits) {
		if (!isRecord(raw)) continue;
		const from = out.length;
		const ref = (key: string) => short(leaf(raw[key]) ?? "");
		if ("set" in raw) {
			const box = leaf(raw.checkbox);
			if (box !== undefined && box in CHECKBOX_STATUS)
				out.push(
					label(labels, STATUS_SUMMARY[CHECKBOX_STATUS[box] ?? "none"] as string, {
						title: ref("set"),
					}),
				);
			if ("assignee" in raw) out.push(label(labels, "outlineSumAssigned", { title: ref("set") }));
			if ("alias" in raw) out.push(label(labels, "outlineSumAliased", { title: ref("set") }));
		} else if ("add" in raw) {
			const n = topLevelItems(leaf(raw.markdown) ?? "").length;
			out.push(
				label(labels, /\/$/.test(leaf(raw.add) ?? "") ? "outlineSumPages" : "outlineSumAdded", {
					n,
				}),
			);
		} else if ("replace" in raw)
			out.push(label(labels, "outlineSumReplaced", { title: ref("replace") }));
		else if ("move" in raw) out.push(label(labels, "outlineSumMoved", { title: ref("move") }));
		else if ("delete" in raw)
			out.push(label(labels, "outlineSumDeleted", { title: ref("delete") }));
		else if ("confirm" in raw)
			out.push(label(labels, "outlineSumConfirmed", { label: ref("confirm") }));
		else if ("reject" in raw)
			out.push(label(labels, "outlineSumRejected", { label: ref("reject") }));
		if (held.has(raw))
			for (let i = from; i < out.length; i++)
				out[i] = label(labels, "outlineSumHeld", { what: out[i] as string });
	}
	return out;
}

/** At most two phrases, then how many more (`hidden`: changes the phrases do not name at all). */
function joinPhrases(phrases: string[], labels: Labels, hidden = 0): string {
	const shown = phrases.slice(0, 2);
	const more = phrases.length - shown.length + hidden;
	return [...shown, ...(more > 0 ? [label(labels, "outlineSumMore", { n: more })] : [])].join(
		" · ",
	);
}

/** Where a call is: still running, failed (or refused, or stopped), or done. */
function callPhase(status: string | undefined): "running" | "failed" | "done" {
	switch (status) {
		case "running":
		case "pending":
		case "initializing":
		case "streaming":
		case "queued":
			return "running";
		case "fail":
		case "error":
		case "denied":
		case "cancelled":
			return "failed";
		default:
			return "done";
	}
}

/** What a call that has not written what it says is, in front of what it says. */
function phased(
	what: string,
	phase: "running" | "failed" | "done",
	noChange: boolean,
	labels: Labels,
): string {
	if (!what) return what;
	if (phase === "running") return label(labels, "outlineSumRunning", { what });
	if (phase === "failed") return label(labels, "outlineSumFailed", { what });
	if (noChange) return label(labels, "outlineSumNoChange", { what });
	return what;
}

/**
 * The header line of an outline tool's card (and of its folded row): what the call did, in the
 * reader's words. The figures (`✓1 +3 #6`) are drawn beside it (`outlineEditHeaderStats`).
 *
 * Only a call that wrote something says it as done. One still running, one that failed, one
 * that changed nothing and an edit held for confirmation say so first ("写入中：", "未写入：",
 * "无改动：", "待确认："). The call's status rides in `metadata._toolStatus` (the shell's summary
 * resolver adds it, as it adds a Send's).
 */
export function outlineToolSummary(
	toolName: string,
	inputJson: unknown,
	metadata: Record<string, unknown> | null | undefined,
	labels: Labels,
): string {
	const meta = metadata ?? {};
	const input = isRecord(inputJson) && !("_truncated" in inputJson) ? inputJson : {};
	const phase = callPhase(leaf(meta._toolStatus));
	switch (toolName) {
		case "OutlineEdit": {
			if (isOutlineDecisionCall(input, meta)) {
				const decisions = decisionsOf(input, meta);
				const made = decisions.filter((d) => d.decided);
				const failed = decisions.length - made.length;
				const phrases = made.map((d) => {
					const entry = d.decided as Record<string, unknown>;
					if (d.action === "confirm") {
						const seq =
							isRecord(entry.commit) && typeof entry.commit.seq === "number"
								? entry.commit.seq
								: undefined;
						return `${label(labels, "outlineSumConfirmed", { label: d.label })}${seq !== undefined ? ` → #${seq}` : ""}`;
					}
					return label(
						labels,
						entry.status === "withdrawn" ? "outlineSumWithdrewChange" : "outlineSumRejected",
						{ label: d.label },
					);
				});
				// Before the result (running), or none made (failed): what the call tried.
				if (made.length === 0)
					return (
						phased(joinPhrases(legacyEditPhrases(input, labels), labels), phase, false, labels) ||
						label(labels, "outlineSumEdit")
					);
				const said = joinPhrases(phrases, labels);
				return failed > 0
					? `${said} · ${label(labels, "outlineSumDecisionsFailed", { n: failed })}`
					: said;
			}
			const display = phase === "done" ? readOutlineEditDisplay(meta) : null;
			const phrases = display
				? editPhrases(display, labels)
				: legacyEditPhrases(input, labels, meta);
			// Nothing written, nothing held, nothing to say it with: the edits changed nothing.
			const noChange =
				!display && "commit" in meta && meta.commit === null && !meta.pending && phase === "done";
			return (
				phased(joinPhrases(phrases, labels, display?.more ?? 0), phase, noChange, labels) ||
				label(labels, "outlineSumEdit")
			);
		}
		case "OutlineRead": {
			const title = leaf(meta.title);
			const address = leaf(input.address) ?? leaf(meta.address) ?? "";
			const blocks = typeof meta.blocks === "number" ? meta.blocks : undefined;
			// The commit it read as of; while running (or failed), what the call asked for, which may
			// be a time.
			const asked = input.asOf;
			const asOf =
				typeof meta.asOf === "number"
					? label(labels, "outlineSumAsOf", { n: meta.asOf })
					: typeof asked === "number"
						? label(labels, "outlineSumAsOf", { n: asked })
						: typeof asked === "string" && asked.trim()
							? label(labels, "outlineSumAsOfTime", { time: short(asked, 24) })
							: undefined;
			const head = title
				? short(title, 48)
				: address === "*"
					? label(labels, "outlineSumAllSpaces")
					: address
						? short(address, 48)
						: label(labels, "outlineSumSpaces");
			return [
				head,
				...(asOf ? [asOf] : []),
				...(blocks !== undefined ? [label(labels, "outlineSumBlocks", { n: blocks })] : []),
			].join(" · ");
		}
		case "OutlineSearch": {
			const query = leaf(input.query) ?? leaf(meta.query) ?? "";
			const n = typeof meta.resultCount === "number" ? meta.resultCount : undefined;
			const count = n !== undefined ? label(labels, "outlineSumResults", { n }) : null;
			if (!query) return count ?? label(labels, "outlineSumSearch");
			return [`\u201c${short(query, 48)}\u201d`, ...(count ? [count] : [])].join(" · ");
		}
		case "Ask": {
			// Asking is the call itself: only a failed one says it did not happen.
			const askPhase = phase === "failed" ? phase : "done";
			if (Array.isArray(input.withdraw))
				return phased(
					label(labels, "outlineSumWithdraw", { n: input.withdraw.length }),
					askPhase,
					false,
					labels,
				);
			if (Array.isArray(input.answered))
				return phased(
					label(labels, "outlineSumRelayed", { n: input.answered.length }),
					askPhase,
					false,
					labels,
				);
			const questions = Array.isArray(input.questions) ? input.questions : [];
			const first = isRecord(questions[0]) ? leaf(questions[0].question) : undefined;
			if (!first) return label(labels, "outlineSumAsk");
			let total = 0;
			for (const q of questions) {
				total++;
				if (isRecord(q) && Array.isArray(q.items)) total += q.items.length;
			}
			return phased(
				total > 1
					? `${short(first, 48)} · ${label(labels, "outlineSumMore", { n: total - 1 })}`
					: short(first, 60),
				askPhase,
				false,
				labels,
			);
		}
		default:
			return toolName;
	}
}
