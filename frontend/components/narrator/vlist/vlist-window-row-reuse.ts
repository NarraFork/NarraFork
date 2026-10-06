import type { ReactElement } from "react";
import type { ExactRowProps } from "./ExactRow";

/** Complete draw inputs, not a second handwritten cache-key/dependency list. */
export interface WindowRowProjection {
	props: ExactRowProps;
	/** Synthetic/live rows never reuse an element even when their geometry is stable. */
	skipReuse?: boolean;
}

interface WindowRowEntry {
	readonly props: ExactRowProps;
	readonly element: ReactElement<ExactRowProps>;
}

export interface WindowRowElementFrame {
	readonly owner: string;
	readonly entries: ReadonlyMap<string, WindowRowEntry>;
	readonly elements: readonly ReactElement<ExactRowProps>[];
	readonly created: number;
	readonly reused: number;
}

function sameSourceIds(a: readonly string[], b: readonly string[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index++) {
		if (a[index] !== b[index]) return false;
	}
	return true;
}

/**
 * Stricter than ExactRow.memo: an item wrapper change is always a miss, and ALL
 * supplied props (including new future fields) are checked. This optimizes pure
 * scrolling, not document updates. Never sample/hash bodies or ignore callbacks.
 */
export function sameWindowRowProps(a: ExactRowProps, b: ExactRowProps): boolean {
	const keys = Object.keys(b) as (keyof ExactRowProps)[];
	if (Object.keys(a).length !== keys.length) return false;
	for (const key of keys) {
		if (!Object.hasOwn(a, key)) return false;
		if (key === "sourceIds") {
			if (!sameSourceIds(a.sourceIds, b.sourceIds)) return false;
		} else if (!Object.is(a[key], b[key])) return false;
	}
	return true;
}

function canReuseRow({ props, skipReuse }: WindowRowProjection): boolean {
	return !(
		skipReuse ||
		props.item.spec.opts?.streamingContent === true ||
		props.animateStreaming ||
		props.permissionSlot != null ||
		props.editorSlot != null ||
		props.onUnknownHeight != null ||
		(props.traceRowPermissionSlots?.size ?? 0) > 0 ||
		(props.closingRowKeys?.size ?? 0) > 0 ||
		props.askInPassingPending != null
	);
}

/**
 * Pure frame construction: the previous COMMITTED frame is read-only. Discarding
 * this result cannot evict/mutate it. Publishing the new frame replaces (never
 * merges) its map, so retained nodes/handlers stay bounded to the mounted window
 * plus any editor/swipe pins the shell already included.
 */
export function buildWindowRowElementFrame(
	previous: WindowRowElementFrame | null,
	owner: string,
	rows: readonly WindowRowProjection[],
	createElement: (key: string, props: ExactRowProps) => ReactElement<ExactRowProps>,
): WindowRowElementFrame {
	const prior = previous?.owner === owner ? previous.entries : undefined;
	const entries = new Map<string, WindowRowEntry>();
	const elements: ReactElement<ExactRowProps>[] = [];
	let created = 0;
	let reused = 0;
	for (const row of rows) {
		const key = row.props.item.spec.key;
		const cacheable = canReuseRow(row);
		const cached = cacheable ? prior?.get(key) : undefined;
		if (cached && sameWindowRowProps(cached.props, row.props)) {
			entries.set(key, cached);
			elements.push(cached.element);
			reused++;
			continue;
		}
		// Capture the projection, not a caller-mutable props object/source-id array.
		const props = { ...row.props, sourceIds: [...row.props.sourceIds] };
		const element = createElement(key, props);
		if (cacheable) entries.set(key, { props, element });
		elements.push(element);
		created++;
	}
	return { owner, entries, elements, created, reused };
}
