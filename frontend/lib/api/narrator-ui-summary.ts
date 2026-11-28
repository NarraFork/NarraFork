import { getAuthSnapshot, request, subscribeAuth } from "./client";

export interface NarratorUiSummary {
	narratorId: string;
	canWrite: boolean;
	activeTerminalCount: number;
	discussion: { roomId: string | null; unread: number; unreadCapped: boolean };
}

export const NARRATOR_UI_SUMMARY_MAX_BYTES = 2 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

export async function getNarratorUiSummary(
	narratorId: string,
	options: { signal?: AbortSignal } = {},
): Promise<NarratorUiSummary> {
	const { generation } = getAuthSnapshot();
	const sessionChanged = () => new DOMException("Session changed", "AbortError");
	const controller = new AbortController();
	const abort = () => controller.abort(options.signal?.reason);
	if (options.signal?.aborted) abort();
	else options.signal?.addEventListener("abort", abort, { once: true });
	const stop = subscribeAuth(() => {
		if (getAuthSnapshot().generation !== generation) controller.abort(sessionChanged());
	});
	const timeout = setTimeout(
		() => controller.abort(new Error("UI summary request timed out")),
		REQUEST_TIMEOUT_MS,
	);
	try {
		controller.signal.throwIfAborted();
		const result = await request<NarratorUiSummary>(
			`/narrators/${encodeURIComponent(narratorId)}/ui-summary`,
			{ signal: controller.signal, maxResponseBytes: NARRATOR_UI_SUMMARY_MAX_BYTES },
		);
		controller.signal.throwIfAborted();
		if (getAuthSnapshot().generation !== generation) throw sessionChanged();
		if (
			result?.narratorId !== narratorId ||
			typeof result.canWrite !== "boolean" ||
			!Number.isSafeInteger(result.activeTerminalCount) ||
			result.activeTerminalCount < 0 ||
			!result.discussion ||
			!(result.discussion.roomId === null || typeof result.discussion.roomId === "string") ||
			!Number.isSafeInteger(result.discussion.unread) ||
			result.discussion.unread < 0 ||
			typeof result.discussion.unreadCapped !== "boolean"
		)
			throw new Error("Invalid narrator UI summary");
		return result;
	} finally {
		clearTimeout(timeout);
		stop();
		options.signal?.removeEventListener("abort", abort);
	}
}
