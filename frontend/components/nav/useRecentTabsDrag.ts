import {
	type DragEndEvent,
	type DragMoveEvent,
	type DragStartEvent,
	MouseSensor,
	TouchSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import type { QueryClient } from "@tanstack/react-query";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RecentTab } from "../../hooks/recent-tabs-utils";
import {
	applyRecentTabsDelta,
	applyRecentTabsDeltaAndFollowUp,
	refreshRecentTabsLoadedWindow,
} from "../../hooks/useRecentTabs";
import { api } from "../../lib/api";
import { cancelDrag, endDrag, getPanelDrag, moveDrag, startDragManual } from "../../lib/panel-drag";
import {
	createRecentTabDragModel,
	planRecentTabInternalDrop,
	projectRecentTabDragOrder,
	recentTabDragIndicatorRows,
	recentTabDragMeasuredRow,
	resolveRecentTabInternalDrop,
} from "./recent-tab-drag-model";
import type { RecentTabDropRow, RecentTabDropTarget } from "./recent-tab-drop-target";
import { autoScrollAllowedForPointer } from "./recent-tabs-logic";

export interface UseRecentTabsDragOptions {
	/** Latest section tabs; project/narrator filtering belongs to the caller. */
	tabs: RecentTab[];
	groupingEnabled: boolean;
	directoryCollapsedByPath: ReadonlyMap<string, boolean>;
	containerRef: RefObject<HTMLElement | null>;
	qc: QueryClient;
	onError: () => void;
}

function sourceIdentity(entry: {
	unit: string;
	role: string;
	pinned: boolean;
	workspaceId?: string;
	tab?: RecentTab;
}) {
	return JSON.stringify([
		entry.unit,
		entry.role,
		entry.pinned,
		entry.workspaceId,
		entry.tab?.narratorId,
	]);
}

// A bounded submission includes serial moves and any required cache reconciliation.
const SUBMISSION_TIMEOUT_MS = 120_000;

function awaitSubmission<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason ?? new Error("Recent tab reorder cancelled"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		// Attach both branches even after abort so late responses cannot cause unhandled rejection.
		operation.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
function eventPointer(event: Event): { x: number; y: number } | null {
	const pointer = event as MouseEvent | TouchEvent;
	if ("clientX" in pointer) return { x: pointer.clientX, y: pointer.clientY };
	const touch = pointer.touches?.[0] ?? pointer.changedTouches?.[0];
	return touch ? { x: touch.clientX, y: touch.clientY } : null;
}

export function useRecentTabsDrag(options: UseRecentTabsDragOptions) {
	const { tabs, groupingEnabled, directoryCollapsedByPath, containerRef } = options;
	const [draggingId, setDraggingId] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [optimistic, setOptimistic] = useState<RecentTab[] | null>(null);
	const [indicator, setIndicator] = useState<{
		rows: RecentTabDropRow[];
		target: RecentTabDropTarget;
		containerTop: number;
	} | null>(null);
	const directoryKeysRef = useRef<ReadonlySet<string>>(new Set());
	const renderTabs = useMemo(
		() => projectRecentTabDragOrder(tabs, optimistic, directoryKeysRef.current),
		[tabs, optimistic],
	);
	const model = useMemo(
		() => createRecentTabDragModel(renderTabs, groupingEnabled, directoryCollapsedByPath),
		[renderTabs, groupingEnabled, directoryCollapsedByPath],
	);
	const modelRef = useRef(model);
	modelRef.current = model;
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const draggingRef = useRef(false);
	const pendingRef = useRef(false);
	const submissionRef = useRef<AbortController | null>(null);
	const activeRef = useRef<string | null>(null);
	const sourceIdentityRef = useRef<string | null>(null);
	const ownedRef = useRef<ReturnType<typeof getPanelDrag>>(null);
	const pointerRef = useRef<{ x: number; y: number } | null>(null);
	const originRef = useRef<{ x: number; y: number } | null>(null);
	const capturedRef = useRef(false);
	const clickRef = useRef(false);
	const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const mountedRef = useRef(true);
	const indicatorFrameRef = useRef<number | null>(null);
	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
		useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 5 } }),
	);

	const measureRows = useCallback((): RecentTabDropRow[] => {
		const container = optionsRef.current.containerRef.current;
		if (!container) return [];
		const result: RecentTabDropRow[] = [];
		for (const el of container.querySelectorAll<HTMLElement>("[data-tab-sort-id]")) {
			const rect = el.getBoundingClientRect();
			const row = recentTabDragMeasuredRow(
				modelRef.current,
				el.dataset.tabSortId ?? "",
				rect.top,
				rect.bottom,
			);
			if (row && rect.height > 0) result.push(row);
		}
		return result.sort((a, b) => a.top - b.top);
	}, []);

	const updateIndicator = useCallback(() => {
		const source = activeRef.current;
		const pointer = pointerRef.current;
		const el = optionsRef.current.containerRef.current;
		if (!source || !pointer || !el) return;
		const rect = el.getBoundingClientRect();
		const rows = measureRows();
		const target = resolveRecentTabInternalDrop(modelRef.current, source, rows, pointer, rect);
		const next = target
			? {
					rows: recentTabDragIndicatorRows(modelRef.current, source, rows),
					target,
					containerTop: rect.top,
				}
			: null;
		setIndicator((previous) => {
			if (!previous || !next) return previous === next ? previous : next;
			if (
				previous.containerTop !== next.containerTop ||
				JSON.stringify(previous.target) !== JSON.stringify(next.target) ||
				previous.rows.length !== next.rows.length
			)
				return next;
			const unchanged = previous.rows.every((row, index) => {
				const other = next.rows[index];
				return (
					row.key === other.key &&
					row.top === other.top &&
					row.bottom === other.bottom &&
					row.pinned === other.pinned &&
					row.workspaceId === other.workspaceId &&
					row.keyBlock.length === other.keyBlock.length &&
					row.keyBlock.every((key, keyIndex) => key === other.keyBlock[keyIndex])
				);
			});
			return unchanged ? previous : next;
		});
	}, [measureRows]);

	const scheduleIndicator = useCallback(() => {
		if (!activeRef.current || indicatorFrameRef.current !== null) return;
		indicatorFrameRef.current = requestAnimationFrame(() => {
			indicatorFrameRef.current = null;
			updateIndicator();
		});
	}, [updateIndicator]);

	const clear = useCallback(() => {
		if (indicatorFrameRef.current !== null) {
			cancelAnimationFrame(indicatorFrameRef.current);
			indicatorFrameRef.current = null;
		}
		activeRef.current = null;
		sourceIdentityRef.current = null;
		draggingRef.current = false;
		pointerRef.current = null;
		originRef.current = null;
		capturedRef.current = false;
		ownedRef.current = null;
		if (mountedRef.current) {
			setDraggingId(null);
			setIndicator(null);
		}
	}, []);
	const suppressClick = useCallback(() => {
		clickRef.current = true;
		if (clickTimerRef.current !== null) clearTimeout(clickTimerRef.current);
		clickTimerRef.current = setTimeout(() => {
			clickRef.current = false;
			clickTimerRef.current = null;
		}, 0);
	}, []);
	const onDragCancel = useCallback(() => {
		if (!activeRef.current) return;
		suppressClick();
		if (ownedRef.current && getPanelDrag() === ownedRef.current) cancelDrag();
		clear();
	}, [clear, suppressClick]);

	useEffect(() => {
		if (!activeRef.current) return;
		const entry = model.entries.get(activeRef.current);
		if (!entry || sourceIdentity(entry) !== sourceIdentityRef.current) onDragCancel();
		else scheduleIndicator();
	}, [model, onDragCancel, scheduleIndicator]);
	// Mode changes cancel even when the dragged tab survives in the new mode.
	const modeRef = useRef(groupingEnabled);
	useEffect(() => {
		if (modeRef.current !== groupingEnabled) onDragCancel();
		modeRef.current = groupingEnabled;
	}, [groupingEnabled, onDragCancel]);

	useEffect(() => {
		if (!draggingId) return;
		const doc = containerRef.current?.ownerDocument ?? document;
		const capture = (event: Event) => {
			const pointer = eventPointer(event);
			if (!pointer || !activeRef.current) return;
			capturedRef.current = true;
			pointerRef.current = pointer;
			if (ownedRef.current && getPanelDrag() === ownedRef.current) {
				moveDrag(pointer.x, pointer.y);
				ownedRef.current = getPanelDrag();
			}
			scheduleIndicator();
		};
		for (const event of ["mousemove", "mouseup", "touchmove", "touchend"])
			doc.addEventListener(event, capture, true);
		// Auto-scroll emits scroll events even while the pointer is stationary.
		doc.addEventListener("scroll", scheduleIndicator, true);
		doc.defaultView?.addEventListener("resize", scheduleIndicator);
		scheduleIndicator();
		return () => {
			for (const event of ["mousemove", "mouseup", "touchmove", "touchend"])
				doc.removeEventListener(event, capture, true);
			doc.removeEventListener("scroll", scheduleIndicator, true);
			doc.defaultView?.removeEventListener("resize", scheduleIndicator);
		};
	}, [draggingId, containerRef, scheduleIndicator]);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			submissionRef.current?.abort();
			if (ownedRef.current && getPanelDrag() === ownedRef.current) cancelDrag();
			clear();
			if (clickTimerRef.current !== null) clearTimeout(clickTimerRef.current);
		};
	}, [clear]);

	const onDragStart = useCallback(
		(event: DragStartEvent) => {
			if (pendingRef.current || activeRef.current) return;
			const key = String(event.active.id);
			const entry = modelRef.current.entries.get(key);
			if (!entry) return;
			activeRef.current = key;
			sourceIdentityRef.current = sourceIdentity(entry);
			draggingRef.current = true;
			const pointer = eventPointer(event.activatorEvent);
			pointerRef.current = pointer;
			originRef.current = pointer;
			capturedRef.current = false;
			setDraggingId(key);
			const tab = entry.tab;
			const narratorId =
				tab?.type === "narrator" || tab?.type === "subagent"
					? tab.id
					: tab?.type === "chapter"
						? tab.narratorId
						: null;
			if (narratorId && tab && pointer) {
				startDragManual(narratorId, tab.title, pointer.x, pointer.y);
				ownedRef.current = getPanelDrag();
			}
			updateIndicator();
		},
		[updateIndicator],
	);
	const updatePointer = useCallback((event: DragMoveEvent | DragEndEvent) => {
		if (!activeRef.current) return;
		const origin = originRef.current;
		if (!capturedRef.current && origin)
			pointerRef.current = { x: origin.x + event.delta.x, y: origin.y + event.delta.y };
		const pointer = pointerRef.current;
		if (pointer && ownedRef.current && getPanelDrag() === ownedRef.current) {
			moveDrag(pointer.x, pointer.y);
			ownedRef.current = getPanelDrag();
		}
	}, []);
	const onDragMove = useCallback(
		(event: DragMoveEvent) => {
			updatePointer(event);
			scheduleIndicator();
		},
		[updatePointer, scheduleIndicator],
	);
	const onDragEnd = useCallback(
		async (event: DragEndEvent) => {
			const source = activeRef.current;
			if (!source) return;
			updatePointer(event);
			const pointer = pointerRef.current;
			const el = optionsRef.current.containerRef.current;
			const target =
				pointer && el
					? resolveRecentTabInternalDrop(
							modelRef.current,
							source,
							measureRows(),
							pointer,
							el.getBoundingClientRect(),
						)
					: null;
			const plan = target ? planRecentTabInternalDrop(modelRef.current, source, target) : null;
			suppressClick();
			// A sidebar release belongs only to sorting, even if another surface still
			// holds an earlier hover target. Keep sidebar subscribers suspended until broadcast ends.
			try {
				if (ownedRef.current && getPanelDrag() === ownedRef.current) {
					const rect = el?.getBoundingClientRect();
					const inside =
						pointer &&
						rect &&
						pointer.x >= rect.left &&
						pointer.x <= rect.right &&
						pointer.y >= rect.top &&
						pointer.y <= rect.bottom;
					if (inside) cancelDrag();
					else endDrag();
				}
			} finally {
				clear();
			}
			if (!plan || (!plan.directoryKeys && !plan.moves.length)) return;
			pendingRef.current = true;
			setPending(true);
			directoryKeysRef.current = new Set(plan.directoryKeys ?? []);
			setOptimistic(plan.finalTabs);
			const { qc, onError } = optionsRef.current;
			const controller = new AbortController();
			submissionRef.current = controller;
			const timeout = setTimeout(
				() => controller.abort(new Error("Recent tab reorder timed out")),
				SUBMISSION_TIMEOUT_MS,
			);
			const { signal } = controller;
			try {
				if (plan.directoryKeys) {
					const result = await awaitSubmission(
						api.setRecentTabDirectoryOrder(plan.directoryKeys, signal),
						signal,
					);
					await awaitSubmission(applyRecentTabsDeltaAndFollowUp(qc, result), signal);
				} else {
					let reset = false;
					let backfill = false;
					let revision: number | undefined;
					for (const move of plan.moves) {
						signal.throwIfAborted();
						const result = await awaitSubmission(
							api.moveRecentTab(
								move.key,
								move.beforeKey
									? { beforeKey: move.beforeKey }
									: { afterKey: move.afterKey as string },
								signal,
							),
							signal,
						);
						const applied = applyRecentTabsDelta(qc, result);
						reset ||= applied.gaps.length > 0;
						backfill ||= applied.backfill.length > 0;
						revision = result.revision;
					}
					if (reset || backfill) {
						await awaitSubmission(
							refreshRecentTabsLoadedWindow(qc, { reset, minimumRevision: revision }),
							signal,
						);
					}
				}
			} catch {
				try {
					if (mountedRef.current) onError();
				} finally {
					// Resync partial commits, but never keep a cancelled submission locked on a hung refresh.
					await awaitSubmission(refreshRecentTabsLoadedWindow(qc, { reset: true }), signal).catch(
						() => {},
					);
				}
			} finally {
				clearTimeout(timeout);
				if (submissionRef.current === controller) submissionRef.current = null;
				pendingRef.current = false;
				if (mountedRef.current) {
					setPending(false);
					setOptimistic(null);
				}
			}
		},
		[clear, measureRows, suppressClick, updatePointer],
	);
	const autoScrollOptions = useMemo(
		() => ({
			canScroll: (element: Element) => {
				const container = optionsRef.current.containerRef.current;
				if (!container || (element !== container && !element.contains(container))) return false;
				const gate =
					container.closest("[data-auto-scroll-gate]") ?? container.closest("nav") ?? container;
				if (element !== container && !gate.contains(element)) return false;
				return autoScrollAllowedForPointer(
					pointerRef.current?.x ?? null,
					gate.getBoundingClientRect(),
				);
			},
		}),
		[],
	);
	const consumeClick = useCallback(() => {
		if (!clickRef.current) return false;
		clickRef.current = false;
		return true;
	}, []);
	const draggingEntry = draggingId ? model.entries.get(draggingId) : undefined;
	const draggingDirectory = draggingId
		? model.rows.find((row) => row.kind === "directory" && `dir:${row.path}` === draggingId)
		: undefined;
	return {
		model,
		renderTabs,
		draggingId,
		draggingTab: draggingEntry?.tab ?? null,
		draggingDirectory: draggingDirectory?.kind === "directory" ? draggingDirectory : null,
		draggingRef,
		pending,
		sensors,
		autoScrollOptions,
		onDragStart,
		onDragMove,
		onDragEnd,
		onDragCancel,
		indicator,
		measureRows,
		consumeClick,
	};
}
