import {
	COMMUNICATION_LIMITS,
	type CommunicationCandidates,
	type CommunicationMutation,
	type CommunicationMutationResult,
} from "@shared/narrator-communication";
import { request } from "./client";

export const narratorCommunicationApi = {
	searchCommunicationCandidates: (
		narratorId: string,
		query: string,
		options: { signal?: AbortSignal; limit?: number; targetId?: string } = {},
	) => {
		const params = new URLSearchParams({ q: query });
		if (options.limit !== undefined) params.set("limit", String(options.limit));
		if (options.targetId !== undefined) params.set("targetId", options.targetId);
		return request<CommunicationCandidates>(
			`/narrators/${encodeURIComponent(narratorId)}/communication/candidates?${params}`,
			{ signal: options.signal, maxResponseBytes: COMMUNICATION_LIMITS.maxSnapshotBytes },
		);
	},
	mutateCommunication: (
		narratorId: string,
		mutation: CommunicationMutation,
		options: { signal?: AbortSignal } = {},
	) =>
		request<CommunicationMutationResult>(
			`/narrators/${encodeURIComponent(narratorId)}/communication`,
			{
				method: "POST",
				body: JSON.stringify(mutation),
				signal: options.signal,
				maxResponseBytes: 16 * 1024,
			},
		),
};
