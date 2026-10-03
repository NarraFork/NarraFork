import type { TextDocumentRef } from "@shared/pretext-layout/text-document";
import { type DocumentToken, documentTokensForRange } from "./text-document-pure-core";
import type { TextDocumentViewResult } from "./text-document-worker-client";
import type { DocumentRow, TextDocumentViewOptions } from "./text-document-worker-protocol";

export interface DocumentViewOperations {
	view(
		ref: TextDocumentRef,
		options: TextDocumentViewOptions,
		signal?: AbortSignal,
	): Promise<TextDocumentViewResult>;
	highlight(
		ref: TextDocumentRef,
		options: TextDocumentViewOptions,
		rows: readonly DocumentRow[],
		signal?: AbortSignal,
	): Promise<DocumentToken[]>;
}
export interface DocumentViewSnapshot extends TextDocumentViewResult {
	documentKey: string;
	ready: boolean;
	highlightReady: boolean;
	error?: string;
}
interface Target {
	ref: TextDocumentRef;
	options: TextDocumentViewOptions;
}
interface Window {
	target: Target;
	view: TextDocumentViewResult;
	layoutKey: string;
}
export const EMPTY_DOCUMENT_VIEW: DocumentViewSnapshot = {
	documentKey: "",
	rows: [],
	contentHeight: 0,
	contentWidth: 0,
	revision: -1,
	ready: false,
	highlightReady: false,
};

/** A newer prefix replaces only its covered raw ranges, never clears all prior colours. */
export function overlayDocumentTokens(
	previous: readonly DocumentToken[],
	patch: readonly DocumentToken[],
	ranges: readonly { start: number; end: number }[],
): DocumentToken[] {
	const kept: DocumentToken[] = [];
	for (const token of previous) {
		let pieces = [{ start: token.start, end: token.end }];
		for (const range of ranges) {
			if (range.end <= token.start || range.start >= token.end) continue;
			pieces = pieces.flatMap((part) => {
				if (range.end <= part.start || range.start >= part.end) return [part];
				const result = [];
				if (part.start < range.start) result.push({ start: part.start, end: range.start });
				if (part.end > range.end) result.push({ start: range.end, end: part.end });
				return result;
			});
		}
		for (const piece of pieces) kept.push({ ...token, ...piece });
	}
	return [...kept, ...patch].sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Two independent latest-target pumps. Appends NEVER abort a running layout or
 * highlight. A completed old prefix remains paintable, then the newest target
 * runs; source text is still held by the store. Only epoch/style/geometry changes
 * cancel incompatible work. This prevents a 50ms producer starving a 100ms job.
 */
export class TextDocumentViewSession {
	private target?: Target;
	private window?: Window;
	private pendingTokens?: Window;
	private tokenTarget?: Target;
	private tokenRanges: readonly { start: number; end: number }[] = [];
	private documentKey = "";
	private layoutKey = "";
	private styleKey = "";
	private layoutController?: AbortController;
	private tokenController?: AbortController;
	private colours: DocumentToken[] = [];
	private error?: string;
	private snapshot = EMPTY_DOCUMENT_VIEW;
	private stopped = false;
	private layoutJobs = 0;
	private tokenJobs = 0;
	private cancellations = 0;
	constructor(
		private operations: DocumentViewOperations,
		private publish: (value: DocumentViewSnapshot) => void,
	) {}

	setTarget(ref: TextDocumentRef, options: TextDocumentViewOptions): void {
		const key = JSON.stringify([ref.id, ref.epoch]);
		const style = JSON.stringify([key, options.language, options.theme]);
		const { language: _language, theme: _theme, ...geometry } = options;
		const layout = JSON.stringify([key, geometry]);
		const same =
			this.target?.ref === ref &&
			this.layoutKey === layout &&
			this.styleKey === style &&
			!this.stopped;
		if (same) return;
		this.stopped = false;
		if (this.documentKey !== key) {
			this.cancelLayout();
			this.cancelTokens();
			this.window = undefined;
			this.pendingTokens = undefined;
			this.tokenTarget = undefined;
			this.colours = [];
			this.snapshot = EMPTY_DOCUMENT_VIEW;
		}
		if (this.styleKey !== style) {
			this.cancelTokens();
			this.colours = [];
			this.tokenTarget = undefined;
			this.pendingTokens = undefined;
		}
		if (this.layoutKey !== layout) this.cancelLayout();
		this.documentKey = key;
		this.layoutKey = layout;
		this.styleKey = style;
		this.target = { ref, options };
		this.error = undefined;
		this.emit();
		this.pumpLayout();
	}
	getSnapshot() {
		return this.snapshot;
	}
	stats() {
		return {
			layoutJobs: this.layoutJobs,
			tokenJobs: this.tokenJobs,
			cancellations: this.cancellations,
			layoutActive: !!this.layoutController,
			tokenActive: !!this.tokenController,
			pendingTokenTargets: this.pendingTokens ? 1 : 0,
		};
	}
	stop(): void {
		this.stopped = true;
		this.cancelLayout();
		this.cancelTokens();
		this.target = undefined;
		this.pendingTokens = undefined;
		this.window = undefined;
		this.colours = [];
		this.tokenTarget = undefined;
		this.documentKey = "";
		this.layoutKey = "";
		this.styleKey = "";
	}
	private cancelLayout() {
		if (this.layoutController) {
			this.cancellations++;
			this.layoutController.abort();
			this.layoutController = undefined;
		}
	}
	private cancelTokens() {
		if (this.tokenController) {
			this.cancellations++;
			this.tokenController.abort();
			this.tokenController = undefined;
		}
	}
	private pumpLayout() {
		if (this.stopped || !this.target || this.layoutController) return;
		const target = this.target;
		if (this.window?.target === target) return;
		const key = this.layoutKey;
		const controller = new AbortController();
		this.layoutController = controller;
		this.layoutJobs++;
		void (async () => {
			try {
				const view = await this.operations.view(target.ref, target.options, controller.signal);
				if (this.stopped || this.layoutController !== controller || key !== this.layoutKey) return;
				const options = this.target?.options ?? target.options;
				const completed = { target: { ref: target.ref, options }, view, layoutKey: key };
				// Preserve identity for the same latest target; only style metadata may differ.
				if (this.target === target) completed.target = target;
				this.window = completed;
				this.colours = view.rows.flatMap((row) =>
					documentTokensForRange(this.colours, row.start, row.end),
				);
				this.pendingTokens = completed;
				this.emit();
				this.pumpTokens();
			} catch (failure) {
				if (!this.stopped && this.layoutController === controller && !controller.signal.aborted) {
					this.error = failure instanceof Error ? failure.message : String(failure);
					this.emit();
				}
			} finally {
				if (this.layoutController === controller) {
					this.layoutController = undefined;
					// One latest replacement, not every obsolete intermediate prefix.
					if (this.target !== target) this.pumpLayout();
				}
			}
		})();
	}
	private pumpTokens() {
		if (this.stopped || this.tokenController || !this.pendingTokens) return;
		const pending = this.pendingTokens;
		this.pendingTokens = undefined;
		const key = this.styleKey;
		const controller = new AbortController();
		this.tokenController = controller;
		this.tokenJobs++;
		void (async () => {
			try {
				const tokens = await this.operations.highlight(
					pending.target.ref,
					pending.target.options,
					pending.view.rows,
					controller.signal,
				);
				if (this.stopped || this.tokenController !== controller || key !== this.styleKey) return;
				const merged = overlayDocumentTokens(this.colours, tokens, pending.view.rows);
				this.colours =
					this.window?.view.rows.flatMap((row) =>
						documentTokensForRange(merged, row.start, row.end),
					) ?? [];
				this.tokenTarget = pending.target;
				this.tokenRanges = pending.view.rows.map(({ start, end }) => ({ start, end }));
				this.emit();
			} catch (failure) {
				if (!this.stopped && this.tokenController === controller && !controller.signal.aborted) {
					this.error = failure instanceof Error ? failure.message : String(failure);
					this.emit();
				}
			} finally {
				if (this.tokenController === controller) {
					this.tokenController = undefined;
					this.pumpTokens();
				}
			}
		})();
	}
	private emit() {
		if (!this.target || this.stopped) return;
		const view = this.window?.view;
		const colour = this.tokenTarget;
		const full =
			!!colour &&
			colour.ref.epoch === this.target.ref.epoch &&
			colour.ref.revision === this.target.ref.revision &&
			colour.ref.length === this.target.ref.length &&
			colour.options.language === this.target.options.language &&
			colour.options.theme === this.target.options.theme &&
			this.window?.target.ref === this.target.ref &&
			!!this.window?.view.rows.every((row) =>
				this.tokenRanges.some((range) => range.start <= row.start && range.end >= row.end),
			);
		this.snapshot = {
			...(view ?? EMPTY_DOCUMENT_VIEW),
			documentKey: this.documentKey,
			rows:
				view?.rows.map((row) => ({
					...row,
					tokens: documentTokensForRange(this.colours, row.start, row.end),
				})) ?? [],
			ready: !!view && this.window?.layoutKey === this.layoutKey,
			highlightReady: full,
			error: this.error,
		};
		this.publish(this.snapshot);
	}
}
