export const MAX_LIVE_COMPACT_TEXT_CHARS = 200_000;
export const MAX_LIVE_COMPACT_DELTA_CHARS = 32_000;

export type LiveCompactChannel = "output" | "thinking";

export interface LiveCompactProgress {
	model: string;
	reasoningEffort?: string;
	startedAt: string;
	/** The first bounded prefix received so far, used for on-demand detail reads. */
	output: string;
	thinking: string;
	outputChars: number;
	thinkingChars: number;
	outputTruncated: boolean;
	thinkingTruncated: boolean;
}

export type LiveCompactStreamEvent =
	| {
			kind: "delta";
			channel: LiveCompactChannel;
			delta: string;
			outputChars: number;
			thinkingChars: number;
	  }
	| { kind: "heartbeat"; outputChars: number; thinkingChars: number }
	| { kind: "finished"; status: "compacted" | "failed" };

type LiveCompactSubscriber = (event: LiveCompactStreamEvent) => void;

export const liveCompactProgress = new Map<string, LiveCompactProgress>();
const liveCompactSubscribers = new Map<string, Set<LiveCompactSubscriber>>();

export function startLiveCompactProgress(
	messageId: string,
	progress: Omit<
		LiveCompactProgress,
		| "output"
		| "thinking"
		| "outputChars"
		| "thinkingChars"
		| "outputTruncated"
		| "thinkingTruncated"
	>,
): void {
	liveCompactProgress.set(messageId, {
		...progress,
		output: "",
		thinking: "",
		outputChars: 0,
		thinkingChars: 0,
		outputTruncated: false,
		thinkingTruncated: false,
	});
}

/**
 * Subscribe after a caller has fetched the current detail snapshot.
 * The prefix that arrived between that fetch and this subscription is replayed first,
 * then future deltas are delivered. Registration and replay happen synchronously so
 * no model delta can fall between the two phases.
 */
export function subscribeLiveCompactProgress(
	messageId: string,
	offset: { output: number; thinking: number },
	onEvent: LiveCompactSubscriber,
): (() => void) | null {
	const current = liveCompactProgress.get(messageId);
	if (!current) return null;
	let subscribers = liveCompactSubscribers.get(messageId);
	if (!subscribers) {
		subscribers = new Set();
		liveCompactSubscribers.set(messageId, subscribers);
	}
	subscribers.add(onEvent);
	const outputFrom = Math.max(0, Math.min(offset.output, current.output.length));
	const thinkingFrom = Math.max(0, Math.min(offset.thinking, current.thinking.length));
	if (outputFrom < current.output.length) {
		emitDelta([onEvent], {
			kind: "delta",
			channel: "output",
			delta: current.output.slice(outputFrom),
			outputChars: current.outputChars,
			thinkingChars: current.thinkingChars,
		});
	}
	if (thinkingFrom < current.thinking.length) {
		emitDelta([onEvent], {
			kind: "delta",
			channel: "thinking",
			delta: current.thinking.slice(thinkingFrom),
			outputChars: current.outputChars,
			thinkingChars: current.thinkingChars,
		});
	}
	return () => {
		subscribers?.delete(onEvent);
		if (subscribers?.size === 0) liveCompactSubscribers.delete(messageId);
	};
}

export function appendLiveCompactDelta(
	messageId: string,
	channel: LiveCompactChannel,
	delta: string,
	counts: { outputChars: number; thinkingChars: number },
): void {
	if (!delta) return;
	const current = liveCompactProgress.get(messageId);
	if (!current) return;
	const field = channel === "output" ? "output" : "thinking";
	const truncatedField = channel === "output" ? "outputTruncated" : "thinkingTruncated";
	const existing = current[field];
	const remaining = Math.max(0, MAX_LIVE_COMPACT_TEXT_CHARS - existing.length);
	const retained = delta.slice(0, remaining);
	current[field] = existing + retained;
	current[truncatedField] = current[truncatedField] || retained.length < delta.length;
	current.outputChars = counts.outputChars;
	current.thinkingChars = counts.thinkingChars;
	if (!retained) return;
	const subscribers = liveCompactSubscribers.get(messageId);
	if (!subscribers) return;
	for (let offset = 0; offset < retained.length; offset += MAX_LIVE_COMPACT_DELTA_CHARS) {
		emitDelta([...subscribers], {
			kind: "delta",
			channel,
			delta: retained.slice(offset, offset + MAX_LIVE_COMPACT_DELTA_CHARS),
			outputChars: current.outputChars,
			thinkingChars: current.thinkingChars,
		});
	}
}

export function finishLiveCompactProgress(messageId: string, status: "compacted" | "failed"): void {
	const subscribers = liveCompactSubscribers.get(messageId);
	if (subscribers) {
		for (const subscriber of subscribers) subscriber({ kind: "finished", status });
	}
	liveCompactSubscribers.delete(messageId);
	liveCompactProgress.delete(messageId);
}

function emitDelta(
	subscribers: Iterable<LiveCompactSubscriber>,
	event: Extract<LiveCompactStreamEvent, { kind: "delta" }>,
): void {
	for (let offset = 0; offset < event.delta.length; offset += MAX_LIVE_COMPACT_DELTA_CHARS) {
		const chunk = {
			...event,
			delta: event.delta.slice(offset, offset + MAX_LIVE_COMPACT_DELTA_CHARS),
		};
		for (const subscriber of subscribers) subscriber(chunk);
	}
}
