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

import { textDocumentStore } from "@frontend/lib/text-document-store";
import { messageBody } from "@shared/narrator-blocks/message-blocks";
import type { TextDocumentRangeReader } from "@shared/pretext-layout/text-document";
import {
	type ReasoningTranslationActivity,
	readReasoningTranslationActivity,
} from "@shared/reasoning-translation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNarratorWS } from "../../../hooks/useNarratorWS";
import { documentWriteInput, receiveWriteDocument } from "../content/document-source";
import {
	buildStreamingMsg,
	type StreamingBlock,
	upsertStreamingImageGenerationBlock,
	upsertStreamingWebSearchBlock,
} from "../message/message-segments";
import { buildTopLevelStreamingChunksMsg } from "../narrator-message-helpers";
import type { NarratorMsg } from "../narrator-panel-types";
import {
	contentBlockIdentity,
	dropSupersededStreamingBlocks,
} from "../streaming/streaming-block-supersede";
import {
	applyExactStreamDelta,
	applyExactStreamingSnapshotUpdate,
	type StreamDeltaEvent,
} from "./exact-streaming-accumulator";
import { type HandoffMessage, projectStreamingMessage } from "./streaming-handoff";
import {
	applyStreamingSendDelivery,
	applyStreamingToolChunk,
	applyStreamingToolCompleted,
	applyStreamingToolExecuting,
	applyStreamingToolLongRunning,
	applyStreamingToolOutput,
	applyStreamingToolProgress,
	applyStreamingToolStarted,
	collectPersistedDocumentPins,
	collectPersistedToolUseIds,
	createStreamingToolStore,
	dropDiscardedStreamingTools,
	dropPersistedStreamingTools,
	isRetiredStreamingDocument,
	isRetiredStreamingToolBinding,
	isTextDocumentPersisted,
	streamingToolChunks,
} from "./streaming-tool-chunks";
import { nextStreamAnimEpoch } from "./vlist-stream-anim-extra";

const EMPTY_MESSAGES: readonly HandoffMessage[] = [];

export interface UseVListStreamingMessageOptions {
	/** Only subscribe + accumulate while the narrator is active (working/waiting). */
	enabled: boolean;
	/** A subagent page treats its own (parent-pointing) deltas as top-level. */
	isSubagent?: boolean;
	/** Actual loaded document: the sole evidence that a block is visible elsewhere. */
	committedMessages?: readonly HandoffMessage[];
	fetchTextDocumentRange?: TextDocumentRangeReader;
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
	const { enabled, isSubagent = false, committedMessages = EMPTY_MESSAGES } = options;
	// Raw text never takes a committed (citation-cleaned) value as its seed. A
	// checkpoint only removes the display copy; later deltas still append here.
	const blocksRef = useRef<StreamingBlock[]>([]);
	const identityRef = useRef<{ model?: string; provider?: string }>({});
	const ownerRef = useRef(narratorId);
	const finalizedRef = useRef(new Map<string, number>());
	const toolStoreRef = useRef(createStreamingToolStore());
	const documentOwnersRef = useRef(
		new Map<
			string,
			{
				id: string;
				epoch: string;
				release: (discard?: boolean) => void;
			}
		>(),
	);
	/** Pending output throttle state per tool (latest preview + its timer). */
	const outputThrottleRef = useRef<
		Map<
			string,
			{ latest: string; lastFlushAt: number; timer: ReturnType<typeof setTimeout> | null }
		>
	>(new Map());
	const rafRef = useRef(0);
	/** A checkpoint may retire the body object without closing its active lane. */
	const liveLaneRef = useRef<{
		id: string;
		revision: number;
		type: "text" | "reasoning";
	} | null>(null);
	const reasoningActivityRef = useRef<ReasoningTranslationActivity | null>(null);
	const snapshotEpochRef = useRef<number | undefined>(undefined);
	// Membership, not a second copy of the snapshot body. Weak references also
	// release checkpointed lanes that are no longer in the raw accumulator.
	const snapshotBlocksRef = useRef(new WeakSet<StreamingBlock>());
	const [version, setVersion] = useState(0);

	const flush = useCallback(() => {
		if (rafRef.current) return;
		rafRef.current = requestAnimationFrame(() => {
			rafRef.current = 0;
			setVersion((value) => value + 1);
		});
	}, []);

	const applyReasoningActivity = useCallback(
		(
			next: ReasoningTranslationActivity | null | undefined,
			message?: NarratorMsg,
			restore = false,
		) => {
			if (next === undefined) return;
			const current = reasoningActivityRef.current;
			const lane = liveLaneRef.current;
			// A late subscription baseline cannot take ownership back from content
			// actually received on this connection. No tombstone is required.
			if (
				restore &&
				next &&
				((lane && (lane.type !== "reasoning" || lane.id !== next.elementId)) ||
					(!lane && toolStoreRef.current.size > 0))
			)
				return;
			if (
				next &&
				((current?.elementId === next.elementId && current.revision > next.revision) ||
					(current?.elementId !== next.elementId &&
						(finalizedRef.current.get(next.elementId) ?? -1) >= next.revision &&
						!(restore && !liveLaneRef.current && toolStoreRef.current.size === 0)))
			)
				return;
			if (!next && current && message) {
				const completed = messageBody(message).find((block) => block.id === current.elementId);
				const identity = completed && contentBlockIdentity(completed);
				if (!identity || identity.revision < current.revision) return;
			}
			reasoningActivityRef.current = next;
			if (next)
				liveLaneRef.current = {
					id: next.elementId,
					revision: next.revision,
					type: "reasoning",
				};
			else if (liveLaneRef.current?.type === "reasoning") liveLaneRef.current = null;
			flush();
		},
		[flush],
	);

	// Pins belong to this streaming surface, not to a mounted body row: a Write
	// can be collapsed/offscreen while its only source is still arriving.
	const syncDocumentOwner = useCallback((toolUseId: string, discard = false) => {
		const previous = documentOwnersRef.current.get(toolUseId);
		const document = toolStoreRef.current.get(toolUseId)?.textDocument;
		if (!document) {
			documentOwnersRef.current.delete(toolUseId);
			previous?.release(discard);
			return;
		}
		if (previous?.id === document.id && previous.epoch === document.epoch) return;
		const known = textDocumentStore.getSnapshot(document.id);
		if (known?.epoch !== document.epoch) return;
		const release = textDocumentStore.retainSource(document.id);
		documentOwnersRef.current.set(toolUseId, { id: document.id, epoch: document.epoch, release });
		previous?.release();
	}, []);
	const retireMissingDocuments = useCallback(
		(discard = false) => {
			for (const toolUseId of documentOwnersRef.current.keys()) {
				if (!toolStoreRef.current.has(toolUseId)) syncDocumentOwner(toolUseId, discard);
			}
		},
		[syncDocumentOwner],
	);
	const releaseDocuments = useCallback((discard = false) => {
		for (const owner of documentOwnersRef.current.values()) owner.release(discard);
		documentOwnersRef.current.clear();
	}, []);

	const clearOutputTimers = useCallback(() => {
		for (const state of outputThrottleRef.current.values()) {
			if (state.timer) clearTimeout(state.timer);
		}
		outputThrottleRef.current.clear();
	}, []);

	const clearBlocks = useCallback(
		(discardDocuments = false) => {
			if (rafRef.current) {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = 0;
			}
			const hadContent =
				blocksRef.current.length > 0 ||
				toolStoreRef.current.size > 0 ||
				reasoningActivityRef.current !== null;
			clearOutputTimers();
			releaseDocuments(discardDocuments);
			finalizedRef.current.clear();
			identityRef.current = {};
			liveLaneRef.current = null;
			reasoningActivityRef.current = null;
			snapshotEpochRef.current = undefined;
			snapshotBlocksRef.current = new WeakSet();
			if (hadContent) {
				blocksRef.current = [];
				toolStoreRef.current = createStreamingToolStore();
				setVersion((value) => value + 1);
			}
		},
		[clearOutputTimers, releaseDocuments],
	);

	// Reset accumulation whenever the target narrator changes or streaming is
	// disabled (the narrator left the active state, or unmount).
	useEffect(() => {
		if (!enabled) clearBlocks();
		return () => clearBlocks();
	}, [enabled, clearBlocks]);
	useEffect(() => {
		ownerRef.current = narratorId;
		clearBlocks();
	}, [narratorId, clearBlocks]);

	// Per-tool hand-off: retire each synthetic card exactly when a persisted message
	// carrying its tool-use id lands. Independent of the row-level hand-off because a
	// turn persists its tools progressively — an early tool's real card can exist
	// while later ones are still streaming.
	const persistedToolUseIds = useMemo(
		() => collectPersistedToolUseIds(committedMessages),
		[committedMessages],
	);
	const persistedDocumentPins = useMemo(
		() => collectPersistedDocumentPins(committedMessages),
		[committedMessages],
	);
	useEffect(() => {
		if (
			dropPersistedStreamingTools(
				toolStoreRef.current,
				persistedToolUseIds,
				(chunk) =>
					!!chunk.textDocument &&
					isTextDocumentPersisted(chunk.textDocument, persistedDocumentPins),
			)
		) {
			retireMissingDocuments();
			setVersion((value) => value + 1);
		}
	}, [persistedToolUseIds, persistedDocumentPins, retireMissingDocuments]);

	// Final message events seal ids, but only the actual document may release their
	// raw bodies. A late final/checkpoint cannot clear a newer revision or NEW id.
	useEffect(() => {
		void version; // A final WS frame may seal ids after the loaded array last changed.
		// Provider tool blocks (web_search, image_generation) leave once persisted; a
		// text/reasoning lane leaves once its id is acknowledged at its revision, and a
		// newer revision can reopen the same raw accumulator after a checkpoint.
		const providerTools = blocksRef.current.filter((block) => !contentBlockIdentity(block));
		dropSupersededStreamingBlocks(providerTools, committedMessages);
		const retainedTools = new Set(providerTools);
		const acknowledged = new Map<string, number>();
		for (const message of committedMessages) {
			for (const block of messageBody(message) as readonly Record<string, unknown>[]) {
				const identity = contentBlockIdentity(block);
				if (identity)
					acknowledged.set(
						identity.id,
						Math.max(acknowledged.get(identity.id) ?? -1, identity.revision),
					);
			}
		}
		blocksRef.current = blocksRef.current.filter((block) => {
			const identity = contentBlockIdentity(block);
			return identity
				? (finalizedRef.current.get(identity.id) ?? -1) < identity.revision ||
						(acknowledged.get(identity.id) ?? -1) < identity.revision
				: retainedTools.has(block);
		});
	}, [committedMessages, version]);

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
			onMessage: (data) => {
				const message = data.message as NarratorMsg | undefined;
				if (
					message?.role !== "assistant" ||
					message.narratorId !== narratorId ||
					(!isSubagent && message.parentToolUseId)
				)
					return;
				if (data.reasoningTranslationActivity !== undefined)
					applyReasoningActivity(
						readReasoningTranslationActivity(data.reasoningTranslationActivity),
						message,
					);
				else {
					// Legacy final messages can settle a legacy lane. Once the server
					// supplied independent display ownership, omission cannot revoke it.
					const active = reasoningActivityRef.current;
					if (
						active &&
						active.displayTailStart === undefined &&
						messageBody(message).some((block) => block.id === active.elementId)
					)
						applyReasoningActivity(null, message);
				}
				for (const block of messageBody(message)) {
					const identity = contentBlockIdentity(block);
					if (identity)
						finalizedRef.current.set(
							identity.id,
							Math.max(finalizedRef.current.get(identity.id) ?? -1, identity.revision),
						);
				}
				// Tombstones contain ids/revisions only, and never retain historical text.
				while (finalizedRef.current.size > 2048) {
					const oldest = finalizedRef.current.keys().next().value;
					if (oldest === undefined) break;
					finalizedRef.current.delete(oldest);
				}
				flush();
			},
			onMessageUpdated: (message, _replacement, activity) => {
				if (message.narratorId !== narratorId || (!isSubagent && message.parentToolUseId)) return;
				applyReasoningActivity(activity, message);
			},
			onStreamEvent: (wsData: { event?: Record<string, unknown>; [key: string]: unknown }) => {
				const event = wsData.event as StreamDeltaEvent | undefined;
				if (
					(!isSubagent && (wsData.parentToolUseId || event?.subagentToolUseId)) ||
					(wsData.subagentNarratorId && wsData.subagentNarratorId !== narratorId)
				)
					return;
				const delta = event?.delta;
				if (
					typeof delta?.id === "string" &&
					typeof delta.revision === "number" &&
					(finalizedRef.current.get(delta.id) ?? -1) >= delta.revision
				)
					return;
				const result = applyExactStreamDelta(
					blocksRef.current,
					wsData.event as StreamDeltaEvent,
					isSubagent,
				);
				if (result.applied) {
					const block = blocksRef.current[result.blockIndex];
					if (block?.type === "reasoning" || block?.type === "text") {
						liveLaneRef.current = { id: block.id, revision: block.revision, type: block.type };
						const previous = reasoningActivityRef.current;
						reasoningActivityRef.current =
							block.type === "reasoning"
								? {
										elementId: block.id,
										revision: block.revision,
										completedRanges:
											previous?.elementId === block.id ? previous.completedRanges : [],
										...(previous?.elementId === block.id && previous.displayTailStart !== undefined
											? { displayTailStart: previous.displayTailStart }
											: {}),
									}
								: null;
					}
					flush();
				}
				// A rejected replay delta cannot clear/reopen the newer accepted lane.
				if (!result.applied && typeof delta?.text === "string" && delta.text) return;
				if (wsData.reasoningTranslationActivity !== undefined)
					applyReasoningActivity(
						readReasoningTranslationActivity(wsData.reasoningTranslationActivity),
					);
			},
			onStreamingIdentity: (identity) => {
				if (!isSubagent && identity.parentToolUseId) return;
				if (
					identityRef.current.model !== identity.model ||
					identityRef.current.provider !== identity.provider
				) {
					identityRef.current = { model: identity.model, provider: identity.provider };
					flush();
				}
			},
			onStreamingSnapshot: (snapshot) => {
				if (
					(!isSubagent && snapshot.parentToolUseId) ||
					(snapshot.subagentNarratorId && snapshot.subagentNarratorId !== narratorId)
				)
					return;
				// Old-server snapshots omit identity; never erase a newer live identity.
				const identity = {
					model: snapshot.model ?? identityRef.current.model,
					provider: snapshot.provider ?? identityRef.current.provider,
				};
				if (
					identityRef.current.model !== identity.model ||
					identityRef.current.provider !== identity.provider
				) {
					identityRef.current = identity;
					flush();
				}
				let toolsChanged = false;
				for (const chunk of snapshot.toolChunks) {
					if (!isSubagent && chunk.parentToolUseId) continue;
					// Retired bindings must not reach the snapshot's later started/executing
					// folds either; rejecting only its raw input chunk would be too late.
					if (isRetiredStreamingToolBinding(toolStoreRef.current, chunk)) continue;
					if (
						chunk.inputDocument
							? isTextDocumentPersisted(chunk.inputDocument.ref, persistedDocumentPins)
							: persistedToolUseIds.has(chunk.toolUseId)
					)
						continue;
					if (
						chunk.inputDocument &&
						isRetiredStreamingDocument(
							toolStoreRef.current,
							chunk.toolUseId,
							chunk.inputDocument.ref,
						)
					)
						continue;
					const inputDocument = chunk.inputDocument
						? {
								...chunk.inputDocument,
								ref: receiveWriteDocument(
									chunk.inputDocument,
									undefined,
									options.fetchTextDocumentRange,
								),
							}
						: undefined;
					// A name-only tool may receive no more deltas for a long time.
					// Restore it from the subscription snapshot, not the next live event.
					toolsChanged =
						applyStreamingToolChunk(toolStoreRef.current, {
							...chunk,
							inputDocument,
							fromSnapshot: true,
						}) || toolsChanged;
					if (isRetiredStreamingToolBinding(toolStoreRef.current, chunk)) continue;
					if (chunk.started) {
						toolsChanged =
							applyStreamingToolStarted(toolStoreRef.current, {
								...chunk,
								input: (chunk.toolName === "Write" && narratorId
									? documentWriteInput(
											narratorId,
											chunk.toolUseId,
											chunk.input,
											chunk.inputDocument?.ref.source,
										)
									: chunk.input) as Record<string, unknown> | undefined,
							}) || toolsChanged;
					}
					if (chunk.executing) {
						toolsChanged = applyStreamingToolExecuting(toolStoreRef.current, chunk) || toolsChanged;
					}
					if (chunk.streamingOutput !== undefined) {
						toolsChanged =
							applyStreamingToolOutput(
								toolStoreRef.current,
								chunk.toolUseId,
								chunk.streamingOutput,
							) || toolsChanged;
					}
					if (chunk.structuredProgress) {
						toolsChanged =
							applyStreamingToolProgress(
								toolStoreRef.current,
								chunk.toolUseId,
								chunk.structuredProgress,
							) || toolsChanged;
					}
					syncDocumentOwner(chunk.toolUseId);
				}
				const applied = applyExactStreamingSnapshotUpdate(
					blocksRef.current,
					snapshot.streamingBlocks.filter((block) => {
						const identity = contentBlockIdentity(block);
						return !identity || (finalizedRef.current.get(identity.id) ?? -1) < identity.revision;
					}) as StreamingBlock[],
				);
				if (applied.textChanged) {
					// A catch-up is an existing-text baseline, including on SAME-page
					// reconnect. Publish the epoch ON the message, not as shell state:
					// the coordinator must commit it together with the new body/layout.
					// Deltas coalesced into this rAF are safely sealed with the batch;
					// later live frames retain the epoch and animate normally.
					snapshotEpochRef.current = nextStreamAnimEpoch();
					snapshotBlocksRef.current = new WeakSet(
						blocksRef.current.filter(
							(block) => block.type === "text" || block.type === "reasoning",
						),
					);
				}
				const snapshotActivity = snapshot.reasoningTranslationActivity;
				const snapshotTail = blocksRef.current.at(-1);
				if (
					applied.changed &&
					snapshotActivity &&
					snapshotTail?.type === "reasoning" &&
					snapshotTail.id === snapshotActivity.elementId &&
					snapshotTail.revision <= snapshotActivity.revision &&
					snapshot.streamingBlocks.some((block) => {
						const identity = contentBlockIdentity(block);
						return (
							block.type === "reasoning" &&
							identity?.id === snapshotTail.id &&
							identity.revision === snapshotTail.revision
						);
					})
				) {
					// Unlike an empty baseline, accepted new current content is a real
					// handoff during disconnection, even when no later delta arrives.
					liveLaneRef.current = {
						id: snapshotTail.id,
						revision: snapshotTail.revision,
						type: "reasoning",
					};
				}
				if (applied.changed && snapshot.reasoningTranslationActivity === undefined) {
					const block = blocksRef.current.at(-1);
					if (block?.type === "text" || block?.type === "reasoning") {
						liveLaneRef.current = { id: block.id, revision: block.revision, type: block.type };
						reasoningActivityRef.current =
							block.type === "reasoning"
								? { elementId: block.id, revision: block.revision, completedRanges: [] }
								: null;
					}
					flush();
				}
				if (toolsChanged) {
					if (snapshot.reasoningTranslationActivity === undefined) {
						liveLaneRef.current = null;
						reasoningActivityRef.current = null;
					}
					flush();
				}
				if (applied.changed) flush();
				// A subscription can restore a persisted current item with no raw body.
				// Final-message tombstones retire text, not this visual ownership.
				applyReasoningActivity(snapshot.reasoningTranslationActivity, undefined, true);
			},
			onStreamingReset: (parentToolUseId) => {
				// The owning page receives the reset without a parentToolUseId; the
				// parent-page duplicate keeps it set and must be ignored here.
				if (parentToolUseId) return;
				clearBlocks(true);
			},
			// A replayed attempt abandoned these tool ids mid-arguments. They never
			// persisted, so the structural hand-off has no replacement to wait for and
			// would keep the cards spinning forever.
			onToolUseDiscarded: (toolUseIds, rawParentToolUseId) => {
				if (!isSubagent && rawParentToolUseId) return;
				if (dropDiscardedStreamingTools(toolStoreRef.current, toolUseIds)) {
					retireMissingDocuments(true);
					flush();
				}
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
				error,
				errorCode,
			) => {
				if (!isSubagent && rawParentToolUseId) return;
				upsertStreamingImageGenerationBlock(blocksRef.current, {
					id,
					status,
					error,
					errorCode,
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
				meta,
				inputDocument,
			) => {
				if (!isSubagent && rawParentToolUseId) return;
				if (
					inputDocument &&
					isRetiredStreamingDocument(toolStoreRef.current, toolUseId, inputDocument.ref)
				)
					return;
				if (inputDocument)
					inputDocument = {
						...inputDocument,
						ref: receiveWriteDocument(
							inputDocument,
							streamingField?.delta,
							options.fetchTextDocumentRange,
						),
					};
				// The model is writing tool arguments, so no text lane is open: whatever
				// reasoning or text preceded this is finished and must settle now instead of
				// waiting for the turn to persist.
				liveLaneRef.current = null;
				reasoningActivityRef.current = null;
				if (
					applyStreamingToolChunk(toolStoreRef.current, {
						toolUseId,
						toolName,
						...(meta?.toolCallId ? { toolCallId: meta.toolCallId } : {}),
						...(meta?.executionAttempt !== undefined
							? { executionAttempt: meta.executionAttempt }
							: {}),
						inputCharsTotal,
						...(extractedFilePath !== undefined ? { extractedFilePath } : {}),
						...(contentCharsReceived !== undefined ? { contentCharsReceived } : {}),
						...(extractedFields !== undefined ? { extractedFields } : {}),
						...(metadata !== undefined ? { metadata } : {}),
						...(streamingField ? { streamingField } : {}),
						...(inputDocument ? { inputDocument } : {}),
					})
				)
					flush();
				syncDocumentOwner(toolUseId);
			},
			onToolStarted: (
				toolUseId,
				toolName,
				streamStartedAt,
				streamCompletedAt,
				input,
				rawParentToolUseId,
				meta,
				streamingEditOrigin,
				inputDocument,
			) => {
				if (!isSubagent && rawParentToolUseId) return;
				if (
					inputDocument &&
					isRetiredStreamingDocument(toolStoreRef.current, toolUseId, inputDocument.ref)
				)
					return;
				if (inputDocument)
					receiveWriteDocument(inputDocument, undefined, options.fetchTextDocumentRange);
				if (
					applyStreamingToolStarted(toolStoreRef.current, {
						toolUseId,
						toolName,
						...(meta?.toolCallId ? { toolCallId: meta.toolCallId } : {}),
						...(meta?.executionAttempt !== undefined
							? { executionAttempt: meta.executionAttempt }
							: {}),
						...(streamStartedAt != null ? { streamStartedAt } : {}),
						...(streamCompletedAt != null ? { streamCompletedAt } : {}),
						...(input
							? {
									input: (toolName === "Write" && narratorId
										? documentWriteInput(
												narratorId,
												toolUseId,
												input,
												inputDocument?.ref.source ??
													(meta?.toolCallId ? { toolCallId: meta.toolCallId } : undefined),
											)
										: input) as Record<string, unknown>,
								}
							: {}),
						...(meta ? { metadata: meta as Record<string, unknown> } : {}),
						...(streamingEditOrigin ? { streamingEditOrigin } : {}),
					})
				)
					flush();
				syncDocumentOwner(toolUseId);
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
						...(updatedInput
							? {
									updatedInput: (toolStoreRef.current.get(toolUseId)?.toolName === "Write" &&
									narratorId
										? documentWriteInput(narratorId, toolUseId, updatedInput)
										: updatedInput) as Record<string, unknown>,
								}
							: {}),
						...(metadata ? { metadata } : {}),
					})
				)
					flush();
				syncDocumentOwner(toolUseId);
			},
			// Live stdout of a running command. Throttled per tool: a build emitting
			// megabytes would otherwise re-render the row on every socket frame.
			onToolOutput: (toolUseId, output, rawParentToolUseId, meta) => {
				// Explicit Agent counts paint a keyed badge, never a synthetic tool or flush.
				if (meta?.subagentOutputCount) return;
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
		if (!enabled || !narratorId || ownerRef.current !== narratorId) return null;
		const chunks = streamingToolChunks(toolStoreRef.current);
		const activity = reasoningActivityRef.current;
		if (blocksRef.current.length === 0 && chunks.length === 0 && !activity) return null;
		// Both halves go through the chunked path's own builders, so the two lists
		// render identical cards from identical state. Text/reasoning/native blocks
		// come first, then the live tool cards — the order the model produced them.
		const toolChunksMsg =
			chunks.length > 0 ? buildTopLevelStreamingChunksMsg(chunks, narratorId, null) : null;
		const lane = liveLaneRef.current;
		const streaming =
			buildStreamingMsg({
				...identityRef.current,
				streamingBlocks: blocksRef.current,
				toolChunksMsg,
				narratorId,
				liveBlockIndex: lane
					? blocksRef.current.findIndex((block) => block.id === lane.id && block.type === lane.type)
					: -1,
			}) ??
			(activity
				? ({
						id: "__streaming__",
						narratorId,
						role: "assistant",
						parentToolUseId: null,
						blocks: [],
						toolCalls: [],
						contentText: null,
						createdAt: "",
						liveBlockIndex: -1,
						...identityRef.current,
					} as NarratorMsg)
				: null);
		if (streaming && activity) streaming.reasoningTranslationActivity = activity;
		if (streaming && snapshotEpochRef.current != null) {
			streaming._streamAnimSnapshotEpoch = snapshotEpochRef.current;
			// The builder emits fresh block objects in raw-accumulator order. Mark
			// only snapshot-covered lanes, before projections filter/reorder them:
			// a genuinely NEW lane on a later live frame must still fade on birth.
			for (const [index, raw] of blocksRef.current.entries()) {
				const block = messageBody(streaming)[index];
				if (block && snapshotBlocksRef.current.has(raw)) {
					block._streamAnimSnapshotEpoch = snapshotEpochRef.current;
				}
			}
		}
		return projectStreamingMessage(streaming, committedMessages, isSubagent);
	}, [enabled, narratorId, version, committedMessages, isSubagent]);
}
