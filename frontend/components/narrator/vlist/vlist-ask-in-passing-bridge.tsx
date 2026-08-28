/**
 * vlist-ask-in-passing-bridge.tsx — "Ask in passing" interactions for the exact vlist.
 *
 * The pretext vlist paints every row as a zero-DOM copy, so the ask-in-passing
 * card had no component of its own that could own state, a mutation or routing:
 *
 *   - PENDING: `RenderAskInPassing`'s pending form is a VISUAL copy — a `readOnly`
 *     TextInput and two buttons with no handlers. The reader could type nothing and
 *     submit nothing, which is exactly the reported bug ("顺便提问功能无法使用").
 *   - RESOLVED: the measured payload carried only the question text, so the card
 *     painted its arrow but had no target narrator to navigate to.
 *
 * Both halves are restored here, mirroring how `vlist-compact-bridge` restores the
 * compact marker's interactions:
 *
 *   - pending  → mounts the REAL `AskInPassingPendingCard` from the chunked path as
 *     a row SLOT (like the permission bridge does for permission forms), so the
 *     input state, the fork+send mutation, the cancel DELETE and the navigation are
 *     literally the same component. Its row becomes a dynamic (post-paint measured)
 *     row, so a slightly different real height cannot clip the form.
 *   - resolved → binds an `onOpen` callback that opens the target narrator,
 *     resolved from the row's own message payload (the layout spec drops it).
 *     "Opens" goes through the same `useOpenAskInPassingNarrator` the cards use,
 *     so a docked surface gets a panel beside the chat and only an off-dock one
 *     navigates away.
 *
 * Lives in vlist/ (so the isolation guard allows importing outer app modules) and
 * is only ever used by PretextExactMessageList.
 */

import { type ReactNode, useMemo } from "react";
import { AskInPassingPendingCard, useOpenAskInPassingNarrator } from "../AskInPassingCard";
import {
	resolveVListAskInPassingTarget,
	type VListAskInPassingTarget,
} from "./vlist-ask-in-passing-target";
import type { VListItem } from "./vlist-pipeline";

/** The minimal message shape this bridge reads (raw loaded document messages). */
export interface AskInPassingSourceMessage {
	id?: unknown;
	contentJson?: unknown;
}

export interface UseVListAskInPassingArgs {
	narratorId: string;
	renderItems: readonly VListItem[];
	/** `spec.key → manifest source message ids` (system cards carry no id in the key). */
	sourceIdsByKey: ReadonlyMap<string, readonly string[]>;
	/** Loaded document messages — the resolved card's target id lives in their blocks. */
	messages: readonly AskInPassingSourceMessage[];
}

export interface VListAskInPassingActions {
	/**
	 * `spec.key → live pending form node`. Present only for PENDING cards; those
	 * rows must also be treated as dynamic-height rows by the shell.
	 */
	pendingSlots: ReadonlyMap<string, ReactNode>;
	/** `spec.key → navigate-to-target callback`, for RESOLVED cards only. */
	openByKey: ReadonlyMap<string, () => void>;
}

const EMPTY_SLOTS: ReadonlyMap<string, ReactNode> = new Map();
const EMPTY_OPENS: ReadonlyMap<string, () => void> = new Map();

/**
 * Build the per-row ask-in-passing wiring for the currently rendered items.
 *
 * Both maps are rebuilt only when the rendered items / source ids / messages
 * change (never on scroll), so each row's slot and callback stay referentially
 * stable inside one document revision and the `ExactRow` memo keeps skipping
 * unchanged rows.
 */
export function useVListAskInPassing({
	narratorId,
	renderItems,
	sourceIdsByKey,
	messages,
}: UseVListAskInPassingArgs): VListAskInPassingActions {
	// Shared with the chunked path's cards, so both open the answer in the same
	// host: a panel beside the conversation when this surface has a dock, a route
	// only when it does not.
	const openAnswer = useOpenAskInPassingNarrator();

	// Targets first (pure): which rows are ask-in-passing cards, in which state,
	// and where a resolved one points. Keeps the React work below trivial.
	const targets = useMemo(() => {
		const map = new Map<string, VListAskInPassingTarget>();
		for (const item of renderItems) {
			if (!item || item.spec.kind !== "ask-in-passing") continue;
			const target = resolveVListAskInPassingTarget(
				item.spec.kind,
				item.spec.data,
				sourceIdsByKey.get(item.spec.key) ?? [],
				messages,
			);
			if (target) map.set(item.spec.key, target);
		}
		return map;
	}, [renderItems, sourceIdsByKey, messages]);

	const pendingSlots = useMemo(() => {
		const map = new Map<string, ReactNode>();
		for (const [key, target] of targets) {
			if (target.kind !== "pending") continue;
			map.set(
				key,
				<AskInPassingPendingCard messageId={target.messageId} narratorId={narratorId} />,
			);
		}
		return map.size > 0 ? map : EMPTY_SLOTS;
	}, [targets, narratorId]);

	const openByKey = useMemo(() => {
		const map = new Map<string, () => void>();
		for (const [key, target] of targets) {
			if (target.kind !== "resolved") continue;
			const targetNarratorId = target.targetNarratorId;
			if (!targetNarratorId) continue;
			map.set(key, () => openAnswer(targetNarratorId));
		}
		return map.size > 0 ? map : EMPTY_OPENS;
	}, [targets, openAnswer]);

	return { pendingSlots, openByKey };
}
