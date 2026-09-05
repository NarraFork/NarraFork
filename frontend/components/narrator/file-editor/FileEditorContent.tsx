/**
 * FileEditorContent.tsx — editing a workspace file in the browser.
 *
 * Wraps the CodeMirror surface with the three things a save needs to be honest:
 * the optimistic lock, a conflict view built from the existing `DiffView`, and an
 * explicit choice when the lock fails. Editing is opt-in per panel — the default
 * remains the read-only viewer, so nothing about opening a file changes.
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
import { IconAlertTriangle, IconDeviceFloppy, IconRefresh } from "@tabler/icons-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, api } from "../../../lib/api";
import { getShikiLang } from "../../../lib/shiki-lang";
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

export interface FileEditorContentProps {
	/** Absolute path of the file being edited. */
	filePath: string;
	/** Narrator whose workspace bounds the write. Required by the server. */
	narratorId: string;
	/**
	 * Reports whether the buffer differs from disk.
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

export function FileEditorContent({ filePath, narratorId, onDirtyChange }: FileEditorContentProps) {
	const { t } = useTranslation("narrator");
	const [state, setState] = useState<EditorState | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
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
		setLoadError(null);
		try {
			// `/fs/edit-source`, not `/fs/preview`: preview decodes as UTF-8 unconditionally,
			// so saving a GBK file loaded through it would write replacement characters over
			// every un-decodable byte. This route reports the real encoding and refuses
			// files that cannot round-trip as text at all.
			const res = await api.fsEditSource(filePath);
			setEncoding(res.encoding);
			// The hash comes from the server, computed over the same decoded text — so the
			// lock cannot disagree with itself, and it works without WebCrypto.
			setState(initialEditorState(res.content, res.hash));
		} catch (err) {
			setLoadError(describeLoadError(err, t));
		}
	}, [filePath, t]);

	useEffect(() => {
		void load();
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
			if (!state || savingRef.current) return;

			const sending = state.buffer;
			savingRef.current = true;
			setState((prev) => (prev ? beginSave(prev) : prev));
			try {
				const result = await api.fsWrite({
					path: filePath,
					content: sending,
					narratorId,
					baseHash: state.baseHash,
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
								? saveConflicted(prev, data.currentContent as string, data.currentHash as string)
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
		[encoding, filePath, narratorId, state, t],
	);

	const handleSave = useCallback(() => {
		if (!state || !canSave(state)) return;
		void performSave(false);
	}, [performSave, state]);

	const handleChange = useCallback((buffer: string) => {
		setState((prev) => (prev ? applyEdit(prev, buffer) : prev));
	}, []);

	// Computed before the early returns below so the hook order stays fixed; the
	// render path re-reads it once `state` is known to be non-null.
	const dirty = state ? isDirty(state) : false;
	useEffect(() => {
		onDirtyChange?.(dirty);
	}, [dirty, onDirtyChange]);
	useEffect(
		() => () => {
			// On unmount the buffer is gone, so nothing is dirty any more — leaving the
			// flag set would keep the owner refusing an action there is no longer a
			// reason to refuse.
			onDirtyChange?.(false);
		},
		[onDirtyChange],
	);

	if (loadError) {
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
				<Group gap={6} wrap="nowrap">
					{dirty && (
						<Badge size="xs" color="yellow" variant="light">
							{t("fileEditor.unsaved")}
						</Badge>
					)}
					{state.error && (
						<Text size="xs" c="red" truncate>
							{state.error}
						</Text>
					)}
				</Group>
				<Group gap={4} wrap="nowrap">
					<Tooltip label={t("fileEditor.reload")} openDelay={200}>
						<ActionIcon
							variant="subtle"
							color="gray"
							size="sm"
							onClick={() => void load()}
							disabled={state.saving}
						>
							<IconRefresh size={14} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("fileEditor.save")} openDelay={200}>
						<ActionIcon
							variant={dirty ? "filled" : "subtle"}
							color={dirty ? "green" : "gray"}
							size="sm"
							onClick={handleSave}
							loading={state.saving}
							disabled={!canSave(state)}
						>
							<IconDeviceFloppy size={14} />
						</ActionIcon>
					</Tooltip>
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
				<CodeMirrorEditor value={state.buffer} onChange={handleChange} onSave={handleSave} />
			</Box>
		</Box>
	);
}

/** Re-exported so the panel can reset the editor when the path changes. */
export { reloaded };
