import type { ContextComposition } from "@shared/context-composition";
import { request } from "./client";

export function getContextComposition(narratorId: string, signal?: AbortSignal, cursor?: string) {
	return request<ContextComposition>(
		`/narrators/${encodeURIComponent(narratorId)}/context-composition${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
		{
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
				: AbortSignal.timeout(10_000),
			maxResponseBytes: 256 * 1024,
		},
	);
}
