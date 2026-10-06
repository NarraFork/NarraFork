/**
 * vlist-ask-in-passing-bridge.tsx — list-scoped ask-in-passing controller.
 *
 * Rows own neither drafts nor requests: the controller survives virtual row
 * unmounts, while RenderAskInPassing remains the fixed-geometry renderer.
 */
import { useAskInPassing, useCancelAskInPassing } from "@frontend/hooks/useNarrator";
import { subscribeAskInPassingEvents } from "@frontend/lib/ask-in-passing-events";
import { notifications } from "@mantine/notifications";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useOpenAskInPassingNarrator } from "../question/AskInPassingCard";
import type { AskInPassingPendingInteraction } from "./render/RenderAskInPassing";
import { type AskInPassingDraft, AskInPassingDraftStore } from "./vlist-ask-in-passing-state";
import {
	resolveVListAskInPassingTarget,
	type VListAskInPassingTarget,
} from "./vlist-ask-in-passing-target";
import type { VListItem } from "./vlist-pipeline";

export interface AskInPassingSourceMessage {
	id?: unknown;
	contentJson?: unknown;
}

export interface UseVListAskInPassingArgs {
	narratorId: string;
	renderItems: readonly VListItem[];
	sourceIdsByKey: ReadonlyMap<string, readonly string[]>;
	messages: readonly AskInPassingSourceMessage[];
}

export interface VListAskInPassingActions {
	pendingByKey: ReadonlyMap<string, AskInPassingPendingInteraction>;
	openByKey: ReadonlyMap<string, () => void>;
	requestFocus: (messageId: string) => void;
	forget: (messageId: string) => void;
}

export function useVListAskInPassing({
	narratorId,
	renderItems,
	sourceIdsByKey,
	messages,
}: UseVListAskInPassingArgs): VListAskInPassingActions {
	const openAnswer = useOpenAskInPassingNarrator();
	const { mutateAsync: resolve } = useAskInPassing();
	const { mutateAsync: cancel } = useCancelAskInPassing();
	// A new narrator is a new ownership scope, even when the shell is reused.
	const scope = useMemo(() => ({ narratorId, store: new AskInPassingDraftStore() }), [narratorId]);
	const currentScope = useRef<typeof scope | null>(scope);
	currentScope.current = scope;
	useEffect(() => {
		currentScope.current = scope;
		return () => {
			currentScope.current = null;
		};
	}, [scope]);
	const revision = useSyncExternalStore(
		scope.store.subscribe,
		scope.store.getSnapshot,
		scope.store.getSnapshot,
	);
	useEffect(() => {
		scope.store.reconcile(messages);
	}, [scope, messages]);
	useEffect(
		() =>
			subscribeAskInPassingEvents((event) => {
				if (event.narratorId !== narratorId) return;
				if (event.kind === "start") scope.store.requestFocus(event.message.id);
				else scope.store.forget(event.kind === "deleted" ? event.messageId : event.message.id);
			}),
		[scope, narratorId],
	);

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

	const submit = useCallback(
		async (messageId: string) => {
			const draft = scope.store.begin(messageId, "submitting");
			if (!draft) return;
			try {
				const answer = await resolve({
					narratorId,
					pendingMessageId: messageId,
					question: draft.value.trim(),
				});
				scope.store.forget(messageId);
				// WS may already have unmounted the pending row; the LIST still owns this continuation.
				if (currentScope.current === scope) openAnswer(answer.id);
			} catch (error) {
				scope.store.fail(messageId);
				if (currentScope.current === scope)
					notifications.show({
						message: error instanceof Error ? error.message : String(error),
						color: "red",
						autoClose: 5000,
					});
			}
		},
		[scope, narratorId, resolve, openAnswer],
	);
	const dismiss = useCallback(
		async (messageId: string) => {
			if (!scope.store.begin(messageId, "cancelling")) return;
			try {
				await cancel({ narratorId, messageId });
				scope.store.forget(messageId);
			} catch (error) {
				scope.store.fail(messageId);
				if (currentScope.current === scope)
					notifications.show({
						message: error instanceof Error ? error.message : String(error),
						color: "red",
						autoClose: 5000,
					});
			}
		},
		[scope, narratorId, cancel],
	);

	const pendingCache = useRef(
		new Map<
			string,
			{
				draft: AskInPassingDraft;
				terminal: boolean;
				submit: typeof submit;
				dismiss: typeof dismiss;
				props: AskInPassingPendingInteraction;
			}
		>(),
	);
	const pendingByKey = useMemo(() => {
		void revision;
		const cache = new Map<
			string,
			{
				draft: AskInPassingDraft;
				terminal: boolean;
				submit: typeof submit;
				dismiss: typeof dismiss;
				props: AskInPassingPendingInteraction;
			}
		>();
		const map = new Map<string, AskInPassingPendingInteraction>();
		for (const [key, target] of targets) {
			if (target.kind !== "pending") continue;
			const id = target.messageId;
			const draft = scope.store.get(id);
			const terminal = scope.store.isTerminal(id);
			const previous = pendingCache.current.get(key);
			if (
				previous?.draft === draft &&
				previous.terminal === terminal &&
				previous.submit === submit &&
				previous.dismiss === dismiss
			) {
				map.set(key, previous.props);
				cache.set(key, previous);
				continue;
			}
			const props: AskInPassingPendingInteraction = {
				value: draft.value,
				// Canonical resolution/deletion may beat the list rebuild. Keep the stale
				// pending shell inert instead of presenting an input that cannot be saved.
				busy: terminal || draft.phase !== "editing",
				operation: draft.phase === "editing" ? undefined : draft.phase,
				onChange: (value) => scope.store.setValue(id, value),
				onConfirm: () => {
					void submit(id);
				},
				onCancel: () => {
					void dismiss(id);
				},
				focusRequest: draft.focusRequested ? 1 : null,
				onFocusConsumed: () => scope.store.consumeFocus(id),
			};
			map.set(key, props);
			cache.set(key, { draft, terminal, submit, dismiss, props });
		}
		pendingCache.current = cache;
		return map;
	}, [scope, targets, revision, submit, dismiss]);
	const openByKey = useMemo(() => {
		const map = new Map<string, () => void>();
		for (const [key, target] of targets) {
			if (target.kind !== "resolved" || !target.targetNarratorId) continue;
			const id = target.targetNarratorId;
			map.set(key, () => openAnswer(id));
		}
		return map;
	}, [targets, openAnswer]);
	const requestFocus = useCallback((id: string) => scope.store.requestFocus(id), [scope]);
	const forget = useCallback((id: string) => scope.store.forget(id), [scope]);
	return { pendingByKey, openByKey, requestFocus, forget };
}
