import { Box, Button, Group, Stack, Text, Textarea } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { MAX_NARRATOR_DRAFT_CHARS } from "@shared/narrator-limits";
import { useQueryClient } from "@tanstack/react-query";
import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { useNarratorCommands } from "../../hooks/useCommands";
import { useInputHistory, writeInputHistoryEntries } from "../../hooks/useInputHistory";
import { useNamedNarrators } from "../../hooks/useNamedNarrator";
import { ApiError, api } from "../../lib/api";
import { formatLocaleNumber } from "../../lib/intl-format";
import { CommandParamHelper } from "./CommandParamHelper";
import { type CommandItem, CommandPopover } from "./CommandPopover";
import { useNarratorDockContext } from "./dock/NarratorDockContext";
import { getMentionQuery, type MentionCandidate, MentionPopover } from "./MentionPopover";
import {
	classifyDraftRevisionConflict,
	cleanupLegacyNarratorInputStorage,
	getNarratorDraftStorageId,
	persistNarratorInputDraft,
	purgeLegacyNarratorInputStorage,
	readNarratorInputDraft,
	resolveHydratedNarratorDraft,
} from "./narrator-draft-storage";

const INPUT_DRAFT_SYNC_DEBOUNCE_MS = 800;

function createDraftSourceId(): string {
	return (
		globalThis.crypto?.randomUUID?.() ??
		`draft-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
}

function isDraftWithinSyncLimit(input: string): boolean {
	return input.length <= MAX_NARRATOR_DRAFT_CHARS;
}

/** Remote draft shape carried by the WS `draft_changed` event and 409 conflicts. */
export interface NarratorRemoteDraft {
	hasDraft: boolean;
	text: string;
	revision: number;
	updatedAt: string | null;
	updatedBy: string | null;
	sourceId: string | null;
}

export type ComposerQueueMode = "turn" | "tool" | "interrupt";

/**
 * Imperative surface the panel uses to drive the composer from its send/queue/
 * restore flows. Reads go through refs so they always see the latest value,
 * even synchronously after a `setText` within the same tick.
 */
export interface NarratorComposerHandle {
	/** Current raw textarea value (untrimmed). */
	getText(): string;
	/** True when the textarea holds no non-whitespace text (attachments not counted). */
	isTextEmpty(): boolean;
	/** True when `target` is this composer's textarea element. */
	ownsTextarea(target: unknown): boolean;
	focus(): void;
	setText(text: string): void;
	appendText(text: string): void;
	/** Clear the text and, when the draft link is ready, sync the empty draft. */
	clearTextAndDraft(): void;
	/** Clear only the on-screen text for an in-flight send; the draft record is
	 * left untouched so a failed send can restore it. */
	hideTextForSend(): void;
	/** Post-send draft bookkeeping (sync empty / adopt conflicting server draft). */
	commitDraftAfterSend(): void;
	/** Record a sent message in the up-arrow input history. */
	noteSent(text: string): void;
	/** Forward a WS `draft_changed` event into the draft state machine. */
	handleDraftChanged(draft: NarratorRemoteDraft): void;
}

export interface NarratorComposerProps {
	narratorId: string;
	/** Shared with the panel's send flow: draft sync must not fire mid-send. */
	sendingRef: React.RefObject<boolean>;
	/** External text-append bridge (e.g. "ask in passing" from a sibling panel). */
	appendInputRef?: React.MutableRefObject<((text: string) => void) | null>;
	/** True while a non-question pending permission owns the Enter key. */
	permEnterActive: boolean;
	/** Panel-owned attachment counts, for the Enter-key sendability gate. */
	hasAttachments: boolean;
	/** Queue modes bound to Enter / Ctrl(Cmd)+Enter. */
	enterMode: ComposerQueueMode;
	ctrlEnterMode: ComposerQueueMode;
	/** Panel send entry point; reads the text back via the handle. */
	onSendWithMode: (mode: ComposerQueueMode) => void;
	/** Fires only when the empty↔non-empty flag flips, never per keystroke. */
	onTextFlagsChange: (hasText: boolean) => void;
	/** Images pasted into the textarea; attachments are owned by the panel. */
	onPasteImages: (files: File[]) => void;
}

/**
 * The narrator chat text input and everything derived from it per keystroke:
 * draft hydration/sync/conflict, input history, slash-command and @mention
 * popovers, and the draft warning banners.
 *
 * WHY THIS EXISTS AS A SEPARATE COMPONENT
 * ---------------------------------------
 * `input` changes on every keystroke. When it lived in NarratorPanel, each
 * keystroke re-rendered the whole panel body (banners, toolbar, drawers, and —
 * via any unstable prop — the message list), which measured ~110ms per key in
 * a dev trace. Keeping the state here confines keystroke renders to this small
 * subtree; the panel learns nothing until the empty↔non-empty flag flips or a
 * send is requested.
 */
export const NarratorComposer = forwardRef<NarratorComposerHandle, NarratorComposerProps>(
	function NarratorComposer(
		{
			narratorId,
			sendingRef,
			appendInputRef,
			permEnterActive,
			hasAttachments,
			enterMode,
			ctrlEnterMode,
			onSendWithMode,
			onTextFlagsChange,
			onPasteImages,
		},
		ref,
	) {
		const { t } = useTranslation("narrator");
		const qc = useQueryClient();
		const { data: currentUser } = useCurrentUser();
		const currentUserId = currentUser?.id ? String(currentUser.id) : null;
		const dock = useNarratorDockContext();

		// --- Input management ---
		const [input, setInput] = useState("");
		const [draftHydrated, setDraftHydrated] = useState(false);
		const [draftSyncState, setDraftSyncState] = useState<
			"loading" | "ready" | "error" | "conflict"
		>("loading");
		const [draftLoadAttempt, setDraftLoadAttempt] = useState(0);
		const inputRef = useRef(input);
		inputRef.current = input;
		const draftSourceIdRef = useRef(createDraftSourceId());
		const lastSyncedDraftRef = useRef("");
		const lastDraftRevisionRef = useRef<number | null>(null);
		const lastDraftUpdatedAtRef = useRef<string | null>(null);
		const draftConflictRef = useRef<NarratorRemoteDraft | null>(null);
		const draftSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
		const draftSyncSeqRef = useRef(0);
		const textareaRef = useRef<HTMLTextAreaElement>(null);
		// null until the user is known: recall is keyed per `(user, narrator)`, and a
		// placeholder key would both consume a slot in the bounded history namespace and
		// strand whatever was typed before hydration in a list nothing reads again.
		const inputHistory = useInputHistory(
			currentUserId ? getNarratorDraftStorageId(currentUserId, narratorId) : null,
		);

		/** Set text and synchronously update the ref so same-tick readers see it. */
		const setText = useCallback((text: string) => {
			inputRef.current = text;
			setInput(text);
		}, []);

		const appendText = useCallback((text: string) => {
			setInput((prev) => {
				const next = prev ? `${prev}\n${text}` : text;
				inputRef.current = next;
				return next;
			});
		}, []);
		useEffect(() => {
			if (!currentUserId || !draftHydrated || sendingRef.current) return;
			persistNarratorInputDraft(
				currentUserId,
				narratorId,
				input,
				lastDraftRevisionRef.current,
				lastDraftUpdatedAtRef.current,
			);
		}, [currentUserId, draftHydrated, input, narratorId, sendingRef]);

		const syncDraftNow = useCallback(
			async (text: string, baseRevision = lastDraftRevisionRef.current) => {
				if (!currentUserId) throw new Error("Current user is unavailable");
				if (baseRevision == null) throw new Error("Draft has not been loaded from the server");
				if (!isDraftWithinSyncLimit(text)) {
					throw new Error(`Draft exceeds the ${MAX_NARRATOR_DRAFT_CHARS} character sync limit`);
				}
				if (draftSyncTimerRef.current) {
					clearTimeout(draftSyncTimerRef.current);
					draftSyncTimerRef.current = null;
				}
				const seq = ++draftSyncSeqRef.current;
				const sourceId = draftSourceIdRef.current;
				let revision = baseRevision;
				let retriedOwnRevision = false;
				while (true) {
					try {
						const result = await api.updateNarratorDraft(narratorId, text, revision, sourceId);
						if (seq === draftSyncSeqRef.current) {
							const newerConflict = draftConflictRef.current;
							if (newerConflict && newerConflict.revision > result.revision) return result;
							lastSyncedDraftRef.current = result.text;
							lastDraftRevisionRef.current = result.revision;
							lastDraftUpdatedAtRef.current = result.updatedAt;
							draftConflictRef.current = null;
							setDraftSyncState("ready");
							persistNarratorInputDraft(
								currentUserId,
								narratorId,
								inputRef.current,
								result.revision,
								result.updatedAt,
							);
							qc.setQueryData(
								["narrators", narratorId],
								(old: Record<string, unknown> | undefined) =>
									old ? { ...old, traits: result.traits, hasDraft: result.hasDraft } : old,
							);
						}
						return result;
					} catch (err) {
						const current =
							err instanceof ApiError && err.status === 409
								? (err.data?.current as
										| {
												hasDraft?: unknown;
												text?: unknown;
												revision?: unknown;
												updatedAt?: unknown;
												updatedBy?: unknown;
												sourceId?: unknown;
										  }
										| undefined)
								: undefined;
						if (
							current &&
							typeof current.text === "string" &&
							typeof current.revision === "number"
						) {
							const remote: NarratorRemoteDraft = {
								hasDraft: !!current.hasDraft,
								text: current.text,
								revision: current.revision,
								updatedAt: typeof current.updatedAt === "string" ? current.updatedAt : null,
								updatedBy: typeof current.updatedBy === "string" ? current.updatedBy : null,
								sourceId: typeof current.sourceId === "string" ? current.sourceId : null,
							};
							const action = classifyDraftRevisionConflict({
								requestSequence: seq,
								latestSequence: draftSyncSeqRef.current,
								requestSourceId: sourceId,
								currentSourceId: remote.sourceId,
							});
							if (action === "retry" && !retriedOwnRevision) {
								retriedOwnRevision = true;
								revision = remote.revision;
								continue;
							}
							if (action === "conflict") {
								draftConflictRef.current = remote;
								setDraftSyncState("conflict");
							}
						}
						throw err;
					}
				}
			},
			[currentUserId, narratorId, qc],
		);

		const clearTextAndDraft = useCallback(() => {
			inputRef.current = "";
			setInput("");
			if (draftSyncState === "ready") void syncDraftNow("").catch(() => {});
		}, [draftSyncState, syncDraftNow]);

		const hideTextForSend = useCallback(() => {
			inputRef.current = "";
			setInput("");
		}, []);

		// Reclaim pre-facade draft/history keys once per tab.
		//
		// Those keys were unbounded in count and up to 512k characters each, and
		// nothing ever enumerated the area to expire them — so a tab that already
		// accumulated dozens carries their quota cost until it is closed, which is the
		// state that made typing (and the desktop) stutter. The per-narrator cleanup in
		// the hydration effect below only reaches ids this tab happens to reopen, so a
		// sweep is what actually frees an already-degraded session.
		// Input history is MIGRATED rather than dropped: unlike a draft it has no server
		// copy, so deleting it would silently cost the user their up-arrow recall.
		useEffect(() => {
			purgeLegacyNarratorInputStorage(writeInputHistoryEntries);
		}, []);

		useEffect(() => {
			void draftLoadAttempt;
			if (!currentUserId) {
				setDraftHydrated(false);
				setDraftSyncState("loading");
				return;
			}
			let cancelled = false;
			setDraftHydrated(false);
			setDraftSyncState("loading");
			draftConflictRef.current = null;
			lastSyncedDraftRef.current = "";
			lastDraftRevisionRef.current = null;
			if (draftSyncTimerRef.current) {
				clearTimeout(draftSyncTimerRef.current);
				draftSyncTimerRef.current = null;
			}
			cleanupLegacyNarratorInputStorage(currentUserId, narratorId);
			const localDraft = readNarratorInputDraft(currentUserId, narratorId);
			lastDraftRevisionRef.current = localDraft.serverRevision;
			lastDraftUpdatedAtRef.current = localDraft.serverUpdatedAt;
			inputRef.current = localDraft.text;
			setInput(localDraft.text);
			setDraftHydrated(true);
			const localDraftAtRequest = localDraft.text;

			api
				.getNarratorDraft(narratorId)
				.then((draft) => {
					if (cancelled) return;
					const serverText = draft.hasDraft ? draft.text : "";
					const currentInput = inputRef.current;
					const resolved = resolveHydratedNarratorDraft({
						local: localDraft,
						serverText,
						serverRevision: draft.revision,
						currentInput,
						localChangedSinceRequest: currentInput !== localDraftAtRequest,
					});
					lastSyncedDraftRef.current = serverText;
					lastDraftRevisionRef.current = resolved.conflict
						? localDraft.serverRevision
						: draft.revision;
					lastDraftUpdatedAtRef.current = resolved.conflict
						? localDraft.serverUpdatedAt
						: draft.updatedAt;
					inputRef.current = resolved.text;
					setInput(resolved.text);
					persistNarratorInputDraft(
						currentUserId,
						narratorId,
						resolved.text,
						resolved.conflict ? localDraft.serverRevision : draft.revision,
						resolved.conflict ? localDraft.serverUpdatedAt : draft.updatedAt,
					);
					if (resolved.conflict) {
						draftConflictRef.current = draft;
						setDraftSyncState("conflict");
					} else {
						setDraftSyncState("ready");
					}
				})
				.catch(() => {
					if (!cancelled) setDraftSyncState("error");
				});
			return () => {
				cancelled = true;
			};
		}, [currentUserId, draftLoadAttempt, narratorId]);

		useEffect(() => {
			if (!draftHydrated || !currentUserId || draftSyncState !== "ready" || sendingRef.current)
				return;
			if (!isDraftWithinSyncLimit(input)) return;
			if (input === lastSyncedDraftRef.current) return;
			if (draftSyncTimerRef.current) clearTimeout(draftSyncTimerRef.current);
			draftSyncTimerRef.current = setTimeout(() => {
				draftSyncTimerRef.current = null;
				void syncDraftNow(inputRef.current).catch((err) => {
					if (import.meta.env.DEV) console.warn("[NarratorComposer] draft sync failed:", err);
				});
			}, INPUT_DRAFT_SYNC_DEBOUNCE_MS);
			return () => {
				if (draftSyncTimerRef.current) {
					clearTimeout(draftSyncTimerRef.current);
					draftSyncTimerRef.current = null;
				}
			};
		}, [currentUserId, draftHydrated, draftSyncState, input, syncDraftNow, sendingRef]);

		const retryDraftHydration = useCallback(() => {
			setDraftLoadAttempt((attempt) => attempt + 1);
		}, []);

		const acceptServerDraft = useCallback(() => {
			const remote = draftConflictRef.current;
			if (!remote || !currentUserId) return;
			const remoteText = remote.hasDraft ? remote.text : "";
			lastSyncedDraftRef.current = remoteText;
			lastDraftRevisionRef.current = remote.revision;
			lastDraftUpdatedAtRef.current = remote.updatedAt;
			draftConflictRef.current = null;
			inputRef.current = remoteText;
			setInput(remoteText);
			setDraftSyncState("ready");
			persistNarratorInputDraft(
				currentUserId,
				narratorId,
				remoteText,
				remote.revision,
				remote.updatedAt,
			);
		}, [currentUserId, narratorId]);

		const commitDraftAfterSend = useCallback(() => {
			if (draftSyncState === "ready") {
				setDraftSyncState("loading");
				void syncDraftNow("").catch(() => setDraftSyncState("error"));
			} else if (draftSyncState === "conflict") {
				// The local text was sent, but another client owns a newer draft. Keep that
				// remote draft rather than clearing it as a side effect of this send.
				acceptServerDraft();
			}
		}, [draftSyncState, syncDraftNow, acceptServerDraft]);

		const overwriteServerDraft = useCallback(() => {
			const remote = draftConflictRef.current;
			if (!remote) return;
			void syncDraftNow(inputRef.current, remote.revision).catch((err) => {
				notifications.show({
					title: t("draftSyncFailed"),
					message: err instanceof Error ? err.message : String(err),
					color: "red",
				});
			});
		}, [syncDraftNow, t]);

		const handleDraftChanged = useCallback(
			(draft: NarratorRemoteDraft) => {
				const currentRevision = lastDraftRevisionRef.current;
				if (currentRevision != null && draft.revision < currentRevision) return;
				const remoteText = draft.hasDraft ? draft.text : "";
				const hasLocalUnsyncedChanges = inputRef.current !== lastSyncedDraftRef.current;
				if (
					draft.sourceId !== draftSourceIdRef.current &&
					hasLocalUnsyncedChanges &&
					remoteText !== inputRef.current
				) {
					draftConflictRef.current = draft;
					setDraftSyncState("conflict");
					return;
				}
				lastSyncedDraftRef.current = remoteText;
				lastDraftRevisionRef.current = draft.revision;
				lastDraftUpdatedAtRef.current = draft.updatedAt;
				draftConflictRef.current = null;
				setDraftSyncState("ready");
				const shouldApplyRemote = draft.sourceId !== draftSourceIdRef.current;
				const nextInput = shouldApplyRemote ? remoteText : inputRef.current;
				if (currentUserId) {
					persistNarratorInputDraft(
						currentUserId,
						narratorId,
						nextInput,
						draft.revision,
						draft.updatedAt,
					);
				}
				if (shouldApplyRemote) {
					inputRef.current = remoteText;
					setInput(remoteText);
				}
			},
			[currentUserId, narratorId],
		);

		// --- Command popover ---
		// Only fetch commands when user starts typing "/" to avoid unnecessary API call on page load
		const { data: commandsList } = useNarratorCommands(
			input.startsWith("/") ? narratorId : undefined,
		);
		// Show command popover only when typing command name (no space yet),
		// or when typing optional tool sub-completion (/load <tool>, /unload <tool>).
		// Suppress when browsing input history so arrow keys keep navigating history.
		const commandPopoverVisible =
			input.startsWith("/") &&
			!input.includes("\n") &&
			(!input.includes(" ") ||
				// /load <tool>, /unload <tool>, and the skill sub-completions
				// (/load skill <name>, /unload all_skills, ...).
				/^\/(?:load|unload)\s(?:skill(?:\s\S*)?|\S*)$/i.test(input)) &&
			(commandsList?.length ?? 0) > 0 &&
			!inputHistory.isBrowsing;
		// Matched command for param helper (after space is typed)
		const matchedCommand = useMemo(() => {
			if (!input.startsWith("/") || !commandsList?.length) return null;
			const spaceIdx = input.indexOf(" ");
			if (spaceIdx === -1) return null;
			const cmdName = input.slice(1, spaceIdx);
			return (
				commandsList.find(
					(c) => c.name.toLowerCase() === cmdName.toLowerCase() && c.type === "command",
				) ?? null
			);
		}, [input, commandsList]);
		const handleCommandSelect = useCallback(
			(cmd: CommandItem) => {
				if (cmd.type === "skill") {
					// Skill selected — use /skill command so backend injects content directly
					setText(`/skill ${cmd.name} `);
				} else if (cmd.type === "tool" && !cmd.name.includes(" ")) {
					// Parent /load entry — expand to show sub-items
					setText(`/${cmd.name} `);
				} else {
					// Always keep command format — user can continue typing or press space for params
					setText(`/${cmd.name}`);
				}
			},
			[setText],
		);
		const closeCommandPopover = useCallback(() => {
			clearTextAndDraft();
		}, [clearTextAndDraft]);

		// === @mention of named narrators ===========================================
		const { data: namedNarrators } = useNamedNarrators();
		const [mentionCaret, setMentionCaret] = useState<number | null>(null);
		const mentionQuery = useMemo(() => {
			if (mentionCaret === null) return null;
			// Don't compete with the slash-command popover.
			if (input.startsWith("/")) return null;
			return getMentionQuery(input, mentionCaret);
		}, [input, mentionCaret]);
		const mentionCandidates = useMemo<MentionCandidate[]>(() => {
			if (!namedNarrators) return [];
			return namedNarrators
				.filter((n: { handle?: string | null }) => !!n.handle)
				.map((n: { id: string; handle: string; title?: string | null; status?: string }) => ({
					id: n.id,
					handle: n.handle,
					title: n.title,
					status: n.status,
				}));
		}, [namedNarrators]);
		const mentionPopoverVisible =
			mentionQuery !== null && !inputHistory.isBrowsing && mentionCandidates.length > 0;
		const handleMentionSelect = useCallback(
			(candidate: MentionCandidate) => {
				const caret = mentionCaret;
				if (caret === null) return;
				const upto = input.slice(0, caret);
				const at = upto.lastIndexOf("@");
				if (at === -1) return;
				const before = input.slice(0, at);
				const after = input.slice(caret);
				const insert = `@${candidate.handle} `;
				const next = before + insert + after;
				setText(next);
				// Move caret to just after the inserted handle.
				const nextCaret = before.length + insert.length;
				requestAnimationFrame(() => {
					const ta = textareaRef.current;
					if (ta) {
						ta.focus();
						ta.setSelectionRange(nextCaret, nextCaret);
					}
					setMentionCaret(nextCaret);
				});
			},
			[input, mentionCaret, setText],
		);
		const closeMentionPopover = useCallback(() => setMentionCaret(null), []);

		useEffect(() => {
			if (appendInputRef) {
				appendInputRef.current = appendText;
			}
			// In dock mode also register the appender so a sibling terminal panel can
			// push selected text into this chat input without a shared React parent.
			const unregister = dock?.registerAppendChatInput(appendText);
			return () => {
				if (appendInputRef) appendInputRef.current = null;
				unregister?.();
			};
		}, [appendInputRef, dock, appendText]);

		// Force react-textarea-autosize to recalculate after viewport width
		// changes (e.g. DevTools mobile↔desktop toggle). The library recalculates
		// on window "resize" but can read stale layout during rapid toggles.
		// Bumping a counter triggers a React re-render → useLayoutEffect inside
		// TextareaAutosize fires resizeTextarea() with the final layout values.
		const [, setTextareaResizeTick] = useState(0);
		useEffect(() => {
			const ta = textareaRef.current;
			if (!ta) return;
			let prevWidth = ta.clientWidth;
			let timer = 0;
			const ro = new ResizeObserver(() => {
				const w = ta.clientWidth;
				if (w !== prevWidth) {
					prevWidth = w;
					clearTimeout(timer);
					// Wait for layout to settle before triggering re-render
					timer = window.setTimeout(() => {
						setTextareaResizeTick((n) => n + 1);
					}, 100);
				}
			});
			ro.observe(ta);
			return () => {
				clearTimeout(timer);
				ro.disconnect();
			};
		}, []);

		// Report the empty↔non-empty transition upward (the panel's send-button
		// gating and permission Enter-hint need it), never the text itself.
		const hasText = input.trim().length > 0;
		useEffect(() => {
			onTextFlagsChange(hasText);
		}, [hasText, onTextFlagsChange]);

		const handlePaste = (e: React.ClipboardEvent) => {
			const items = e.clipboardData.items;
			const imageFiles: File[] = [];
			for (const item of items) {
				if (item.type.startsWith("image/")) {
					const file = item.getAsFile();
					if (file) imageFiles.push(file);
				}
			}
			if (imageFiles.length > 0) {
				onPasteImages(imageFiles);
			}
		};

		const handleKeyDown = (e: React.KeyboardEvent) => {
			// Let CommandPopover handle arrow/tab/escape keys when visible,
			// but still allow Enter to reach our send handler (CommandPopover
			// calls stopPropagation when it consumes Enter for selection).
			if (commandPopoverVisible && e.key !== "Enter") return;
			// Same for the @mention popover: it consumes arrow/tab/escape/enter via a
			// capture-phase listener; guard here so navigation keys don't double-handle.
			if (mentionPopoverVisible && e.key !== "Enter") return;

			if (e.key === "Enter" && !e.nativeEvent.isComposing) {
				// Permission shortcut: when the composer holds nothing to send and a
				// permission is pending, the panel's global keydown handler owns Enter.
				// preventDefault here to stop the textarea from inserting a newline.
				// Attachments count as content: an image-only draft falls through to
				// the send below.
				if (
					permEnterActive &&
					!hasText &&
					!hasAttachments &&
					!e.shiftKey &&
					!e.ctrlKey &&
					!e.metaKey
				) {
					e.preventDefault();
					return; // action handled by global handler
				}

				// Enter and Ctrl/Cmd+Enter each send with their own configured queue
				// behavior. Shift+Enter is left to the browser for a native newline.
				if (e.ctrlKey || e.metaKey) {
					if (!e.shiftKey) {
						e.preventDefault();
						onSendWithMode(ctrlEnterMode);
					}
				} else if (!e.shiftKey) {
					e.preventDefault();
					onSendWithMode(enterMode);
				}
				return;
			}
			// 上下箭头翻阅输入历史
			// 需要处理 soft-wrap（长文本自动折行）的情况：
			// 先让浏览器执行默认的光标移动，如果光标位置没变说明已在首/末视觉行，
			// 此时才触发历史导航。
			if (e.key === "ArrowUp" || e.key === "ArrowDown") {
				const textarea = e.currentTarget as HTMLTextAreaElement;
				const posBefore = textarea.selectionStart;
				const direction = e.key === "ArrowUp" ? "up" : "down";
				// 让浏览器先处理默认行为，下一帧再检查光标是否移动
				requestAnimationFrame(() => {
					const posAfter = textarea.selectionStart;
					if (posBefore !== posAfter) return; // 光标移动了，说明还在文本中间行
					const result = inputHistory.navigate(direction, inputRef.current);
					if (result !== null) {
						setText(result);
						// 将光标移到末尾
						requestAnimationFrame(() => {
							textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
						});
					}
				});
			}
		};

		useImperativeHandle(
			ref,
			(): NarratorComposerHandle => ({
				getText: () => inputRef.current,
				isTextEmpty: () => inputRef.current.trim().length === 0,
				ownsTextarea: (target) => target === textareaRef.current,
				focus: () => textareaRef.current?.focus(),
				setText,
				appendText,
				clearTextAndDraft,
				hideTextForSend,
				commitDraftAfterSend,
				noteSent: (text) => inputHistory.push(text),
				handleDraftChanged,
			}),
			[
				setText,
				appendText,
				clearTextAndDraft,
				hideTextForSend,
				commitDraftAfterSend,
				inputHistory,
				handleDraftChanged,
			],
		);

		return (
			<Box style={{ position: "relative", flex: 1 }}>
				<CommandPopover
					commands={commandsList ?? []}
					input={input}
					visible={commandPopoverVisible}
					onSelect={handleCommandSelect}
					onClose={closeCommandPopover}
				/>
				<MentionPopover
					candidates={mentionCandidates}
					query={mentionQuery}
					visible={mentionPopoverVisible}
					onSelect={handleMentionSelect}
					onClose={closeMentionPopover}
				/>
				{matchedCommand && (
					<CommandParamHelper
						command={matchedCommand}
						input={input}
						visible={!commandPopoverVisible}
					/>
				)}
				{draftSyncState === "error" && (
					<Group gap="xs" mb={4} wrap="nowrap">
						<Text size="xs" c="orange" style={{ flex: 1 }}>
							{t("draftLoadFailed")}
						</Text>
						<Button size="compact-xs" variant="light" onClick={retryDraftHydration}>
							{t("draftRetry")}
						</Button>
					</Group>
				)}
				{draftSyncState === "conflict" && (
					<Stack gap={4} mb={4}>
						<Text size="xs" c="orange">
							{t("draftConflict")}
						</Text>
						<Group gap="xs">
							<Button size="compact-xs" variant="light" onClick={acceptServerDraft}>
								{t("draftUseServer")}
							</Button>
							<Button size="compact-xs" color="orange" onClick={overwriteServerDraft}>
								{t("draftUseLocal")}
							</Button>
						</Group>
					</Stack>
				)}
				{!isDraftWithinSyncLimit(input) && (
					<Text size="xs" c="orange" mb={4}>
						{t("draftTooLong", {
							limit: formatLocaleNumber(MAX_NARRATOR_DRAFT_CHARS),
						})}
					</Text>
				)}
				<Textarea
					ref={textareaRef}
					placeholder={t("sendPlaceholder")}
					value={input}
					onChange={(e) => {
						setInput(e.currentTarget.value);
						setMentionCaret(e.currentTarget.selectionStart);
						inputHistory.reset();
					}}
					onKeyDown={handleKeyDown}
					onKeyUp={(e) => setMentionCaret(e.currentTarget.selectionStart)}
					onClick={(e) => setMentionCaret(e.currentTarget.selectionStart)}
					onBlur={() => setMentionCaret(null)}
					onPaste={handlePaste}
					autosize
					minRows={1}
					maxRows={6}
				/>
			</Box>
		);
	},
);
