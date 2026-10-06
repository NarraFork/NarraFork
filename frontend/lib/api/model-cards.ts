import type { ModelCard } from "@shared/model-card";
import { request } from "./client";

export type { ModelCard };

export interface ModelCardsResponse {
	cards: ModelCard[];
	/**
	 * Per card, the field names the user set (as opposed to inherited from the
	 * builtin seed data). Keyed by `modelKey`; a card absent from the map is
	 * entirely inherited.
	 */
	provenance: Record<string, string[]>;
}

export const modelCardsApi = {
	listModelCards: () => request<ModelCardsResponse>("/model-cards"),

	upsertModelCard: (card: ModelCard) =>
		request<{ card: ModelCard }>(`/model-cards/${encodeURIComponent(card.modelKey)}`, {
			method: "PUT",
			body: JSON.stringify(card),
		}),

	deleteModelCard: (modelKey: string) =>
		request<{ ok: boolean; deleted: boolean }>(`/model-cards/${encodeURIComponent(modelKey)}`, {
			method: "DELETE",
		}),

	/**
	 * Drop the user's delta so the card follows builtin values again.
	 *
	 * Not the same as saving the builtin values back: that would record a delta
	 * whose values merely happen to match today, pinning those fields against
	 * future builtin updates.
	 */
	resetModelCard: (modelKey: string) =>
		request<{ card: ModelCard | null }>(`/model-cards/${encodeURIComponent(modelKey)}/reset`, {
			method: "POST",
		}),
};
