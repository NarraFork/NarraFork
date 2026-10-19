import { Box, Button, Group, Stack, Text } from "@mantine/core";
import { useDisclosure, useFocusTrap } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
	type ComposerDocument,
	type ComposerInlineNode,
	composerDocumentText,
	parseComposerDocument,
	readComposerDocument,
} from "@shared/composer-document";
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
import { formatLocaleNumber } from "../../../lib/intl-format";
import { shouldFallbackPanelState } from "../../../lib/narrator-panel-state";
import { useImageViewer } from "../../common/image-viewer-context";
import { useNarratorDockContext } from "../dock/NarratorDockContext";
import { CommandParamHelper } from "./CommandParamHelper";
import { type CommandItem, CommandPopover } from "./CommandPopover";
import {
	composerAssetsFromFiles,
	composerInputFromDocument,
	composerNodeId,
	importComposerInput,
	missingComposerAssets,
} from "./composer-document-adapter";
import { getComposerFileOrder } from "./composer-file-order";
import { composerOptimizeTarget } from "./composer-optimize-target";
import { joinQuotedComposerInput, MAX_COMPOSER_QUOTES } from "./composer-quotes";
import { getComposerAssetId } from "./draft-image-attachments";
import { FileReferencePopover } from "./FileReferencePopover";
import { useFileReferenceScope } from "./FileReferenceScope";
import {
	copyFileReferences,
	editFileReferenceInput,
	type FileReferenceInput,
	fileReferenceKeyAction,
	getFileReferenceQuery,
	readFileReferences,
	rememberFileReference,
	sameFileReferenceInput,
} from "./file-reference-input";
import { InlineComposerEditor, type InlineComposerEditorHandle } from "./InlineComposerEditor";
import { InlineQuoteCandidate } from "./InlineQuoteCandidate";
import { getMentionQuery, type MentionCandidate, MentionPopover } from "./MentionPopover";
import classes from "./NarratorComposer.module.css";
import {
	canHydrateNarratorDraftFromMeta,
	classifyDraftRevisionConflict,
	cleanupLegacyNarratorInputStorage,
	getNarratorDraftStorageId,
	isAcknowledgedNarratorDraft,
	persistNarratorInputDraft,
	purgeLegacyNarratorInputStorage,
	readNarratorInputDraft,
	resolveHydratedNarratorDraft,
} from "./narrator-draft-storage";
import { revealComposerQuote, revealQuotedFile } from "./quote-jump";
import { TextareaOptimizeControls } from "./TextareaOptimizeControls";
import { type QuoteCandidate, useQuoteCandidate } from "./use-quote-candidate";

const INPUT_DRAFT_SYNC_DEBOUNCE_MS = 800;
const EMPTY_FILES: File[] = [];

function createDraftSourceId(): string {
	return (
		globalThis.crypto?.randomUUID?.() ??
		`draft-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
}

function isDraftWithinSyncLimit(input: string): boolean {
	return input.length <= MAX_NARRATOR_DRAFT_CHARS;
}

function splitDocumentInput(document: ComposerDocument) {
	// The model prefix is a projection of quote atoms, not a second parser for literal text.
	// A quote-looking text node after a real quote must remain in the editable body.
	const quotes = document.paragraphs.flatMap((paragraph) =>
		paragraph.children.filter((node) => node.type === "quote"),
	);
	const bodyDocument: ComposerDocument = {
		...document,
		paragraphs: document.paragraphs.map((paragraph) => ({
			children: paragraph.children.filter((node) => node.type !== "quote"),
		})),
	};
	return { quotes, body: composerDocumentText(bodyDocument) };
}

export interface NarratorRemoteDraft {
	hasDraft: boolean;
	text: string;
	fileReferences?: FileReference[];
	composerDocument?: ComposerDocument;
	hasComposerDocument?: boolean;
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
	getDocument(): ComposerDocument | undefined;
	hasMissingAssets(): boolean;
	captureAttachmentSelection(): void;
	captureAttachmentInsertion(
		origin: "picker" | "paste" | "drop" | "direct",
	): ReturnType<InlineComposerEditorHandle["captureSelectionBookmark"]> | undefined;
	insertAcceptedFiles(
		files: File[],
		bookmark?: ReturnType<InlineComposerEditorHandle["captureSelectionBookmark"]>,
	): boolean;
	/** True when both text and file references are empty (other attachments are panel-owned). */
	isTextEmpty(): boolean;
	/** True when `target` is this composer's textarea element. */
	ownsTextarea(target: unknown): boolean;
	focus(): void;
	setText(text: string): void;
	getFileReferences(): FileReference[];
	setFileReferences(refs: FileReference[]): void;
	restoreInput(text: string, refs: FileReference[], document?: ComposerDocument): void;
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
	noteSent(text: string, refs?: FileReference[], document?: ComposerDocument): void;
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
	attachedImages?: File[];
	attachedTextFiles?: File[];
	attachmentsHydrating?: boolean;
	attachmentsRestoreFailed?: boolean;
	onRetryAttachments?: () => void;
	restoredAttachmentResources?: ReadonlyMap<string, File>;
	onAttachmentsChange?: (images: File[], textFiles: File[]) => void;
	onDocumentAssetsChange?: (ids: readonly string[]) => void;
	controls?: React.ReactNode;
	actions?: React.ReactNode;
	sending?: boolean;
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
			attachedImages = EMPTY_FILES,
			attachedTextFiles = EMPTY_FILES,
			attachmentsHydrating = false,
			attachmentsRestoreFailed = false,
			onRetryAttachments,
			restoredAttachmentResources,
			onAttachmentsChange,
			onDocumentAssetsChange,
			controls,
			actions,
			sending = false,
		},
		ref,
	) {
		const { t } = useTranslation("narrator");
		const qc = useQueryClient();
		const { data: currentUser } = useCurrentUser();
		const currentUserId = currentUser?.id ? String(currentUser.id) : null;
		const currentDraftScope = currentUserId
			? getNarratorDraftStorageId(currentUserId, narratorId)
			: null;
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
		const fullscreenTrap = useFocusTrap(fullscreenOpened);
		useEffect(() => {
			if (!fullscreenOpened) return;
			const owner = textareaRef.current?.ownerDocument;
			const close = (event: KeyboardEvent) => {
				if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
				// Popovers own their first Escape. Otherwise intercept before ProseMirror's
				// native Escape/select-parent handler can stop the bubbling event.
				if (
					Array.from(owner?.querySelectorAll('[role="menu"], [role="listbox"]') ?? []).some(
						(menu) => menu.getClientRects().length > 0,
					)
				)
					return;
				event.preventDefault();
				event.stopPropagation();
				closeFullscreen();
			};
			owner?.addEventListener("keydown", close, true);
			return () => owner?.removeEventListener("keydown", close, true);
		}, [fullscreenOpened, closeFullscreen]);

		// Text and reference occurrences have one source of truth, local to this subtree.
		const [inputState, setInputState] = useState<FileReferenceInput>({
			text: "",
			fileReferences: [],
		});
		const { text: input, fileReferences } = inputState;
		const document = useMemo(() => importComposerInput(inputState), [inputState]);
		// Leading quote blocks are shown as chips; the textarea and its popovers
		// only ever see the body after them (see composer-quotes.ts).
		const { quotes, body: bodyInput } = useMemo(() => splitDocumentInput(document), [document]);
		const bodyText = bodyInput.text;
		const inputStateRef = useRef(inputState);
		const [draftHydrated, setDraftHydrated] = useState(false);
		const [draftSyncState, setDraftSyncState] = useState<
			"loading" | "ready" | "error" | "conflict"
		>("loading");
		const [draftLoadAttempt, setDraftLoadAttempt] = useState(0);
		const inputRef = useRef(input);
		const draftSourceIdRef = useRef(createDraftSourceId());
		const lastSyncedDraftRef = useRef<FileReferenceInput | null>(null);
		// Unknown local snapshots can detect edits, but cannot serve as acknowledged baselines.
		const unacknowledgedDraftRef = useRef<{
			input: FileReferenceInput;
			unsynced: boolean;
		} | null>(null);
		const lastDraftRevisionRef = useRef<number | null>(null);
		const lastDraftUpdatedAtRef = useRef<string | null>(null);
		const draftConflictRef = useRef<NarratorRemoteDraft | null>(null);
		const draftSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
		const draftSyncSeqRef = useRef(0);
		const draftReadEpochRef = useRef(0);
		const draftOwnerScopeRef = useRef<string | null>(null);
		const textareaRef = useRef<HTMLDivElement>(null);
		const editorRef = useRef<InlineComposerEditorHandle>(null);
		const [editorElement, setEditorElement] = useState<HTMLDivElement | null>(null);
		const [editorFocused, setEditorFocused] = useState(false);
		useEffect(() => {
			editorElement?.setAttribute("data-narrator-composer", narratorId);
		}, [editorElement, narratorId]);
		const openImageViewer = useImageViewer();
		const previewURLsRef = useRef(new Map<File, string>());
		useEffect(() => {
			if (!currentDraftScope) return;
			const urls = previewURLsRef.current;
			return () => {
				for (const url of urls.values()) URL.revokeObjectURL(url);
				urls.clear();
			};
		}, [currentDraftScope]);
		// The live resource cache outlives node deletion so undo can restore its File.
		const resourceCacheRef = useRef(new Map<string, File>());
		const resourceOwnerRef = useRef(currentDraftScope);
		const authoritativeAssetsRef = useRef<Set<string> | null>(null);
		const attachmentRecoveryRef = useRef({ attachmentsHydrating, attachmentsRestoreFailed });
		attachmentRecoveryRef.current = { attachmentsHydrating, attachmentsRestoreFailed };
		const hasUnconfirmedLegacyAttachments = useCallback(
			() =>
				authoritativeAssetsRef.current === null &&
				(attachmentRecoveryRef.current.attachmentsHydrating ||
					attachmentRecoveryRef.current.attachmentsRestoreFailed),
			[],
		);
		const readPersistableDocument = useCallback(
			(value: ComposerDocument | null | undefined) =>
				hasUnconfirmedLegacyAttachments() ? undefined : (value ?? undefined),
			[hasUnconfirmedLegacyAttachments],
		);
		if (resourceOwnerRef.current !== currentDraftScope) {
			resourceCacheRef.current.clear();
			authoritativeAssetsRef.current = null;
			resourceOwnerRef.current = currentDraftScope;
		}
		// Successfully recovered but deleted files stay available to this owner's undo history.
		// They are not live attachments and never drive legacy adoption or persistence by themselves.
		for (const [id, file] of restoredAttachmentResources ?? [])
			if (!resourceCacheRef.current.has(id)) resourceCacheRef.current.set(id, file);
		for (const file of [...attachedImages, ...attachedTextFiles])
			resourceCacheRef.current.set(getComposerAssetId(file), file);
		const resources = new Map(resourceCacheRef.current);
		const documentRef = useRef(document);
		documentRef.current = document;
		const releaseUnusedResources = useCallback(() => {
			const keep = new Set(documentRef.current.assets.map((asset) => asset.id));
			for (const [id, file] of resourceCacheRef.current) {
				if (keep.has(id)) continue;
				resourceCacheRef.current.delete(id);
				const url = previewURLsRef.current.get(file);
				if (url) URL.revokeObjectURL(url);
				previewURLsRef.current.delete(file);
			}
		}, []);
		const pickerBookmarkRef = useRef<ReturnType<
			InlineComposerEditorHandle["captureSelectionBookmark"]
		> | null>(null);
		const reconcileAssetsRef = useRef(onDocumentAssetsChange);
		reconcileAssetsRef.current = onDocumentAssetsChange;
		useEffect(() => {
			void currentDraftScope; // A different owner must not inherit an open file picker's bookmark.
			return () => {
				pickerBookmarkRef.current?.cancel();
				pickerBookmarkRef.current = null;
			};
		}, [currentDraftScope]);
		const attachmentStateRef = useRef({
			images: attachedImages,
			textFiles: attachedTextFiles,
			onChange: onAttachmentsChange,
		});
		attachmentStateRef.current = {
			images: attachedImages,
			textFiles: attachedTextFiles,
			onChange: onAttachmentsChange,
		};
		// null until the user is known: recall is keyed per `(user, narrator)`, and a
		// placeholder key would both consume a slot in the bounded history namespace and
		// strand whatever was typed before hydration in a list nothing reads again.
		const inputHistory = useInputHistory(
			currentUserId ? getNarratorDraftStorageId(currentUserId, narratorId) : null,
		);

		const declareDocumentAssets = useCallback((ids: readonly string[]) => {
			authoritativeAssetsRef.current = new Set(ids);
			reconcileAssetsRef.current?.(ids);
		}, []);

		/** Synchronous ref updates make restore→send in the same tick atomic. */
		const applyInput = useCallback((next: FileReferenceInput) => {
			const nextDocument = importComposerInput(next);
			inputStateRef.current = next;
			inputRef.current = next.text;
			documentRef.current = nextDocument;
			setInputState(next);
		}, []);
		const setText = useCallback(
			(text: string) => {
				applyInput(editFileReferenceInput(inputStateRef.current, text));
			},
			[applyInput],
		);
		const readQuotedInput = useCallback(() => splitDocumentInput(documentRef.current), []);
		const applyBody = useCallback(
			(body: FileReferenceInput) => {
				applyInput(joinQuotedComposerInput(readQuotedInput().quotes, body));
			},
			[applyInput, readQuotedInput],
		);
		const setBodyText = useCallback(
			(text: string) => {
				const previous = readQuotedInput().body.text;
				if (previous === text) return;
				if (editorRef.current) {
					let start = 0;
					while (start < previous.length && start < text.length && previous[start] === text[start])
						start++;
					let end = previous.length;
					let nextEnd = text.length;
					while (end > start && nextEnd > start && previous[end - 1] === text[nextEnd - 1]) {
						end--;
						nextEnd--;
					}
					editorRef.current.setSelection(start, end);
					editorRef.current.insertNodes(
						text.slice(start, nextEnd) ? [{ type: "text", text: text.slice(start, nextEnd) }] : [],
					);
				} else applyBody(editFileReferenceInput(readQuotedInput().body, text));
			},
			[applyBody, readQuotedInput],
		);
		const restoreInput = useCallback(
			(text: string, refs: FileReference[], composerDocument?: ComposerDocument) => {
				const next = { text, fileReferences: copyFileReferences(refs, text), composerDocument };
				// Validate/apply before committing refs: a failed restore must keep the local draft intact.
				const restored = parseComposerDocument(importComposerInput(next));
				editorRef.current?.setDocument(restored);
				applyInput(next);
				// Local acknowledged snapshots need the same ownership contract as remote detail.
				// An absent legacy layout is still unknown until its old blobs have been imported.
				if (readComposerDocument(composerDocument))
					declareDocumentAssets(restored.assets.map((asset) => asset.id));
			},
			[applyInput, declareDocumentAssets],
		);
		/** Remote documents are authoritative about membership, not just text/layout. */
		const restoreRemoteInput = useCallback(
			(text: string, refs: FileReference[], composerDocument?: ComposerDocument) => {
				restoreInput(text, refs, composerDocument);
				const ids = composerDocument?.assets.map((asset) => asset.id) ?? [];
				declareDocumentAssets(ids);
				if (!reconcileAssetsRef.current) {
					const keep = new Set(ids);
					const current = attachmentStateRef.current;
					const images = current.images.filter((file) => keep.has(getComposerAssetId(file)));
					const textFiles = current.textFiles.filter((file) => keep.has(getComposerAssetId(file)));
					if (
						images.length !== current.images.length ||
						textFiles.length !== current.textFiles.length
					)
						current.onChange?.(images, textFiles);
				}
			},
			[restoreInput, declareDocumentAssets],
		);
		const captureAttachmentSelection = useCallback(() => {
			pickerBookmarkRef.current?.cancel();
			pickerBookmarkRef.current = editorRef.current?.captureSelectionBookmark() ?? null;
		}, []);
		const captureAttachmentInsertion = useCallback(
			(origin: "picker" | "paste" | "drop" | "direct") => {
				const pending = pickerBookmarkRef.current;
				pickerBookmarkRef.current = null;
				if (origin === "picker" && pending) return pending;
				pending?.cancel();
				return editorRef.current?.captureSelectionBookmark();
			},
			[],
		);
		const setFileReferences = useCallback(
			(refs: FileReference[]) => {
				restoreInput(inputRef.current, refs);
			},
			[restoreInput],
		);
		const appendText = useCallback(
			(text: string) => {
				const previous = readQuotedInput().body.text;
				setBodyText(previous ? `${previous}\n${text}` : text);
			},
			[readQuotedInput, setBodyText],
		);
		const addFileReference = useCallback(
			(reference: FileReference) => {
				try {
					editorRef.current?.insertNodes([{ type: "fileReference", id: reference.id, reference }]);
					if (fileCacheScope) rememberFileReference(fileCacheScope, reference);
				} catch (error) {
					notifications.show({
						title: t("fileReferences.addFailed"),
						message: error instanceof Error ? error.message : String(error),
						color: "red",
					});
				}
			},
			[fileCacheScope, t],
		);

		const syncAttachedFiles = useCallback((next: ComposerDocument) => {
			const files = next.assets.flatMap((asset) => {
				const file = resourceCacheRef.current.get(asset.id);
				return file ? [{ file, kind: asset.kind }] : [];
			});
			const images = files.filter((item) => item.kind === "image").map((item) => item.file);
			const textFiles = files.filter((item) => item.kind === "textFile").map((item) => item.file);
			const previous = attachmentStateRef.current;
			if (
				images.length !== previous.images.length ||
				textFiles.length !== previous.textFiles.length ||
				images.some((file, index) => file !== previous.images[index]) ||
				textFiles.some((file, index) => file !== previous.textFiles[index])
			)
				previous.onChange?.(images, textFiles);
		}, []);
		const applyDocument = useCallback(
			(next: ComposerDocument) => {
				// Initialization/selection-only transactions must not create a dirty rich draft.
				if (
					JSON.stringify(readComposerDocument(next)) ===
					JSON.stringify(readComposerDocument(documentRef.current))
				)
					return;
				applyInput(composerInputFromDocument(next));
				if (!hasUnconfirmedLegacyAttachments())
					declareDocumentAssets(next.assets.map((asset) => asset.id));
				inputHistory.reset();
				syncAttachedFiles(next);
			},
			[
				applyInput,
				inputHistory.reset,
				syncAttachedFiles,
				hasUnconfirmedLegacyAttachments,
				declareDocumentAssets,
			],
		);

		const insertAcceptedFiles = useCallback(
			(
				files: File[],
				bookmark?: ReturnType<InlineComposerEditorHandle["captureSelectionBookmark"]>,
			) => {
				const editor = editorRef.current;
				if (files.length && hasUnconfirmedLegacyAttachments()) {
					bookmark?.cancel();
					notifications.show({
						color: "yellow",
						message: t(
							attachmentRecoveryRef.current.attachmentsRestoreFailed
								? "composerAttachmentsRestoreFailed"
								: "composerRestoringAssets",
						),
					});
					return false;
				}
				if (!files.length || !editor?.getElement() || sendingRef.current) {
					bookmark?.cancel();
					return false;
				}
				if (!bookmark?.restore()) {
					notifications.show({ message: t("composerAttachmentInsertionExpired"), color: "yellow" });
					return false;
				}
				const assets = composerAssetsFromFiles(
					files.filter((file) => file.type.startsWith("image/")),
					files.filter((file) => !file.type.startsWith("image/")),
				);
				for (const file of files) resourceCacheRef.current.set(getComposerAssetId(file), file);
				const nodes: ComposerInlineNode[] = files.map((file) => ({
					type: "attachment",
					id: composerNodeId(),
					assetId: getComposerAssetId(file),
				}));
				try {
					editor.insertNodes(nodes, assets);
					const used = new Set(editor.getDocument().assets.map((asset) => asset.id));
					if (!assets.every((asset) => used.has(asset.id)))
						throw new Error(t("fileReferences.addFailed"));
					return true;
				} catch (error) {
					const used = new Set(documentRef.current.assets.map((asset) => asset.id));
					for (const asset of assets)
						if (!used.has(asset.id)) resourceCacheRef.current.delete(asset.id);
					notifications.show({
						title: t("fileReferences.addFailed"),
						message: error instanceof Error ? error.message : String(error),
						color: "red",
					});
					return false;
				}
			},
			[sendingRef, t, hasUnconfirmedLegacyAttachments],
		);

		// Legacy/local hydration only. New uploads are inserted through per-batch bookmarks.
		// Late hydration must never replace the user's current selection.
		useEffect(() => {
			let cancelled = false;
			queueMicrotask(() => {
				if (cancelled) return;
				if (sendingRef.current) return;
				const current = documentRef.current;
				const known = new Set(current.assets.map((asset) => asset.id));
				const fresh = composerAssetsFromFiles(attachedImages, attachedTextFiles).filter(
					(asset) =>
						!known.has(asset.id) &&
						(!authoritativeAssetsRef.current || authoritativeAssetsRef.current.has(asset.id)),
				);
				fresh.sort((a, b) => {
					const left = resourceCacheRef.current.get(a.id);
					const right = resourceCacheRef.current.get(b.id);
					return (
						(left ? getComposerFileOrder(left) : Number.MAX_SAFE_INTEGER) -
						(right ? getComposerFileOrder(right) : Number.MAX_SAFE_INTEGER)
					);
				});
				if (!fresh.length) return;
				const nodes: ComposerInlineNode[] = fresh.map((asset) => ({
					type: "attachment",
					id: composerNodeId(),
					assetId: asset.id,
				}));
				if (editorRef.current?.getElement()) {
					const selection = editorRef.current.captureSelectionBookmark();
					editorRef.current.setSelection(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
					editorRef.current.insertNodes(nodes, fresh);
					selection.restore();
				} else {
					const paragraphs = current.paragraphs.map((paragraph) => ({
						children: [...paragraph.children],
					}));
					paragraphs[paragraphs.length - 1].children.push(...nodes);
					applyInput(
						composerInputFromDocument({
							...current,
							paragraphs,
							assets: [...current.assets, ...fresh],
						}),
					);
				}
			});
			return () => {
				cancelled = true;
			};
		}, [attachedImages, attachedTextFiles, applyInput, sendingRef]);

		// Prompt optimization hook
		const optimizeHook = usePromptOptimize({
			narratorId,
			textareaRef: useRef<HTMLTextAreaElement>(null),
			target: () => composerOptimizeTarget(editorRef.current),
			onOptimized: (text) => {
				// Fallback: if execCommand fails, update state directly
				setBodyText(text);
			},
		});

		useEffect(() => {
			if (
				!currentUserId ||
				!draftHydrated ||
				sendingRef.current ||
				draftOwnerScopeRef.current !== currentDraftScope
			)
				return;
			const unknown = unacknowledgedDraftRef.current;
			const unknownEdited =
				unknown &&
				(unknown.unsynced || !sameFileReferenceInput(inputStateRef.current, unknown.input));
			// Without a trusted server baseline, reverting to the restored value cannot acknowledge edits.
			if (unknownEdited) unknown.unsynced = true;
			persistNarratorInputDraft(
				currentUserId,
				narratorId,
				input,
				lastDraftRevisionRef.current,
				lastDraftUpdatedAtRef.current,
				fileReferences,
				lastSyncedDraftRef.current ?? (unknownEdited ? null : undefined),
				readPersistableDocument(inputState.composerDocument),
			);
		}, [
			currentUserId,
			currentDraftScope,
			draftHydrated,
			input,
			inputState,
			fileReferences,
			narratorId,
			sendingRef,
			readPersistableDocument,
		]);

		const syncDraftNow = useCallback(
			async (
				text: string,
				baseRevision = lastDraftRevisionRef.current,
				references = inputStateRef.current.fileReferences,
				composerDocument: ComposerDocument | null = inputStateRef.current.composerDocument ?? null,
			) => {
				const refs = copyFileReferences(references, text);
				if (!currentUserId) throw new Error("Current user is unavailable");
				if (draftOwnerScopeRef.current !== currentDraftScope)
					throw new Error("Draft belongs to a previous account or narrator");
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
							readPersistableDocument(composerDocument),
						);
						if (
							seq === draftSyncSeqRef.current &&
							qc.getQueryData<{ id?: string }>(["auth", "me"])?.id === currentUserId
						) {
							const newerConflict = draftConflictRef.current;
							if (newerConflict && newerConflict.revision > result.revision) return result;
							lastSyncedDraftRef.current = {
								text: result.text,
								fileReferences: readFileReferences(result.fileReferences, result.text),
								composerDocument: readComposerDocument(result.composerDocument),
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
								lastSyncedDraftRef.current,
								readPersistableDocument(inputStateRef.current.composerDocument),
							);
							qc.setQueryData(
								["narrators", narratorId],
								(old: Record<string, unknown> | undefined) =>
									old ? { ...old, traits: result.traits, hasDraft: result.hasDraft } : old,
							);
						}
						return result;
					} catch (err) {
						if (
							seq !== draftSyncSeqRef.current ||
							qc.getQueryData<{ id?: string }>(["auth", "me"])?.id !== currentUserId
						)
							return;
						const current =
							err instanceof ApiError && err.status === 409
								? (err.data?.current as
										| {
												hasDraft?: unknown;
												text?: unknown;
												fileReferences?: unknown;
												composerDocument?: unknown;
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
								composerDocument: readComposerDocument(current.composerDocument),
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
			[currentUserId, currentDraftScope, narratorId, qc, readPersistableDocument],
		);

		const clearTextAndDraft = useCallback(() => {
			restoreInput("", []);
			declareDocumentAssets([]);
			releaseUnusedResources();
			attachmentStateRef.current.onChange?.([], []);
			if (draftSyncState === "ready") void syncDraftNow("", undefined, [], null).catch(() => {});
		}, [draftSyncState, syncDraftNow, restoreInput, releaseUnusedResources, declareDocumentAssets]);

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
			const readEpoch = ++draftReadEpochRef.current;
			draftOwnerScopeRef.current = null;
			if (!currentUserId) {
				restoreInput("", []);
				lastDraftRevisionRef.current = null;
				lastDraftUpdatedAtRef.current = null;
				lastSyncedDraftRef.current = null;
				unacknowledgedDraftRef.current = null;
				setDraftHydrated(false);
				setDraftSyncState("loading");
				return;
			}
			let cancelled = false;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 15_000);
			const alive = () =>
				!cancelled &&
				draftReadEpochRef.current === readEpoch &&
				qc.getQueryData<{ id?: string }>(["auth", "me"])?.id === currentUserId;
			setDraftHydrated(false);
			setDraftSyncState("loading");
			draftConflictRef.current = null;
			lastSyncedDraftRef.current = null;
			unacknowledgedDraftRef.current = null;
			lastDraftRevisionRef.current = null;
			if (draftSyncTimerRef.current) {
				clearTimeout(draftSyncTimerRef.current);
				draftSyncTimerRef.current = null;
			}
			cleanupLegacyNarratorInputStorage(currentUserId, narratorId);
			const localDraft = readNarratorInputDraft(currentUserId, narratorId);
			lastDraftRevisionRef.current = localDraft.serverRevision;
			lastDraftUpdatedAtRef.current = localDraft.serverUpdatedAt;
			restoreInput(localDraft.text, localDraft.fileReferences ?? [], localDraft.composerDocument);
			const localDraftAtRequest = inputStateRef.current;
			// Restore trusted text AND references before the persist effect is enabled.
			// A dirty clear or a legacy/unknown CAS base must not be stamped synchronized.
			if (isAcknowledgedNarratorDraft(localDraft)) {
				lastSyncedDraftRef.current = localDraftAtRequest;
			} else {
				unacknowledgedDraftRef.current = {
					input: localDraftAtRequest,
					unsynced: !!localDraft.unsynced,
				};
			}
			draftOwnerScopeRef.current = currentDraftScope;
			setDraftHydrated(true);

			const loadDraft = async () => {
				try {
					const panel = await api.getNarratorPanelState(narratorId, {
						signal: controller.signal,
						fresh: draftLoadAttempt > 0,
					});
					if (!alive()) return;
					if (canHydrateNarratorDraftFromMeta(localDraft, panel.draft)) {
						// The local snapshot is acknowledged. Keep any text/references typed while metadata loaded.
						lastSyncedDraftRef.current = {
							text: localDraft.text,
							fileReferences: readFileReferences(localDraft.fileReferences, localDraft.text),
							composerDocument: localDraft.composerDocument,
						};
						lastDraftRevisionRef.current = panel.draft.revision;
						lastDraftUpdatedAtRef.current = panel.draft.updatedAt;
						setDraftSyncState("ready");
						persistNarratorInputDraft(
							currentUserId,
							narratorId,
							inputRef.current,
							panel.draft.revision,
							panel.draft.updatedAt,
							inputStateRef.current.fileReferences,
							lastSyncedDraftRef.current,
							readPersistableDocument(inputStateRef.current.composerDocument),
						);
						return;
					}
				} catch (error) {
					if (!alive() || !shouldFallbackPanelState(error)) throw error;
				}
				return api.getNarratorDraft(narratorId, controller.signal);
			};

			loadDraft()
				.then((draft) => {
					if (!alive() || !draft) return;
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
						serverComposerDocument: readComposerDocument(draft.composerDocument),
						currentComposerDocument: readPersistableDocument(
							inputStateRef.current.composerDocument,
						),
						currentInput,
						currentFileReferences: inputStateRef.current.fileReferences,
						localChangedSinceRequest:
							!sameFileReferenceInput(inputStateRef.current, localDraftAtRequest) ||
							(!!unacknowledgedDraftRef.current?.unsynced && !localDraft.unsynced),
					});
					if (resolved.composerDocument || localDraft.composerDocument)
						restoreRemoteInput(
							resolved.text,
							resolved.fileReferences ?? [],
							resolved.composerDocument,
						);
					else
						restoreInput(resolved.text, resolved.fileReferences ?? [], resolved.composerDocument);
					lastSyncedDraftRef.current = {
						text: serverText,
						fileReferences: serverFileReferences,
						composerDocument: readComposerDocument(draft.composerDocument),
					};
					lastDraftRevisionRef.current = resolved.conflict
						? localDraft.serverRevision
						: draft.revision;
					lastDraftUpdatedAtRef.current = resolved.conflict
						? localDraft.serverUpdatedAt
						: draft.updatedAt;
					persistNarratorInputDraft(
						currentUserId,
						narratorId,
						resolved.text,
						resolved.conflict ? localDraft.serverRevision : draft.revision,
						resolved.conflict ? localDraft.serverUpdatedAt : draft.updatedAt,
						resolved.fileReferences ?? [],
						lastSyncedDraftRef.current,
						readPersistableDocument(inputStateRef.current.composerDocument),
					);
					if (resolved.conflict) {
						draftConflictRef.current = draft;
						setDraftSyncState("conflict");
					} else {
						setDraftSyncState("ready");
					}
				})
				.catch(() => {
					if (alive()) setDraftSyncState("error");
				})
				.finally(() => clearTimeout(timer));
			return () => {
				cancelled = true;
				clearTimeout(timer);
				draftSyncSeqRef.current++;
				controller.abort();
			};
		}, [
			currentUserId,
			currentDraftScope,
			draftLoadAttempt,
			narratorId,
			restoreInput,
			restoreRemoteInput,
			readPersistableDocument,
			qc,
		]);

		useEffect(() => {
			if (!draftHydrated || !currentUserId || draftSyncState !== "ready" || sendingRef.current)
				return;
			if (!isDraftWithinSyncLimit(input)) return;
			if (
				lastSyncedDraftRef.current &&
				sameFileReferenceInput(inputState, lastSyncedDraftRef.current)
			)
				return;
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
			lastSyncedDraftRef.current = {
				text: remoteText,
				fileReferences: refs,
				composerDocument: remote.composerDocument,
			};
			lastDraftRevisionRef.current = remote.revision;
			lastDraftUpdatedAtRef.current = remote.updatedAt;
			draftConflictRef.current = null;
			restoreRemoteInput(remoteText, refs, remote.composerDocument);
			setDraftSyncState("ready");
			persistNarratorInputDraft(
				currentUserId,
				narratorId,
				remoteText,
				remote.revision,
				remote.updatedAt,
				refs,
				lastSyncedDraftRef.current,
				readPersistableDocument(inputStateRef.current.composerDocument),
			);
		}, [currentUserId, narratorId, restoreRemoteInput, readPersistableDocument]);

		const commitDraftAfterSend = useCallback(() => {
			if (draftSyncState === "ready") {
				setDraftSyncState("loading");
				void syncDraftNow("", undefined, [], null).catch(() => setDraftSyncState("error"));
			} else if (draftSyncState === "conflict") {
				// The local text was sent, but another client owns a newer draft. Keep that
				// remote draft rather than clearing it as a side effect of this send.
				acceptServerDraft();
			}
			releaseUnusedResources();
		}, [draftSyncState, syncDraftNow, acceptServerDraft, releaseUnusedResources]);

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

		const remoteDraftHandlerRef = useRef<(draft: NarratorRemoteDraft) => void>(() => {});
		const handleDraftChanged = useCallback(
			(draft: NarratorRemoteDraft) => {
				const currentRevision = lastDraftRevisionRef.current;
				if (currentRevision != null && draft.revision < currentRevision) return;
				if (draft.hasDraft && draft.hasComposerDocument && !draft.composerDocument) {
					const epoch = ++draftReadEpochRef.current;
					const scope = draftOwnerScopeRef.current;
					void api
						.getNarratorDraft(narratorId, AbortSignal.timeout(15_000))
						.then((detail) => {
							if (
								epoch !== draftReadEpochRef.current ||
								scope !== draftOwnerScopeRef.current ||
								detail.revision < draft.revision ||
								detail.revision < (lastDraftRevisionRef.current ?? 0)
							)
								return;
							// A newer save may legitimately clear the draft or come from a legacy text client.
							// Only the same nonempty revision is bound by this summary's layout promise.
							if (
								detail.hasDraft &&
								detail.revision === draft.revision &&
								!readComposerDocument(detail.composerDocument)
							)
								throw new Error("Draft detail is missing the announced layout");
							remoteDraftHandlerRef.current({ ...detail, hasComposerDocument: false });
						})
						.catch(() => {
							if (
								epoch === draftReadEpochRef.current &&
								scope === draftOwnerScopeRef.current &&
								// PUT already returns the full draft after broadcasting its summary.
								// A failed redundant GET cannot invalidate that acknowledged snapshot.
								!(
									(lastDraftRevisionRef.current ?? -1) >= draft.revision &&
									lastSyncedDraftRef.current
								)
							)
								setDraftSyncState("error");
						});
					return;
				}
				draftReadEpochRef.current++;
				const remoteText = draft.hasDraft ? draft.text : "";
				const remoteRefs = draft.hasDraft
					? readFileReferences(draft.fileReferences, remoteText)
					: [];
				const remoteInput = {
					text: remoteText,
					fileReferences: remoteRefs,
					composerDocument: draft.composerDocument,
				};
				const unknown = unacknowledgedDraftRef.current;
				const hasLocalUnsyncedChanges = lastSyncedDraftRef.current
					? !sameFileReferenceInput(inputStateRef.current, lastSyncedDraftRef.current)
					: !!(
							inputRef.current ||
							inputStateRef.current.fileReferences.length ||
							unknown?.unsynced ||
							(unknown && !sameFileReferenceInput(inputStateRef.current, unknown.input))
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
				const shouldApplyRemote = draft.sourceId !== draftSourceIdRef.current;
				if (shouldApplyRemote) restoreRemoteInput(remoteText, remoteRefs, draft.composerDocument);
				lastSyncedDraftRef.current = remoteInput;
				lastDraftRevisionRef.current = draft.revision;
				lastDraftUpdatedAtRef.current = draft.updatedAt;
				draftConflictRef.current = null;
				setDraftSyncState("ready");
				const nextInput = shouldApplyRemote ? remoteInput : inputStateRef.current;
				if (currentUserId) {
					persistNarratorInputDraft(
						currentUserId,
						narratorId,
						nextInput.text,
						draft.revision,
						draft.updatedAt,
						nextInput.fileReferences,
						lastSyncedDraftRef.current,
						readPersistableDocument(nextInput.composerDocument),
					);
				}
			},
			[currentUserId, narratorId, restoreRemoteInput, readPersistableDocument],
		);

		remoteDraftHandlerRef.current = handleDraftChanged;

		// --- Command popover ---
		// A quoted message is never a slash command: the quote prefix leads its text.
		const commandInput = document.paragraphs.some((paragraph) =>
			paragraph.children.some((node) => node.type !== "text" && node.type !== "break"),
		)
			? ""
			: bodyText;
		// Only fetch commands when user starts typing "/" to avoid unnecessary API call on page load
		const { data: commandsList } = useNarratorCommands(
			commandInput.startsWith("/") ? narratorId : undefined,
		);
		// Show command popover only when typing command name (no space yet),
		// or when typing optional tool sub-completion (/load <tool>, /unload <tool>).
		// Suppress when browsing input history so arrow keys keep navigating history.
		const commandPopoverVisible =
			editorFocused &&
			commandInput.startsWith("/") &&
			!commandInput.includes("\n") &&
			(!commandInput.includes(" ") ||
				// /load <tool>, /unload <tool>, and the skill sub-completions
				// (/load skill <name>, /unload all_skills, ...).
				/^\/(?:load|unload)\s(?:skill(?:\s\S*)?|\S*)$/i.test(commandInput)) &&
			(commandsList?.length ?? 0) > 0 &&
			!inputHistory.isBrowsing;
		// Matched command for param helper (after space is typed)
		const matchedCommand = useMemo(() => {
			if (!commandInput.startsWith("/") || !commandsList?.length) return null;
			const spaceIdx = commandInput.indexOf(" ");
			if (spaceIdx === -1) return null;
			const cmdName = commandInput.slice(1, spaceIdx);
			return (
				commandsList.find(
					(c) => c.name.toLowerCase() === cmdName.toLowerCase() && c.type === "command",
				) ?? null
			);
		}, [commandInput, commandsList]);
		const handleCommandSelect = useCallback(
			(cmd: CommandItem) => {
				if (cmd.type === "skill") {
					// Skill selected — use /skill command so backend injects content directly
					setBodyText(`/skill ${cmd.name} `);
				} else if (cmd.type === "tool" && !cmd.name.includes(" ")) {
					// Parent /load entry — expand to show sub-items
					setBodyText(`/${cmd.name} `);
				} else {
					// Always keep command format — user can continue typing or press space for params
					setBodyText(`/${cmd.name}`);
				}
			},
			[setBodyText],
		);
		const closeCommandPopover = useCallback(() => {
			clearTextAndDraft();
		}, [clearTextAndDraft]);

		// === @mention of named narrators ===========================================
		const { data: namedNarrators } = useNamedNarrators();
		const [mentionCaret, setMentionCaret] = useState<number | null>(null);
		const [queryContext, setQueryContext] =
			useState<ReturnType<InlineComposerEditorHandle["getTextContext"]>>(null);
		const handleComposerSelection = useCallback((selection: { start: number; end: number }) => {
			const input = editorRef.current?.getElement();
			if (!input?.contains(input.ownerDocument.activeElement)) {
				setMentionCaret(null);
				setQueryContext(null);
				return;
			}
			setMentionCaret(selection.start);
			const next = editorRef.current?.getTextContext() ?? null;
			setQueryContext((current) =>
				current?.text === next?.text &&
				current?.start === next?.start &&
				current?.end === next?.end &&
				current?.caret === next?.caret
					? current
					: next,
			);
		}, []);
		const mentionQuery = useMemo(() => {
			if (mentionCaret === null || !queryContext) return null;
			// Atom boundaries must never be joined into a mention token.
			if (commandInput.startsWith("/")) return null;
			return getMentionQuery(queryContext.text, queryContext.caret - queryContext.start);
		}, [commandInput, mentionCaret, queryContext]);
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
			editorFocused &&
			mentionQuery !== null &&
			!inputHistory.isBrowsing &&
			mentionCandidates.length > 0;
		const handleMentionSelect = useCallback(
			(candidate: MentionCandidate) => {
				const caret = mentionCaret;
				if (caret === null) return;
				const upto = bodyText.slice(0, caret);
				const at = upto.lastIndexOf("@");
				if (at === -1) return;
				const before = bodyText.slice(0, at);
				const after = bodyText.slice(caret);
				const insert = `@${candidate.handle} `;
				const next = before + insert + after;
				setBodyText(next);
				// Move caret to just after the inserted handle.
				const nextCaret = before.length + insert.length;
				requestAnimationFrame(() => {
					editorRef.current?.focus();
					editorRef.current?.setSelection(nextCaret, nextCaret);
					setMentionCaret(nextCaret);
				});
			},
			[bodyText, mentionCaret, setBodyText],
		);
		const closeMentionPopover = useCallback(() => setMentionCaret(null), []);

		const [dismissedFileQuery, setDismissedFileQuery] = useState<string | null>(null);
		const fileQuery = useMemo(() => {
			if (
				!editorFocused ||
				mentionCaret === null ||
				!queryContext ||
				commandInput.startsWith("/") ||
				inputHistory.isBrowsing
			)
				return null;
			const query = getFileReferenceQuery(
				bodyText,
				mentionCaret,
				bodyInput.fileReferences,
				queryContext.start,
			);
			return query && JSON.stringify([bodyText, mentionCaret]) !== dismissedFileQuery
				? query
				: null;
		}, [
			bodyText,
			bodyInput.fileReferences,
			commandInput,
			mentionCaret,
			queryContext,
			editorFocused,
			inputHistory.isBrowsing,
			dismissedFileQuery,
		]);
		const closeFilePopover = useCallback(() => {
			setDismissedFileQuery(
				JSON.stringify([readQuotedInput().body.text, editorRef.current?.getSelection().start]),
			);
		}, [readQuotedInput]);
		const moveFileCaret = useCallback((caret: number) => {
			requestAnimationFrame(() => {
				editorRef.current?.focus();
				editorRef.current?.setSelection(caret, caret);
				setMentionCaret(caret);
			});
		}, []);
		const handleFileSelect = useCallback(
			(reference: FileReference) => {
				if (!fileQuery) return;
				try {
					editorRef.current?.setSelection(fileQuery.start, fileQuery.end);
					editorRef.current?.insertNodes([
						{ type: "fileReference", id: reference.id, reference },
						{ type: "text", text: " " },
					]);
					if (fileCacheScope) rememberFileReference(fileCacheScope, reference);
					setDismissedFileQuery(null);
				} catch (error) {
					notifications.show({
						title: t("fileReferences.addFailed"),
						message: error instanceof Error ? error.message : String(error),
						color: "red",
					});
				}
			},
			[fileQuery, fileCacheScope, t],
		);
		const handleFileNavigate = useCallback(
			(candidate: FileReferenceCandidate) => {
				if (!fileQuery) return;
				const prefix = `#${candidate.relativePath.replace(/[\\/]+$/, "")}/`;
				const body = readQuotedInput().body.text;
				setBodyText(body.slice(0, fileQuery.start) + prefix + body.slice(fileQuery.end));
				moveFileCaret(fileQuery.start + prefix.length);
			},
			[fileQuery, setBodyText, moveFileCaret, readQuotedInput],
		);
		useEffect(() => dock?.registerAddFileReference?.(addFileReference), [dock, addFileReference]);

		// === Selection quotes ======================================================
		const acceptQuoteRef = useRef<(candidate: QuoteCandidate) => void>(() => {});
		const quoteCandidate = useQuoteCandidate({
			textareaRef,
			element: editorElement,
			onShortcut: (candidate) => acceptQuoteRef.current(candidate),
		});
		const acceptQuote = useCallback(
			(candidate: QuoteCandidate) => {
				if (hasUnconfirmedLegacyAttachments()) {
					notifications.show({
						color: "yellow",
						message: t(
							attachmentRecoveryRef.current.attachmentsRestoreFailed
								? "composerAttachmentsRestoreFailed"
								: "composerRestoringAssets",
						),
					});
					return;
				}
				try {
					if (candidate.kind === "file") {
						if (!candidate.reference) throw new Error(t("quote.fileUnsaved"));
						addFileReference(candidate.reference);
					} else {
						const current = documentRef.current.paragraphs
							.flatMap((paragraph) => paragraph.children)
							.filter((node) => node.type === "quote");
						if (current.length >= MAX_COMPOSER_QUOTES)
							throw new Error(t("quote.limit", { count: MAX_COMPOSER_QUOTES }));
						editorRef.current?.insertNodes([
							{ type: "quote", id: composerNodeId(), ...candidate.quote },
						]);
					}
					quoteCandidate.hide(candidate);
				} catch (error) {
					notifications.show({
						title: t("quote.addFailed"),
						message: error instanceof Error ? error.message : String(error),
						color: "red",
					});
				}
			},
			[addFileReference, quoteCandidate.hide, t, hasUnconfirmedLegacyAttachments],
		);
		acceptQuoteRef.current = acceptQuote;

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

		// Report the empty↔non-empty transition upward (the panel's send-button
		// gating and permission Enter-hint need it), never the text itself.
		const hasText = input.trim().length > 0 || fileReferences.length > 0;
		useEffect(() => {
			onTextFlagsChange(hasText);
		}, [hasText, onTextFlagsChange]);

		// Enter outside interactive controls returns focus to this visible chat input.
		useEffect(() => {
			const textarea = editorElement;
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
					sendingRef.current ||
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
		}, [permEnterActive, editorElement, sendingRef]);

		const handleKeyDown = (e: React.KeyboardEvent) => {
			if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || sendingRef.current) return;
			if (fileQuery && fileReferenceKeyAction(e.nativeEvent)) {
				// The scoped capture listener owns these keys, including empty/loading results.
				// Defer to the native capture listener on the editor DOM. Stopping at
				// this React ancestor would prevent FileReferencePopover from receiving it.
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
			// Up/down follow visual lines, including soft wraps. History runs only from the
			// first line upward or the last line downward. Prevent that press before the
			// browser handles it: contenteditable otherwise jumps to the end of the last line
			// when history does not replace the text. Editor state is still the pre-key caret
			// here; selectionchange applies the browser move later.
			if (
				(e.key === "ArrowUp" || e.key === "ArrowDown") &&
				!e.shiftKey &&
				!e.ctrlKey &&
				!e.metaKey &&
				(!documentRef.current.assets.length || inputHistory.isBrowsing)
			) {
				const direction = e.key === "ArrowUp" ? "up" : "down";
				if (!editorRef.current?.isCaretOnVerticalEdge(direction)) return;
				e.preventDefault();
				const result = inputHistory.navigateEntry(
					direction,
					inputRef.current,
					inputStateRef.current.fileReferences,
					readPersistableDocument(inputStateRef.current.composerDocument),
				);
				if (!result) return;
				restoreRemoteInput(result.text, result.fileReferences, result.composerDocument);
				syncAttachedFiles(documentRef.current);
				// Layout measures on the next frame; scroll once that height is committed.
				const reveal = () => editorRef.current?.revealCaretAtEnd();
				const win = editorRef.current?.getElement()?.ownerDocument.defaultView;
				if (win) win.requestAnimationFrame(() => win.requestAnimationFrame(reveal));
				else requestAnimationFrame(() => requestAnimationFrame(reveal));
			}
		};

		useImperativeHandle(
			ref,
			(): NarratorComposerHandle => ({
				getText: () => inputRef.current,
				captureAttachmentSelection,
				captureAttachmentInsertion,
				insertAcceptedFiles,
				getDocument: () => inputStateRef.current.composerDocument,
				hasMissingAssets: () =>
					missingComposerAssets(documentRef.current, resourceCacheRef.current),
				isTextEmpty: () =>
					inputRef.current.trim().length === 0 && inputStateRef.current.fileReferences.length === 0,
				ownsTextarea: (target) =>
					!!target &&
					typeof target === "object" &&
					"nodeType" in target &&
					!!textareaRef.current?.contains(target as Node),
				focus: () => editorRef.current?.focus(),
				setText,
				getFileReferences: () => copyFileReferences(inputStateRef.current.fileReferences),
				setFileReferences,
				restoreInput,
				addFileReference,
				appendText,
				clearTextAndDraft,
				hideTextForSend,
				commitDraftAfterSend,
				noteSent: (text, refs, document) => inputHistory.push(text, refs, document),
				handleDraftChanged,
			}),
			[
				captureAttachmentSelection,
				captureAttachmentInsertion,
				insertAcceptedFiles,
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
			<Box
				ref={fullscreenTrap}
				className={fullscreenOpened ? classes.fullscreen : undefined}
				style={fullscreenOpened ? undefined : { position: "relative", flex: 1, minWidth: 0 }}
				role={fullscreenOpened ? "dialog" : undefined}
				aria-modal={fullscreenOpened || undefined}
				aria-label={fullscreenOpened ? t("fullscreenComposerTitle") : undefined}
			>
				<CommandPopover
					anchorRef={textareaRef}
					commands={commandsList ?? []}
					input={commandInput}
					visible={commandPopoverVisible}
					onSelect={handleCommandSelect}
					onClose={closeCommandPopover}
				/>
				<MentionPopover
					anchorRef={textareaRef}
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
						input={commandInput}
						visible={!commandPopoverVisible}
					/>
				)}
				{attachmentsRestoreFailed && (
					<Group gap="xs" mb={4} wrap="nowrap" data-attachment-restore-error>
						<Text size="xs" c="orange" style={{ flex: 1 }}>
							{t("composerAttachmentsRestoreFailed")}
						</Text>
						{onRetryAttachments && (
							<Button
								size="compact-xs"
								variant="light"
								onClick={onRetryAttachments}
								disabled={sending}
							>
								{t("draftRetry")}
							</Button>
						)}
					</Group>
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
				<InlineComposerEditor
					ref={editorRef}
					elementRef={textareaRef}
					onElement={setEditorElement}
					value={document}
					adaptive={!fullscreenOpened}
					leadingControls={controls}
					candidate={
						quoteCandidate.candidate
							? {
									key: quoteCandidate.candidate.key,
									content: (
										<InlineQuoteCandidate
											candidate={quoteCandidate.candidate}
											showShortcut={quoteCandidate.showShortcut}
											disabled={sending || hasUnconfirmedLegacyAttachments()}
											onAccept={acceptQuote}
											onDismiss={quoteCandidate.hide}
										/>
									),
								}
							: undefined
					}
					onChange={applyDocument}
					resources={resources}
					attachmentsHydrating={attachmentsHydrating}
					attachmentsRestoreFailed={attachmentsRestoreFailed}
					disabled={sending}
					placeholder={t(quotes.length ? "quote.placeholder" : "sendPlaceholder")}
					onSelectionChange={handleComposerSelection}
					onFocus={() => setEditorFocused(true)}
					onBlur={() => {
						setEditorFocused(false);
						setMentionCaret(null);
						setQueryContext(null);
					}}
					onKeyDown={handleKeyDown}
					onPasteFiles={onPasteImages}
					onOpenQuote={(quote) => revealComposerQuote(dock, quote, editorElement)}
					onOpenFile={(reference) => revealQuotedFile(dock, reference)}
					onOpenImage={(asset) => {
						const file = resourceCacheRef.current.get(asset.id);
						if (!file) return;
						let src = previewURLsRef.current.get(file);
						if (!src) {
							src = URL.createObjectURL(file);
							previewURLsRef.current.set(file, src);
						}
						openImageViewer({ src, blob: file, filename: file.name, alt: file.name });
					}}
					controls={
						<Group gap="xs" wrap="wrap" justify="flex-end">
							{fullscreenOpened && (
								<Button size="compact-xs" variant="subtle" onClick={closeFullscreen}>
									{t("richComposer.collapse")}
								</Button>
							)}
							<TextareaOptimizeControls
								disabled={!bodyText.trim() || optimizeHook.loading || sending}
								loading={optimizeHook.loading}
								withContext={optimizeHook.withContext}
								onToggleContext={optimizeHook.toggleContext}
								onOptimize={optimizeHook.handleOptimize}
								onCancelOptimize={optimizeHook.cancelOptimize}
								onExpand={() => {
									optimizeHook.cancelOptimize();
									openFullscreen();
								}}
								contextMessageCount={optimizeHook.contextMessageCount}
								onContextMessageCountChange={optimizeHook.setContextMessageCount}
							/>
							{actions}
						</Group>
					}
				/>
				{!attachmentsRestoreFailed && missingComposerAssets(document, resources) && (
					<Text size="xs" c={attachmentsHydrating ? "dimmed" : "orange"}>
						{t(attachmentsHydrating ? "composerRestoringAssets" : "composerMissingAssets")}
					</Text>
				)}
			</Box>
		);
	},
);
