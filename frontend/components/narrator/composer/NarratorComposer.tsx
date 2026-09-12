import { ActionIcon, Box, Button, Group, Stack, Text, Textarea, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import type { FileReference, FileReferenceCandidate } from "@shared/file-reference";
import { MAX_NARRATOR_DRAFT_CHARS } from "@shared/narrator-limits";
import { useQueryClient } from "@tanstack/react-query";
import {
	forwardRef,
	type RefObject,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../../hooks/useAuth";
import { useNarratorCommands } from "../../../hooks/useCommands";
import { useInputHistory, writeInputHistoryEntries } from "../../../hooks/useInputHistory";
import { useNamedNarrators } from "../../../hooks/useNamedNarrator";
import { usePromptOptimize } from "../../../hooks/usePromptOptimize";
import { ApiError, api } from "../../../lib/api";
import { narratorsApi } from "../../../lib/api/narrators";
import { formatLocaleNumber } from "../../../lib/intl-format";
import { useNarratorDockContext } from "../dock/NarratorDockContext";
import { CommandParamHelper } from "./CommandParamHelper";
import { type CommandItem, CommandPopover } from "./CommandPopover";
import { ComposerFullscreenModal } from "./ComposerFullscreenModal";
import { FileReferencePopover } from "./FileReferencePopover";
import { useFileReferenceScope } from "./FileReferenceScope";
import {
	copyFileReferences,
	editFileReferenceInput,
	type FileReferenceInput,
	fileReferenceKeyAction,
	getFileReferenceQuery,
	insertFileReference,
	readFileReferences,
	rememberFileReference,
	sameFileReferenceInput,
} from "./file-reference-input";
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
import { TextareaOptimizeControls } from "./TextareaOptimizeControls";

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
	fileReferences?: FileReference[];
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
	/** True when both text and file references are empty (other attachments are panel-owned). */
	isTextEmpty(): boolean;
	/** True when `target` is this composer's textarea element. */
	ownsTextarea(target: unknown): boolean;
	focus(): void;
	setText(text: string): void;
	getFileReferences(): FileReference[];
	setFileReferences(refs: FileReference[]): void;
	restoreInput(text: string, refs: FileReference[]): void;
	addFileReference(ref: FileReference): void;
	appendText(text: string): void;
	/** Clear text and references and, when ready, sync the empty draft tombstone. */
	clearTextAndDraft(): void;
	/** Clear only the on-screen text for an in-flight send; the draft record is
	 * left untouched so a failed send can restore it. */
	hideTextForSend(): void;
	/** Post-send draft bookkeeping (sync empty / adopt conflicting server draft). */
	commitDraftAfterSend(): void;
	/** Record a sent message in the up-arrow input history. */
	noteSent(text: string, refs?: FileReference[]): void;
	/** Forward a WS `draft_changed` event into the draft state machine. */
	handleDraftChanged(draft: NarratorRemoteDraft): void;
}

export interface NarratorComposerProps {
	narratorId: string;
	sendingRef: RefObject<boolean>;
	appendInputRef?: RefObject<((text: string) => void) | null>;
	permEnterActive: boolean;
	hasAttachments: boolean;
	enterMode: "turn" | "tool" | "interrupt";
	ctrlEnterMode: "turn" | "tool" | "interrupt";
	onSendWithMode: (mode: "turn" | "tool" | "interrupt") => void | Promise<void>;
	onTextFlagsChange: (has: boolean) => void;
	onPasteImages?: (files: File[]) => void;
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
		const fileScope = useFileReferenceScope();
		const fileCacheScope =
			currentUserId && fileScope.context
				? JSON.stringify([
						currentUserId,
						narratorId,
						fileScope.context.deviceId,
						fileScope.context.cwd,
					])
				: null;

		// Fullscreen modal state
		const [fullscreenOpened, { open: openFullscreen, close: closeFullscreen }] =
			useDisclosure(false);

		// Text and reference occurrences have one source of truth, local to this subtree.
		const [inputState, setInputState] = useState<FileReferenceInput>({
			text: "",
			fileReferences: [],
		});
		const { text: input, fileReferences } = inputState;
		const inputStateRef = useRef(inputState);
		const [draftHydrated, setDraftHydrated] = useState(false);
		const [draftSyncState, setDraftSyncState] = useState<
			"loading" | "ready" | "error" | "conflict"
		>("loading");
		const [draftLoadAttempt, setDraftLoadAttempt] = useState(0);
		const inputRef = useRef(input);
		const draftSourceIdRef = useRef(createDraftSourceId());
		const lastSyncedDraftRef = useRef<FileReferenceInput>({ text: "", fileReferences: [] });
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

		/** Synchronous ref updates make restore→send in the same tick atomic. */
		const applyInput = useCallback((next: FileReferenceInput) => {
			inputStateRef.current = next;
			inputRef.current = next.text;
			setInputState(next);
		}, []);
		const setText = useCallback(
			(text: string) => {
				applyInput(editFileReferenceInput(inputStateRef.current, text));
			},
			[applyInput],
		);
		const restoreInput = useCallback(
			(text: string, refs: FileReference[]) => {
				applyInput({ text, fileReferences: copyFileReferences(refs, text) });
			},
			[applyInput],
		);
		const setFileReferences = useCallback(
			(refs: FileReference[]) => {
				restoreInput(inputRef.current, refs);
			},
			[restoreInput],
		);
		const appendText = useCallback(
			(text: string) => {
				const previous = inputRef.current;
				setText(previous ? `${previous}\n${text}` : text);
			},
			[setText],
		);
		const addFileReference = useCallback(
			(reference: FileReference) => {
				try {
					const next = insertFileReference(inputStateRef.current, reference);
					applyInput(next);
					if (fileCacheScope) rememberFileReference(fileCacheScope, reference);
					requestAnimationFrame(() => {
						textareaRef.current?.focus();
						textareaRef.current?.setSelectionRange(next.caret, next.caret);
					});
				} catch (error) {
					notifications.show({
						title: t("fileReferences.addFailed", { defaultValue: "无法添加文件引用" }),
						message: error instanceof Error ? error.message : String(error),
						color: "red",
					});
				}
			},
			[applyInput, fileCacheScope, t],
		);

		// Prompt optimization hook
		const optimizeHook = usePromptOptimize({
			narratorId,
			textareaRef,
			onOptimized: (text) => {
				// Fallback: if execCommand fails, update state directly
				setText(text);
			},
		});

		useEffect(() => {
			if (!currentUserId || !draftHydrated || sendingRef.current) return;
			persistNarratorInputDraft(
				currentUserId,
				narratorId,
				input,
				lastDraftRevisionRef.current,
				lastDraftUpdatedAtRef.current,
				fileReferences,
			);
		}, [currentUserId, draftHydrated, input, fileReferences, narratorId, sendingRef]);

		const syncDraftNow = useCallback(
			async (
				text: string,
				baseRevision = lastDraftRevisionRef.current,
				references = inputStateRef.current.fileReferences,
			) => {
				const refs = copyFileReferences(references, text);
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
						const result = await api.updateNarratorDraft(
							narratorId,
							text,
							revision,
							sourceId,
							refs,
						);
						if (seq === draftSyncSeqRef.current) {
							const newerConflict = draftConflictRef.current;
							if (newerConflict && newerConflict.revision > result.revision) return result;
							lastSyncedDraftRef.current = {
								text: result.text,
								fileReferences: readFileReferences(result.fileReferences, result.text),
							};
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
								inputStateRef.current.fileReferences,
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
												fileReferences?: unknown;
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
								fileReferences: readFileReferences(current.fileReferences, current.text),
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
			restoreInput("", []);
			if (draftSyncState === "ready") void syncDraftNow("", undefined, []).catch(() => {});
		}, [draftSyncState, syncDraftNow, restoreInput]);

		const hideTextForSend = useCallback(() => {
			restoreInput("", []);
		}, [restoreInput]);

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
			// An old account/narrator's in-flight CAS must not overwrite the newly hydrated pair.
			draftSyncSeqRef.current++;
			if (!currentUserId) {
				setDraftHydrated(false);
				setDraftSyncState("loading");
				return;
			}
			let cancelled = false;
			setDraftHydrated(false);
			setDraftSyncState("loading");
			draftConflictRef.current = null;
			lastSyncedDraftRef.current = { text: "", fileReferences: [] };
			lastDraftRevisionRef.current = null;
			if (draftSyncTimerRef.current) {
				clearTimeout(draftSyncTimerRef.current);
				draftSyncTimerRef.current = null;
			}
			cleanupLegacyNarratorInputStorage(currentUserId, narratorId);
			const localDraft = readNarratorInputDraft(currentUserId, narratorId);
			lastDraftRevisionRef.current = localDraft.serverRevision;
			lastDraftUpdatedAtRef.current = localDraft.serverUpdatedAt;
			restoreInput(localDraft.text, localDraft.fileReferences ?? []);
			setDraftHydrated(true);
			const localDraftAtRequest = inputStateRef.current;

			api
				.getNarratorDraft(narratorId)
				.then((draft) => {
					if (cancelled) return;
					const serverText = draft.hasDraft ? draft.text : "";
					const serverFileReferences = draft.hasDraft
						? readFileReferences(draft.fileReferences, serverText)
						: [];
					const currentInput = inputRef.current;
					const resolved = resolveHydratedNarratorDraft({
						local: localDraft,
						serverText,
						serverFileReferences,
						serverRevision: draft.revision,
						currentInput,
						currentFileReferences: inputStateRef.current.fileReferences,
						localChangedSinceRequest: !sameFileReferenceInput(
							inputStateRef.current,
							localDraftAtRequest,
						),
					});
					lastSyncedDraftRef.current = { text: serverText, fileReferences: serverFileReferences };
					lastDraftRevisionRef.current = resolved.conflict
						? localDraft.serverRevision
						: draft.revision;
					lastDraftUpdatedAtRef.current = resolved.conflict
						? localDraft.serverUpdatedAt
						: draft.updatedAt;
					restoreInput(resolved.text, resolved.fileReferences ?? []);
					persistNarratorInputDraft(
						currentUserId,
						narratorId,
						resolved.text,
						resolved.conflict ? localDraft.serverRevision : draft.revision,
						resolved.conflict ? localDraft.serverUpdatedAt : draft.updatedAt,
						resolved.fileReferences ?? [],
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
		}, [currentUserId, draftLoadAttempt, narratorId, restoreInput]);

		useEffect(() => {
			if (!draftHydrated || !currentUserId || draftSyncState !== "ready" || sendingRef.current)
				return;
			if (!isDraftWithinSyncLimit(input)) return;
			if (sameFileReferenceInput(inputState, lastSyncedDraftRef.current)) return;
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
		}, [currentUserId, draftHydrated, draftSyncState, input, inputState, syncDraftNow, sendingRef]);

		const retryDraftHydration = useCallback(() => {
			setDraftLoadAttempt((attempt) => attempt + 1);
		}, []);

		const acceptServerDraft = useCallback(() => {
			const remote = draftConflictRef.current;
			if (!remote || !currentUserId) return;
			const remoteText = remote.hasDraft ? remote.text : "";
			const refs = remote.hasDraft ? readFileReferences(remote.fileReferences, remoteText) : [];
			lastSyncedDraftRef.current = { text: remoteText, fileReferences: refs };
			lastDraftRevisionRef.current = remote.revision;
			lastDraftUpdatedAtRef.current = remote.updatedAt;
			draftConflictRef.current = null;
			restoreInput(remoteText, refs);
			setDraftSyncState("ready");
			persistNarratorInputDraft(
				currentUserId,
				narratorId,
				remoteText,
				remote.revision,
				remote.updatedAt,
				refs,
			);
		}, [currentUserId, narratorId, restoreInput]);

		const commitDraftAfterSend = useCallback(() => {
			if (draftSyncState === "ready") {
				setDraftSyncState("loading");
				void syncDraftNow("", undefined, []).catch(() => setDraftSyncState("error"));
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
				const remoteRefs = draft.hasDraft
					? readFileReferences(draft.fileReferences, remoteText)
					: [];
				const remoteInput = { text: remoteText, fileReferences: remoteRefs };
				const hasLocalUnsyncedChanges = !sameFileReferenceInput(
					inputStateRef.current,
					lastSyncedDraftRef.current,
				);
				if (
					draft.sourceId !== draftSourceIdRef.current &&
					hasLocalUnsyncedChanges &&
					!sameFileReferenceInput(remoteInput, inputStateRef.current)
				) {
					draftConflictRef.current = draft;
					setDraftSyncState("conflict");
					return;
				}
				lastSyncedDraftRef.current = remoteInput;
				lastDraftRevisionRef.current = draft.revision;
				lastDraftUpdatedAtRef.current = draft.updatedAt;
				draftConflictRef.current = null;
				setDraftSyncState("ready");
				const shouldApplyRemote = draft.sourceId !== draftSourceIdRef.current;
				const nextInput = shouldApplyRemote ? remoteInput : inputStateRef.current;
				if (currentUserId) {
					persistNarratorInputDraft(
						currentUserId,
						narratorId,
						nextInput.text,
						draft.revision,
						draft.updatedAt,
						nextInput.fileReferences,
					);
				}
				if (shouldApplyRemote) restoreInput(remoteText, remoteRefs);
			},
			[currentUserId, narratorId, restoreInput],
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

		const [dismissedFileQuery, setDismissedFileQuery] = useState<string | null>(null);
		const fileQuery = useMemo(() => {
			if (mentionCaret === null || input.startsWith("/") || inputHistory.isBrowsing) return null;
			const query = getFileReferenceQuery(input, mentionCaret, fileReferences);
			return query && JSON.stringify([input, mentionCaret]) !== dismissedFileQuery ? query : null;
		}, [input, mentionCaret, fileReferences, inputHistory.isBrowsing, dismissedFileQuery]);
		const closeFilePopover = useCallback(() => {
			setDismissedFileQuery(
				JSON.stringify([inputRef.current, textareaRef.current?.selectionStart]),
			);
		}, []);
		const moveFileCaret = useCallback((caret: number) => {
			requestAnimationFrame(() => {
				textareaRef.current?.focus();
				textareaRef.current?.setSelectionRange(caret, caret);
				setMentionCaret(caret);
			});
		}, []);
		const handleFileSelect = useCallback(
			(reference: FileReference) => {
				if (!fileQuery) return;
				try {
					const next = insertFileReference(inputStateRef.current, reference, [
						fileQuery.start,
						fileQuery.end,
					]);
					applyInput(next);
					if (fileCacheScope) rememberFileReference(fileCacheScope, reference);
					moveFileCaret(next.caret);
				} catch (error) {
					notifications.show({
						title: t("fileReferences.addFailed", { defaultValue: "无法添加文件引用" }),
						message: error instanceof Error ? error.message : String(error),
						color: "red",
					});
				}
			},
			[fileQuery, applyInput, fileCacheScope, moveFileCaret, t],
		);
		const handleFileNavigate = useCallback(
			(candidate: FileReferenceCandidate) => {
				if (!fileQuery) return;
				const prefix = `#${candidate.relativePath.replace(/[\\/]+$/, "")}/`;
				setText(
					inputRef.current.slice(0, fileQuery.start) +
						prefix +
						inputRef.current.slice(fileQuery.end),
				);
				moveFileCaret(fileQuery.start + prefix.length);
			},
			[fileQuery, setText, moveFileCaret],
		);
		useEffect(() => dock?.registerAddFileReference?.(addFileReference), [dock, addFileReference]);

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
		const hasText = input.trim().length > 0 || fileReferences.length > 0;
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
				onPasteImages?.(imageFiles);
			}
		};

		// Enter outside interactive controls returns focus to this visible chat input.
		useEffect(() => {
			const textarea = textareaRef.current;
			if (!textarea || permEnterActive) return;
			const doc = textarea.ownerDocument;
			const handler = (e: KeyboardEvent) => {
				if (
					e.key !== "Enter" ||
					e.defaultPrevented ||
					e.repeat ||
					e.isComposing ||
					e.keyCode === 229 ||
					e.shiftKey ||
					e.ctrlKey ||
					e.metaKey ||
					e.altKey ||
					textarea.disabled ||
					textarea.getClientRects().length === 0
				)
					return;
				const target = e.target instanceof Element ? e.target : null;
				if (
					target?.closest(
						'input, textarea, select, button, a[href], summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], .xterm',
					) ||
					doc.querySelector('[aria-modal="true"]')
				)
					return;
				const panel = textarea.closest("[data-narrator-panel]");
				if (target && target !== doc.body && target !== doc.documentElement) {
					if (!panel?.contains(target)) return;
				} else {
					// Multiple chats can be visible in the workspace: don't pick one arbitrarily.
					const visible = Array.from(doc.querySelectorAll("[data-narrator-composer]")).filter(
						(node) => node.getClientRects().length > 0,
					);
					if (visible.length !== 1 || visible[0] !== textarea) return;
				}
				e.preventDefault();
				textarea.focus();
			};
			doc.defaultView?.addEventListener("keydown", handler);
			return () => doc.defaultView?.removeEventListener("keydown", handler);
		}, [permEnterActive]);

		const composingRef = useRef(false);
		const beforeEditRef = useRef<{ start: number; end: number } | undefined>(undefined);
		const handleKeyDown = (e: React.KeyboardEvent) => {
			if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || composingRef.current)
				return;
			if (fileQuery && fileReferenceKeyAction(e.nativeEvent)) {
				// The scoped capture listener owns these keys, including empty/loading results.
				e.preventDefault();
				e.stopPropagation();
				return;
			}
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
					const result = inputHistory.navigateEntry(
						direction,
						inputRef.current,
						inputStateRef.current.fileReferences,
					);
					if (result !== null) {
						restoreInput(result.text, result.fileReferences);
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
				isTextEmpty: () =>
					inputRef.current.trim().length === 0 && inputStateRef.current.fileReferences.length === 0,
				ownsTextarea: (target) => target === textareaRef.current,
				focus: () => textareaRef.current?.focus(),
				setText,
				getFileReferences: () => copyFileReferences(inputStateRef.current.fileReferences),
				setFileReferences,
				restoreInput,
				addFileReference,
				appendText,
				clearTextAndDraft,
				hideTextForSend,
				commitDraftAfterSend,
				noteSent: (text, refs) => inputHistory.push(text, refs),
				handleDraftChanged,
			}),
			[
				setText,
				setFileReferences,
				restoreInput,
				addFileReference,
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
				<FileReferencePopover
					narratorId={narratorId}
					context={fileScope.context}
					cacheScope={fileCacheScope}
					query={fileQuery}
					selection={
						fileScope.selection !== undefined ? fileScope.selection : dock?.fileReferenceSelection
					}
					textareaRef={textareaRef}
					onSelect={handleFileSelect}
					onNavigate={handleFileNavigate}
					onClose={closeFilePopover}
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
				{fileReferences
					.filter((reference) => !reference.inputRange)
					.map((reference) => (
						<Group key={reference.id} gap="xs" mb={4} wrap="nowrap">
							<Text size="xs" truncate style={{ flex: 1 }}>
								{reference.deviceId} · {reference.label}
							</Text>
							<Button
								size="compact-xs"
								variant="subtle"
								onClick={() =>
									setFileReferences(
										inputStateRef.current.fileReferences.filter((item) => item.id !== reference.id),
									)
								}
							>
								{t("fileReferences.remove", { defaultValue: "移除引用" })}
							</Button>
						</Group>
					))}
				<Textarea
					ref={textareaRef}
					data-narrator-composer
					placeholder={t("sendPlaceholder")}
					value={input}
					onBeforeInput={(e) => {
						beforeEditRef.current = {
							start: e.currentTarget.selectionStart,
							end: e.currentTarget.selectionEnd,
						};
					}}
					onChange={(e) => {
						applyInput(
							editFileReferenceInput(
								inputStateRef.current,
								e.currentTarget.value,
								beforeEditRef.current,
							),
						);
						beforeEditRef.current = undefined;
						setDismissedFileQuery(null);
						setMentionCaret(e.currentTarget.selectionStart);
						inputHistory.reset();
					}}
					onCompositionStart={() => {
						composingRef.current = true;
					}}
					onCompositionEnd={() => {
						composingRef.current = false;
					}}
					onKeyDown={handleKeyDown}
					onKeyUp={(e) => setMentionCaret(e.currentTarget.selectionStart)}
					onClick={(e) => setMentionCaret(e.currentTarget.selectionStart)}
					onBlur={() => setMentionCaret(null)}
					onPaste={handlePaste}
					autosize
					minRows={1}
					maxRows={6}
					rightSection={
						<TextareaOptimizeControls
							disabled={!input.trim() || optimizeHook.loading}
							loading={optimizeHook.loading}
							withContext={optimizeHook.withContext}
							onToggleContext={optimizeHook.toggleContext}
							onOptimize={optimizeHook.handleOptimize}
							onExpand={openFullscreen}
							contextMessageCount={optimizeHook.contextMessageCount}
							onContextMessageCountChange={optimizeHook.setContextMessageCount}
						/>
					}
					rightSectionWidth="auto"
					styles={{
						section: {
							alignItems: "center",
							paddingRight: 8,
						},
					}}
				/>
				<ComposerFullscreenModal
					opened={fullscreenOpened}
					onClose={closeFullscreen}
					initialText={input}
					onSubmit={(text) => {
						setText(text);
						closeFullscreen();
						requestAnimationFrame(() => textareaRef.current?.focus());
					}}
					optimizeHook={optimizeHook}
					narratorId={narratorId}
				/>
			</Box>
		);
	},
);
