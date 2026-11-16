/**
 * Browser fixture of the history of any block (pageless outline, F2): the forest's fixture
 * (`OutlineView` against the real outline routes, `../forest/outline-forest.browser-fixture`)
 * plus what the history screens show — the timeline strip, the side panel's history, the
 * history bar, the comparison, the marks on the forest as of a point, and the restore dialog.
 */
export * from "../forest/outline-forest.browser-fixture";

const q = <T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document) => [
	...root.querySelectorAll<T>(selector),
];

/** The seqs of the timeline strip's ticks, oldest first; `current` is the one shown. */
export function ticks(): { seqs: number[]; current: number | null } {
	const all = q("[data-testid=outline-timeline] [data-seq]");
	const current = all.find((tick) => tick.getAttribute("aria-current") === "true");
	return {
		seqs: all.map((tick) => Number(tick.dataset.seq)),
		current: current ? Number(current.dataset.seq) : null,
	};
}

export function clickTick(seq: number): boolean {
	const tick = q(`[data-testid=outline-timeline] [data-seq="${seq}"]`)[0];
	if (!tick) return false;
	tick.click();
	return true;
}

/** Click the first element with this test id (`nth`: another one). */
export function clickTestId(id: string, nth = 0): boolean {
	const element = q(`[data-testid="${id}"]`)[nth];
	if (!element || (element as HTMLButtonElement).disabled) return false;
	element.click();
	return true;
}

/** Click a button (or a tab) by its text. */
export function clickText(text: string): boolean {
	const element = q("button, [role=tab]").find((el) => el.textContent?.trim() === text);
	if (!element) return false;
	element.click();
	return true;
}

export function has(selector: string): boolean {
	return document.querySelector(selector) !== null;
}

/** The side panel's history: the seqs listed, newest first. */
export function historyItems(): number[] {
	return q("[data-history-seq]").map((item) => Number(item.dataset.historySeq));
}

export function clickHistoryItem(seq: number): boolean {
	const item = q(`[data-history-seq="${seq}"]`)[0];
	if (!item) return false;
	item.click();
	return true;
}

/** The history bar, when a view as of a commit shows it. */
export function bar(): {
	banner: string;
	restore: boolean;
	compare: boolean;
	readOnly: boolean;
} | null {
	const element = document.querySelector("[data-testid=outline-history-bar]");
	if (!element) return null;
	return {
		banner: element.querySelector("[data-testid=outline-history-banner]")?.textContent ?? "",
		restore: element.querySelector("[data-testid=outline-history-restore]") !== null,
		compare: element.querySelector("[data-testid=outline-history-compare]") !== null,
		readOnly: element.querySelector("[data-testid=outline-history-read-only]") !== null,
	};
}

/** The comparison's rows. */
export function diffEntries(): Array<{ id: string; kind: string; text: string; fields: string }> {
	return q("[data-diff-entry]").map((row) => ({
		id: row.dataset.diffEntry ?? "",
		kind: row.dataset.diffKind ?? "",
		text: row.textContent ?? "",
		fields: row.querySelector<HTMLElement>("[data-diff-fields]")?.dataset.diffFields ?? "",
	}));
}

/** The forest's rows that carry a comparison's mark: block id → kind. */
export function forestMarks(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const row of q("[data-testid=outline-block-tree] [data-block-id][data-diff]")) {
		out[row.dataset.blockId ?? ""] = row.dataset.diff ?? "";
	}
	return out;
}

/** The restore dialog's phase, or null when it is closed. */
export function restorePhase(): string | null {
	return document.querySelector<HTMLElement>("[data-restore-phase]")?.dataset.restorePhase ?? null;
}

/** The change list, by group. */
export function restoreGroups(): Array<{
	group: string;
	entries: Array<{ id: string; action: string; text: string }>;
}> {
	return q("[data-restore-group]").map((group) => ({
		group: group.dataset.restoreGroup ?? "",
		entries: q("[data-restore-entry]", group).map((entry) => ({
			id: entry.dataset.restoreEntry ?? "",
			action: entry.dataset.restoreAction ?? "",
			text: entry.textContent ?? "",
		})),
	}));
}

/** The result's moved-away rows and skips. */
export function restoreResult(): {
	text: string;
	skipped: Array<{ id: string; reason: string }>;
	movedAway: string[];
} | null {
	const result = document.querySelector<HTMLElement>("[data-testid=outline-restore-result]");
	if (!result) return null;
	return {
		text: result.textContent ?? "",
		skipped: q("[data-restore-skip]", result).map((row) => ({
			id: row.dataset.block ?? "",
			reason: row.dataset.restoreSkip ?? "",
		})),
		movedAway: q("[data-restore-entry]", result).map((row) => row.dataset.restoreEntry ?? ""),
	};
}

/** The restore dialog has finished appearing (its transition is over). */
export function dialogSettled(): boolean {
	const content = document.querySelector<HTMLElement>(".mantine-Modal-content");
	return content !== null && getComputedStyle(content).opacity === "1";
}

export function restoreProblem(): string | null {
	return (
		document.querySelector<HTMLElement>("[data-testid=outline-restore-problem]")?.dataset.problem ??
		null
	);
}

/** Use the "Move back" of a moved-away block. */
export function moveBack(blockId: string): boolean {
	const button = q<HTMLButtonElement>(
		`[data-testid=outline-move-back][data-block="${blockId}"]`,
	)[0];
	if (!button || button.disabled) return false;
	button.click();
	return true;
}

/** Choose the comparison's newer point ("now" or a seq). */
export function compareWith(value: string): boolean {
	const select = document.querySelector<HTMLSelectElement>("[data-testid=outline-diff-to]");
	if (!select) return false;
	const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
	setter?.call(select, value);
	select.dispatchEvent(new Event("change", { bubbles: true }));
	return true;
}

/** The widest element's right edge beyond the viewport (0: nothing sticks out). */
export function widest(): { over: number; what: string } {
	const width = document.documentElement.clientWidth;
	let over = 0;
	let what = "";
	for (const element of q("body *")) {
		const box = element.getBoundingClientRect();
		if (box.width === 0 || box.height === 0) continue;
		// Inside something that scrolls sideways on its own (the timeline strip) is fine.
		if (element.closest(".mantine-ScrollArea-viewport")) continue;
		if (box.right - width > over) {
			over = box.right - width;
			what = `${element.tagName}.${element.className}`;
		}
	}
	return { over, what };
}
