import { useShikiThemeName } from "@frontend/hooks/useShikiTokens";
import { useTextDocumentView } from "@frontend/hooks/useTextDocumentView";
import { textDocumentStore } from "@frontend/lib/text-document-store";
import type { TextDocumentRef } from "@shared/pretext-layout/text-document";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useContentViewport } from "../scroll/AutoFollowScroll";
import { DocumentSearch } from "./DocumentSearch";
import { DocumentSourceStatus } from "./DocumentSourceStatus";
import { DocumentTextFragment } from "./DocumentTextFragment";
import { nativeDocumentCaretOffset } from "./document-caret";
import { copyDocument } from "./document-clipboard";
import { takeDocumentFind } from "./document-find-intent";
import { type DocumentPaintToken, documentPaintTokens } from "./document-paint-tokens";
import { type DocumentMatch, findDocumentMatch } from "./document-search";
import {
	type DocumentSelection,
	documentAutoscroll,
	markedIntervals,
	moveSelectionOnBoundaries,
	selectionRange,
	selectOffset,
} from "./document-selection";

export interface DocumentCodeBodyProps {
	document: TextDocumentRef;
	language?: string;
	font: string;
	lineHeight: number;
	letterSpacing?: number;
	tabSize?: number;
	wordWrap?: boolean;
	fontRevision?: number;
	/** Inline and modal share bytes but not selection/read positions. */
	pane?: "inline" | "modal";
}

const selections = new Map<string, DocumentSelection>();
const EMPTY_DOCUMENT_ROWS: ReturnType<typeof useTextDocumentView>["rows"] = [];

/** A viewport-sized painting of visual rows; the store is the only copy/find source. */
export function DocumentCodeBody({
	document: input,
	language,
	font,
	lineHeight,
	letterSpacing = 0,
	tabSize = 4,
	wordWrap = true,
	fontRevision,
	pane = "inline",
}: DocumentCodeBodyProps) {
	const viewport = useContentViewport();
	const { t } = useTranslation("narrator");
	const theme = useShikiThemeName();
	const subscribe = useCallback(
		(listener: () => void) => textDocumentStore.subscribe(input.id, listener),
		[input.id],
	);
	const snapshot = useCallback(() => textDocumentStore.getSnapshot(input.id) ?? input, [input]);
	const document = useSyncExternalStore(subscribe, snapshot, snapshot);
	const [box, setBox] = useState(() => viewport?.getSnapshot());
	useLayoutEffect(() => {
		if (!viewport) return;
		setBox(viewport.getSnapshot());
		return viewport.subscribeViewport(setBox);
	}, [viewport]);
	useEffect(() => textDocumentStore.retain(input.id), [input.id]);
	const view = useTextDocumentView(document, {
		language: language ?? "text",
		theme,
		font,
		lineHeight,
		letterSpacing,
		tabSize,
		width: (box?.viewportWidth ?? 0) > 0 ? (box?.contentWidth ?? 0) : 0,
		wrap: wordWrap,
		top: Math.max(0, (box?.scrollTop ?? 0) - (box?.contentOrigin ?? 0)),
		height: box?.viewportHeight ?? 0,
		left: box?.scrollLeft ?? 0,
		viewportWidth: (box?.viewportWidth ?? 0) > 0 ? (box?.contentWidth ?? 0) : 0,
		fontRevision,
	});
	const sourceKey = `${document.id}:${document.epoch}`;
	const sourceProjection = useRef({ key: sourceKey, staleRows: view.rows, waiting: false });
	if (sourceProjection.current.key !== sourceKey)
		sourceProjection.current = { key: sourceKey, staleRows: view.rows, waiting: true };
	if (
		sourceProjection.current.waiting &&
		view.ready &&
		view.rows !== sourceProjection.current.staleRows
	)
		sourceProjection.current.waiting = false;
	const sourceRows = sourceProjection.current.waiting ? EMPTY_DOCUMENT_ROWS : view.rows;
	const colorKey = `${sourceKey}:${language}:${theme}`;
	const confirmedColors = useRef<{ key: string; tokens: DocumentPaintToken[] }>({
		key: colorKey,
		tokens: [],
	});
	if (confirmedColors.current.key !== colorKey)
		confirmedColors.current = { key: colorKey, tokens: [] };
	const paintRows = useMemo(() => {
		const previous = confirmedColors.current.tokens;
		const rows = sourceRows.map((row) => ({
			...row,
			tokens: documentPaintTokens(row.start, row.end, row.tokens, previous),
		}));
		if (view.highlightReady && !sourceProjection.current.waiting)
			confirmedColors.current = { key: colorKey, tokens: sourceRows.flatMap((row) => row.tokens) };
		return rows;
	}, [sourceRows, view.highlightReady, colorKey]);
	const highlightPending =
		!view.highlightReady || paintRows.some((row) => row.tokens.some((token) => token.pending));
	const root = useRef<HTMLDivElement>(null);
	const selectionKey = `${document.id}:${pane}`;
	const [selection, setSelection] = useState<DocumentSelection>(
		() => selections.get(selectionKey) ?? { anchor: 0, focus: 0 },
	);
	const selectionRef = useRef(selection);
	selectionRef.current = selection;
	const updateSelection = useCallback(
		(next: DocumentSelection) => {
			selectionRef.current = next;
			selections.set(selectionKey, next);
			if (selections.size > 256) selections.delete(selections.keys().next().value as string);
			setSelection(next);
		},
		[selectionKey],
	);
	useEffect(() => {
		updateSelection(selections.get(selectionKey) ?? { anchor: 0, focus: 0 });
	}, [selectionKey, updateSelection]);
	useEffect(() => {
		const current = selectionRef.current;
		if (current.anchor > document.length || current.focus > document.length)
			updateSelection({
				anchor: Math.min(current.anchor, document.length),
				focus: Math.min(current.focus, document.length),
			});
	}, [document.length, updateSelection]);
	const [findOpen, setFindOpen] = useState(false);
	useLayoutEffect(() => {
		if (takeDocumentFind(document.source)) {
			viewport?.pauseFollowing();
			setFindOpen(true);
		}
	}, [document.source, viewport?.pauseFollowing]);
	const [query, setQuery] = useState("");
	const [match, setMatch] = useState<DocumentMatch | null>(null);
	const [searchStatus, setSearchStatus] = useState<"idle" | "searching" | "missing" | "error">(
		"idle",
	);
	const [copyFailed, setCopyFailed] = useState(false);
	const searchAbort = useRef<AbortController | null>(null);
	const searchRunning = useRef(false);
	const searchDirty = useRef(false);
	const jumpRevision = useRef(0);
	const matchEpoch = useRef(document.epoch);
	useEffect(() => {
		if (matchEpoch.current === document.epoch) return;
		matchEpoch.current = document.epoch;
		searchAbort.current?.abort();
		searchRunning.current = false;
		searchDirty.current = true;
		setMatch(null);
		setSearchStatus("idle");
	}, [document.epoch]);
	const goTo = useCallback(
		async (offset: number, signal?: AbortSignal) => {
			anchor.current = null;
			viewport?.pauseFollowing();
			const revision = ++jumpRevision.current;
			const point = await view.locateOffset(offset);
			const node = viewport?.viewportRef.current;
			if (!node || !point || signal?.aborted || revision !== jumpRevision.current) return;
			// Reader jumps detach before async lookup; anchor corrections use viewport.scrollTo separately.
			node.scrollTop = point.top + (viewport?.contentPadding?.y ?? 0);
			if (!wordWrap) node.scrollLeft = Math.max(0, point.left - 24);
		},
		[
			view.locateOffset,
			viewport?.viewportRef,
			viewport?.contentPadding?.y,
			viewport?.pauseFollowing,
			wordWrap,
		],
	);
	const find: (direction: 1 | -1, current?: DocumentMatch | null) => void = useCallback(
		(direction: 1 | -1, current = match) => {
			if (query) viewport?.pauseFollowing();
			searchAbort.current?.abort();
			const abort = new AbortController();
			searchAbort.current = abort;
			searchRunning.current = true;
			searchDirty.current = false;
			let missing = false;
			setSearchStatus("searching");
			void findDocumentMatch(document.id, query, current, direction, abort.signal)
				.then(async (found) => {
					if (abort.signal.aborted) return;
					setMatch(found);
					setSearchStatus(found || !query ? "idle" : "missing");
					missing = !found;
					if (found) await goTo(found.start, abort.signal);
				})
				.catch(() => {
					if (!abort.signal.aborted) setSearchStatus("error");
				})
				.finally(() => {
					if (searchAbort.current !== abort) return;
					searchRunning.current = false;
					if (!abort.signal.aborted && missing && searchDirty.current) findRef.current(1, null);
				});
		},
		[document.id, query, match, goTo, viewport?.pauseFollowing],
	);
	const findRef = useRef(find);
	findRef.current = find;
	// biome-ignore lint/correctness/useExhaustiveDependencies: query/source changes restart the debounced search through the latest callback ref.
	useEffect(() => {
		if (!findOpen) return;
		const timer = setTimeout(() => findRef.current(1, null), 120);
		return () => {
			clearTimeout(timer);
			searchAbort.current?.abort();
		};
	}, [findOpen, query, document.id]);
	// A no-match query is retried as chunks arrive, including terms straddling a chunk boundary.
	// biome-ignore lint/correctness/useExhaustiveDependencies: source watermark changes retry an unmatched full-source query.
	useEffect(() => {
		if (findOpen && query && !match) {
			if (searchRunning.current) searchDirty.current = true;
			else findRef.current(1, null);
		}
	}, [document.revision, document.length, findOpen, query, match]);
	useEffect(
		() => () => {
			searchAbort.current?.abort();
			jumpRevision.current++;
		},
		[],
	);

	const lastView = useRef(view);
	const projection = `${document.epoch}|${font}|${fontRevision}|${lineHeight}|${letterSpacing}|${tabSize}|${wordWrap}|${box?.contentWidth}`;
	const lastProjection = useRef(projection);
	const anchor = useRef<{ offset: number; inset: number; staleRows?: typeof view.rows } | null>(
		null,
	);
	if (lastProjection.current !== projection) {
		const top = (box?.scrollTop ?? 0) - (box?.contentOrigin ?? 0);
		const row = lastView.current.rows.find((row) => row.top + row.height > top);
		if (row && !viewport?.isFollowing())
			anchor.current = {
				offset: row.start,
				inset: top - row.top,
				staleRows: lastView.current.rows === view.rows ? view.rows : undefined,
			};
		lastProjection.current = projection;
	}
	useLayoutEffect(() => {
		if (!viewport || !view.ready) return;
		const pending = anchor.current;
		// A new projection must publish its own extent before a source anchor can be restored.
		if (pending?.staleRows === view.rows && !viewport.isFollowing()) return;
		viewport.setContentSize({ width: view.contentWidth, height: view.contentHeight });
		if (pending && !viewport.isFollowing()) {
			let cancelled = false;
			void view
				.locateOffset(Math.min(document.length, pending.offset))
				.then((point) => {
					if (!cancelled && point && anchor.current === pending) {
						anchor.current = null;
						viewport.scrollTo(point.top + pending.inset + (viewport.contentPadding?.y ?? 0));
					}
				})
				.catch(() => {});
			viewport.notifyLayout();
			return () => {
				cancelled = true;
			};
		}
		viewport.notifyLayout();
	}, [
		view.ready,
		view.contentWidth,
		view.contentHeight,
		view.locateOffset,
		view.rows,
		viewport,
		document.length,
	]);
	lastView.current = view;

	const drag = useRef<{ x: number; y: number; pointerId: number } | null>(null);
	const animation = useRef(0);
	const hit = useCallback(
		(x: number, y: number) => {
			const node = viewport?.viewportRef.current;
			if (!node) return undefined;
			// Only hit-test a user gesture; no DOM geometry participates in layout/measurement.
			const rect = node.getBoundingClientRect();
			const current = viewport.getSnapshot();
			const visibleX = Math.max(rect.left, Math.min(x, rect.left + current.viewportWidth - 1));
			const visibleY = Math.max(rect.top, Math.min(y, rect.top + current.viewportHeight - 1));
			const native = root.current
				? nativeDocumentCaretOffset(root.current, visibleX, visibleY)
				: undefined;
			if (native !== undefined) return Math.max(0, Math.min(document.length, native));
			if (!view.ready) return undefined;
			return view.offsetAtPosition(
				x - rect.left + current.scrollLeft - (viewport.contentPadding?.x ?? 0),
				y - rect.top + current.scrollTop - current.contentOrigin,
			);
		},
		[view.ready, view.offsetAtPosition, viewport, document.length],
	);
	const dragFrame = useRef<() => void>(() => {});
	dragFrame.current = () => {
		animation.current = 0;
		const pointer = drag.current;
		const node = viewport?.viewportRef.current;
		if (!pointer || !node || !viewport) return;
		const rect = node.getBoundingClientRect();
		const current = viewport.getSnapshot();
		const delta = documentAutoscroll(pointer.y, rect.top, current.viewportHeight);
		if (delta)
			node.scrollTop = Math.max(
				0,
				Math.min(current.scrollHeight - current.viewportHeight, current.scrollTop + delta),
			);
		const offset = hit(pointer.x, pointer.y);
		if (offset !== undefined)
			updateSelection(selectOffset(selectionRef.current, offset, true, document.length));
		animation.current = requestAnimationFrame(() => dragFrame.current());
	};
	useEffect(
		() => () => {
			if (animation.current) cancelAnimationFrame(animation.current);
		},
		[],
	);

	const handleKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (event.target !== event.currentTarget || event.altKey) return;
		if (
			[
				"ArrowLeft",
				"ArrowRight",
				"ArrowUp",
				"ArrowDown",
				"PageUp",
				"PageDown",
				"Home",
				"End",
			].includes(event.key)
		) {
			anchor.current = null;
			jumpRevision.current++;
		}
		const modifier = event.ctrlKey || event.metaKey;
		if (modifier && !event.shiftKey && event.key.toLowerCase() === "f") {
			event.preventDefault();
			event.stopPropagation();
			viewport?.pauseFollowing();
			setFindOpen(true);
			return;
		}
		if (modifier && !event.shiftKey && event.key.toLowerCase() === "a") {
			event.preventDefault();
			event.stopPropagation();
			viewport?.pauseFollowing();
			updateSelection({ anchor: 0, focus: document.length });
			return;
		}
		if (modifier && !event.shiftKey && event.key.toLowerCase() === "c") {
			const range = selectionRange(selectionRef.current);
			if (range.start === range.end) return;
			event.preventDefault();
			event.stopPropagation();
			void copyDocument(document, range).then(
				() => setCopyFailed(false),
				() => setCopyFailed(true),
			);
			return;
		}
		if (modifier && !event.shiftKey && event.key !== "Home" && event.key !== "End") return;
		let next: DocumentSelection | undefined;
		if (event.key === "ArrowLeft" || event.key === "ArrowRight")
			next = moveSelectionOnBoundaries(
				selectionRef.current,
				event.key === "ArrowLeft" ? -1 : 1,
				event.shiftKey,
				document.length,
				view.rows.flatMap((row) => row.points.map((point) => point.offset)),
			);
		if (event.key === "Home" || event.key === "End") {
			const row = view.rows.find(
				(row) => selectionRef.current.focus >= row.start && selectionRef.current.focus <= row.end,
			);
			const offset = modifier
				? event.key === "Home"
					? 0
					: document.length
				: row
					? event.key === "Home"
						? row.start
						: row.end
					: undefined;
			if (offset !== undefined)
				next = selectOffset(selectionRef.current, offset, event.shiftKey, document.length);
		}
		if (event.key === "ArrowUp" || event.key === "ArrowDown") {
			const point = view.positionAtOffset(selectionRef.current.focus);
			if (point)
				next = selectOffset(
					selectionRef.current,
					view.offsetAtPosition(
						point.left,
						point.top + (event.key === "ArrowUp" ? -lineHeight : lineHeight),
					),
					event.shiftKey,
					document.length,
				);
		}
		if (next) {
			event.preventDefault();
			event.stopPropagation();
			updateSelection(next);
			void goTo(next.focus).catch(() => {});
		}
	};
	const portal = viewport?.viewportRef.current?.parentElement;
	return (
		<>
			{/* biome-ignore lint/a11y/useSemanticElements: virtual read-only code selection cannot be represented by a full-text input. */}
			<div
				ref={root}
				data-document-code-body={document.id}
				data-document-pane={pane}
				data-selection-anchor={selection.anchor}
				data-selection-focus={selection.focus}
				data-highlight-pending={highlightPending || undefined}
				title={highlightPending ? t("documentHighlightPending") : undefined}
				aria-busy={highlightPending}
				role="textbox"
				aria-readonly="true"
				aria-multiline="true"
				aria-label={t("documentCodeBody")}
				tabIndex={0}
				style={{
					position: "relative",
					width: Math.max(view.contentWidth, box?.contentWidth ?? 1),
					height: Math.max(lineHeight, view.contentHeight),
					font,
					lineHeight: `${lineHeight}px`,
					letterSpacing,
					tabSize,
					whiteSpace: "pre",
					userSelect: "none",
					touchAction: "pan-x pan-y",
					outline: "none",
				}}
				onKeyDown={handleKey}
				onWheel={() => {
					anchor.current = null;
					jumpRevision.current++;
				}}
				onPointerDown={(event) => {
					if (
						event.target instanceof Element &&
						event.target.closest("button,input,textarea,a,[data-message-selection-ignore]")
					)
						return;
					anchor.current = null;
					jumpRevision.current++;
					// Touch remains browser-owned scrolling. Native touch selection isn't a mouse drag.
					if (event.pointerType === "touch" || event.button !== 0) return;
					const offset = hit(event.clientX, event.clientY);
					if (offset === undefined) return;
					event.preventDefault();
					event.stopPropagation();
					event.currentTarget.focus({ preventScroll: true });
					viewport?.pauseFollowing();
					event.currentTarget.setPointerCapture?.(event.pointerId);
					updateSelection(
						selectOffset(selectionRef.current, offset, event.shiftKey, document.length),
					);
					drag.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
					if (!animation.current)
						animation.current = requestAnimationFrame(() => dragFrame.current());
				}}
				onPointerMove={(event) => {
					if (drag.current?.pointerId === event.pointerId)
						drag.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
				}}
				onPointerUp={() => {
					drag.current = null;
					if (animation.current) cancelAnimationFrame(animation.current);
					animation.current = 0;
				}}
				onPointerCancel={() => {
					drag.current = null;
				}}
			>
				{document.length > 0 &&
				(sourceProjection.current.waiting || (!view.ready && !sourceRows.length)) ? (
					<DocumentSourceStatus />
				) : null}
				{paintRows.map((row) => {
					const positions = new Map(row.points.map((point) => [point.offset, point.x]));
					return (
						<div
							key={row.index}
							data-document-visual-row={row.index}
							data-source-start={row.start}
							style={{
								position: "absolute",
								top: row.top,
								left: row.left,
								height: row.height,
								whiteSpace: "pre",
							}}
						>
							{row.tokens.flatMap((token) =>
								markedIntervals(
									Math.max(row.start, token.start),
									Math.min(row.end, token.end),
									selection,
									match,
								).map((part) => (
									<span
										key={`${token.start}:${part.start}`}
										data-source-start={part.start}
										data-source-end={part.end}
										style={{
											color: token.color,
											fontStyle: token.fontStyle && token.fontStyle & 1 ? "italic" : undefined,
											fontWeight: token.fontStyle && token.fontStyle & 2 ? 700 : undefined,
											textDecoration:
												token.fontStyle && token.fontStyle & 4 ? "underline" : undefined,
											background: part.selected
												? "var(--mantine-color-indigo-7)"
												: part.found
													? "var(--mantine-color-yellow-7)"
													: undefined,
										}}
									>
										<DocumentTextFragment
											text={row.text.slice(part.start - row.start, part.end - row.start)}
											start={part.start}
											positions={positions}
										/>
									</span>
								)),
							)}
						</div>
					);
				})}
				{view.error || copyFailed ? (
					<div
						role="alert"
						style={{ position: "sticky", top: 0, color: "var(--mantine-color-red-6)" }}
					>
						{copyFailed ? t("documentCopyFailed") : t("documentLoadFailed")}{" "}
						{view.error ? (
							<button type="button" onClick={view.retry}>
								{t("documentRetry")}
							</button>
						) : null}
					</div>
				) : null}
			</div>
			{findOpen && portal
				? createPortal(
						<DocumentSearch
							query={query}
							onQuery={(value) => {
								setMatch(null);
								setQuery(value);
							}}
							onFind={find}
							onClose={() => {
								setFindOpen(false);
								root.current?.focus({ preventScroll: true });
							}}
							status={searchStatus}
						/>,
						portal,
					)
				: null}
		</>
	);
}
