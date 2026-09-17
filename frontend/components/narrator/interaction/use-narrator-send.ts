import { notifications } from "@mantine/notifications";
import type { FileReference } from "@shared/file-reference";
import type { TFunction } from "i18next";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type BufferMessageSummary, isAbortError } from "../../../lib/api";
import { narratorWSManager } from "../../../lib/narrator-ws-manager";
import { hasSendableComposerContent } from "../composer/composer-send-gate";
import { trimFileReferenceInput } from "../composer/file-reference-input";
import type { NarratorComposerHandle } from "../composer/NarratorComposer";
import { revokeContentBlockPreviewUrls } from "../narrator-message-helpers";
import type { ContentBlock } from "../narrator-panel-types";
import type { BooleanOverride, DangerReflectionOverride } from "./reflection-types";

/** Subset of a send response that indicates a buffered (queued) message. */
export type BufferedSendResult = {
	buffered?: boolean;
	id?: string;
	bufferedAt?: string;
	/** Set when a busy `/goal` was queued; used to show a "queued task" toast. */
	specGoalQueued?: boolean;
	/** The protected task text carried by a queued `/goal`. */
	objective?: string;
};

/** Live sending/upload progress surfaced to the composer + cancel button. */
export interface NarratorSendingState {
	attachmentCount: number;
	progress: number | null;
	canCancel: boolean;
}

interface CurrentUserLike {
	id?: string | number;
	username?: string;
	avatarColor?: string | null;
	avatarImageId?: string | null;
}

interface NarratorLike {
	cwd?: string | null;
	model?: string | null;
	systemPrompt?: string | null;
	permissionMode?: string | null;
	reasoningEffort?: string | null;
	fastModeOverride?: unknown;
	relaxedPlan?: unknown;
	planReflectionAutoApproveOverride?: unknown;
	dangerReflectionOverride?: unknown;
}

export interface UseNarratorSendOptions {
	narratorId: string;
	composerRef: React.RefObject<NarratorComposerHandle | null>;

	// Attachments (owned by useComposerAttachments, shared with the composer).
	attachedImages: File[];
	attachedTextFiles: File[];
	attachedImagesRef: React.RefObject<File[]>;
	attachedTextFilesRef: React.RefObject<File[]>;
	updateAttachedImages: (files: File[]) => void;
	updateAttachedTextFiles: (files: File[]) => void;
	hideAttachedFilesForSend: () => void;
	clearAttachedFilesAndDraft: () => void;

	// Shared send guard (also read by the composer's disabled state).
	sendingRef: React.RefObject<boolean>;

	// Queue buffer (owned by the WS layer).
	setQueuedMessages: React.Dispatch<React.SetStateAction<BufferMessageSummary[]>>;
	reconcileBufferedMessages: () => void;

	// Scroll + narrator/session state derived in the panel.
	scrollToBottom: (instant?: boolean) => void;
	isActive: boolean;
	isSubagent: boolean;
	isTakenOver: boolean;
	showCompactQueueChoice: boolean;
	canRetryLastUserMessage: boolean;
	canContinueNarrator: boolean;
	fetchedNarrator: NarratorLike | null | undefined;
	narrator: NarratorLike | null | undefined;
	chapterWorktreePath: string | null | undefined;
	currentUser: CurrentUserLike | null | undefined;
	enterQueueMode: "turn" | "tool" | "interrupt";
	ctrlEnterQueueMode: "turn" | "tool" | "interrupt";

	// Mutations / infra passed from the panel.
	createNarrator: {
		mutateAsync: (input: Record<string, unknown>) => Promise<{ id: string }>;
	};
	interruptNarrator: { mutateAsync: (narratorId: string) => Promise<unknown> };
	registerSubmitToNarrator: ((fn: (text: string) => void) => (() => void) | undefined) | undefined;
	setNarratorWorking: () => void;
	navigateToNarrator: (narratorId: string) => void;

	normalizeBooleanOverride: (value: unknown) => BooleanOverride;
	normalizeDangerReflectionOverride: (value: unknown) => DangerReflectionOverride;
	t: TFunction<"narrator">;
}

export interface UseNarratorSendResult {
	sendingState: NarratorSendingState | null;
	isSending: boolean;
	cancelSending: () => void;
	reportUploadProgress: (fraction: number) => void;
	handleSend: () => Promise<void>;
	handleSendRef: React.RefObject<() => void | Promise<void>>;
	handleSendWithModeRef: React.RefObject<
		(mode: "turn" | "tool" | "interrupt") => void | Promise<void>
	>;
	ctrlEnterQueueModeRef: React.RefObject<"turn" | "tool" | "interrupt">;
	composerSendWithMode: (mode: "turn" | "tool" | "interrupt") => void;
	forwardTextToNarrator: (text: string) => void;
	handleRetry: () => Promise<void>;
	handleContinue: () => Promise<void>;
}

/**
 * The narrator's send subsystem, extracted whole from NarratorPanel: the
 * in-flight sending state + upload-progress throttle + cancel, the buffered-send
 * reconciliation (`applyBufferedSendResult`), the optimistic `submitMessage`, the
 * `doSendBuffered` composer path, the mode-aware `handleSendWithMode` (with its
 * `/new` spawn and compact-queue branches), the dock-bridge `forwardTextToNarrator`,
 * and the retry/continue actions.
 *
 * Kept lifted (called from the panel) rather than pushed into a single child:
 * its inputs (`composerRef`, attachments, scroll, the shared `sendingRef`) and
 * outputs (the stable send refs consumed by `useQueuedMessageActions`) are shared
 * across the composer, the queue actions, and the panel's dock bridge.
 */
export function useNarratorSend(options: UseNarratorSendOptions): UseNarratorSendResult {
	const {
		narratorId,
		composerRef,
		attachedImages,
		attachedTextFiles,
		attachedImagesRef,
		attachedTextFilesRef,
		updateAttachedImages,
		updateAttachedTextFiles,
		hideAttachedFilesForSend,
		clearAttachedFilesAndDraft,
		sendingRef,
		setQueuedMessages,
		reconcileBufferedMessages,
		scrollToBottom,
		isActive,
		isSubagent,
		isTakenOver,
		showCompactQueueChoice,
		canRetryLastUserMessage,
		canContinueNarrator,
		fetchedNarrator,
		narrator,
		chapterWorktreePath,
		currentUser,
		enterQueueMode,
		ctrlEnterQueueMode,
		createNarrator,
		interruptNarrator,
		registerSubmitToNarrator,
		setNarratorWorking,
		navigateToNarrator,
		normalizeBooleanOverride,
		normalizeDangerReflectionOverride,
		t,
	} = options;

	const [sendingState, setSendingState] = useState<NarratorSendingState | null>(null);
	const isSending = sendingState !== null;
	// AbortController for the in-flight send request; used by the cancel button.
	const sendAbortRef = useRef<AbortController | null>(null);
	// Throttle progress updates to whole-percent changes to avoid re-render storms.
	const lastProgressPercentRef = useRef(-1);
	const reportUploadProgress = useCallback((fraction: number) => {
		const percent = Math.min(100, Math.max(0, Math.round(fraction * 100)));
		if (percent === lastProgressPercentRef.current) return;
		lastProgressPercentRef.current = percent;
		setSendingState((prev) => (prev ? { ...prev, progress: fraction } : prev));
	}, []);
	const cancelSending = useCallback(() => {
		sendAbortRef.current?.abort();
	}, []);

	const applyBufferedSendResult = useCallback(
		(
			result: BufferedSendResult | null | undefined,
			text: string,
			imageCount: number,
			priority?: boolean,
			fileReferences?: FileReference[],
		) => {
			if (!result?.buffered || !result.id) return false;

			const queuedMessage: BufferMessageSummary = {
				id: result.id,
				text,
				bufferedAt: result.bufferedAt ?? new Date().toISOString(),
				imageCount,
				fileReferences,
				creator:
					currentUser?.id && currentUser?.username
						? {
								id: String(currentUser.id),
								username: String(currentUser.username),
								avatarColor: currentUser.avatarColor ?? null,
								avatarImageId: currentUser.avatarImageId ?? null,
							}
						: null,
				priority: priority || undefined,
			};

			setQueuedMessages((prev) => {
				if (prev.some((m) => m.id === queuedMessage.id)) return prev;
				return priority ? [queuedMessage, ...prev] : [...prev, queuedMessage];
			});

			// A busy `/goal` is queued rather than applied immediately; tell the user
			// the protected task will be added once the queued command is consumed.
			if (result.specGoalQueued) {
				notifications.show({
					title: t("spec.specGoalQueued"),
					message: result.objective ?? undefined,
					color: "blue",
					autoClose: 4000,
				});
			}

			// Reconcile with the authoritative queue, but guarded: if the narrator
			// consumed this (priority) message and broadcast buffer_consumed while the
			// GET was in flight, the epoch guard drops the stale pre-consume snapshot
			// so the message doesn't reappear in the "pending" area.
			reconcileBufferedMessages();

			return true;
		},
		[currentUser, setQueuedMessages, reconcileBufferedMessages, t],
	);

	// --- Send / retry message ---
	/**
	 * Send as a new turn on an idle narrator.
	 *
	 * `priority` is not about queue ordering here — an idle narrator has no turn to
	 * cut in front of. It is the explicit "do not wait for the running compaction"
	 * opt-out: the server queues an idle-but-compacting narrator's messages by
	 * default, and this flag makes it start the turn immediately instead. On a
	 * narrator that is neither busy nor compacting it changes nothing.
	 */
	const submitMessage = async (
		msg: string,
		images: File[] = [],
		textFiles: File[] = [],
		signal?: AbortSignal,
		priority?: boolean,
		fileReferences: FileReference[] = [],
	) => {
		const optimisticBlocks: ContentBlock[] = [
			...fileReferences.map((reference) => ({ type: "file_reference", reference })),
			...images.map((f) => ({
				type: "image",
				filename: f.name,
				mediaType: f.type,
				previewUrl: URL.createObjectURL(f),
			})),
			...textFiles.map((f) => ({
				type: "text_file",
				filename: f.name,
				size: f.size,
			})),
			{ type: "text", text: msg },
		];
		scrollToBottom(true);
		try {
			const result = await api.sendNarratorMessage(
				narratorId,
				msg,
				images.length > 0 ? images : undefined,
				textFiles.length > 0 ? textFiles : undefined,
				priority,
				reportUploadProgress,
				signal,
				fileReferences,
			);
			// Handle /load tool response — not a real message, just a tool load confirmation
			if (result?.loaded) {
				const toolName = result.toolName ?? "tool";
				notifications.show({
					title: result.alreadyLoaded ? t("toolAlreadyLoaded") : t("toolLoaded"),
					message: toolName,
					color: result.alreadyLoaded ? "yellow" : "green",
				});
			} else if (result?.type === "bash" && result?.id) {
				// /bash command — WS broadcasts will provide real messages
				scrollToBottom(true);
			} else if (result?.specGoal) {
				// /goal added a protected task; the real user message arrives via WS.
				notifications.show({
					title: result.added ? t("spec.specGoalAdded") : t("spec.specGoalExists"),
					message: result.objective ?? undefined,
					color: result.added ? "green" : "yellow",
					autoClose: 4000,
				});
				// /goal now launches a Spec continuation. Mirror normal sends' optimistic
				// working state so a missed early WS frame cannot make the loop look idle.
				if (result.started) {
					setNarratorWorking();
					setTimeout(() => narratorWSManager.checkSync(narratorId), 500);
				}
				scrollToBottom(true);
			} else if (result?.buffered) {
				// Message was buffered — show it in the queue immediately.
				// The WS buffer_set event can be missed when the subscription is not
				// fully caught up, so also reconcile with REST.
				applyBufferedSendResult(result, msg, images.length, priority, fileReferences);
				scrollToBottom(true);
			} else if (result?.id) {
				// Normal message — set narrator status to "working" optimistically.
				// This guards against the race where the WS subscribe message hasn't
				// been processed by the server yet when the backend broadcasts the
				// status_change event.
				setNarratorWorking();
				// Safety net: trigger a sync_check shortly after sending so that
				// even if the WS subscription was delayed, we catch up on any
				// missed events from the server.
				setTimeout(() => narratorWSManager.checkSync(narratorId), 500);
			}
		} catch (err) {
			// The request may have reached the server even when the response was lost.
			// Never force the narrator back to idle; reconcile from the authoritative session.
			void narratorWSManager.checkSync(narratorId);
			throw err;
		} finally {
			revokeContentBlockPreviewUrls(optimisticBlocks);
		}
	};

	/** Shared logic for sending a buffered message (normal or priority). */
	const doSendBuffered = async (
		msg: string,
		priority?: boolean,
		signal?: AbortSignal,
		references?: FileReference[],
	): Promise<boolean> => {
		const draft = trimFileReferenceInput({
			text: composerRef.current?.getText() ?? "",
			fileReferences: composerRef.current?.getFileReferences() ?? [],
		});
		const fileReferences = references ?? (draft.text === msg ? draft.fileReferences : []);
		const images = [...attachedImages];
		const textFiles = [...attachedTextFiles];
		composerRef.current?.hideTextForSend();
		hideAttachedFilesForSend();
		try {
			const result = await api.sendNarratorMessage(
				narratorId,
				msg,
				images.length > 0 ? images : undefined,
				textFiles.length > 0 ? textFiles : undefined,
				priority,
				reportUploadProgress,
				signal,
				fileReferences,
			);
			const buffered = applyBufferedSendResult(
				result,
				msg,
				images.length,
				priority,
				fileReferences,
			);
			composerRef.current?.commitDraftAfterSend();
			clearAttachedFilesAndDraft();
			// Whether the message was buffered (202) or the backend fell through
			// to a direct send (201), scroll so the new content is visible.
			scrollToBottom(true);
			return buffered;
		} catch (err) {
			// Restore text and its independently tracked file references together.
			composerRef.current?.restoreInput(msg, fileReferences);
			if (images.length > 0) updateAttachedImages(images);
			if (textFiles.length > 0) updateAttachedTextFiles(textFiles);
			throw err; // Re-throw to let caller handle
		}
	};

	/**
	 * Latest `doSendBuffered`, for callers registered once with the dock bridge.
	 *
	 * `doSendBuffered` is redefined every render (it closes over the live
	 * attachments), so a bridge that captured it directly would keep calling a
	 * stale closure with stale attachment state.
	 */
	const doSendBufferedRef = useRef(doSendBuffered);
	doSendBufferedRef.current = doSendBuffered;

	/**
	 * Core send handler. When the narrator is active, `mode` selects the queue
	 * behavior:
	 *   - "turn": normal queue — wait for the current turn to finish
	 *   - "tool": priority queue — cut in after the current tool call completes
	 *   - "interrupt": priority queue + immediate interrupt (auto-resume consumes it)
	 *
	 * An idle narrator that is COMPACTING is a third state, not a busy one: there is
	 * no turn to cut into, but starting one now would race the summary that is about
	 * to replace the history. The server queues it by default and consumes the queue
	 * when the compact settles, so the only meaningful choice is wait-or-not — which
	 * is what the compact queue modes (see SendOptionsSplitButton) offer. `mode` maps
	 * onto it as "turn" = wait, anything else = run now (`priority` opts out of the
	 * server-side queue).
	 *
	 * When the narrator is fully idle, `mode` is ignored and the message is sent
	 * directly (an idle session is never interrupted). `/new` while active always
	 * uses the normal queue regardless of mode — spawning a new narrator should
	 * not interrupt the current turn.
	 */
	const handleSendWithMode = async (mode: "turn" | "tool" | "interrupt") => {
		const composerText = composerRef.current?.getText() ?? "";
		const { text: msg, fileReferences } = trimFileReferenceInput({
			text: composerText,
			fileReferences: composerRef.current?.getFileReferences() ?? [],
		});
		const attachmentCount =
			attachedImages.length + attachedTextFiles.length + fileReferences.length;
		// An attachment-only message is a valid turn: images (and text files) carry the
		// content by themselves, so an empty textarea must not block the send.
		if (
			!hasSendableComposerContent({
				text: composerText,
				imageCount: attachedImages.length,
				textFileCount: attachedTextFiles.length,
				fileReferenceCount: fileReferences.length,
			}) ||
			sendingRef.current
		)
			return;
		sendingRef.current = true;
		lastProgressPercentRef.current = -1;
		const abortController = new AbortController();
		sendAbortRef.current = abortController;
		// Only offer cancellation when there's an upload worth aborting.
		setSendingState({
			attachmentCount,
			progress: attachmentCount > 0 ? 0 : null,
			canCancel: attachmentCount > 0,
		});
		let restoreOnError: {
			msg: string;
			images: File[];
			textFiles: File[];
			fileReferences: FileReference[];
		} | null = null;
		try {
			composerRef.current?.noteSent(msg, fileReferences);

			const newMatch = msg.match(/^\/new(?:\s+([\s\S]*))?$/);
			if (newMatch) {
				if (fileReferences.length) throw new Error(t("fileReferences.newSessionFirst"));
				if (isActive) {
					// /new while active: always normal queue (never interrupt to spawn).
					await doSendBuffered(msg);
					return;
				}

				const initialMessage = newMatch[1]?.trim() ?? "";
				const images = [...attachedImages];
				const textFiles = [...attachedTextFiles];
				restoreOnError = { msg, images, textFiles, fileReferences };
				composerRef.current?.hideTextForSend();
				hideAttachedFilesForSend();

				const currentCwd =
					fetchedNarrator?.cwd ?? narrator?.cwd ?? chapterWorktreePath ?? undefined;
				const newNarrator = await createNarrator.mutateAsync({
					chapterId: null,
					model: fetchedNarrator?.model ?? narrator?.model ?? undefined,
					systemPrompt: fetchedNarrator?.systemPrompt ?? narrator?.systemPrompt ?? undefined,
					permissionMode: fetchedNarrator?.permissionMode ?? narrator?.permissionMode ?? undefined,
					reasoningEffort:
						fetchedNarrator?.reasoningEffort ?? narrator?.reasoningEffort ?? undefined,
					fastModeOverride: normalizeBooleanOverride(
						fetchedNarrator?.fastModeOverride ?? narrator?.fastModeOverride,
					),
					relaxedPlan: fetchedNarrator?.relaxedPlan ?? narrator?.relaxedPlan ?? undefined,
					planReflectionAutoApproveOverride: normalizeBooleanOverride(
						fetchedNarrator?.planReflectionAutoApproveOverride ??
							narrator?.planReflectionAutoApproveOverride,
					),
					dangerReflectionOverride: normalizeDangerReflectionOverride(
						fetchedNarrator?.dangerReflectionOverride ?? narrator?.dangerReflectionOverride,
					),
					cwd: currentCwd,
				});

				if (initialMessage) {
					await api.sendNarratorMessage(
						newNarrator.id,
						initialMessage,
						images.length > 0 ? images : undefined,
						textFiles.length > 0 ? textFiles : undefined,
						undefined,
						reportUploadProgress,
						abortController.signal,
					);
				}

				composerRef.current?.commitDraftAfterSend();
				clearAttachedFilesAndDraft();
				restoreOnError = null;
				navigateToNarrator(newNarrator.id);
				return;
			}

			if (isActive) {
				// A subagent that is still controlled by its parent must receive user input
				// at the next safe post-tool boundary. Never wait for its whole task turn,
				// and never use the generic interrupt route (which hard-stops subagents).
				if (isSubagent && !isTakenOver) {
					await doSendBuffered(msg, true, abortController.signal);
					return;
				}
				// A taken-over subagent queues without a soft stop, so the "interrupt"
				// mode's follow-up interrupt has nothing to hand over — and the generic
				// interrupt route hard-stops subagents, which would end the takeover.
				// Queue plainly; the runner drains the message when the turn suspends.
				if (isSubagent) {
					await doSendBuffered(msg, mode !== "turn", abortController.signal);
					return;
				}
				if (mode === "turn") {
					await doSendBuffered(msg, false, abortController.signal);
				} else if (mode === "tool") {
					await doSendBuffered(msg, true, abortController.signal);
				} else {
					// "interrupt": insert at the front (await success), then interrupt so
					// the loop's auto-resume immediately consumes the queued message.
					// Only interrupt when the message was actually buffered — if the
					// backend fell through to a direct send (narrator went idle between
					// the status check and this request), interrupting would abort the
					// message we just sent.
					const buffered = await doSendBuffered(msg, true, abortController.signal);
					if (buffered) {
						// The queued message must be durably accepted before interrupting. Using
						// `mutate` here fired-and-forgot the interrupt request; its cancellation
						// could race the queue write/auto-resume and leave the message stuck in
						// the "next request" state.
						await interruptNarrator.mutateAsync(narratorId);
					}
				}
				return;
			}
			// Idle but compacting: the server decides queue-or-send, so this only has to
			// carry the user's intent. "turn" (wait) leaves `priority` off and lets the
			// server queue it; any other mode sets `priority` to run now. The response
			// tells us which happened — a 202 lands in the queued-messages area, a 201
			// starts a turn — so both outcomes are handled by `submitMessage` already.
			if (showCompactQueueChoice) {
				const images = [...attachedImages];
				const textFiles = [...attachedTextFiles];
				restoreOnError = { msg, images, textFiles, fileReferences };
				composerRef.current?.hideTextForSend();
				hideAttachedFilesForSend();
				await submitMessage(
					msg,
					images,
					textFiles,
					abortController.signal,
					mode !== "turn",
					fileReferences,
				);
				composerRef.current?.commitDraftAfterSend();
				clearAttachedFilesAndDraft();
				restoreOnError = null;
				return;
			}
			const images = [...attachedImages];
			const textFiles = [...attachedTextFiles];
			// Remember the draft so a cancelled upload can restore it — submitMessage
			// clears the input/attachments up-front for the optimistic bubble.
			restoreOnError = { msg, images, textFiles, fileReferences };
			composerRef.current?.hideTextForSend();
			hideAttachedFilesForSend();
			await submitMessage(
				msg,
				images,
				textFiles,
				abortController.signal,
				undefined,
				fileReferences,
			);
			composerRef.current?.commitDraftAfterSend();
			clearAttachedFilesAndDraft();
			restoreOnError = null;
		} catch (err) {
			// Restore the drafted input/attachments so the user doesn't lose their
			// message. `doSendBuffered` already restores internally on its own throw;
			// this covers the `/new` and idle direct-send paths.
			if (restoreOnError) {
				composerRef.current?.restoreInput(restoreOnError.msg, restoreOnError.fileReferences);
				if (restoreOnError.images.length > 0) updateAttachedImages(restoreOnError.images);
				if (restoreOnError.textFiles.length > 0) updateAttachedTextFiles(restoreOnError.textFiles);
			}
			// A user-initiated cancel is not a failure — show a gentle notice, not an error.
			if (isAbortError(err)) {
				notifications.show({ message: t("sendCancelled"), color: "gray", autoClose: 2000 });
				return;
			}
			notifications.show({
				title: t("sendFailed"),
				message: err instanceof Error ? err.message : String(err),
				color: "red",
			});
		} finally {
			sendingRef.current = false;
			sendAbortRef.current = null;
			setSendingState(null);
		}
	};

	/**
	 * Default send action for the main send/queue button click.
	 * Follows the queue behavior bound to the Enter key (`enterQueueMode`).
	 */
	const handleSend = async () => {
		await handleSendWithMode(enterQueueMode);
	};
	const handleSendRef = useRef(handleSend);
	handleSendRef.current = handleSend;

	/**
	 * Submit externally-supplied text as a user message (the user-chat panel's
	 * "send to narrator").
	 *
	 * Routed through `doSendBuffered` — the composer's own send path — rather than
	 * calling the REST endpoint directly, so a forward that lands mid-turn is
	 * QUEUED exactly like anything typed here, and the draft / attachment
	 * bookkeeping stays consistent. The current draft is deliberately preserved:
	 * the forwarded text is its own message, not an edit of what the user was
	 * composing.
	 *
	 * ONE implementation shared by both hosts that offer forwarding: the dock
	 * bridge (`registerSubmitToNarrator`) and the mobile Drawer host's
	 * `onForwardToNarrator` prop. They must not diverge — a host that skipped the
	 * save/restore ritual below would send the user's in-progress draft and staged
	 * attachments out with the forwarded text, then commit an empty draft to the
	 * server.
	 */
	// attachedImagesRef/attachedTextFilesRef are stable RefObjects from
	// useComposerAttachments; their `.current` reads must not be deps.
	// biome-ignore lint/correctness/useExhaustiveDependencies: stable refs from hook
	const forwardTextToNarrator = useCallback(
		(text: string) => {
			const trimmed = text.trim();
			if (!trimmed) return;
			void (async () => {
				const preservedDraft = composerRef.current?.getText() ?? "";
				const preservedFileReferences = composerRef.current?.getFileReferences() ?? [];
				const preservedImages = attachedImagesRef.current;
				const preservedTextFiles = attachedTextFilesRef.current;
				try {
					// Forward-only send: no attachments, and the in-progress draft is put
					// back afterwards so the operator does not lose what they were typing.
					composerRef.current?.restoreInput(trimmed, []);
					updateAttachedImages([]);
					updateAttachedTextFiles([]);
					await doSendBufferedRef.current(trimmed, false);
				} catch (err) {
					notifications.show({
						color: "red",
						title: t("sendFailed", "Failed to send"),
						message: err instanceof Error ? err.message : "",
					});
				} finally {
					composerRef.current?.restoreInput(preservedDraft, preservedFileReferences);
					if (preservedImages.length > 0) updateAttachedImages(preservedImages);
					if (preservedTextFiles.length > 0) updateAttachedTextFiles(preservedTextFiles);
				}
			})();
		},
		[t, updateAttachedImages, updateAttachedTextFiles],
	);

	useEffect(() => {
		if (!registerSubmitToNarrator) return;
		return registerSubmitToNarrator(forwardTextToNarrator);
	}, [registerSubmitToNarrator, forwardTextToNarrator]);

	// The active queue button mirrors the keyboard shortcuts: a short press uses
	// Enter's mode, while a long press uses Ctrl/Cmd+Enter's mode.
	const handleSendWithModeRef = useRef(handleSendWithMode);
	handleSendWithModeRef.current = handleSendWithMode;
	// Stable entry points handed to <NarratorComposer>: it re-renders per
	// keystroke, so every prop must be referentially stable to keep its own
	// memoized children (popovers) from thrashing.
	const composerSendWithMode = useCallback((mode: "turn" | "tool" | "interrupt") => {
		void handleSendWithModeRef.current(mode);
	}, []);
	const ctrlEnterQueueModeRef = useRef(ctrlEnterQueueMode);
	ctrlEnterQueueModeRef.current = ctrlEnterQueueMode;

	const handleRetry = async () => {
		if (!canRetryLastUserMessage) return;
		try {
			await api.retryLastMessage(narratorId);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to retry";
			notifications.show({ title: "Error", message, color: "red" });
		}
	};

	const handleContinue = async () => {
		if (!canContinueNarrator) return;
		try {
			await api.continueNarrator(narratorId);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to continue";
			notifications.show({ title: "Error", message, color: "red" });
		}
	};

	return {
		sendingState,
		isSending,
		cancelSending,
		reportUploadProgress,
		handleSend,
		handleSendRef,
		handleSendWithModeRef,
		ctrlEnterQueueModeRef,
		composerSendWithMode,
		forwardTextToNarrator,
		handleRetry,
		handleContinue,
	};
}
