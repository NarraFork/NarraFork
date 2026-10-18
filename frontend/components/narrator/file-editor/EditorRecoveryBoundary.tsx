import { Alert, Box, Button, Group, Text } from "@mantine/core";
import type { EditorReadMode, EditorRecoveryScope } from "@shared/editor-document";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../../lib/api/client";
import { editorDocumentApi } from "../../../lib/api/editor-documents";
import { saveBlobAsFile } from "../../../lib/file-download";
import { useEditorPanelVisible } from "../narrator-panel-visibility";
import { filePanelBaseName } from "../panels/panel-kind";
import { EditorDraftRecovery } from "./EditorDraftRecovery";
import { useEditorAuthority } from "./editor-authority";
import { editorDocumentRegistry } from "./editor-document-registry";
import type { EditorSessionState } from "./editor-session-state";
import { captureEditorSnapshot, encodeEditorSnapshot } from "./editor-worker-client";
import type { EditorWorkingCopy, WorkingCopyOptions } from "./editor-working-copy";

export interface EditorRecoveryScopeProps {
	filePath: string;
	narratorId?: string;
	deviceId?: string;
	referenceOrigin?: boolean;
	rawProtocol?: boolean;
}
export function readEditorProtocol(explicit?: boolean): "text-v1" | "raw-v2" {
	return explicit === false ? "text-v1" : "raw-v2";
}
export function editorRecoveryScopeIdentity(props: EditorRecoveryScopeProps) {
	return JSON.stringify([
		props.narratorId ?? "",
		props.deviceId ?? "local",
		props.filePath,
		!!props.referenceOrigin,
	]);
}
function exclusionSlot() {
	let resolve!: (copy: EditorWorkingCopy | null | PromiseLike<EditorWorkingCopy | null>) => void;
	const exclude = new Promise<EditorWorkingCopy | null>((done) => {
		resolve = done;
	});
	return {
		exclude,
		resolve,
		kind: "pending" as "pending" | "view" | "blocked",
		token: null as symbol | null,
	};
}
/** Coordinates only lifecycle metadata. Neither gate status nor this context grants file access. */
class RecoveryHost {
	private slot = exclusionSlot();
	private snapshot = { epoch: 0, exclude: this.slot.exclude };
	readMode?: EditorReadMode;
	private listeners = new Set<() => void>();
	private gateAttempt: number | undefined;
	constructor(
		readonly identity: string,
		readonly protocol: "text-v1" | "raw-v2",
	) {}
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	getSnapshot = () => this.snapshot;
	/** Target negotiation only, never a file permission or a body/model binding. */
	setReadMode(readMode: EditorReadMode) {
		this.readMode = readMode;
	}
	private replace() {
		this.slot = exclusionSlot();
		this.snapshot = {
			...this.snapshot,
			epoch: this.snapshot.epoch + 1,
			exclude: this.slot.exclude,
		};
		for (const listener of this.listeners) listener();
	}
	registerViewing(viewing: Promise<EditorWorkingCopy | null>) {
		if (this.slot.kind !== "pending") this.replace();
		const token = Symbol("editor-view");
		this.slot.kind = "view";
		this.slot.token = token;
		this.slot.resolve(viewing);
		let active = true;
		let unsubscribe: (() => void) | undefined;
		void viewing.then((copy) => {
			if (!active || !copy) return;
			let invalidated = !!copy.getSnapshot().invalidated;
			unsubscribe = copy.subscribe(() => {
				const next = !!copy.getSnapshot().invalidated;
				if (next === invalidated || this.slot.token !== token) return;
				invalidated = next;
				this.snapshot = {
					...this.snapshot,
					epoch: this.snapshot.epoch + 1,
					exclude: this.slot.exclude,
				};
				for (const listener of this.listeners) listener();
			});
		});
		return () => {
			active = false;
			unsubscribe?.();
			if (this.slot.token === token) this.slot.token = null;
		};
	}
	gate(kind: "pending" | "editor" | "blocked", attempt: number) {
		if (
			kind === "pending" &&
			this.gateAttempt !== undefined &&
			this.gateAttempt !== attempt &&
			this.slot.kind === "blocked"
		)
			this.replace();
		this.gateAttempt = attempt;
		if (kind !== "blocked" || this.slot.kind === "blocked") return;
		if (this.slot.kind === "view") this.replace();
		this.slot.kind = "blocked";
		this.slot.resolve(null);
	}
}
const RecoveryHostContext = createContext<RecoveryHost | null>(null);
export function useEditorRecoveryHost(props: EditorRecoveryScopeProps) {
	const host = useContext(RecoveryHostContext);
	return host?.identity === editorRecoveryScopeIdentity(props) &&
		(props.rawProtocol === undefined || host.protocol === readEditorProtocol(props.rawProtocol))
		? host
		: null;
}

/** Stable outside metadata/size gates, including when the editable child never mounts. */
export function EditorRecoveryBoundary(props: EditorRecoveryScopeProps & { children: ReactNode }) {
	const { t } = useTranslation("narrator");
	const principal = useEditorAuthority(props.narratorId, t("fileEditor.identityChanged"));
	const [defaultProtocol] = useState(() => readEditorProtocol());
	const protocol =
		props.rawProtocol === undefined ? defaultProtocol : readEditorProtocol(props.rawProtocol);
	// Origin updates retain the host DOM; the independently keyed coordinator and editor
	// binding still forbid migrating an old draft to a different authorization origin.
	return (
		<RecoveryBoundaryIdentity
			key={JSON.stringify([
				principal,
				props.narratorId,
				props.deviceId ?? "local",
				props.filePath,
				protocol,
			])}
			{...props}
			protocol={protocol}
		/>
	);
}
function RecoveryBoundaryIdentity({
	filePath,
	narratorId,
	deviceId = "local",
	referenceOrigin = false,
	protocol,
	children,
}: EditorRecoveryScopeProps & { children: ReactNode; protocol: "text-v1" | "raw-v2" }) {
	const { t } = useTranslation("narrator");
	const latest = useRef(t);
	latest.current = t;
	const identity = editorRecoveryScopeIdentity({ filePath, narratorId, deviceId, referenceOrigin });
	const host = useMemo(() => new RecoveryHost(identity, protocol), [identity, protocol]);
	const request = useSyncExternalStore(host.subscribe, host.getSnapshot, host.getSnapshot);
	const [retained, setRetained] = useState<readonly EditorWorkingCopy[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [publishedFor, setPublishedFor] = useState<typeof request | null>(null);
	const visible = useEditorPanelVisible();
	// Coalesce only this visible discovery generation, not a cross-request ACL cache.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new visible request must obtain fresh ACL proof
	const authorizeScope = useMemo(() => {
		let pending: Promise<EditorRecoveryScope> | undefined;
		let ownerSignal: AbortSignal | undefined;
		return (signal: AbortSignal) => {
			if (!pending || ownerSignal?.aborted) {
				ownerSignal = signal;
				pending = editorDocumentApi.recoveryScope(
					narratorId ?? "",
					{ deviceId, origin: referenceOrigin ? "reference" : "legacy" },
					signal,
				);
			}
			return pending;
		};
	}, [narratorId, deviceId, referenceOrigin, request, visible]);
	useEffect(() => {
		if (!visible) return;
		setRetained([]);
		setError(null);
		setPublishedFor(null);
		const controller = new AbortController();
		let release: (() => void) | undefined;
		const options: WorkingCopyOptions = {
			narratorId: narratorId ?? "",
			path: filePath,
			deviceId,
			protocol,
			origin: () => (referenceOrigin ? "reference" : "legacy"),
			translate: (key, defaultValue) => latest.current(`fileEditor.${key}`, { defaultValue }),
		};
		void editorDocumentRegistry
			.discoverRetained(options, controller.signal, request.exclude, authorizeScope)
			.then((lease) => {
				if (controller.signal.aborted) {
					lease.release();
					return;
				}
				release = lease.release;
				setRetained(lease.retainedCopies);
				setPublishedFor(request);
			})
			.catch((cause) => {
				if (controller.signal.aborted) return;
				setRetained([]);
				setError(cause instanceof Error ? cause.message : String(cause));
				setPublishedFor(request);
				if (cause instanceof ApiError && [401, 403, 404].includes(cause.status) && narratorId)
					editorDocumentRegistry.invalidateNarrator(
						narratorId,
						latest.current("fileEditor.identityChanged"),
					);
			});
		return () => {
			controller.abort();
			release?.();
		};
	}, [narratorId, filePath, deviceId, referenceOrigin, request, visible, authorizeScope, protocol]);
	return (
		<RecoveryHostContext.Provider value={host}>
			<Box style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
				<EditorDraftRecovery
					visible={visible}
					exclude={request.exclude}
					authorizeScope={authorizeScope}
					options={{
						narratorId: narratorId ?? "",
						path: filePath,
						deviceId,
						protocol,
						origin: () => (referenceOrigin ? "reference" : "legacy"),
					}}
				/>
				{publishedFor === request &&
					retained.map((copy) => <RetainedEditorCopy key={copy.lifetimeId} copy={copy} />)}
				{publishedFor === request && error && (
					<Text c="red" size="xs" px="xs">
						{error}
					</Text>
				)}
				<Box style={{ flex: 1, minHeight: 0 }}>{children}</Box>
			</Box>
		</RecoveryHostContext.Provider>
	);
}

export function EditorReceiptNotice({ state }: { state: EditorSessionState }) {
	const { t } = useTranslation("narrator");
	const receipt = state.receipt;
	if (
		!receipt ||
		(receipt.status !== "saved" && receipt.status !== "failed" && receipt.status !== "not-applied")
	)
		return null;
	return (
		<Text size="xs" data-editor-retired-receipt={receipt.status}>
			{receipt.status === "saved"
				? t("fileEditor.receiptSaved")
				: receipt.status === "not-applied"
					? t("fileEditor.receiptNotApplied")
					: t("fileEditor.receiptFailed", {
							message: receipt.error?.message ?? receipt.error?.code ?? "",
						})}
		</Text>
	);
}
/** Kept separate from the newly authorized editor: neither querying nor exporting installs its draft. */
function RetainedEditorCopy({ copy }: { copy: EditorWorkingCopy }) {
	const { t } = useTranslation("narrator");
	const state = useSyncExternalStore(copy.subscribe, copy.getSnapshot, copy.getSnapshot);
	const [exporting, setExporting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const controller = useRef<AbortController | null>(null);
	useEffect(() => () => controller.current?.abort(), []);
	const download = async () => {
		if (!copy.model || exporting) return;
		const pending = new AbortController();
		controller.current = pending;
		setExporting(true);
		setError(null);
		try {
			const blob = await encodeEditorSnapshot(captureEditorSnapshot(copy.model), pending.signal);
			pending.signal.throwIfAborted();
			saveBlobAsFile(blob, `${filePanelBaseName(copy.options.path)}.retained-draft.utf8.txt`);
		} catch (cause) {
			if (!pending.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (!pending.signal.aborted) setExporting(false);
		}
	};
	const discard = async () => {
		if (!window.confirm(t("fileEditor.confirmDiscardRetained"))) return;
		if (!editorDocumentRegistry.canDiscardRetained(copy)) {
			setError(t("fileEditor.closeRetainedView"));
			return;
		}
		setExporting(true);
		try {
			if ((await copy.draftCheckpoint?.discard()) === false) {
				setError(t("fileEditor.backupIncomplete"));
				return;
			}
			if (!editorDocumentRegistry.discardRetained(copy))
				setError(t("fileEditor.closeRetainedView"));
		} finally {
			setExporting(false);
		}
	};
	if (state.discarded) return null;
	return (
		<Alert
			color="yellow"
			radius={0}
			title={t("fileEditor.retainedDraftTitle")}
			data-editor-retained-draft
		>
			<Text size="xs">{t("fileEditor.retainedDraftBody")}</Text>
			<EditorReceiptNotice state={state} />
			{(state.receiptError || error) && (
				<Text size="xs" c="red">
					{state.receiptError || error}
				</Text>
			)}
			<Group gap="xs" mt="xs">
				{state.phase === "unknown" && (
					<Button
						size="xs"
						loading={!!state.checkingReceipt}
						onClick={() => void copy.session.reconcile()}
					>
						{t("fileEditor.checkSave")}
					</Button>
				)}
				<Button
					size="xs"
					variant="default"
					loading={exporting}
					disabled={!copy.model}
					onClick={() => void download()}
				>
					{t("fileEditor.downloadRetainedDraft")}
				</Button>
				<Button
					size="xs"
					variant="subtle"
					color="red"
					disabled={state.phase !== "idle" || !!state.checkingReceipt || exporting}
					onClick={discard}
				>
					{t("fileEditor.discardRetainedDraft")}
				</Button>
			</Group>
		</Alert>
	);
}
