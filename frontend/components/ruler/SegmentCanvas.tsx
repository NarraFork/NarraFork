import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { memo, useEffect, useMemo } from "react";
import type { RulerSegment } from "../../hooks/useRuler";
import { api } from "../../lib/api";
import { localScale } from "./fisheye";
import type { RulerOrientation, RulerPixiChapterPayload } from "./types";
import { getCardModeForChapter } from "./zoom-tiers";

/** Active segments refresh faster; historical ones can be stale longer. */
function getSegmentStaleTime(segment: RulerSegment): number {
	if (segment.activeChapterCount > 0) return 15_000; // 15s for active
	return 5 * 60 * 1000; // 5min for historical
}

const RULER_SEGMENT_GC_TIME_MS = 60_000;

interface SegmentChapter {
	id: string;
	title: string;
	status: string;
	branch: string;
	role: string;
	parentChapterId: string | null;
	narratorId: string | null;
	narratorStatus: string | null;
	/** Narrator is parked until an unavailable model recovers (see PixiChapterInfo). */
	narratorModelUnavailable?: boolean;
	reviewStatus: string | null;
	startCommitSha: string | null;
	mergeCommitSha: string | null;
	anchorCommitSha: string | null;
	axisOffset: number;
	crossOffset: number;
	panelWidth: number | null;
	panelHeight: number | null;
}

interface SegmentData {
	chapters: SegmentChapter[];
	edges: Array<{ id: string; sourceId: string; targetId: string; type: string }>;
}

export interface CardWorldInfo {
	id: string;
	title: string;
	worldX: number;
	worldY: number;
	worldW: number;
	worldH: number;
	status: string;
	narratorStatus: string | null;
	/**
	 * Narrator is parked until an unavailable model recovers. Offscreen bubbles
	 * use this to stay silent: the wait is not actionable, so it must not raise an
	 * attention bubble even though the status reads `waiting`.
	 */
	narratorModelUnavailable?: boolean;
}

interface SegmentCanvasProps {
	projectId: string;
	fromSha: string;
	toSha: string;
	/** Position along the main axis (world coords) */
	mainPos: number;
	/** Size along the main axis (world coords) */
	mainSize: number;
	segment: RulerSegment;
	/** Current camera scale — used for inverse-scaling interactive elements */
	scale?: number;
	orientation?: RulerOrientation;
	/** World-space cross-axis offset of the viewport top/left edge */
	viewTop?: number;
	/** World-space cross-axis size of the viewport */
	viewHeight?: number;
	// ⚠️ No `cardRegistry` prop. This component writes NO world positions: since the
	// PixiJS pipeline took over drawing (commit c7d623ad) it only loads segment data
	// and reports chapters through `onChaptersLoaded`. The prop lingered here, declared
	// but never destructured, which left RulerFlow's registry permanently empty. It is
	// now filled in RulerFlow from `pixiChapters` — the same list PixiJS draws.
	/** Request the parent to fit a world-space rect into the viewport */
	onFitToView?: (worldX: number, worldY: number, worldW: number, worldH: number) => void;
	/** World-space X of the zoom center (for morph proximity) */
	zoomCenterWorldX?: number;
	/** Screen-space size of the viewport along the main axis (for fisheye) */
	viewportSize?: number;
	/** Screen-space main-axis position of this segment (fisheye-mapped) */
	screenMainPos?: number;
	/** Screen-space main-axis size of this segment (fisheye-mapped) */
	screenMainSize?: number;
	/** Screen-space cross-axis offset (crossPan + rulerThickness) */
	screenCrossOffset?: number;
	/** Callback when chapters are loaded for a segment */
	onChaptersLoaded?: (fromSha: string, chapters: RulerPixiChapterPayload[]) => void;
	/** Lightweight callback during card drag — updates PixiJS without React re-render */
	onChapterDragMove?: (fromSha: string, chapters: RulerPixiChapterPayload[]) => void;
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 72;

export const SegmentCanvas = memo(
	function SegmentCanvas({
		projectId,
		fromSha,
		toSha,
		mainPos,
		mainSize,
		segment: _segment,
		scale = 1,
		orientation = "horizontal",
		zoomCenterWorldX = 0,
		viewportSize = 1200,
		onChaptersLoaded,
	}: SegmentCanvasProps) {
		const isH = orientation === "horizontal";

		// Determine data detail level based on the segment point closest to the
		// fisheye center. Using the segment center caused long segments at the
		// viewport edge to downgrade too early — their center was far from the
		// fisheye peak even though their near edge was still in the high-LOD zone.
		// Request "full" data when the nearest edge reaches at least L2 (compact),
		// so chapters are ready before they morph into card phase.
		const segNearestWorld = Math.max(mainPos, Math.min(mainPos + mainSize, zoomCenterWorldX));
		const segEffectiveScale = localScale(segNearestWorld, zoomCenterWorldX, viewportSize, scale);
		const segCardMode = getCardModeForChapter(segEffectiveScale);
		const needsFull = segCardMode === "full" || segCardMode === "compact";

		const { data } = useQuery({
			queryKey: ["rulerSegment", projectId, fromSha, needsFull ? "full" : "summary"],
			queryFn: () =>
				api.getRulerSegment(
					projectId,
					fromSha,
					toSha,
					needsFull ? "full" : "summary",
				) as Promise<SegmentData>,
			staleTime: getSegmentStaleTime(_segment),
			gcTime: RULER_SEGMENT_GC_TIME_MS,
			placeholderData: _segment.activeChapterCount === 0 ? keepPreviousData : undefined,
		});

		const chapters = data?.chapters ?? [];

		const laid = useMemo(() => {
			const padding = 20;
			const gap = 16;
			if (isH) {
				// Horizontal: mainSize is X-axis, tile cards along X
				const cols = Math.max(1, Math.floor((mainSize - padding * 2) / (NODE_WIDTH + gap)));
				return chapters.map((ch, i) => {
					if (ch.axisOffset !== 0 || ch.crossOffset !== 0)
						return { ...ch, layoutX: ch.axisOffset, layoutY: ch.crossOffset };
					const col = i % cols;
					const row = Math.floor(i / cols);
					return {
						...ch,
						layoutX: padding + col * (NODE_WIDTH + gap),
						layoutY: padding + row * (NODE_HEIGHT + gap),
					};
				});
			}
			// Vertical: mainSize is Y-axis, tile cards along Y
			// layoutX = cross-axis offset, layoutY = main-axis offset
			// (in horizontal mode layoutX is main-axis; axes swap in vertical mode)
			const rows = Math.max(1, Math.floor((mainSize - padding * 2) / (NODE_HEIGHT + gap)));
			return chapters.map((ch, i) => {
				if (ch.axisOffset !== 0 || ch.crossOffset !== 0)
					return { ...ch, layoutX: ch.axisOffset, layoutY: ch.crossOffset };
				const row = i % rows;
				const col = Math.floor(i / rows);
				return {
					...ch,
					layoutX: padding + row * (NODE_HEIGHT + gap),
					layoutY: padding + col * (NODE_WIDTH + gap),
				};
			});
		}, [chapters, mainSize, isH]);

		// Report chapter data to parent for PixiJS rendering
		useEffect(() => {
			if (onChaptersLoaded && laid.length > 0) {
				onChaptersLoaded(
					fromSha,
					laid.map((ch) => ({
						id: ch.id,
						status: ch.status,
						title: ch.title,
						branch: ch.branch,
						role: ch.role,
						parentChapterId: ch.parentChapterId,
						narratorId: ch.narratorId,
						narratorStatus: ch.narratorStatus,
						narratorModelUnavailable: ch.narratorModelUnavailable,
						reviewStatus: ch.reviewStatus,
						startCommitSha: ch.startCommitSha,
						mergeCommitSha: ch.mergeCommitSha,
						layoutX: ch.layoutX,
						layoutY: ch.layoutY,
					})),
				);
			}
		}, [laid, fromSha, onChaptersLoaded]);

		// Clear PixiJS data only on full unmount.
		// Intentionally omits onChaptersLoaded from deps — parent must provide a stable
		// (useCallback) reference so this cleanup fires only on unmount, not on re-render.
		// biome-ignore lint/correctness/useExhaustiveDependencies: unmount-only cleanup; parent guarantees stable callback ref
		useEffect(() => {
			return () => {
				onChaptersLoaded?.(fromSha, []);
			};
		}, [fromSha]);

		// PixiJS handles all rendering — this component only loads data.
		return null;
	},
	(prev, next) => {
		// Skip re-render when only camera-driven cosmetic props change (scale).
		// viewTop/viewHeight are NOT skipped because they drive cross-axis card culling.
		if (prev.projectId !== next.projectId) return false;
		if (prev.fromSha !== next.fromSha) return false;
		if (prev.toSha !== next.toSha) return false;
		if (prev.mainPos !== next.mainPos) return false;
		if (prev.mainSize !== next.mainSize) return false;
		if (prev.segment !== next.segment) return false;
		if (prev.orientation !== next.orientation) return false;
		if (prev.onFitToView !== next.onFitToView) return false;
		if (prev.scale !== next.scale) return false;
		if (prev.zoomCenterWorldX !== next.zoomCenterWorldX) return false;
		if (prev.viewportSize !== next.viewportSize) return false;
		if (prev.screenMainPos !== next.screenMainPos) return false;
		if (prev.screenCrossOffset !== next.screenCrossOffset) return false;
		if (prev.onChaptersLoaded !== next.onChaptersLoaded) return false;
		if (prev.onChapterDragMove !== next.onChapterDragMove) return false;
		return true;
	},
);
