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
	outlineSumNoChange: "no change",
	outlineSumBlocks: "{n} blocks",
	outlineSumAsOf: "as of #{n}",
	outlineSumSpaces: "spaces",
	outlineSumAllSpaces: "every space",
	outlineSumResults: "{n} results",
	outlineSearchProcess: "process",
	outlineSumSearch: "Search",
	outlineSumWithdraw: "withdrew {n} question(s)",
	outlineSumRelayed: "wrote down {n} answer(s)",
	outlineSumQuestions: "{n} questions",
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
	const rows: ToolChangeRow[] = [];
	for (const op of display.ops) {
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
	if (display.more) rows.push(moreRow(display.more, labels));
	if (display.pending)
		rows.push(pendingRow(display.pending.label, display.pending.decider, labels));
	return capRows(rows, labels);
}

function moreRow(n: number, labels: Labels): ToolChangeRow {
	return {
		glyph: "more",
		tone: "dim",
		parts: [{ kind: "text", text: label(labels, "outlineMoreChanges", { n }) }],
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

/** At most `CHANGE_ROWS_MAX` rows: the rest are counted in a last row. */
function capRows(rows: ToolChangeRow[], labels: Labels, max = 24): ToolChangeRow[] {
	if (rows.length <= max) return rows;
	const kept = rows.slice(0, max - 1);
	return [...kept, moreRow(rows.length - kept.length, labels)];
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
	const rows: ToolChangeRow[] = [];
	edits.forEach((raw, index) => {
		if (!isRecord(raw)) return;
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
	if (pending) rows.push(pendingRow(pending, undefined, labels));
	return capRows(rows, labels);
}

/** The decisions of a `confirm` / `reject` call. */
export function outlineDecisionRows(
	inputJson: unknown,
	metadata: Record<string, unknown> | null | undefined,
	labels: Labels,
): ToolChangeRow[] {
	const decided = Array.isArray(metadata?.decided) ? metadata.decided : null;
	const rows: ToolChangeRow[] = [];
	const chip = (text: string): ToolChangePart => ({
		kind: "chip",
		label: text,
		color: "orange",
		verbatim: true,
	});
	if (decided) {
		for (const raw of decided.slice(0, 24)) {
			if (!isRecord(raw)) continue;
			const confirmed = leaf(raw.confirm);
			const rejected = leaf(raw.reject);
			if (confirmed) {
				const commit = isRecord(raw.commit) ? raw.commit : null;
				const seq = typeof commit?.seq === "number" ? commit.seq : undefined;
				const space = leaf(raw.space);
				const href = space && seq !== undefined ? outlineCommitPath(space, seq) : null;
				rows.push({
					glyph: "confirm",
					parts:
						seq !== undefined
							? fill(label(labels, "outlineConfirmed"), {
									label: chip(confirmed),
									commit: {
										kind: "link",
										text: label(labels, "outlineCommitShort", { seq }),
										...(href ? { href } : {}),
									},
								})
							: fill(label(labels, "outlineConfirmedNoCommit"), { label: chip(confirmed) }),
				});
			} else if (rejected) {
				rows.push({
					glyph: raw.status === "withdrawn" ? "withdraw" : "reject",
					parts: fill(
						label(labels, raw.status === "withdrawn" ? "outlineWithdrew" : "outlineRejected"),
						{
							label: chip(rejected),
						},
					),
				});
			}
		}
		return rows;
	}
	// A failed decision call has no `decided`: its input says what it tried.
	const input = isRecord(inputJson) ? inputJson : null;
	for (const raw of Array.isArray(input?.edits) ? input.edits.slice(0, 24) : []) {
		if (!isRecord(raw)) continue;
		const c = leaf(raw.confirm);
		const r = leaf(raw.reject);
		if (c)
			rows.push({
				glyph: "confirm",
				parts: fill(label(labels, "outlineConfirmedNoCommit"), { label: chip(c) }),
			});
		else if (r)
			rows.push({
				glyph: "reject",
				parts: fill(label(labels, "outlineRejected"), { label: chip(r) }),
			});
	}
	return rows;
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
	for (const raw of questions.slice(0, 10)) {
		push(raw, false);
		const items = isRecord(raw) ? raw.items : undefined;
		if (Array.isArray(items)) for (const item of items.slice(0, 10)) push(item, true);
	}
	return capRows(rows, labels);
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
 * the reader looks for: "勾成完成 X · 记下 3 条"); the rest keep the call's order.
 */
function editPhrases(display: OutlineEditDisplay, labels: Labels): string[] {
	const out: string[] = [];
	const first = display.ops.filter((op) => op.op === "set" && op.status);
	const rest = display.ops.filter((op) => !(op.op === "set" && op.status));
	for (const op of [...first, ...rest]) {
		switch (op.op) {
			case "set": {
				const title = short(op.target.title || op.target.address);
				if (op.status)
					out.push(label(labels, STATUS_SUMMARY[op.status.to ?? "none"] as string, { title }));
				if (op.assignee) out.push(label(labels, "outlineSumAssigned", { title }));
				if (op.alias) out.push(label(labels, "outlineSumAliased", { title }));
				break;
			}
			case "add":
				out.push(
					label(labels, op.parent ? "outlineSumAdded" : "outlineSumPages", {
						n: op.created.length + (op.more ?? 0),
					}),
				);
				break;
			case "replace":
				out.push(label(labels, "outlineSumReplaced", { title: short(op.target.title) }));
				break;
			case "move":
				out.push(label(labels, "outlineSumMoved", { title: short(op.target.title) }));
				break;
			case "delete":
				out.push(label(labels, "outlineSumDeleted", { title: short(op.target.title) }));
				break;
		}
	}
	return out;
}

/** The same phrases for an older call, from its input (references as written). */
function legacyEditPhrases(inputJson: unknown, labels: Labels): string[] {
	const all = isRecord(inputJson) && Array.isArray(inputJson.edits) ? inputJson.edits : [];
	// A task's new status first, as for a call with its display.
	const ticks = (e: unknown) => isRecord(e) && "set" in e && "checkbox" in e;
	const edits = [...all.filter(ticks), ...all.filter((e) => !ticks(e))];
	const out: string[] = [];
	for (const raw of edits) {
		if (!isRecord(raw)) continue;
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
	}
	return out;
}

/** At most two phrases, then how many more. */
function joinPhrases(phrases: string[], labels: Labels): string {
	if (phrases.length <= 2) return phrases.join(" · ");
	return `${phrases.slice(0, 2).join(" · ")} · ${label(labels, "outlineSumMore", { n: phrases.length - 2 })}`;
}

/**
 * The header line of an outline tool's card (and of its folded row): what the call did, in the
 * reader's words. The figures (`✓1 +3 #6`) are drawn beside it (`outlineEditHeaderStats`).
 */
export function outlineToolSummary(
	toolName: string,
	inputJson: unknown,
	metadata: Record<string, unknown> | null | undefined,
	labels: Labels,
): string {
	const meta = metadata ?? {};
	const input = isRecord(inputJson) && !("_truncated" in inputJson) ? inputJson : {};
	switch (toolName) {
		case "OutlineEdit": {
			if (Array.isArray(meta.decided)) {
				const phrases = (meta.decided as unknown[]).flatMap((raw) => {
					if (!isRecord(raw)) return [];
					const c = leaf(raw.confirm);
					const r = leaf(raw.reject);
					if (c) {
						const seq =
							isRecord(raw.commit) && typeof raw.commit.seq === "number"
								? raw.commit.seq
								: undefined;
						return [
							`${label(labels, "outlineSumConfirmed", { label: c })}${seq !== undefined ? ` → #${seq}` : ""}`,
						];
					}
					if (r)
						return [
							label(
								labels,
								raw.status === "withdrawn" ? "outlineSumWithdrewChange" : "outlineSumRejected",
								{
									label: r,
								},
							),
						];
					return [];
				});
				return joinPhrases(phrases, labels) || label(labels, "outlineSumEdit");
			}
			const display = readOutlineEditDisplay(meta);
			const phrases = display ? editPhrases(display, labels) : legacyEditPhrases(input, labels);
			if (display?.more) phrases.push(label(labels, "outlineSumMore", { n: display.more }));
			return joinPhrases(phrases, labels) || label(labels, "outlineSumEdit");
		}
		case "OutlineRead": {
			const title = leaf(meta.title);
			const address = leaf(input.address) ?? leaf(meta.address) ?? "";
			const blocks = typeof meta.blocks === "number" ? meta.blocks : undefined;
			const asOf =
				typeof meta.asOf === "number"
					? meta.asOf
					: typeof input.asOf === "number"
						? input.asOf
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
				...(asOf !== undefined ? [label(labels, "outlineSumAsOf", { n: asOf })] : []),
				...(blocks !== undefined ? [label(labels, "outlineSumBlocks", { n: blocks })] : []),
			].join(" · ");
		}
		case "OutlineSearch": {
			const query = leaf(input.query) ?? leaf(meta.query) ?? "";
			const n = typeof meta.resultCount === "number" ? meta.resultCount : undefined;
			const count = n !== undefined ? label(labels, "outlineSumResults", { n }) : null;
			if (!query) return count ?? label(labels, "outlineSumSearch");
			return [`“${short(query, 48)}”`, ...(count ? [count] : [])].join(" · ");
		}
		case "Ask": {
			if (Array.isArray(input.withdraw))
				return label(labels, "outlineSumWithdraw", { n: input.withdraw.length });
			if (Array.isArray(input.answered))
				return label(labels, "outlineSumRelayed", { n: input.answered.length });
			const questions = Array.isArray(input.questions) ? input.questions : [];
			const first = isRecord(questions[0]) ? leaf(questions[0].question) : undefined;
			if (!first) return label(labels, "outlineSumAsk");
			let total = 0;
			for (const q of questions) {
				total++;
				if (isRecord(q) && Array.isArray(q.items)) total += q.items.length;
			}
			return total > 1
				? `${short(first, 48)} · ${label(labels, "outlineSumMore", { n: total - 1 })}`
				: short(first, 60);
		}
		default:
			return toolName;
	}
}
