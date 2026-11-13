import type { ReactNode } from "react";

const EMPTY_SLOTS: ReadonlyMap<string, ReactNode> = new Map();

/** Build-only replacement for Outline Ask forms, not permission/AsyncQuestion slots. */
export function useOutlineAskSlots(_options: {
	renderItems: readonly unknown[];
	tools: ReadonlyMap<string, unknown>;
	enabled?: boolean;
}): ReadonlyMap<string, ReactNode> {
	return EMPTY_SLOTS;
}
