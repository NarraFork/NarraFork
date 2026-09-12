/**
 * useVListStreamingMessage.ts — Accumulates live stream deltas into ONE synthetic
 * message that the exact list renders as the document's last row.
 *
 * Why this is not an overlay any more
 * -----------------------------------
 * Live output used to be drawn as a separate block below the canvas, with its own
 * layout arithmetic and a timed retirement handshake. That bought nothing: the
 * expensive part of streaming was never the document rebuild, it was re-measuring
 * the growing text (now incremental — see streaming-block-cache.ts). Meanwhile the
 * overlay cost a duplicate render path, a second scroll-height source, and a bug
 * where output vanished for readers who had scrolled up.
 *
 * As a real trailing message the live row shares one coordinate system with
 * everything else, so it virtualizes, measures, anchors and hands off like any
 * other row.
 *
 * Retirement is structural, not timed: the row is dropped when the committed
 * document already contains its content (see streaming-handoff.ts). This hook only
 * clears on genuine invalidations — narrator switch, stream reset, session end,
 * error.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNarratorWS } from "../../../hooks/useNarratorWS";
import {
	buildStreamingMsg,
	type StreamingBlock,
	upsertStreamingImageGenerationBlock,
	upsertStreamingWebSearchBlock,
} from "../message-segments";
import { buildTopLevelStreamingChunksMsg } from "../narrator-message-helpers";
import type { NarratorMsg } from "../narrator-panel-types";
import { dropSupersededStreamingBlocks } from "../streaming/streaming-block-supersede";
import {
	applyExactStreamDelta,
	applyExactStreamingSnapshot,
	type StreamDeltaEvent,
} from "./exact-streaming-accumulator";
import { resetStreamingBlockCache } from "./streaming-block-cache";
import { commitGrowthSignature, type HandoffMessage } from "./streaming-handoff";
import {
	applyStreamingSendDelivery,
	applyStreamingToolChunk,
	applyStreamingToolCompleted,
	applyStreamingToolExecuting,
	applyStreamingToolLongRunning,
	applyStreamingToolOutput,
	applyStreamingToolProgress,
	applyStreamingToolStarted,
	collectPersistedToolUseIds,
	createStreamingToolStore,
	dropDiscardedStreamingTools,
	dropPersistedStreamingTools,
	streamingToolChunks,
} from "./streaming-tool-chunks";

const EMPTY_MESSAGES: readonly HandoffMessage[] = [];

export interface UseVListStreamingMessageOptions {
	/** Only subscribe + accumulate while the narrator is active (working/waiting). */
	enabled: boolean;
	/** A subagent page treats its own (parent-pointing) deltas as top-level. */
	isSubagent?: boolean;
	/**
	 * True once the committed document already contains this row's content.
	 *
	 * Resolved by the shell from the loaded document (streaming-handoff.ts). It is a
	 * STRUCTURAL fact, so unlike the old timeout it can never drop live output while
	 * the replacement is missing.
	 */
	superseded?: boolean;
	/**
	 * Committed messages, used for the PER-TOOL hand-off.
	 *
	 * A turn persists its tools one message at a time, so individual synthetic cards
	 * retire independently of the row as a whole: each is dropped exactly when a
	 * persisted message carrying its tool-use id appears.
	 */
	committedMessages?: readonly HandoffMessage[];
	/**
	 * Report how much text has arrived since the document last grew, so the shell can
	 * feed it to the hand-off decision (see streaming-handoff.ts).
	 */
	onCharsSinceCommitChange?: (chars: number) => void;
}

/**
 * Output throttling, matching the chunked path so both lists refresh at the same
 * rate. Small outputs flush immediately (a short command should feel instant);
 * large ones are rate-limited because each flush re-renders the row.
 */
const OUTPUT_THROTTLE_MIN_CHARS = 12_000;
const OUTPUT_THROTTLE_MS = 250;

/**
 * Accumulate live text/reasoning deltas into a synthetic streaming message.
 * Returns null when there is nothing live to show (or while disabled).
 */
export function useVListStreamingMessage(
	narratorId: string | undefined,
	options: UseVListStreamingMessageOptions,
): NarratorMsg | null {
	const {
		enabled,
		isSubagent = false,
		superseded = false,
		committedMessages = EMPTY_MESSAGES,
		onCharsSinceCommitChange,
	} = options;
	const reportCharsRef = useRef(onCharsSinceCommitChange);
	reportCharsRef.current = onCharsSinceCommitChange;
	const blocksRef = useRef<StreamingBlock[]>([]);
	const toolStoreRef = useRef(createStreamingToolStore());
	/** Pending output throttle state per tool (latest preview + its timer). */
	const outputThrottleRef = useRef<
		Map<
			string,
			{ latest: string; lastFlushAt: number; timer: ReturnType<typeof setTimeout> | null }
		>
	>(new Map());
	const rafRef = useRef(0);
	/**
	 * Which text/reasoning lane last received a delta, or -1 when the model has moved
	 * on to tool calls. Stamped onto the published row so renderers can tell a
	 * FINISHED reasoning run from the one still being written — array position cannot,
	 * because the tool cards are appended after the text lanes whatever order the
	 * provider used (see @shared/pretext-layout/streaming-live-blocks).
	 */
	const liveBlockIndexRef = useRef(-1);
	/**
	 * The block currently being written, held BY REFERENCE.
	 *
	 * Separate from `liveBlockIndexRef` on purpose, and not derivable from it. That ref
	 * is an array INDEX, valid only for the array as it stood after the fold that set it
	 * (see StreamDeltaResult.blockIndex): `upsertStreaming*Block` splices native
	 * web_search / image_generation blocks in by `outputIndex` and does NOT update it, so
	 * in a stream that mixes native blocks with text the index can name a neighbour.
	 *
	 * That staleness is harmless for its existing consumer — `buildStreamingMsg` uses it
	 * to mark which lane is "still writing", so at worst a highlight lands one row off.
	 * It is NOT harmless for `dropSupersededStreamingBlocks`, which uses this ref as a
	 * deletion guard: protecting the wrong block would leave the lane that is actually
	 * growing unprotected, and its short first delta can spuriously match an earlier
	 * step's persisted text. So the block is captured at the moment the index is fresh
	 * and compared by identity afterwards. References stay valid across splices because
	 * text/reasoning blocks are mutated in place.
	 */
	const liveBlockRef = useRef<StreamingBlock | null>(null);
	const [version, setVersion] = useState(0);
	/**
	 * Total characters this row has accumulated, and the value at the moment the
	 * document last grew. Their difference is the hand-off's "has the model produced
	 * anything NEW since the last message was stored" signal.
	 */
	const accumulatedCharsRef = useRef(0);
	const charsAtLastCommitRef = useRef(0);

	const flush = useCallback(() => {
		if (rafRef.current) return;
		rafRef.current = requestAnimationFrame(() => {
			rafRef.current = 0;
			setVersion((value) => value + 1);
		});
	}, []);

	const clearOutputTimers = useCallback(() => {
		for (const state of outputThrottleRef.current.values()) {
			if (state.timer) clearTimeout(state.timer);
		}
		outputThrottleRef.current.clear();
	}, []);

	const clearBlocks = useCallback(() => {
		if (rafRef.current) {
			cancelAnimationFrame(rafRef.current);
			rafRef.current = 0;
		}
		clearOutputTimers();
		accumulatedCharsRef.current = 0;
		charsAtLastCommitRef.current = 0;
		liveBlockIndexRef.current = -1;
		liveBlockRef.current = null;
		const hadContent = blocksRef.current.length > 0 || toolStoreRef.current.size > 0;
		if (hadContent) {
			blocksRef.current = [];
			toolStoreRef.current = createStreamingToolStore();
			setVersion((value) => value + 1);
		}
	}, [clearOutputTimers]);

	/** Total characters currently held across the accumulated text/reasoning blocks. */
	const currentCharCount = useCallback(() => {
		let total = 0;
		for (const block of blocksRef.current) {
			if (block.type === "text" || block.type === "reasoning") total += block.text.length;
		}
		return total;
	}, []);

	// Reset accumulation whenever the target narrator changes or streaming is
	// disabled (the narrator left the active state, or unmount).
	useEffect(() => {
		if (!enabled) clearBlocks();
		return () => clearBlocks();
	}, [enabled, clearBlocks]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: narratorId reset is intentional
	useEffect(() => {
		clearBlocks();
	}, [narratorId, clearBlocks]);

	// Drop the row once the document owns its content. Deliberately a PASSIVE
	// effect: the committed message and the streaming row are both already in the
	// same document, and they measure to the same height, so a frame showing the row
	// one commit longer is visually identical — there is nothing to race, and no
	// blank window is possible either way.
	useEffect(() => {
		if (superseded) clearBlocks();
	}, [superseded, clearBlocks]);

	// Reset the "text since the last commit" counter whenever the document GROWS, so
	// the hand-off can tell a stored reply from a NEW paragraph the model started after
	// an earlier step of the same turn was stored (see streaming-handoff.ts).
	//
	// Keyed on the growth SIGNATURE, never on the messages array identity: a live
	// lifecycle patch (tool finished, permission decided, reflection advanced) rebuilds
	// that array several times per turn without adding a message, and resetting on
	// those would let an already-stored earlier step retire the live step that follows
	// it — output that was never persisted, silently gone. See commitGrowthSignature.
	const commitSignature = commitGrowthSignature(committedMessages);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on document growth only
	useEffect(() => {
		charsAtLastCommitRef.current = accumulatedCharsRef.current;
		reportCharsRef.current?.(0);
	}, [commitSignature]);

	// Publish the delta on each render version bump (rAF-coalesced, so at most once
	// per frame).
	useEffect(() => {
		void version;
		reportCharsRef.current?.(
			Math.max(0, accumulatedCharsRef.current - charsAtLastCommitRef.current),
		);
	}, [version]);

	// Release the incremental markdown prefixes tied to this narrator's streaming
	// rows, so a long session does not retain prepared blocks per turn.
	// biome-ignore lint/correctness/useExhaustiveDependencies: narrator-scoped cache reset
	useEffect(() => {
		return () => resetStreamingBlockCache();
	}, [narratorId]);

	// Per-tool hand-off: retire each synthetic card exactly when a persisted message
	// carrying its tool-use id lands. Independent of the row-level hand-off because a
	// turn persists its tools progressively — an early tool's real card can exist
	// while later ones are still streaming.
	const persistedToolUseIds = useMemo(
		() => collectPersistedToolUseIds(committedMessages),
		[committedMessages],
	);
	useEffect(() => {
		if (dropPersistedStreamingTools(toolStoreRef.current, persistedToolUseIds)) {
			setVersion((value) => value + 1);
		}
	}, [persistedToolUseIds]);

	// Per-BLOCK hand-off, the text/reasoning counterpart of the per-tool one above.
	//
	// The server archives each finished block into the partial assistant message as it
	// streams, but that row is invisible to clients until something delivers it — and
	// when a reconnect catch-up finally does, the live row is still holding the same
	// blocks, so the paragraph renders twice (see streaming-block-supersede.ts).
	//
	// Keyed on `committedMessages` for the same reason as the tool half: the trigger is
	// "the document now contains it", a structural fact, not the arrival of some frame.
	// `liveBlockRef` is read through the ref rather than declared as a dependency — it
	// changes on every delta, and its only role is naming which block must not be
	// touched during THIS evaluation.
	useEffect(() => {
		if (dropSupersededStreamingBlocks(blocksRef.current, committedMessages, liveBlockRef.current)) {
			flush();
		}
	}, [committedMessages, flush]);

	/**
	 * Record streaming stdout, rate-limited per tool.
	 *
	 * Small outputs flush immediately so a short command feels instant; past the
	 * threshold a trailing timer coalesces bursts, and the LAST value always lands
	 * (the timer re-reads the latest preview rather than closing over one frame's).
	 */
	const pushToolOutput = useCallback(
		(toolUseId: string, output: string) => {
			const throttles = outputThrottleRef.current;
			let state = throttles.get(toolUseId);
			if (!state) {
				state = { latest: output, lastFlushAt: 0, timer: null };
				throttles.set(toolUseId, state);
			}
			state.latest = output;
			const apply = () => {
				const current = throttles.get(toolUseId);
				if (!current) return;
				current.timer = null;
				current.lastFlushAt = Date.now();
				if (applyStreamingToolOutput(toolStoreRef.current, toolUseId, current.latest)) flush();
			};
			if (output.length < OUTPUT_THROTTLE_MIN_CHARS) {
				if (state.timer) {
					clearTimeout(state.timer);
					state.timer = null;
				}
				apply();
				return;
			}
			const elapsed = Date.now() - state.lastFlushAt;
			if (elapsed >= OUTPUT_THROTTLE_MS) {
				if (state.timer) {
					clearTimeout(state.timer);
					state.timer = null;
				}
				apply();
				return;
			}
			if (!state.timer) state.timer = setTimeout(apply, OUTPUT_THROTTLE_MS - elapsed);
		},
		[flush],
	);

	const subscriptionId = enabled ? narratorId : undefined;
	useNarratorWS(
		subscriptionId,
		{
			onStreamEvent: (wsData: { event?: Record<string, unknown>; [key: string]: unknown }) => {
				const result = applyExactStreamDelta(
					blocksRef.current,
					wsData.event as StreamDeltaEvent,
					isSubagent,
				);
				if (result.applied) {
					// The lane this delta landed in is now the live one. A reasoning delta
					// arriving after a tool call legitimately REOPENS the text lane, which is
					// why this is set on every delta rather than only advanced forward.
					liveBlockIndexRef.current = result.blockIndex;
					// Capture the block ITSELF while the index is still fresh. See
					// liveBlockRef's declaration for why the index cannot be resolved later.
					liveBlockRef.current = blocksRef.current[result.blockIndex] ?? null;
					accumulatedCharsRef.current = currentCharCount();
					flush();
				}
			},
			onStreamingSnapshot: (snapshot) => {
				if (
					applyExactStreamingSnapshot(
						blocksRef.current,
						snapshot.streamingBlocks as StreamingBlock[],
					)
				)
					flush();
			},
			onStreamingReset: (parentToolUseId) => {
				// The owning page receives the reset without a parentToolUseId; the
				// parent-page duplicate keeps it set and must be ignored here.
				if (parentToolUseId) return;
				clearBlocks();
			},
			// A replayed attempt abandoned these tool ids mid-arguments. They never
			// persisted, so the structural hand-off has no replacement to wait for and
			// would keep the cards spinning forever.
			onToolUseDiscarded: (toolUseIds, rawParentToolUseId) => {
				if (!isSubagent && rawParentToolUseId) return;
				if (dropDiscardedStreamingTools(toolStoreRef.current, toolUseIds)) flush();
			},

			// ── Native provider blocks ──────────────────────────────────────────
			// A subagent's native searches / image generations are delivered to the
			// parent for bookkeeping, but belong only to the subagent's own page.
			onWebSearch: (id, status, query, queries, outputIndex, rawParentToolUseId) => {
				if (!isSubagent && rawParentToolUseId) return;
				upsertStreamingWebSearchBlock(blocksRef.current, {
					id,
					status,
					query,
					queries,
					outputIndex,
				});
				flush();
			},
			onImageGeneration: (
				id,
				status,
				revisedPrompt,
				outputIndex,
				partialImageIndex,
				partialSavedPath,
				savedPath,
				width,
				height,
				rawParentToolUseId,
			) => {
				if (!isSubagent && rawParentToolUseId) return;
				upsertStreamingImageGenerationBlock(blocksRef.current, {
					id,
					status,
					revisedPrompt,
					outputIndex,
					partialImageIndex,
					partialSavedPath,
					savedPath,
					width,
					height,
				});
				flush();
			},

			// ── Live tool calls ─────────────────────────────────────────────────
			// These are the events the exact list used to drop entirely: the document
			// patch channel excluded them (they fire per delta) and the old overlay
			// never implemented them, so a tool card only appeared after a coalesced
			// structural reload and a running command showed no output at all.
			//
			// On a parent page an event carrying a parentToolUseId describes a CHILD
			// tool; the parent card's activity summary is maintained by the document
			// patch channel, so it must not become a top-level card here.
			onSendDeliveryResolved: (
				toolUseId,
				targets,
				rawParentToolUseId,
				toolCallBinding,
				targetCount,
			) => {
				if (!isSubagent && rawParentToolUseId) return;
				// A late consumption frame belongs to the persisted patch channel once
				// hand-off retired this tool; do not resurrect a duplicate synthetic Send.
				if (persistedToolUseIds.has(toolUseId) && !toolStoreRef.current.has(toolUseId)) return;
				if (
					applyStreamingSendDelivery(toolStoreRef.current, {
						toolUseId,
						targets,
						toolCallBinding,
						targetCount,
					})
				)
					flush();
			},
			onToolUseChunk: (
				toolUseId,
				toolName,
				inputCharsTotal,
				rawParentToolUseId,
				extractedFilePath,
				contentCharsReceived,
				extractedFields,
				metadata,
				streamingField,
			) => {
				if (!isSubagent && rawParentToolUseId) return;
				// The model is writing tool arguments, so no text lane is open: whatever
				// reasoning or text preceded this is finished and must settle now instead of
				// waiting for the turn to persist.
				liveBlockIndexRef.current = -1;
				liveBlockRef.current = null;
				if (
					applyStreamingToolChunk(toolStoreRef.current, {
						toolUseId,
						toolName,
						inputCharsTotal,
						...(extractedFilePath !== undefined ? { extractedFilePath } : {}),
						...(contentCharsReceived !== undefined ? { contentCharsReceived } : {}),
						...(extractedFields !== undefined ? { extractedFields } : {}),
						...(metadata !== undefined ? { metadata } : {}),
						...(streamingField ? { streamingField } : {}),
					})
				)
					flush();
			},
			onToolStarted: (toolUseId, toolName, streamStartedAt, input, rawParentToolUseId, meta) => {
				if (!isSubagent && rawParentToolUseId) return;
				if (
					applyStreamingToolStarted(toolStoreRef.current, {
						toolUseId,
						toolName,
						...(streamStartedAt != null ? { streamStartedAt } : {}),
						...(input ? { input } : {}),
						...(meta ? { metadata: meta as Record<string, unknown> } : {}),
					})
				)
					flush();
			},
			// Execution actually began (permission granted). Separate from onToolStarted,
			// which only means the input finished parsing — see streaming-tool-chunks.ts.
			onToolExecuting: (toolUseId, executionStartedAt, rawParentToolUseId) => {
				if (!isSubagent && rawParentToolUseId) return;
				if (applyStreamingToolExecuting(toolStoreRef.current, { toolUseId, executionStartedAt }))
					flush();
			},
			onToolCompleted: (
				toolUseId,
				status,
				output,
				durationMs,
				updatedInput,
				metadata,
				rawParentToolUseId,
			) => {
				if (!isSubagent && rawParentToolUseId) return;
				if (
					applyStreamingToolCompleted(toolStoreRef.current, {
						toolUseId,
						status,
						...(output !== undefined ? { output } : {}),
						...(durationMs != null ? { durationMs } : {}),
						...(updatedInput ? { updatedInput } : {}),
						...(metadata ? { metadata } : {}),
					})
				)
					flush();
			},
			// Live stdout of a running command. Throttled per tool: a build emitting
			// megabytes would otherwise re-render the row on every socket frame.
			onToolOutput: (toolUseId, output, rawParentToolUseId) => {
				if (!isSubagent && rawParentToolUseId) return;
				pushToolOutput(toolUseId, output);
			},
			// Determinate progress. NOT routed through the text throttle: the producer
			// already coalesces to ~4 frames/s, and the payload is a few numbers rather
			// than a growing string, so a second throttle would only delay the bar.
			onToolStructuredProgress: (toolUseId, progress, rawParentToolUseId) => {
				if (!isSubagent && rawParentToolUseId) return;
				if (applyStreamingToolProgress(toolStoreRef.current, toolUseId, progress)) flush();
			},
			onToolLongRunning: (toolUseId, _elapsedMs, rawParentToolUseId) => {
				if (!isSubagent && rawParentToolUseId) return;
				if (applyStreamingToolLongRunning(toolStoreRef.current, toolUseId)) flush();
			},

			onStatusChange: (status) => {
				if (status !== "working" && status !== "waiting") clearBlocks();
			},
			onNarratorError: () => clearBlocks(),
		},
		undefined,
		{ kind: "messages" },
	);

	return useMemo<NarratorMsg | null>(() => {
		void version; // re-read the mutable refs on each version bump
		if (!enabled || !narratorId) return null;
		const chunks = streamingToolChunks(toolStoreRef.current);
		if (blocksRef.current.length === 0 && chunks.length === 0) return null;
		// Both halves go through the chunked path's own builders, so the two lists
		// render identical cards from identical state. Text/reasoning/native blocks
		// come first, then the live tool cards — the order the model produced them.
		const toolChunksMsg =
			chunks.length > 0 ? buildTopLevelStreamingChunksMsg(chunks, narratorId, null) : null;
		return buildStreamingMsg({
			streamingBlocks: blocksRef.current,
			toolChunksMsg,
			narratorId,
			liveBlockIndex: liveBlockIndexRef.current,
		});
	}, [enabled, narratorId, version]);
}
