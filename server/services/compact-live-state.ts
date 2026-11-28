export const MAX_LIVE_COMPACT_TEXT_CHARS = 200_000;
export const MAX_LIVE_COMPACT_DELTA_CHARS = 32_000;

export type LiveCompactChannel = "output" | "thinking";

export interface LiveCompactProgress {
	narratorId?: string;
	attempt?: number;
	pendingModel?: string | null;
	canChangeModel?: boolean;
	onModelQueued?: () => void;
	abortStalledRequest?: (reason: string) => boolean;
	model: string;
	reasoningEffort?: string;
	startedAt: string;
	streamVersion: number;
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
	| ({
			kind: "reset";
			streamVersion: number;
	  } & LiveCompactStreamPosition)
	| { kind: "heartbeat"; outputChars: number; thinkingChars: number }
	| { kind: "finished"; status: "compacted" | "failed" };

export interface LiveCompactStreamPosition {
	outputLength: number;
	thinkingLength: number;
	outputChars: number;
	thinkingChars: number;
}

export const EMPTY_LIVE_COMPACT_POSITION: LiveCompactStreamPosition = {
	outputLength: 0,
	thinkingLength: 0,
	outputChars: 0,
	thinkingChars: 0,
};

type LiveCompactSubscriber = (event: LiveCompactStreamEvent) => void;

export const liveCompactProgress = new Map<string, LiveCompactProgress>();
const liveCompactSubscribers = new Map<string, Set<LiveCompactSubscriber>>();
let streamVersion = 0;

export function startLiveCompactProgress(
	messageId: string,
	progress: Omit<
		LiveCompactProgress,
		| "streamVersion"
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
		streamVersion: ++streamVersion,
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
	offset: { output: number; thinking: number; streamVersion?: number },
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
	const replayFromStart =
		offset.streamVersion !== undefined && offset.streamVersion !== current.streamVersion;
	if (replayFromStart) {
		onEvent({
			kind: "reset",
			streamVersion: current.streamVersion,
			...EMPTY_LIVE_COMPACT_POSITION,
		});
	}
	const outputFrom = replayFromStart
		? 0
		: Math.max(0, Math.min(offset.output, current.output.length));
	const thinkingFrom = replayFromStart
		? 0
		: Math.max(0, Math.min(offset.thinking, current.thinking.length));
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
		if (subscribers.size === 0 && liveCompactSubscribers.get(messageId) === subscribers) {
			liveCompactSubscribers.delete(messageId);
		}
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

export function resetLiveCompactProgress(
	messageId: string,
	position: LiveCompactStreamPosition,
): void {
	const current = liveCompactProgress.get(messageId);
	if (!current) return;
	current.output = current.output.slice(0, position.outputLength);
	current.thinking = current.thinking.slice(0, position.thinkingLength);
	current.outputChars = position.outputChars;
	current.thinkingChars = position.thinkingChars;
	current.outputTruncated = position.outputChars > position.outputLength;
	current.thinkingTruncated = position.thinkingChars > position.thinkingLength;
	current.streamVersion = ++streamVersion;
	for (const subscriber of liveCompactSubscribers.get(messageId) ?? []) {
		subscriber({ kind: "reset", streamVersion: current.streamVersion, ...position });
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
