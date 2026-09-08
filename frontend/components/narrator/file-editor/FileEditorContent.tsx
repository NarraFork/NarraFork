/**
 * FileEditorContent.tsx — editing a workspace file in the browser.
 *
 * Wraps the CodeMirror surface with the three things a save needs to be honest:
 * the optimistic lock, a conflict view built from the existing `DiffView`, and an
 * explicit choice when the lock fails. Text panels open directly in this editor;
 * remote files and files without a narrator remain read-only on the same surface.
 *
 * The state transitions live in `save-state.ts` and are tested there; this component
 * only performs I/O and rendering.
 */

import {
	ActionIcon,
	Alert,
	Badge,
	Box,
	Button,
	Center,
	Group,
	Loader,
	Text,
	Tooltip,
} from "@mantine/core";
import {
	FILE_REFERENCE_READ_TIMEOUT_MS,
	type FileReferenceEditorSelection,
	type FileSelection,
} from "@shared/file-reference";
import {
	IconAlertTriangle,
	IconDeviceFloppy,
	IconRefresh,
	IconSearch,
	IconTextWrap,
} from "@tabler/icons-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, api } from "../../../lib/api";
import { request } from "../../../lib/api/client";
import { fileReferenceApi } from "../../../lib/api/file-references";
import { getShikiLang } from "../../../lib/shiki-lang";
import { useFileReferenceScope } from "../FileReferenceScope";
import { filePanelBaseName } from "../panels/panel-kind";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import {
	applyEdit,
	beginSave,
	canSave,
	dismissConfirmation,
	type EditorState,
	initialEditorState,
	isDirty,
	reloaded,
	resolveConflictKeepingMine,
	resolveConflictTakingTheirs,
	saveConflicted,
	saveFailed,
	saveNeedsConfirmation,
	saveSucceeded,
} from "./save-state";

const DiffView = lazy(() => import("../DiffView").then((m) => ({ default: m.DiffView })));

/** Match CodeMirror's document newlines without changing the server's byte hash or encoding. */
function editorText(content: string): string {
	return content.replace(/\r\n?/g, "\n");
}

export interface FileEditorContentProps {
	/** Absolute path of the file being edited. */
	filePath: string;
	/** Narrator whose workspace bounds the write. Required by the server. */
	narratorId?: string;
	deviceId?: string;
	referenceOrigin?: boolean;
	selection?: FileSelection;
	navigationRequestId?: string;
	/** Only direct editor selection events may take ownership; metadata refreshes may not. */
	onFileReferenceSelectionChange?: (
		selection: FileReferenceEditorSelection | null,
		takeOwnership?: boolean,
	) => void;
	/**
	 * Reports whether closing would be unsafe: the buffer differs from disk or
	 * a write is still in flight (even if the user undid back to the old baseline).
	 *
	 * The buffer lives only in this component's state, so unmounting the editor
	 * destroys it. The owner needs to know before it does that.
	 */
	onDirtyChange?: (dirty: boolean) => void;
}

/**
 * Turn a load failure into something the reader can act on.
 *
 * The two refusals that matter are not errors in the file's content but statements
 * about what this editor can do: a binary file cannot round-trip through text, and a
 * file over the cap cannot be loaded in full — so saving it would truncate it. Both
 * arrive with a machine-readable `code`, and both deserve an explanation rather than
 * the server's English sentence, because they are the answer to "why can I not edit
 * this" rather than a fault.
 */
function describeLoadError(err: unknown, t: (key: string) => string): string {
	if (err instanceof ApiError) {
		const code = (err.data as { code?: unknown } | undefined)?.code;
		if (code === "BINARY") return t("fileEditor.binaryNotEditable");
		if (code === "TOO_LARGE_TO_EDIT") return t("fileEditor.tooLargeToEdit");
	}
	return err instanceof Error ? err.message : String(err);
}

/** Only a known saved version can back #selection; dirty remains explicit metadata. */
export function fileEditorReferenceSelection(
	state: EditorState | null,
	deviceId: string,
	filePath: string,
	selection: FileSelection | null,
): FileReferenceEditorSelection | null {
	if (!state?.baseHash || !selection) return null;
	return {
		target: { deviceId, path: filePath, selection },
		label: filePanelBaseName(filePath),
		expectedHash: state.baseHash,
		dirty: isDirty(state),
	};
}

export function FileEditorContent({
	filePath,
	narratorId,
	deviceId = "local",
	referenceOrigin = false,
	selection,
	navigationRequestId,
	onFileReferenceSelectionChange,
	onDirtyChange,
}: FileEditorContentProps) {
	const { t } = useTranslation("narrator");
	const tRef = useRef(t);
	tRef.current = t;
	const scope = useFileReferenceScope();
	const publishSelection = onFileReferenceSelectionChange ?? scope.setSelection;
	const [editorSelection, setEditorSelection] = useState<FileSelection | null>(null);
	const loadControllerRef = useRef<AbortController | null>(null);
	// Upgrading a reused panel to a reference must not reload its dirty editor.
	// The next explicit load still uses the latest scoped/legacy reader policy.
	const referenceOriginRef = useRef(referenceOrigin);
	referenceOriginRef.current = referenceOrigin;
	const [state, renderState] = useState<EditorState | null>(null);
	const stateRef = useRef<EditorState | null>(null);
	const setState = useCallback(
		(next: EditorState | null | ((previous: EditorState | null) => EditorState | null)) => {
			stateRef.current = typeof next === "function" ? next(stateRef.current) : next;
			renderState(stateRef.current);
		},
		[],
	);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [lineWrapping, setLineWrapping] = useState(false);
	const [searchRequestId, setSearchRequestId] = useState(0);
	const readOnly = deviceId !== "local" || !narratorId;
	const phrases = useMemo(
		() => t("fileEditor.searchPhrases", { returnObjects: true }) as Record<string, string>,
		[t],
	);
	/**
	 * The file's encoding, echoed back on every save.
	 *
	 * Held outside `EditorState` because it is a property of the FILE rather than of the
	 * edit: it survives conflict resolution and a reload, and none of the state
	 * transitions have any business changing it.
	 */
	const [encoding, setEncoding] = useState<string>("utf-8");
	/**
	 * In-flight guard, held in a ref rather than read from `state.saving`.
	 *
	 * `handleSave` closes over `state`, and `beginSave`'s `setState` does not update that
	 * closure. Two Ctrl+S presses inside one React batch therefore both see
	 * `saving: false` and both fire — two requests carrying the same `baseHash`, so the
	 * optimistic lock cannot separate them and whichever lands second overwrites the
	 * first with content the user may have already changed. A ref flips synchronously,
	 * which is what a mutual exclusion needs to be.
	 */
	const savingRef = useRef(false);

	const load = useCallback(async () => {
		if (savingRef.current) return;
		if (
			stateRef.current &&
			isDirty(stateRef.current) &&
			!window.confirm(tRef.current("fileEditor.confirmReload"))
		)
			return;
		const bufferAtStart = stateRef.current?.buffer;
		loadControllerRef.current?.abort();
		const controller = new AbortController();
		loadControllerRef.current = controller;
		const timeout = setTimeout(() => controller.abort(), FILE_REFERENCE_READ_TIMEOUT_MS);
		setLoadError(null);
		setLoading(true);
		try {
			// Scoped/remote identities must never fall back to the local filesystem.
			if ((referenceOriginRef.current || deviceId !== "local") && !narratorId)
				throw new Error(tRef.current("fileEditor.missingContext"));
			// Both readers return server-decoded text, hash and encoding together.
			const res =
				referenceOriginRef.current || deviceId !== "local"
					? await fileReferenceApi.preview(
							narratorId as string,
							{ deviceId, path: filePath },
							controller.signal,
						)
					: await request<{ content: string; encoding: string; hash: string }>(
							`/fs/edit-source?path=${encodeURIComponent(filePath)}`,
							{ signal: controller.signal },
						);
			if (loadControllerRef.current !== controller) return;
			// An edit made while the read was pending must never be replaced by its reply.
			if (stateRef.current?.buffer !== bufferAtStart)
				throw new Error(tRef.current("fileEditor.changedDuringReload"));
			setEncoding(res.encoding);
			// Preview preserves source newlines; both initial load and reload need the
			// same LF baseline as the editor, not a synthetic unsaved conversion.
			setState(initialEditorState(editorText(res.content), res.hash));
		} catch (err) {
			if (loadControllerRef.current === controller)
				setLoadError(describeLoadError(err, tRef.current));
		} finally {
			clearTimeout(timeout);
			if (loadControllerRef.current === controller) setLoading(false);
		}
	}, [deviceId, filePath, narratorId, setState]);

	useEffect(() => {
		void load();
		return () => {
			loadControllerRef.current?.abort();
			loadControllerRef.current = null;
		};
	}, [load]);

	/**
	 * Send the buffer.
	 *
	 * `confirmOutsideRoots` is only ever true on the second attempt, after the user read
	 * the resolved path and accepted it — the first attempt must be the one that gets
	 * refused, because the refusal is what produces the path to show.
	 */
	const performSave = useCallback(
		async (confirmOutsideRoots: boolean) => {
			const current = stateRef.current;
			if (!current || savingRef.current || loading || readOnly || !narratorId) return;

			const sending = current.buffer;
			savingRef.current = true;
			setState((prev) => (prev ? beginSave(prev) : prev));
			try {
				const result = await api.fsWrite({
					path: filePath,
					content: sending,
					narratorId,
					baseHash: current.baseHash,
					// Echoed, never re-derived: the encoding belongs to the file, and letting the
					// server sniff the NEW text could convert the file because the replacement
					// content happened to sniff differently.
					encoding,
					// Tell the narrator a person edited the file. Without this the agent's next
					// turn reads a file it believes it last wrote, and the human edit looks like
					// an anonymous external change in the modification view.
					notifyAgent: true,
					...(confirmOutsideRoots ? { confirmOutsideRoots: true } : {}),
				});
				setState((prev) => (prev ? saveSucceeded(prev, sending, result.hash) : prev));
			} catch (err) {
				// 409 covers TWO different outcomes, and treating them alike is what made the
				// confirmation flow unreachable: a stale lock carries the winning content and
				// needs the diff UI, while an outside-roots refusal carries a physical path and
				// needs an acknowledgement. Dispatch on `code`, not on the status.
				if (err instanceof ApiError && err.status === 409) {
					const data = err.data as
						| {
								code?: string;
								currentContent?: string;
								currentHash?: string;
								physicalPath?: string;
								error?: string;
						  }
						| undefined;
					if (data?.code === "NEEDS_CONFIRMATION" && typeof data.physicalPath === "string") {
						setState((prev) =>
							prev
								? saveNeedsConfirmation(
										prev,
										data.physicalPath as string,
										data.error ?? t("fileEditor.outsideWorkspaceBody"),
									)
								: prev,
						);
						return;
					}
					if (typeof data?.currentContent === "string" && data.currentHash) {
						setState((prev) =>
							prev
								? saveConflicted(
										prev,
										editorText(data.currentContent as string),
										data.currentHash as string,
									)
								: prev,
						);
						return;
					}
				}
				setState((prev) =>
					prev ? saveFailed(prev, err instanceof Error ? err.message : String(err)) : prev,
				);
			} finally {
				// Released in `finally`, not after the success path: an early `return` from a
				// 409 branch would otherwise leave the guard latched and the editor unable to
				// save again for the rest of its life.
				savingRef.current = false;
			}
		},
		[encoding, filePath, narratorId, loading, readOnly, t, setState],
	);

	const handleSave = useCallback(() => {
		if (!stateRef.current || !canSave(stateRef.current)) return;
		void performSave(false);
	}, [performSave]);

	const handleChange = useCallback(
		(buffer: string) => {
			// Ctrl+S can arrive before React commits the input render. Publish the
			// new buffer synchronously so saving never sends the previous keystroke.
			if (!stateRef.current) return;
			setState(applyEdit(stateRef.current, buffer));
		},
		[setState],
	);
	const handleSelectionChange = useCallback(
		(next: FileSelection | null, selectionSet: boolean) => {
			// Publish explicit selection transactions even when the range is unchanged:
			// another panel may have acquired ownership. Document-only updates use the
			// metadata effect below and must not acquire ownership (e.g. reload).
			if (selectionSet)
				publishSelection?.(
					fileEditorReferenceSelection(stateRef.current, deviceId, filePath, next),
					true,
				);
			setEditorSelection((previous) =>
				previous?.startLineNumber === next?.startLineNumber &&
				previous?.startColumn === next?.startColumn &&
				previous?.endLineNumber === next?.endLineNumber &&
				previous?.endColumn === next?.endColumn
					? previous
					: next,
			);
		},
		[deviceId, filePath, publishSelection],
	);

	// Computed before the early returns below so the hook order stays fixed; the
	// render path re-reads it once `state` is known to be non-null.
	const dirty = state ? isDirty(state) : false;
	const exitBlocked = dirty || !!state?.saving;
	const baseHash = state?.baseHash;
	useEffect(() => {
		publishSelection?.(
			baseHash && editorSelection
				? {
						target: { deviceId, path: filePath, selection: editorSelection },
						label: filePanelBaseName(filePath),
						expectedHash: baseHash,
						dirty,
					}
				: null,
		);
	}, [deviceId, filePath, editorSelection, baseHash, dirty, publishSelection]);
	useEffect(() => {
		const beforeUnload = (event: BeforeUnloadEvent) => {
			if (!savingRef.current && (!stateRef.current || !isDirty(stateRef.current))) return;
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", beforeUnload);
		return () => window.removeEventListener("beforeunload", beforeUnload);
	}, []);
	useEffect(() => () => publishSelection?.(null), [publishSelection]);
	useEffect(() => {
		onDirtyChange?.(exitBlocked);
	}, [exitBlocked, onDirtyChange]);
	useEffect(
		() => () => {
			// On unmount the buffer is gone, so nothing is dirty any more — leaving the
			// flag set would keep the owner refusing an action there is no longer a
			// reason to refuse.
			onDirtyChange?.(false);
		},
		[onDirtyChange],
	);

	if (loadError && !state) {
		return (
			<Center h="100%" p="md">
				<Group gap="xs" wrap="nowrap">
					<IconAlertTriangle size={16} color="var(--mantine-color-orange-6)" />
					<Text size="sm" c="dimmed">
						{loadError}
					</Text>
					<Tooltip label={t("fileTree.retry")} openDelay={200}>
						<ActionIcon variant="subtle" size="sm" onClick={() => void load()}>
							<IconRefresh size={14} />
						</ActionIcon>
					</Tooltip>
				</Group>
			</Center>
		);
	}

	if (!state) {
		return (
			<Center h="100%">
				<Loader size="sm" />
			</Center>
		);
	}

	return (
		<Box style={{ height: "100%", display: "flex", flexDirection: "column" }}>
			<Group justify="space-between" gap="xs" px="xs" py={6} wrap="nowrap">
				<Group gap={6} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
					<Text size="xs" c="dimmed" truncate title={filePath}>
						{filePanelBaseName(filePath)}
					</Text>
					{readOnly && (
						<Badge size="xs" color="gray">
							{t("fileEditor.readOnly")}
						</Badge>
					)}
					{dirty && (
						<Badge size="xs" color="yellow" variant="light">
							{t("fileEditor.unsaved")}
						</Badge>
					)}
					{(state.error || loadError) && (
						<Text size="xs" c="red" truncate title={state.error ?? loadError ?? undefined}>
							{state.error || loadError}
						</Text>
					)}
				</Group>
				<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
					<Tooltip label={`${t("fileEditor.search")} (Ctrl/Cmd+F)`} openDelay={200}>
						<ActionIcon
							variant="subtle"
							size="sm"
							aria-label={t("fileEditor.search")}
							onClick={() => setSearchRequestId((id) => id + 1)}
						>
							<IconSearch size={14} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("fileEditor.wrap")} openDelay={200}>
						<ActionIcon
							variant={lineWrapping ? "light" : "subtle"}
							size="sm"
							aria-label={t("fileEditor.wrap")}
							aria-pressed={lineWrapping}
							onClick={() => setLineWrapping((enabled) => !enabled)}
						>
							<IconTextWrap size={14} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("fileEditor.reload")} openDelay={200}>
						<ActionIcon
							variant="subtle"
							color="gray"
							size="sm"
							onClick={() => void load()}
							aria-label={t("fileEditor.reload")}
							loading={loading}
							disabled={state.saving || loading}
						>
							<IconRefresh size={14} />
						</ActionIcon>
					</Tooltip>
					{!readOnly && (
						<Tooltip label={`${t("fileEditor.save")} (Ctrl/Cmd+S)`} openDelay={200}>
							<ActionIcon
								variant={dirty ? "filled" : "subtle"}
								color={dirty ? "green" : "gray"}
								size="sm"
								onClick={handleSave}
								aria-label={t("fileEditor.save")}
								loading={state.saving}
								disabled={loading || !canSave(state)}
							>
								<IconDeviceFloppy size={14} />
							</ActionIcon>
						</Tooltip>
					)}
				</Group>
			</Group>

			{state.confirmation && (
				<Alert
					color="yellow"
					icon={<IconAlertTriangle size={16} />}
					title={t("fileEditor.outsideWorkspaceTitle")}
					radius={0}
				>
					<Text size="xs" mb="xs">
						{state.confirmation.message}
					</Text>
					{/* The RESOLVED path, which is the only thing worth confirming: it differs
					    from the path the user typed exactly when a link redirected the write,
					    and that is the case where consent must not be based on appearances. */}
					<Text size="xs" ff="monospace" mb="xs" style={{ wordBreak: "break-all" }}>
						{state.confirmation.physicalPath}
					</Text>
					<Group gap="xs">
						<Button
							size="xs"
							color="yellow"
							onClick={() => void performSave(true)}
							loading={state.saving}
						>
							{t("fileEditor.outsideWorkspaceConfirm")}
						</Button>
						<Button
							size="xs"
							variant="default"
							onClick={() => {
								setState((prev) => (prev ? dismissConfirmation(prev) : prev));
							}}
						>
							{t("fileEditor.outsideWorkspaceCancel")}
						</Button>
					</Group>
				</Alert>
			)}

			{state.conflict && (
				<Alert
					color="orange"
					icon={<IconAlertTriangle size={16} />}
					title={t("fileEditor.conflictTitle")}
					radius={0}
				>
					<Text size="xs" mb="xs">
						{t("fileEditor.conflictBody")}
					</Text>
					{/* The difference is shown BEFORE either choice is offered: "keep mine"
					    advances the optimistic lock, so it must not be reachable without the
					    user having seen what it would overwrite. */}
					<Box mb="xs" style={{ maxHeight: 240, overflow: "auto" }}>
						<Suspense fallback={<Loader size="xs" />}>
							<DiffView
								oldStr={state.conflict.theirContent}
								newStr={state.buffer}
								language={getShikiLang(filePath)}
								maxHeight={240}
							/>
						</Suspense>
					</Box>
					<Group gap="xs">
						<Button
							size="xs"
							color="orange"
							onClick={() => {
								setState((prev) => (prev ? resolveConflictKeepingMine(prev) : prev));
							}}
						>
							{t("fileEditor.conflictKeepMine")}
						</Button>
						<Button
							size="xs"
							variant="default"
							onClick={() => {
								setState((prev) => (prev ? resolveConflictTakingTheirs(prev) : prev));
							}}
						>
							{t("fileEditor.conflictTakeTheirs")}
						</Button>
					</Group>
				</Alert>
			)}

			<Box style={{ flex: 1, minHeight: 0 }}>
				<CodeMirrorEditor
					value={state.buffer}
					language={getShikiLang(filePath)}
					onChange={handleChange}
					onSave={handleSave}
					selection={selection}
					navigationRequestId={navigationRequestId}
					onSelectionChange={handleSelectionChange}
					readOnly={readOnly || loading}
					lineWrapping={lineWrapping}
					searchRequestId={searchRequestId}
					phrases={phrases}
					ariaLabel={filePath}
				/>
			</Box>
		</Box>
	);
}

/** Re-exported so the panel can reset the editor when the path changes. */
export { reloaded };
