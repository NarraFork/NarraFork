import { narratorWSManager } from "@frontend/lib/narrator-ws-manager";
import {
	matchReasoningTranslationText,
	REASONING_VISIBILITY_MAX_SOURCE_CHARS,
	type ReasoningTranslationSource,
	type ReasoningTranslationSourceRange,
} from "@shared/pretext-layout/reasoning-translation-sources";
import {
	REASONING_TRANSLATION_VISIBILITY_LIMITS,
	type ReasoningTranslationVisibilityGroup,
	type ReasoningTranslationVisibilityTarget,
} from "@shared/reasoning-translation";
import { createContext, type ReactNode, useContext, useLayoutEffect, useMemo, useRef } from "react";
import { useEditorPanelVisible } from "./narrator-panel-visibility";

export const REASONING_VISIBILITY_MAX_FRAGMENTS = 256;
export const REASONING_VISIBILITY_MAX_TEXT_NODES = 2048;
export const REASONING_VISIBILITY_ANIMATION_FRAMES = 120;
export const REASONING_VISIBILITY_MAX_MATCH_CALLS = 32;
const MAX_CACHED_NODE_TEXTS = 128;
const MAX_CACHED_NODE_CHARS = 256;
const MAX_MATCHED_TEXT_RANGES = REASONING_VISIBILITY_MAX_TEXT_NODES * 4;
const ignoredText = 'button, script, style, [aria-hidden="true"], [data-vlist-copy-ignore]';
const textBlock = "p, h1, h2, h3, h4, h5, h6, li, pre, blockquote, td, th";

interface MatchedTextRange extends ReasoningTranslationSourceRange {
	node: Text;
}
interface MatchRequest {
	text: string;
	cacheable: boolean;
}
type MatchWork = Generator<MatchRequest, void, ReasoningTranslationSourceRange[]>;
type MatchText = (
	text: string,
	cacheable: boolean,
) => ReasoningTranslationSourceRange[] | undefined;

interface TextScan {
	source: ReasoningTranslationSource;
	nodeBudget: number;
	charBudget: number;
	visited: number;
	chars: number;
	context: {
		node: Text;
		length: number;
		readable: boolean;
		text: string;
		block: Element | null;
		run: number;
	}[];
	ranges: MatchedTextRange[];
	complete: boolean;
	work: MatchWork[];
	workIndex: number;
	request?: IteratorResult<MatchRequest, void>;
}
interface TextContext {
	length: number;
	readable: boolean;
	clip: Rect | null;
	rects: ArrayLike<Rect>;
}
interface AnimationWatch {
	elements: Map<Element, Set<string>>;
	frames: number;
}

interface Rect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export function intersectReasoningVisibilityRects(a: Rect, b: Rect): Rect | null {
	const rect = {
		left: Math.max(a.left, b.left),
		top: Math.max(a.top, b.top),
		right: Math.min(a.right, b.right),
		bottom: Math.min(a.bottom, b.bottom),
	};
	return Object.values(rect).every(Number.isFinite) &&
		rect.right > rect.left &&
		rect.bottom > rect.top
		? rect
		: null;
}

/** Locate visible lines without scanning a long wrapped source's off-screen prefix. */
export function hasVisibleReasoningClientRect(rects: ArrayLike<Rect>, clip: Rect): boolean {
	let first = 0;
	if (rects.length > 64) {
		// A Text Range's horizontal lines are in document order. Locate the first
		// candidate by its bottom edge, then test actual rectangles (never a ratio
		// of the parent box). Even a late wrapped line keeps a bounded read budget.
		let end = rects.length;
		while (first < end) {
			const middle = Math.floor((first + end) / 2);
			const rect = rects[middle];
			if (!rect || !Number.isFinite(rect.bottom)) return false;
			if (rect.bottom <= clip.top) first = middle + 1;
			else end = middle;
		}
		first = Math.max(0, first - 1);
	}
	for (let index = first; index < Math.min(rects.length, first + 64); index++) {
		const rect = rects[index];
		if (rect && intersectReasoningVisibilityRects(clip, rect)) return true;
	}
	return false;
}

/** Fail closed when layout cannot establish a visible, unclipped text rectangle. */
export function reasoningTextClip(
	node: Element,
	cache = new Map<Element, Rect | null>(),
	includeViewport = true,
): Rect | null {
	const view = node.ownerDocument.defaultView;
	if (
		!view ||
		typeof view.getComputedStyle !== "function" ||
		node.ownerDocument.visibilityState === "hidden" ||
		!node.isConnected ||
		!(view.innerWidth > 0 && view.innerHeight > 0)
	)
		return null;
	const path: Element[] = [];
	let ancestor: Element | null = node;
	while (ancestor && !cache.has(ancestor)) {
		if (path.length >= 64) return null;
		path.push(ancestor);
		ancestor = ancestor.parentElement;
	}
	let clip: Rect | null = ancestor
		? (cache.get(ancestor) ?? null)
		: includeViewport
			? { left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight }
			: {
					left: -Number.MAX_SAFE_INTEGER,
					top: -Number.MAX_SAFE_INTEGER,
					right: Number.MAX_SAFE_INTEGER,
					bottom: Number.MAX_SAFE_INTEGER,
				};
	for (const element of path.reverse()) {
		if (clip) {
			const style = view.getComputedStyle(element);
			if (
				style.display === "none" ||
				style.visibility === "hidden" ||
				style.visibility === "collapse" ||
				style.opacity === "0" ||
				style.contentVisibility === "hidden" ||
				(style.clipPath && style.clipPath !== "none")
			)
				clip = null;
			if (clip) {
				const clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX || style.overflow);
				const clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY || style.overflow);
				if (clipsX || clipsY) {
					const box = element.getBoundingClientRect();
					clip = intersectReasoningVisibilityRects(clip, {
						left: clipsX ? box.left : clip.left,
						right: clipsX ? box.right : clip.right,
						top: clipsY ? box.top : clip.top,
						bottom: clipsY ? box.bottom : clip.bottom,
					});
				}
			}
		}
		cache.set(element, clip);
	}
	return clip;
}

/** Match animation-split text once, then retain exact UTF-16 coordinates per Text node. */
function scanReasoningText(
	container: HTMLElement,
	source: ReasoningTranslationSource,
	nodeBudget: number,
	charBudget: number,
	readContext: (node: Text, length: number) => TextContext,
): TextScan {
	const scan: TextScan = {
		source,
		nodeBudget,
		charBudget,
		visited: 0,
		chars: 0,
		context: [],
		ranges: [],
		complete: false,
		work: [],
		workIndex: 0,
	};
	let pieces: { node: Text; text: string; start: number; end: number; block: Element | null }[] =
		[];
	let chunks: string[] = [];
	let length = 0;
	let block: Element | null = null;
	let runId = 0;
	const finish = () => {
		runId++;
		if (!pieces.length) return;
		const run = pieces;
		const value = chunks.join("");
		function* matchPieces(
			from: number,
			to: number,
		): Generator<MatchRequest, boolean, ReasoningTranslationSourceRange[]> {
			const offset = run[from].start;
			const matches = yield {
				text: value.slice(offset, run[to - 1].end),
				cacheable: to - from === 1,
			};
			for (const match of matches) {
				const matchStart = offset + match.start;
				const matchEnd = offset + match.end;
				let first = from;
				let end = to;
				while (first < end) {
					const middle = Math.floor((first + end) / 2);
					if (run[middle].end <= matchStart) first = middle + 1;
					else end = middle;
				}
				for (let index = first; index < to; index++) {
					const piece = run[index];
					if (piece.start >= matchEnd || scan.ranges.length >= MAX_MATCHED_TEXT_RANGES) break;
					const start = Math.max(matchStart, piece.start) - piece.start;
					const end = Math.min(matchEnd, piece.end) - piece.start;
					if (piece.text.slice(start, end).trim())
						scan.ranges.push({ node: piece.node, start, end, target: match.target });
				}
			}
			return matches.length > 0;
		}
		function* matchRun(): MatchWork {
			if (!(yield* matchPieces(0, run.length))) {
				// Preserve the exact fallback cursor across budget boundaries, rather
				// than restarting long Markdown runs at their first grapheme each frame.
				for (let from = 0; from < run.length; ) {
					let to = from + 1;
					while (to < run.length && run[to].block === run[from].block) to++;
					if ((from === 0 && to === run.length) || !(yield* matchPieces(from, to)))
						for (let index = from; index < to; index++) yield* matchPieces(index, index + 1);
					from = to;
				}
			}
		}
		scan.work.push(matchRun());
		pieces = [];
		chunks = [];
		length = 0;
	};
	const walker = container.ownerDocument.createTreeWalker(container, 4 /* SHOW_TEXT */);
	for (let current = walker.nextNode(); current; current = walker.nextNode()) {
		if (scan.visited >= nodeBudget || scan.chars >= charBudget) break;
		scan.visited++;
		const parent = current.parentElement;
		if (!parent || parent.closest(ignoredText)) {
			finish();
			continue;
		}
		const value = current.textContent ?? "";
		const text = value.slice(0, charBudget - scan.chars);
		scan.chars += text.length;
		if (!text) continue;
		const context = readContext(current as Text, text.length);
		const nextBlock = parent.closest(textBlock);
		scan.context.push({
			node: current as Text,
			length: text.length,
			readable: context.readable,
			text,
			block: nextBlock,
			run: runId,
		});
		if (!context.readable) {
			// An unpainted bridge cannot assign another target's repeated text.
			finish();
			continue;
		}
		if (pieces.length && nextBlock !== block) {
			// Paragraph separators carry matching context, but never DOM evidence.
			if (charBudget - scan.chars < 2) break;
			chunks.push("\n\n");
			length += 2;
			scan.chars += 2;
		}
		block = nextBlock;
		pieces.push({ node: current as Text, text, start: length, end: length + text.length, block });
		chunks.push(text);
		length += text.length;
	}
	finish();
	return scan;
}

function sameReasoningTextInput(a: TextScan, b: TextScan): boolean {
	return (
		a.source === b.source &&
		a.nodeBudget === b.nodeBudget &&
		a.charBudget === b.charBudget &&
		a.visited === b.visited &&
		a.chars === b.chars &&
		a.context.length === b.context.length &&
		a.context.every((entry, index) => {
			const other = b.context[index];
			return (
				entry.node === other.node &&
				entry.text === other.text &&
				entry.readable === other.readable &&
				entry.block === other.block &&
				entry.run === other.run
			);
		})
	);
}

/** Undefined means deferred, never an empty match. Each consumed request advances exactly once. */
function advanceReasoningText(scan: TextScan, matchText: MatchText): void {
	while (scan.workIndex < scan.work.length && scan.ranges.length < MAX_MATCHED_TEXT_RANGES) {
		const work = scan.work[scan.workIndex];
		const request = scan.request ?? work.next();
		if (request.done) {
			scan.workIndex++;
			scan.request = undefined;
			continue;
		}
		const ranges = matchText(request.value.text, request.value.cacheable);
		if (ranges === undefined) {
			scan.request = request;
			return;
		}
		scan.request = work.next(ranges);
	}
	scan.complete = true;
	scan.work = [];
	scan.workIndex = 0;
	scan.request = undefined;
}

const controllers = new Set<ReasoningTranslationVisibilityController>();
let scheduledFrame: number | undefined;
const scheduleControllers = () => {
	if (scheduledFrame !== undefined) return;
	scheduledFrame = requestAnimationFrame((time) => {
		scheduledFrame = undefined;
		for (const controller of controllers) controller.frameChanged(time);
	});
};
const documentVisibilityChanged = () => {
	// Revoke immediately in a background document, rather than waiting for a throttled RAF.
	if (document.visibilityState === "hidden" && scheduledFrame !== undefined) {
		cancelAnimationFrame(scheduledFrame);
		scheduledFrame = undefined;
	}
	for (const controller of controllers) controller.documentVisibilityChanged();
};
const animationChanged = (event: Event) => {
	for (const controller of controllers) controller.animationChanged(event as AnimationEvent);
};
function attachController(controller: ReasoningTranslationVisibilityController): () => void {
	if (!controllers.size) {
		document.addEventListener("scroll", scheduleControllers, { capture: true, passive: true });
		window.addEventListener("resize", scheduleControllers, { passive: true });
		document.addEventListener("visibilitychange", documentVisibilityChanged);
		for (const type of ["animationstart", "animationend", "animationcancel"])
			document.addEventListener(type, animationChanged, true);
	}
	controllers.add(controller);
	return () => {
		controllers.delete(controller);
		if (controllers.size) return;
		document.removeEventListener("scroll", scheduleControllers, true);
		window.removeEventListener("resize", scheduleControllers);
		document.removeEventListener("visibilitychange", documentVisibilityChanged);
		for (const type of ["animationstart", "animationend", "animationcancel"])
			document.removeEventListener(type, animationChanged, true);
		if (scheduledFrame !== undefined) cancelAnimationFrame(scheduledFrame);
		scheduledFrame = undefined;
	};
}

/** A list shares observers and a WS holder, never one listener per animated grapheme. */
export class ReasoningTranslationVisibilityController {
	private fragments = new Map<HTMLElement, ReasoningTranslationSource>();
	private scans = new WeakMap<HTMLElement, TextScan>();
	private revalidateScans = new WeakSet<HTMLElement>();
	private nodeMatches = new WeakMap<
		ReasoningTranslationSource,
		Map<string, ReasoningTranslationSourceRange[]>
	>();
	private animations = new Map<HTMLElement, AnimationWatch>();
	private animationFrame?: number;
	private matchingFrame?: number;
	private remainingMatchCalls = REASONING_VISIBILITY_MAX_MATCH_CALLS;
	private matchingBudgetTime?: number;
	private observed = new Map<Element, number>();
	private observedParents = new Map<HTMLElement, Element>();
	private io?: IntersectionObserver;
	private ro?: ResizeObserver;
	private mo?: MutationObserver;
	private cleanup?: () => void;
	private handle?: { update: () => void; dispose: () => void };
	private visible = false;

	constructor(
		private narratorId: string,
		private visibilityId: string,
	) {}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		if (!visible) {
			this.clearMatchingFrame();
			this.clearAnimationWatch();
			if (typeof document !== "undefined" && document.visibilityState === "hidden") {
				// The panel hook also deactivates for document backgrounding. Pause
				// finite work, then revalidate everything missed while observers detach.
				for (const node of this.fragments.keys()) this.revalidateScans.add(node);
			} else {
				this.scans = new WeakMap();
				this.nodeMatches = new WeakMap();
				this.revalidateScans = new WeakSet();
			}
			this.mo?.disconnect();
			this.mo = undefined;
			this.handle?.dispose();
			this.handle = undefined;
			this.cleanup?.();
			this.cleanup = undefined;
			this.io?.disconnect();
			this.ro?.disconnect();
			this.io = undefined;
			this.ro = undefined;
			this.observed.clear();
			this.observedParents.clear();
			return;
		}
		this.handle = narratorWSManager.registerReasoningTranslationVisibility(
			this.narratorId,
			this.visibilityId,
			() => this.readVisibility(),
		);
		this.cleanup = attachController(this);
		if (typeof IntersectionObserver !== "undefined")
			this.io = new IntersectionObserver(scheduleControllers, {
				root: null,
				rootMargin: "0px",
				threshold: 0,
			});
		if (typeof ResizeObserver !== "undefined") this.ro = new ResizeObserver(scheduleControllers);
		const MutationObserver = document.defaultView?.MutationObserver;
		if (MutationObserver)
			this.mo = new MutationObserver((records) => {
				this.invalidateScans(records);
				this.changed();
			});
		for (const node of this.fragments.keys()) {
			this.observe(node);
			this.discoverAnimations(node);
		}
		this.changed();
	}

	register(node: HTMLElement, source: ReasoningTranslationSource): () => void {
		if (
			this.fragments.size >= REASONING_VISIBILITY_MAX_FRAGMENTS ||
			source.text.length > REASONING_VISIBILITY_MAX_SOURCE_CHARS
		)
			return () => {};
		this.fragments.set(node, source);
		this.scans.delete(node);
		if (this.visible) {
			this.observe(node);
			this.discoverAnimations(node);
		}
		this.changed();
		return () => {
			if (this.fragments.get(node) !== source) return;
			this.fragments.delete(node);
			this.clearMatchingFrame();
			if (![...this.fragments.values()].includes(source)) this.nodeMatches.delete(source);
			this.scans.delete(node);
			this.revalidateScans.delete(node);
			this.animations.delete(node);
			this.updateAnimationFrame();
			this.invalidateScans(this.mo?.takeRecords() ?? []);
			this.mo?.disconnect();
			for (const fragment of this.fragments.keys()) this.observeText(fragment);
			const parent = this.observedParents.get(node);
			this.observedParents.delete(node);
			if (parent) {
				const count = this.observed.get(parent) ?? 0;
				if (count <= 1) {
					this.observed.delete(parent);
					this.io?.unobserve(parent);
					this.ro?.unobserve(parent);
				} else this.observed.set(parent, count - 1);
			}
			this.changed();
		};
	}

	private observeText(node: HTMLElement): void {
		this.mo?.observe(node, {
			subtree: true,
			childList: true,
			characterData: true,
			attributes: true,
			attributeFilter: ["aria-hidden", "data-vlist-copy-ignore"],
		});
	}

	private invalidateScans(records: MutationRecord[]): void {
		if (records.length > REASONING_VISIBILITY_MAX_TEXT_NODES) {
			this.scans = new WeakMap();
			return;
		}
		for (const record of records) {
			let node: Node | null = record.target;
			for (let depth = 0; node && depth < 64; depth++, node = node.parentNode) {
				if (node.nodeType === 1 && this.fragments.has(node as HTMLElement))
					this.scans.delete(node as HTMLElement);
			}
			if (node) {
				this.scans = new WeakMap();
				return;
			}
		}
	}

	private observe(node: HTMLElement): void {
		this.observeText(node);
		// The wrapper is display:contents. Its parent supplies observer hints only;
		// actual demand is proven below against each source-specific text Range.
		const parent = node.parentElement;
		if (!parent || this.observedParents.has(node)) return;
		this.observedParents.set(node, parent);
		const count = this.observed.get(parent) ?? 0;
		this.observed.set(parent, count + 1);
		if (!count) {
			this.io?.observe(parent);
			this.ro?.observe(parent);
		}
	}

	private watchAnimation(node: HTMLElement, element: Element, name: string): void {
		let watch = this.animations.get(node);
		if (!watch) {
			watch = { elements: new Map(), frames: REASONING_VISIBILITY_ANIMATION_FRAMES };
			this.animations.set(node, watch);
		}
		if (watch.elements.size >= REASONING_VISIBILITY_MAX_TEXT_NODES) return;
		let names = watch.elements.get(element);
		if (!names) {
			names = new Set();
			watch.elements.set(element, names);
		}
		if (names.size < 16) names.add(name);
		watch.frames = REASONING_VISIBILITY_ANIMATION_FRAMES;
	}

	private discoverAnimations(node: HTMLElement): void {
		if (document.visibilityState === "hidden" || !node.isConnected || node.closest(ignoredText))
			return;
		// A source can register halfway through a fade, after animationstart. Read
		// existing timelines once on activation; never pause, finish or cancel them.
		let element: Element | null = node;
		let visited = 0;
		for (let depth = 0; element && depth < 64; depth++, element = element.parentElement) {
			if (typeof element.getAnimations !== "function") continue;
			for (const animation of element.getAnimations({ subtree: element === node })) {
				if (++visited > REASONING_VISIBILITY_MAX_TEXT_NODES) break;
				const effect = animation.effect;
				const target = effect && "target" in effect ? effect.target : null;
				if (
					animation.playState !== "running" ||
					(effect && "pseudoElement" in effect && effect.pseudoElement) ||
					!(target instanceof Element) ||
					!(node.contains(target) || target.contains(node)) ||
					target.closest(ignoredText)
				)
					continue;
				this.watchAnimation(
					node,
					target,
					"animationName" in animation && typeof animation.animationName === "string"
						? animation.animationName
						: animation.id,
				);
			}
			if (visited >= REASONING_VISIBILITY_MAX_TEXT_NODES) break;
		}
		this.updateAnimationFrame();
	}

	documentVisibilityChanged(): void {
		if (this.visible && document.visibilityState !== "hidden")
			for (const node of this.fragments.keys()) this.discoverAnimations(node);
		this.changed();
	}

	private clearMatchingFrame(): void {
		if (this.matchingFrame !== undefined) cancelAnimationFrame(this.matchingFrame);
		this.matchingFrame = undefined;
	}

	private updateMatchingFrame(needed: boolean): void {
		if (
			!needed ||
			!this.visible ||
			document.visibilityState === "hidden" ||
			this.animationFrame !== undefined
		) {
			this.clearMatchingFrame();
			return;
		}
		if (this.matchingFrame !== undefined) return;
		// This drains a finite, bounded scan generation; completed cursors never
		// restart. Reuse an animation frame when one already provides the wakeup.
		this.matchingFrame = requestAnimationFrame((time) => {
			this.matchingFrame = undefined;
			this.frameChanged(time);
		});
	}

	private clearAnimationWatch(): void {
		this.animations.clear();
		if (this.animationFrame !== undefined) cancelAnimationFrame(this.animationFrame);
		this.animationFrame = undefined;
	}

	private updateAnimationFrame(): void {
		if (!this.visible || document.visibilityState === "hidden") {
			this.clearAnimationWatch();
			return;
		}
		for (const [node, watch] of this.animations) {
			for (const element of watch.elements.keys()) {
				if (!element.isConnected || !(node.contains(element) || element.contains(node)))
					watch.elements.delete(element);
			}
			if (!node.isConnected || !watch.elements.size || watch.frames <= 0)
				this.animations.delete(node);
		}
		if (!this.animations.size) {
			if (this.animationFrame !== undefined) cancelAnimationFrame(this.animationFrame);
			this.animationFrame = undefined;
			return;
		}
		if (this.animationFrame !== undefined) return;
		this.animationFrame = requestAnimationFrame((time) => {
			this.animationFrame = undefined;
			for (const watch of this.animations.values()) watch.frames--;
			this.frameChanged(time);
			this.updateAnimationFrame();
		});
	}

	animationChanged(event: AnimationEvent): void {
		if (
			!this.visible ||
			document.visibilityState === "hidden" ||
			!(event.target instanceof Element) ||
			event.pseudoElement
		)
			return;
		const element = event.target;
		let relevant = false;
		for (const node of this.fragments.keys()) {
			if (
				!node.isConnected ||
				node.closest(ignoredText) ||
				!(node.contains(element) || element.contains(node))
			)
				continue;
			if (node.contains(element) && element.closest(ignoredText)) continue;
			relevant = true;
			const watch = this.animations.get(node);
			if (event.type === "animationstart") {
				this.watchAnimation(node, element, event.animationName);
			} else if (watch) {
				const names = watch.elements.get(element);
				names?.delete(event.animationName);
				if (!names?.size) watch.elements.delete(element);
			}
		}
		if (relevant) this.changed();
		this.updateAnimationFrame();
	}

	frameChanged(time: number): void {
		// Scroll, animation and continuation callbacks in the same browser frame
		// share one allowance, even if they trigger separate visibility reads.
		if (this.matchingBudgetTime !== time) {
			this.matchingBudgetTime = time;
			this.remainingMatchCalls = REASONING_VISIBILITY_MAX_MATCH_CALLS;
		}
		this.changed();
	}

	changed(): void {
		if (typeof document !== "undefined" && document.visibilityState === "hidden") {
			this.clearMatchingFrame();
			this.clearAnimationWatch();
		}
		this.handle?.update();
	}

	readTargets(): ReasoningTranslationVisibilityTarget[] {
		return this.readVisibility().targets;
	}

	readVisibility(): {
		targets: ReasoningTranslationVisibilityTarget[];
		groups: ReasoningTranslationVisibilityGroup[];
	} {
		if (!this.visible || typeof document === "undefined" || document.visibilityState === "hidden") {
			this.clearMatchingFrame();
			this.clearAnimationWatch();
			return { targets: [], groups: [] };
		}
		this.invalidateScans(this.mo?.takeRecords() ?? []);
		const targets = new Map<string, ReasoningTranslationVisibilityTarget>();
		const groups = new Map<
			string,
			{ anchor: ReasoningTranslationVisibilityTarget; targets: Set<string> }
		>();
		let pendingMatching = false;
		const snapshot = () => {
			for (const node of this.animations.keys()) {
				const source = this.fragments.get(node);
				if (!source || source.ranges.every((range) => targets.has(JSON.stringify(range.target))))
					this.animations.delete(node);
			}
			this.updateAnimationFrame();
			this.updateMatchingFrame(
				pendingMatching && targets.size < REASONING_TRANSLATION_VISIBILITY_LIMITS.targets,
			);
			const entries = [...targets.entries()].sort(([a], [b]) => a.localeCompare(b));
			const indexes = new Map(entries.map(([key], index) => [key, index]));
			return {
				targets: entries.map(([, target]) => target),
				groups: [...groups.entries()]
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([groupId, group]) => ({
						groupId,
						anchor: group.anchor,
						targetIndexes: [...group.targets]
							.flatMap((key) => {
								const index = indexes.get(key);
								return index === undefined ? [] : [index];
							})
							.sort((a, b) => a - b),
					})),
			};
		};
		const contextClips = new Map<Element, Rect | null>();
		const contexts = new Map<Text, TextContext>();
		const readContext = (text: Text, length: number): TextContext => {
			const cached = contexts.get(text);
			if (cached?.length === length) return cached;
			const parent = text.parentElement;
			const clip =
				parent && !parent.closest(ignoredText)
					? reasoningTextClip(parent, contextClips, false)
					: null;
			let rects: ArrayLike<Rect> = [];
			if (clip && length > 0) {
				const range = text.ownerDocument.createRange();
				range.setStart(text, 0);
				range.setEnd(text, length);
				if (typeof range.getClientRects === "function") rects = range.getClientRects();
			}
			const context = {
				length,
				clip,
				rects,
				readable: !!clip && hasVisibleReasoningClientRect(rects, clip),
			};
			contexts.set(text, context);
			return context;
		};
		let visited = 0;
		let chars = 0;
		for (const [node, source] of this.fragments) {
			if (!node.isConnected || node.closest(ignoredText)) continue;
			const nodeBudget = REASONING_VISIBILITY_MAX_TEXT_NODES - visited;
			const charBudget = REASONING_VISIBILITY_MAX_SOURCE_CHARS - chars;
			if (nodeBudget <= 0 || charBudget <= 0) return snapshot();
			let scan = this.scans.get(node);
			if (!this.mo || this.revalidateScans.has(node)) {
				// Compare bounded raw inputs after an observation gap, retaining only
				// unchanged continuations. A pause must neither reset nor stale progress.
				const fresh = scanReasoningText(node, source, nodeBudget, charBudget, readContext);
				if (!scan || !sameReasoningTextInput(scan, fresh)) scan = fresh;
				this.scans.set(node, scan);
				this.revalidateScans.delete(node);
			} else if (
				scan?.source !== source ||
				scan.nodeBudget !== nodeBudget ||
				scan.charBudget !== charBudget ||
				scan.context.some(
					(entry) => readContext(entry.node, entry.length).readable !== entry.readable,
				)
			) {
				scan = scanReasoningText(node, source, nodeBudget, charBudget, readContext);
				this.scans.set(node, scan);
			}
			if (!scan.complete) {
				const cache =
					this.nodeMatches.get(source) ?? new Map<string, ReasoningTranslationSourceRange[]>();
				this.nodeMatches.set(source, cache);
				advanceReasoningText(scan, (text, cacheable) => {
					if (!text.trim()) return [];
					const known = cache.get(text);
					if (known) return known;
					// A shared budget covers every fragment. Deferred requests retain
					// their exact cursor, so later static targets cannot starve.
					if (this.remainingMatchCalls <= 0) return undefined;
					this.remainingMatchCalls--;
					const ranges = matchReasoningTranslationText(source, text);
					if (
						cacheable &&
						text.length <= MAX_CACHED_NODE_CHARS &&
						cache.size < MAX_CACHED_NODE_TEXTS
					)
						cache.set(text, ranges);
					return ranges;
				});
			}
			if (!scan.complete) pendingMatching = true;
			visited += scan.visited;
			chars += scan.chars;
			const confirmed = new Set<string>();
			for (const match of scan.ranges) {
				const key = JSON.stringify(match.target);
				// A prior range for this target is sufficient, not a range for any other target.
				if (confirmed.has(key)) continue;
				const context = contexts.get(match.node);
				const view = node.ownerDocument.defaultView;
				if (!context?.readable || !context.clip || !view) continue;
				const clip = intersectReasoningVisibilityRects(context.clip, {
					left: 0,
					top: 0,
					right: view.innerWidth,
					bottom: view.innerHeight,
				});
				if (!clip) continue;
				let rects = context.rects;
				if (match.start !== 0 || match.end !== context.length) {
					const range = node.ownerDocument.createRange();
					range.setStart(match.node, match.start);
					range.setEnd(match.node, match.end);
					if (typeof range.getClientRects !== "function") continue;
					rects = range.getClientRects();
				}
				// Reuse only the identical whole-Text Range; partial targets must have
				// their own exact Range. Neither parent nor another target is evidence.
				if (!hasVisibleReasoningClientRect(rects, clip)) continue;
				confirmed.add(key);
				targets.set(key, match.target);
				if (source.group) {
					let group = groups.get(source.group.groupId);
					if (!group) {
						group = { anchor: source.group.anchor, targets: new Set() };
						groups.set(source.group.groupId, group);
					}
					group.targets.add(key);
				}
				if (targets.size >= REASONING_TRANSLATION_VISIBILITY_LIMITS.targets) return snapshot();
			}
		}
		return snapshot();
	}

	dispose(): void {
		this.setVisible(false);
		this.fragments.clear();
		this.scans = new WeakMap();
		this.nodeMatches = new WeakMap();
		this.revalidateScans = new WeakSet();
	}
}

const TranslationVisibilityContext = createContext<ReasoningTranslationVisibilityController | null>(
	null,
);

/** Explicit opt-in at the authenticated narrator host, not generic chat/share renderers. */
export function ReasoningTranslationVisibilityProvider({
	narratorId,
	children,
}: {
	narratorId: string;
	children: ReactNode;
}) {
	const visible = useEditorPanelVisible();
	const controller = useMemo(
		() =>
			new ReasoningTranslationVisibilityController(
				narratorId,
				`reasoning-visible-${narratorWSManager.allocateId()}`,
			),
		[narratorId],
	);
	useLayoutEffect(() => {
		controller.setVisible(visible);
		return () => controller.setVisible(false);
	}, [controller, visible]);
	useLayoutEffect(() => () => controller.dispose(), [controller]);
	return (
		<TranslationVisibilityContext.Provider value={controller}>
			{children}
		</TranslationVisibilityContext.Provider>
	);
}

/** Mount only around the actual title/body text, never a whole reasoning row/header. */
export function ReasoningTranslationText({
	source,
	children,
}: {
	source?: ReasoningTranslationSource;
	children: ReactNode;
}) {
	const controller = useContext(TranslationVisibilityContext);
	const ref = useRef<HTMLSpanElement>(null);
	useLayoutEffect(() => {
		if (controller && source?.ranges.length && ref.current)
			return controller.register(ref.current, source);
	}, [controller, source]);
	return (
		<span ref={ref} style={{ display: "contents" }}>
			{children}
		</span>
	);
}
