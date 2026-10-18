import { Alert, Button, Group, Text } from "@mantine/core";
import type { EditorRecoveryScope } from "@shared/editor-document";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { editorDocumentApi } from "../../../lib/api/editor-documents";
import { saveBlobAsFile } from "../../../lib/file-download";
import { editorDocumentRegistry } from "./editor-document-registry";
import { queryDraftOperation } from "./editor-draft-checkpoint";
import {
	claimDraftForRecovery,
	type RecoverableEditorDraft,
	recoverableDraftFormat,
	verifyDraftProvenance,
} from "./editor-draft-provenance";
import { editorDraftStore, editorDraftWriterId } from "./editor-draft-store";
import { sessionDirty } from "./editor-session-state";
import type { EditorWorkingCopy, WorkingCopyOptions } from "./editor-working-copy";

/** Outside FileEditorContent and LargeFileGate: original owners can export even when
 * today's file is missing, inaccessible in this execution context, or cannot be opened. */
export function EditorDraftRecovery({
	options,
	exclude,
	visible,
	authorizeScope,
}: {
	options: WorkingCopyOptions;
	exclude: Promise<EditorWorkingCopy | null>;
	visible: boolean;
	authorizeScope: (signal: AbortSignal) => Promise<EditorRecoveryScope>;
}) {
	const [rows, setRows] = useState<RecoverableEditorDraft[]>([]);
	const [copy, setCopy] = useState<EditorWorkingCopy | null>(null);
	const [authorizedResource, setAuthorizedResource] = useState<string | null>(null);
	const [incomplete, setIncomplete] = useState(false);
	const { t } = useTranslation("narrator");
	const identity = JSON.stringify([
		options.narratorId,
		options.deviceId,
		options.path,
		options.origin(),
	]);
	const latest = useRef(options);
	latest.current = options;
	// biome-ignore lint/correctness/useExhaustiveDependencies: identity fences late discovery without depending on unstable option closures
	useEffect(() => {
		if (!visible || !latest.current.narratorId) {
			setRows([]);
			setCopy(null);
			setIncomplete(false);
			return;
		}
		const controller = new AbortController();
		setRows([]);
		setCopy(null);
		setAuthorizedResource(null);
		setIncomplete(false);
		void (async () => {
			const current = await exclude;
			controller.signal.throwIfAborted();
			const opts = latest.current;
			// Always refresh ACL/owner proof on visibility, including an already retained view.
			// Neither a previous create, client JWT hint nor path grants draft discovery.
			const scope = await authorizeScope(controller.signal);
			controller.signal.throwIfAborted();
			if (current?.draftScope?.recoveryKey === scope.recoveryKey) setCopy(current);
			const candidates = await editorDraftStore.list(scope.recoveryKey, controller.signal);
			controller.signal.throwIfAborted();
			const matching = candidates.filter(
				(row) =>
					row.scope.narratorId === opts.narratorId &&
					row.scope.deviceId === opts.deviceId &&
					row.scope.origin === opts.origin() &&
					(row.scope.canonicalPath === (current?.draftScope?.canonicalPath ?? opts.path) ||
						(!current && row.scope.requestedPath === opts.path)) &&
					row.writerId !== editorDraftWriterId,
			);
			if (current && matching.length) {
				try {
					const descriptor = await editorDocumentApi.create(
						opts.narratorId,
						{
							path: opts.path,
							deviceId: opts.deviceId,
							origin: opts.origin(),
							...(current?.protocol === "raw-v2"
								? {
										protocol: "raw-v2" as const,
										encodingHint: current.options.encodingHint,
									}
								: {}),
						},
						controller.signal,
					);
					void editorDocumentApi.release(opts.narratorId, descriptor.docId).catch(() => {});
					controller.signal.throwIfAborted();
					if (descriptor.recoveryKey === scope.recoveryKey)
						setAuthorizedResource(descriptor.stableResourceKey ?? descriptor.resourceKey ?? null);
				} catch {
					controller.signal.throwIfAborted(); /* original owner may still export */
				}
			}
			controller.signal.throwIfAborted();
			const verified = await verifyDraftProvenance(matching, controller.signal);
			if (verified.length) {
				const fresh = await editorDocumentApi.recoveryScope(
					opts.narratorId,
					{ deviceId: opts.deviceId, origin: opts.origin() },
					controller.signal,
				);
				if (fresh.recoveryKey !== scope.recoveryKey) throw new Error("EDITOR_DRAFT_OWNER_CHANGED");
			}
			controller.signal.throwIfAborted();
			setRows(verified);
		})().catch(() => {
			if (!controller.signal.aborted) setIncomplete(true);
		});
		return () => controller.abort();
	}, [identity, exclude, visible, authorizeScope]);
	return (
		<>
			{copy && <EditorDraftStatus copy={copy} />}
			{incomplete && (
				<Text size="xs" c="yellow" data-editor-backup-incomplete>
					{t("fileEditor.backupIncomplete")}
				</Text>
			)}
			{rows.map((row) => (
				<DraftCandidate
					key={row.id}
					row={row}
					copy={copy}
					options={options}
					authorizedResource={authorizedResource}
				/>
			))}
		</>
	);
}
export function EditorDraftStatus({ copy }: { copy: EditorWorkingCopy }) {
	const state = useSyncExternalStore(copy.subscribe, copy.getSnapshot, copy.getSnapshot);
	const { t } = useTranslation("narrator");
	return (
		<>
			{state.formatProtected && state.formatReady && (
				<Text size="xs" c="yellow" data-editor-format-protected>
					{t("fileEditor.formatBudget")}
				</Text>
			)}
			{state.backupIncomplete && (
				<Text size="xs" c="yellow" data-editor-backup-incomplete>
					{t("fileEditor.backupIncomplete")}
				</Text>
			)}
			{state.restoredDraft && (
				<Text size="xs" c="yellow" data-editor-draft-restored>
					{t(
						state.restoredDiskChanged ? "fileEditor.draftDiskChanged" : "fileEditor.draftRestored",
					)}
				</Text>
			)}
		</>
	);
}
let recoveryBodyInUse = false;
const noSubscribe = () => () => {};
const noSnapshot = () => null;
function DraftCandidate({
	row,
	copy,
	options,
	authorizedResource,
}: {
	row: RecoverableEditorDraft;
	copy: EditorWorkingCopy | null;
	options: WorkingCopyOptions;
	authorizedResource: string | null;
}) {
	const { t } = useTranslation("narrator");
	const [busy, setBusy] = useState(false),
		[error, setError] = useState(false),
		[restored, setRestored] = useState(false);
	const [receipt, setReceipt] = useState<string | null>(null);
	const [formatUnavailable, setFormatUnavailable] = useState(false);
	const state = useSyncExternalStore(
		copy?.subscribe ?? noSubscribe,
		copy?.getSnapshot ?? noSnapshot,
		copy?.getSnapshot ?? noSnapshot,
	);
	const pending = useRef<AbortController | null>(null);
	useEffect(() => () => pending.current?.abort(), []);
	const run = async (action: "restore" | "export" | "query") => {
		if (busy) return;
		const expectedRevision = copy?.getSnapshot().version?.revision;
		const expectedLifetime = copy?.lifetimeId;
		const controller = new AbortController();
		pending.current = controller;
		setBusy(true);
		setError(false);
		let release: (() => void) | undefined;
		let bodyOwned = false;
		try {
			const scope = await editorDocumentApi.recoveryScope(
				options.narratorId,
				{ deviceId: options.deviceId, origin: options.origin() },
				controller.signal,
			);
			if (scope.recoveryKey !== row.scope.recoveryKey)
				throw new Error("EDITOR_DRAFT_OWNER_CHANGED");
			if (action === "query") {
				const result = await queryDraftOperation(row, controller.signal);
				controller.signal.throwIfAborted();
				setReceipt(result.status);
				return;
			}
			if (recoveryBodyInUse) throw new Error("EDITOR_DRAFT_RECOVERY_BUSY");
			recoveryBodyInUse = true;
			bodyOwned = true;
			const cost = row.bytes * 3 + row.length * 2;
			release = copy?.model
				? copy.pin("recovery-candidate", { models: 0, bytes: cost })
				: editorDocumentRegistry.reserveRecovery(cost);
			const blob = await editorDraftStore.read(row, scope.recoveryKey, controller.signal);
			controller.signal.throwIfAborted();
			if (action === "export") {
				// Keep the Blob's admission/pin and the single recovery slot until the
				// shared download helper actually revokes its object URL.
				await new Promise<void>((resolve) =>
					saveBlobAsFile(
						blob,
						row.bodyCodec === "utf8-v1"
							? "editor-recovered-draft.utf8.txt"
							: "editor-recovered-draft.bin",
						resolve,
					),
				);
				return;
			}
			if (!copy || !recoverableDraftFormat(row) || copy.key !== row.scope.resourceKey)
				throw new Error("EDITOR_DRAFT_READ_ONLY");
			const descriptor = await editorDocumentApi.create(
				options.narratorId,
				{
					path: options.path,
					deviceId: options.deviceId,
					origin: options.origin(),
					...(copy.protocol === "raw-v2"
						? {
								protocol: "raw-v2" as const,
								encodingHint: copy.options.encodingHint,
							}
						: {}),
				},
				controller.signal,
			);
			void editorDocumentApi.release(options.narratorId, descriptor.docId).catch(() => {});
			if (
				(descriptor.stableResourceKey ?? descriptor.resourceKey) !== row.scope.resourceKey ||
				descriptor.recoveryKey !== row.scope.recoveryKey
			)
				throw new Error("EDITOR_DRAFT_READ_ONLY");
			const sidecar =
				row.protocol === "raw-v2"
					? await editorDraftStore.readFormat(row, scope.recoveryKey, controller.signal)
					: undefined;
			await claimDraftForRecovery(row, controller.signal);
			if (sidecar) {
				if (copy.protocol !== "raw-v2" || !expectedLifetime)
					throw new Error("EDITOR_DRAFT_READ_ONLY");
				await copy.restoreRawDraft(blob, row, sidecar, controller.signal, {
					revision: expectedRevision,
					lifetime: expectedLifetime,
				});
				setRestored(true);
				return;
			}
			const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
				await blob.arrayBuffer(),
			);
			controller.signal.throwIfAborted();
			if (
				copy.lifetimeId !== expectedLifetime ||
				copy.getSnapshot().version?.revision !== expectedRevision ||
				text.length !== row.length ||
				sessionDirty(copy.getSnapshot()) ||
				!copy.session.restoreDraft(text, row.baseVersion.hash, row.encoding)
			)
				throw new Error("EDITOR_DRAFT_CHANGED");
			setRestored(true);
		} catch (error) {
			if (!controller.signal.aborted) {
				setError(true);
				if (error instanceof Error && /EDITOR_(FORMAT|DRAFT_CORRUPT)/.test(error.message))
					setFormatUnavailable(true);
			}
		} finally {
			release?.();
			if (bodyOwned) recoveryBodyInUse = false;
			if (!controller.signal.aborted) setBusy(false);
		}
	};
	if (restored) return null;
	const writable =
		!formatUnavailable &&
		!!copy?.model &&
		!state?.invalidated &&
		authorizedResource === row.scope.resourceKey &&
		copy.key === row.scope.resourceKey &&
		recoverableDraftFormat(row);
	return (
		<Alert
			color="yellow"
			radius={0}
			title={t("fileEditor.localDraftTitle")}
			data-editor-local-draft
			data-editor-draft-anchor={row.anchor?.anchorId}
		>
			<Text size="xs">
				{t(writable ? "fileEditor.localDraftAvailable" : "fileEditor.localDraftReadOnly")}
			</Text>
			{row.operation && <Text size="xs">{t("fileEditor.draftQueryFirst")}</Text>}
			{receipt && (
				<Text size="xs" data-editor-draft-receipt={receipt}>
					{t("fileEditor.draftReceipt", { status: receipt })}
				</Text>
			)}
			{error && (
				<Text size="xs" c="red">
					{t("fileEditor.backupIncomplete")}
				</Text>
			)}
			<Group gap="xs" mt="xs">
				{writable && (
					<Button
						size="compact-xs"
						disabled={busy || !state?.loaded || state.loading || sessionDirty(state)}
						onClick={() => void run("restore")}
						data-editor-draft-restore
					>
						{t("fileEditor.restoreLocalDraft")}
					</Button>
				)}
				<Button
					size="compact-xs"
					disabled={busy}
					onClick={() => void run("export")}
					data-editor-draft-export
				>
					{t(
						row.bodyCodec === "utf8-v1"
							? "fileEditor.exportLocalDraft"
							: "fileEditor.exportStoredDraft",
					)}
				</Button>
				{row.operation && (
					<Button
						size="compact-xs"
						disabled={busy}
						onClick={() => void run("query")}
						data-editor-draft-query
					>
						{t("fileEditor.checkSave")}
					</Button>
				)}
			</Group>
		</Alert>
	);
}
