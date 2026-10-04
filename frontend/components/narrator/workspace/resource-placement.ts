/** Pure workspace-local geometry. Callers filter out non-grid/locked groups. */
export interface ResourcePlacementSize {
	width: number;
	height: number;
}

export interface ResourcePlacementRect extends ResourcePlacementSize {
	left: number;
	top: number;
}

export interface ResourceGroupRect extends ResourcePlacementRect {
	id: string;
}

export interface ResourceTargetOptions {
	/** Allow the divider/rounding gap between otherwise shared edges (px). */
	edgeTolerance?: number;
}

export const RESOURCE_EDGE_TOLERANCE = 4;
export const RESOURCE_FLOATING_SIZE: Readonly<ResourcePlacementSize> = {
	width: 560,
	height: 420,
};
export const RESOURCE_SPLIT_MINIMUM: Readonly<ResourcePlacementSize> = {
	width: 280,
	height: 180,
};

function validSize(size: ResourcePlacementSize): boolean {
	return (
		Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0
	);
}

function validRect(rect: ResourcePlacementRect | undefined): rect is ResourcePlacementRect {
	return (
		!!rect &&
		validSize(rect) &&
		Number.isFinite(rect.left) &&
		Number.isFinite(rect.top) &&
		Number.isFinite(rect.left + rect.width) &&
		Number.isFinite(rect.top + rect.height)
	);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function overlap(start: number, length: number, otherStart: number, otherLength: number): number {
	return Math.max(
		0,
		Math.min(start + length, otherStart + otherLength) - Math.max(start, otherStart),
	);
}

function nonNegative(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function scoreTarget(source: ResourceGroupRect, target: ResourceGroupRect, tolerance: number) {
	const verticalOverlap = overlap(source.top, source.height, target.top, target.height);
	const horizontalOverlap = overlap(source.left, source.width, target.left, target.width);
	const edges = [
		{
			gap: target.left - source.left - source.width,
			overlap: verticalOverlap,
			onSide: target.left > source.left,
		},
		{
			gap: source.left - target.left - target.width,
			overlap: verticalOverlap,
			onSide: target.left < source.left,
		},
		{
			gap: target.top - source.top - source.height,
			overlap: horizontalOverlap,
			onSide: target.top > source.top,
		},
		{
			gap: source.top - target.top - target.height,
			overlap: horizontalOverlap,
			onSide: target.top < source.top,
		},
	];
	const direction = edges.findIndex(
		(edge) => edge.onSide && Math.abs(edge.gap) <= tolerance && edge.overlap > 0,
	);
	return {
		target,
		id: target.id,
		// All shared-edge neighbors precede the nearest non-neighbor fallback.
		direction: direction === -1 ? edges.length : direction,
		overlap: direction === -1 ? 0 : edges[direction].overlap,
		distance: Math.hypot(
			target.left + target.width / 2 - (source.left + source.width / 2),
			target.top + target.height / 2 - (source.top + source.height / 2),
		),
	};
}

/**
 * Right, left, below, above shared-edge neighbors, then nearest center fallback.
 * Within one direction: longer overlap, shorter center distance, stable id.
 * No source geometry means no inferred target; input order is never a tie-breaker.
 */
export function rankResourceTargets(
	source: ResourceGroupRect | undefined,
	candidates: readonly ResourceGroupRect[],
	options: ResourceTargetOptions = {},
): ResourceGroupRect[] {
	if (!validRect(source)) return [];
	const tolerance = nonNegative(options.edgeTolerance, RESOURCE_EDGE_TOLERANCE);
	return candidates
		.filter(
			(candidate) => candidate.id !== source.id && candidate.id.length > 0 && validRect(candidate),
		)
		.map((candidate) => scoreTarget(source, candidate, tolerance))
		.sort(
			(a, b) =>
				a.direction - b.direction ||
				b.overlap - a.overlap ||
				a.distance - b.distance ||
				(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
		)
		.map((candidate) => candidate.target);
}

/** Id-only form for callers that resolve their own Dockview groups. */
export function rankResourceTargetGroups(
	source: ResourceGroupRect | undefined,
	candidates: readonly ResourceGroupRect[],
	options?: ResourceTargetOptions,
): string[] {
	return rankResourceTargets(source, candidates, options).map((candidate) => candidate.id);
}

export function selectResourceTargetGroup(
	source: ResourceGroupRect | undefined,
	candidates: readonly ResourceGroupRect[],
	options?: ResourceTargetOptions,
): string | null {
	return rankResourceTargetGroups(source, candidates, options)[0] ?? null;
}

export interface ResourceFloatingOptions {
	workspaceWidth: number;
	workspaceHeight: number;
	/** Must already be relative to the workspace, not viewport coordinates. */
	source?: ResourcePlacementRect;
}

/** A temporary 560×420 window, clamped to the workspace (full width on small screens). */
export function computeResourceFloatingBounds({
	workspaceWidth,
	workspaceHeight,
	source,
}: ResourceFloatingOptions): ResourcePlacementRect | null {
	if (!validSize({ width: workspaceWidth, height: workspaceHeight })) return null;
	const width = Math.min(RESOURCE_FLOATING_SIZE.width, workspaceWidth);
	const height = Math.min(RESOURCE_FLOATING_SIZE.height, workspaceHeight);
	let left = (workspaceWidth - width) / 2;
	let top = (workspaceHeight - height) / 2;
	if (validRect(source)) {
		const gap = 8;
		const positions = [
			{ left: source.left + source.width + gap, top: source.top },
			{ left: source.left - width - gap, top: source.top },
			{ left: source.left, top: source.top + source.height + gap },
			{ left: source.left, top: source.top - height - gap },
		];
		// Clamp the orthogonal axis: a bottom-edge source can still have room on its right.
		const fitting = positions.find((position, index) =>
			index < 2
				? position.left >= 0 && position.left + width <= workspaceWidth
				: position.top >= 0 && position.top + height <= workspaceHeight,
		);
		({ left, top } = fitting ?? positions[0]);
	}
	return {
		left: clamp(left, 0, workspaceWidth - width),
		top: clamp(top, 0, workspaceHeight - height),
		width,
		height,
	};
}

export interface ResourceFloatingBounds extends ResourcePlacementSize {
	x: number;
	y: number;
}

/** Dockview-compatible bounds; all positions remain workspace-local. */
export function floatingResourceBounds(
	workspaceWidth: number,
	workspaceHeight: number,
	source?: ResourcePlacementRect,
): ResourceFloatingBounds | null {
	const rect = computeResourceFloatingBounds({ workspaceWidth, workspaceHeight, source });
	return rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null;
}

export interface ResourceSplitOptions {
	sourceMinimum?: ResourcePlacementSize;
	resourceMinimum?: ResourcePlacementSize;
	/** Space reserved for the new divider. */
	gap?: number;
}

export interface ResourceSplitPlacement {
	direction: "right" | "below";
	sourceSize: ResourcePlacementSize;
	newSize: ResourcePlacementSize;
}

/** Split the source itself, preferring right; do not squeeze either pane below its minimum. */
export function computeResourceSplitPlacement(
	source: ResourcePlacementSize | undefined,
	options: ResourceSplitOptions = {},
): ResourceSplitPlacement | null {
	if (!source || !validSize(source)) return null;
	const sourceMinimum = options.sourceMinimum ?? RESOURCE_SPLIT_MINIMUM;
	const resourceMinimum = options.resourceMinimum ?? RESOURCE_SPLIT_MINIMUM;
	if (!validSize(sourceMinimum) || !validSize(resourceMinimum)) return null;
	const gap = nonNegative(options.gap, RESOURCE_EDGE_TOLERANCE);
	const width = source.width - gap;
	if (
		width >= sourceMinimum.width + resourceMinimum.width &&
		source.height >= Math.max(sourceMinimum.height, resourceMinimum.height)
	) {
		const sourceWidth = clamp(width / 2, sourceMinimum.width, width - resourceMinimum.width);
		return {
			direction: "right",
			sourceSize: { width: sourceWidth, height: source.height },
			newSize: { width: width - sourceWidth, height: source.height },
		};
	}
	const height = source.height - gap;
	if (
		height >= sourceMinimum.height + resourceMinimum.height &&
		source.width >= Math.max(sourceMinimum.width, resourceMinimum.width)
	) {
		const sourceHeight = clamp(height / 2, sourceMinimum.height, height - resourceMinimum.height);
		return {
			direction: "below",
			sourceSize: { width: source.width, height: sourceHeight },
			newSize: { width: source.width, height: height - sourceHeight },
		};
	}
	return null;
}

export function resourceSplitDirection(
	source: ResourcePlacementSize | undefined,
	options?: ResourceSplitOptions,
): ResourceSplitPlacement["direction"] | null {
	return computeResourceSplitPlacement(source, options)?.direction ?? null;
}

/** Default preview is a non-modal right drawer, not a centered small window. */
export function resourceDrawerBounds(width: number, height: number) {
	if (!validSize({ width, height })) return null;
	return {
		position: { right: 0, top: 0 } as const,
		width: Math.min(RESOURCE_FLOATING_SIZE.width, width),
		height,
	};
}
