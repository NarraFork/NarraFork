import { buildModelCardIndex } from "@shared/model-card";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../lib/api";

/**
 * Model cards, cached generously.
 *
 * Cards are instance-wide configuration that changes only when an admin edits
 * them, but they are read on every render of the reasoning-tier menu, so a short
 * staleTime would refetch constantly for data that almost never moves.
 */
const MODEL_CARDS_STALE_TIME_MS = 5 * 60_000;

export function useModelCards() {
	return useQuery({
		queryKey: ["model-cards"],
		queryFn: api.listModelCards,
		staleTime: MODEL_CARDS_STALE_TIME_MS,
	});
}

/**
 * The card lookup index, memoized on the fetched card list.
 *
 * Built once per fetch rather than per lookup: resolving a model walks the index,
 * and rebuilding it inside a render pass would redo the work on every keystroke
 * elsewhere in the panel.
 */
export function useModelCardIndex() {
	const { data } = useModelCards();
	const cards = data?.cards;
	return useMemo(() => (cards ? buildModelCardIndex(cards) : null), [cards]);
}

export function useUpsertModelCard() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.upsertModelCard,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["model-cards"] });
			// Cards feed context windows and prices surfaced by the model lists, so
			// the settings query has to be refetched too or those keep the old values.
			qc.invalidateQueries({ queryKey: ["settings"] });
		},
	});
}

export function useDeleteModelCard() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.deleteModelCard,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["model-cards"] });
			qc.invalidateQueries({ queryKey: ["settings"] });
		},
	});
}

export function useResetModelCard() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.resetModelCard,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["model-cards"] });
			qc.invalidateQueries({ queryKey: ["settings"] });
		},
	});
}
