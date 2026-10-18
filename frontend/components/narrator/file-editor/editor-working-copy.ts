import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type {
	EditorDocumentDescriptor,
	EditorRawDocumentDescriptor,
} from "@shared/editor-document";
import { EditorStreamCodec } from "@shared/editor-stream-codec";
import type { editor } from "monaco-editor/editor/editor.api";
import { editorDocumentApi } from "../../../lib/api/editor-documents";
import { EditorDraftCheckpoint } from "./editor-draft-checkpoint";
import type { EditorDraftMetadata, EditorDraftScope } from "./editor-draft-store";
import {
	type EditorFormat,
	EditorFormatHistory,
	editorEolTag,
	restoreEditorFormat,
	serializeEditorFormat,
} from "./editor-format";
import { eolBytes } from "./editor-format-rope";
import { createEditorLocalId } from "./editor-local-id";
import { loadEditorRawCandidate } from "./editor-model-loader";
import {
	type EditorRawSnapshot,
	encodeEditorRawSnapshot,
	inspectEditorRawSnapshot,
} from "./editor-save-client";
import type { EditorRawSaveFormat } from "./editor-save-codec";
import {
	EditorDocumentSession,
	type EditorSessionOptions,
	sessionDirty,
	sessionExitBlocked,
} from "./editor-session-state";
import { captureEditorSnapshot, encodeEditorSnapshot } from "./editor-worker-client";
import { loadMonacoLanguage } from "./monaco-languages";
import { loadMonaco } from "./monaco-loader";
import { editorRawProfile } from "./monaco-profile";

export type WorkingCopyOptions = Pick<
	EditorSessionOptions,
	| "narratorId"
	| "path"
	| "deviceId"
	| "origin"
	| "translate"
	| "readOnlySource"
	| "protocol"
	| "encodingHint"
>;

/** Model creation is independent of any view, including preview-only consumers. */
export async function createWorkingCopyModel(
	path: string,
	key: string,
): Promise<editor.ITextModel> {
	const api = await loadMonaco();
	const language = await loadMonacoLanguage(api, path);
	return api.editor.createModel(
		"",
		language.language,
		api.Uri.from({
			scheme: "narrafork-editor",
			authority: "working-copy",
			path: `/${encodeURIComponent(key)}`,
			query: createEditorLocalId(),
		}),
	);
}

/** One mutable model, baseline and immutable save coordinator; views own no draft data. */
export class EditorWorkingCopy {
	readonly session: EditorDocumentSession;
	readonly key: string;
	readonly protocol: "text-v1" | "raw-v2";
	lifetimeId = createEditorLocalId();
	private formatHistory?: EditorFormatHistory;
	private rawEncoding?: EditorRawSaveFormat;
	private rawCodecSafe = false;
	get formatProtected() {
		return !!this.formatHistory?.protected;
	}
	get preferredEol() {
		return this.formatHistory?.preferred === 2
			? ("CRLF" as const)
			: this.formatHistory?.preferred === 3
				? ("CR" as const)
				: ("LF" as const);
	}
	captureSnapshot() {
		if (!this.model) throw new Error("Editor is not ready");
		const snapshot = captureEditorSnapshot(this.model);
		return this.protocol === "raw-v2"
			? Object.freeze({
					...snapshot,
					modelLifetime: this.lifetimeId,
					rawFormat: this.captureFormat(),
				})
			: { ...snapshot, modelLifetime: this.lifetimeId };
	}
	captureFormat(): EditorRawSaveFormat {
		if (!this.format || !this.rawEncoding) throw new Error("EDITOR_FORMAT_UNAVAILABLE");
		return Object.freeze({ ...this.rawEncoding, root: this.format });
	}
	readonly recoveryKey?: string;
	readonly draftScope?: EditorDraftScope;
	readonly draftCheckpoint?: EditorDraftCheckpoint;
	setBackupError(incomplete: boolean) {
		this.session.setBackupError(incomplete);
	}
	model: editor.ITextModel | null = null;
	format?: EditorFormat;
	rawLoadStats?: { batches: number; maxBatchMs: number; maxQueuedBytes: number };
	get pagedDocument(): EditorRawDocumentDescriptor | undefined {
		const current = this.session.currentDocument;
		return this.session.state.paged && current?.protocol === "raw-v2" ? current : undefined;
	}
	private listeners = new Set<() => void>();
	private subscription: { dispose(): void } | null = null;
	private loading: Promise<void> | null = null;
	private visible = true;
	private disposed = false;
	private generation = 0;
	private applying = false;
	private undoBytes = 0;
	private extraPins = new Map<string, number>();
	private reserved = { models: 0, bytes: 0 };
	private admissionBytes = 0;
	/** Explicit extension point for real candidate/recovery owners, never guessed raw bodies. */
	pin(reason: string, cost = { models: 0, bytes: 0 }) {
		if (
			!Number.isFinite(cost.bytes) ||
			cost.bytes < 0 ||
			!Number.isInteger(cost.models) ||
			cost.models < 0
		)
			throw new Error("Invalid editor resource reservation");
		const reserved = { ...cost };
		this.reserved.models += reserved.models;
		this.reserved.bytes += reserved.bytes;
		this.extraPins.set(reason, (this.extraPins.get(reason) ?? 0) + 1);
		this.emit();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.reserved.models -= reserved.models;
			this.reserved.bytes -= reserved.bytes;
			const count = (this.extraPins.get(reason) ?? 1) - 1;
			if (count) this.extraPins.set(reason, count);
			else this.extraPins.delete(reason);
			this.emit();
		};
	}
	get hasResourcePins() {
		return this.extraPins.size > 0;
	}
	get pinReasons() {
		const state = this.session.state;
		return [
			...(sessionDirty(state) ? ["dirty"] : []),
			...(state.phase !== "idle" ? [state.phase] : []),
			...(state.loading || this.loading ? ["loading"] : []),
			...(state.confirmation ? ["confirmation"] : []),
			...(state.conflict ? ["conflict"] : []),
			...this.extraPins.keys(),
		];
	}
	get resourceCosts() {
		const model = this.model;
		return {
			models: (model || this.admissionBytes ? 1 : 0) + this.reserved.models,
			// Conservative accounting of UTF-16 text/index, retained baseline and edits.
			// Monaco/GC overhead is implementation-dependent: this is NOT a heap bound.
			bytes:
				(this.formatHistory?.bytes ?? (this.format ? eolBytes(this.format) : 0)) +
				this.reserved.bytes +
				Math.max(
					this.session.state.loaded ? 0 : this.admissionBytes,
					model
						? 4096 +
								model.getValueLength() * 6 +
								model.getLineCount() * 64 +
								this.undoBytes +
								this.session.resourceCosts.baselineBytes
						: 0,
				),
			documents: this.session.resourceCosts.documents + (this.seed ? 1 : 0),
			loads: this.loading ? 1 : 0,
		};
	}
	private beforeApply = new Set<(nextModel?: editor.ITextModel | null) => () => void>();
	onWillApply = (listener: (nextModel?: editor.ITextModel | null) => () => void) => {
		this.beforeApply.add(listener);
		return () => {
			this.beforeApply.delete(listener);
		};
	};
	private seed: EditorDocumentDescriptor | undefined;
	constructor(
		readonly options: WorkingCopyOptions,
		descriptor?: EditorDocumentDescriptor,
	) {
		this.key = descriptor?.stableResourceKey ?? descriptor?.resourceKey ?? createEditorLocalId();
		this.protocol = descriptor
			? (descriptor.protocol ?? "text-v1")
			: (options.protocol ?? "text-v1");
		this.recoveryKey = descriptor?.recoveryKey;
		this.seed = descriptor;
		// V1 has no full text profile. Reserve a soft estimate from authorized metadata
		// before allocating the foreground model, then account actual text/index/history.
		this.admissionBytes =
			descriptor?.protocol === "raw-v2"
				? editorRawProfile(descriptor).paged
					? 0
					: 4096 + descriptor.textLength * 6 + descriptor.lineCount * 65
				: descriptor
					? 4096 + Math.max(descriptor.utf8Bytes, descriptor.sourceBytes) * 12
					: 0;
		this.session = new EditorDocumentSession({
			...options,
			protocol: this.protocol,
			resourceKey: descriptor?.resourceKey,
			stableResourceKey: descriptor?.stableResourceKey,
			snapshot: () => this.captureSnapshot(),
			rawReady: () => ({
				formatReady: !!this.format && !!this.rawEncoding,
				codecSafe: this.rawCodecSafe,
				formatProtected: this.formatProtected,
			}),
			encodeRaw: (snapshot, signal) =>
				encodeEditorRawSnapshot(snapshot as EditorRawSnapshot, signal),
			encode: encodeEditorSnapshot,
			api: {
				...editorDocumentApi,
				create: async (...args) => {
					if (this.seed) {
						const seed = this.seed;
						this.seed = undefined;
						return seed;
					}
					return editorDocumentApi.create(...args);
				},
			},
			loadRaw: async (document, signal) => {
				const generation = this.generation;
				if (editorRawProfile(document).paged) {
					return {
						paged: true,
						install: () => {
							signal.throwIfAborted();
							if (this.disposed || generation !== this.generation)
								throw new Error("EDITOR_LOAD_SUPERSEDED");
							this.format = undefined;
							this.rawLoadStats = undefined;
							this.admissionBytes = 0;
							this.replaceModel(null);
							return null;
						},
						dispose() {},
					};
				}
				this.admissionBytes = 0;
				const release = this.pin("candidate", {
					models: 1,
					bytes: 4096 + document.textLength * 6 + document.lineCount * 65,
				});
				let candidate: Awaited<ReturnType<typeof loadEditorRawCandidate>>;
				try {
					candidate = await loadEditorRawCandidate({
						document,
						path: options.path,
						signal,
						read: (consume, credit) =>
							editorDocumentApi.rawSource(options.narratorId, document, consume, signal, credit),
					});
				} catch (error) {
					release();
					throw error;
				}
				let codecSafe = true;
				if (document.encoding === "gbk" || document.encoding === "gb18030") {
					try {
						const encoded = await inspectEditorRawSnapshot(
							{
								...captureEditorSnapshot(candidate.model),
								modelLifetime: createEditorLocalId(),
								rawFormat: {
									root: candidate.format,
									encoding: document.encoding,
									bom: document.bom,
								},
							},
							signal,
						);
						codecSafe = encoded.rawDigest === document.baseHash;
					} catch {
						codecSafe = false;
					}
				}
				let installed = false;
				return {
					install: () => {
						signal.throwIfAborted();
						if (this.disposed || generation !== this.generation)
							throw new Error("EDITOR_LOAD_SUPERSEDED");
						this.format = candidate.format;
						this.rawLoadStats = {
							batches: candidate.batches,
							maxBatchMs: candidate.maxBatchMs,
							maxQueuedBytes: candidate.maxQueuedBytes,
						};
						this.rawEncoding = {
							root: candidate.format,
							encoding: document.encoding,
							bom: document.bom,
						};
						this.rawCodecSafe = codecSafe;
						this.replaceModel(candidate.model);
						this.formatHistory = new EditorFormatHistory(
							candidate.format,
							candidate.model.getAlternativeVersionId(),
							editorEolTag(document.preferredEol),
						);
						installed = true;
						release();
						return this.version();
					},
					dispose: () => {
						if (!installed) candidate.model.dispose();
						release();
					},
				};
			},
			applyContent: (text) => {
				if (!this.model || this.disposed) throw new Error("Editor closed");
				const restore = [...this.beforeApply].map((listener) => listener());
				this.applying = true;
				try {
					this.model.setValue(text);
					this.undoBytes = 0;
				} finally {
					this.applying = false;
				}
				for (const listener of restore) listener();
				return this.version();
			},
			onChange: () => this.emit(),
			beforeDispatch: (operation) =>
				this.draftCheckpoint?.beforeDispatch(operation) ?? Promise.resolve(undefined),
			onSaved: (revision, lifetime) => {
				void this.draftCheckpoint?.saved(revision, lifetime);
			},
		});
		if (descriptor?.resourceKey && descriptor.recoveryKey && !options.readOnlySource) {
			this.draftScope = {
				recoveryKey: descriptor.recoveryKey,
				resourceKey: descriptor.stableResourceKey ?? descriptor.resourceKey,
				narratorId: options.narratorId,
				deviceId: options.deviceId,
				origin: options.origin(),
				canonicalPath: descriptor.target.path,
				requestedPath: options.path,
			};
			this.draftCheckpoint = new EditorDraftCheckpoint(this, this.draftScope);
		}
	}
	async restoreRawDraft(
		blob: Blob,
		row: EditorDraftMetadata,
		tags: Uint8Array,
		signal: AbortSignal,
		expected: { revision?: number; lifetime: string },
	) {
		const document = this.session.currentDocument;
		if (
			document?.protocol !== "raw-v2" ||
			row.protocol !== "raw-v2" ||
			!["LF", "CRLF", "CR"].includes(row.preferredEol ?? "") ||
			blob.size > 20 * 1024 * 1024
		)
			throw new Error("EDITOR_DRAFT_READ_ONLY");
		const codec = new EditorStreamCodec(row.encoding as EditorRawDocumentDescriptor["encoding"]),
			formatHash = sha256.create();
		const read = async (
			consume: (bytes: Uint8Array<ArrayBuffer>, eof: boolean) => Promise<void>,
		) => {
			for (let offset = 0; offset < blob.size; offset += 64 * 1024) {
				signal.throwIfAborted();
				await consume(
					new Uint8Array(await blob.slice(offset, offset + 64 * 1024).arrayBuffer()),
					false,
				);
			}
			await consume(new Uint8Array(), true);
		};
		await read(async (bytes, eof) => {
			formatHash.update(codec.push(bytes, eof).tags);
		});
		const metadata = codec.finish();
		if (
			metadata.baseHash !== row.rawDigest ||
			metadata.textDigest !== row.textDigest ||
			metadata.textLength !== row.length ||
			metadata.bom !== row.bom ||
			bytesToHex(formatHash.digest()) !== bytesToHex(sha256(tags))
		)
			throw new Error("EDITOR_DRAFT_CORRUPT");
		const root = restoreEditorFormat(tags, metadata.lineCount - 1);
		const candidate = await loadEditorRawCandidate({
			document: { ...document, ...metadata },
			path: this.options.path,
			signal,
			read,
		});
		let installed = false;
		try {
			if (metadata.encoding === "gbk" || metadata.encoding === "gb18030") {
				const checked = await inspectEditorRawSnapshot(
					{
						...captureEditorSnapshot(candidate.model),
						modelLifetime: createEditorLocalId(),
						rawFormat: { root, encoding: metadata.encoding, bom: metadata.bom },
					},
					signal,
				);
				if (checked.rawDigest !== metadata.baseHash) throw new Error("EDITOR_DRAFT_READ_ONLY");
			}
			signal.throwIfAborted();
			if (this.lifetimeId !== expected.lifetime || this.model?.getVersionId() !== expected.revision)
				throw new Error("EDITOR_DRAFT_CHANGED");
			if (
				!this.session.restoreDraft("", row.baseVersion.hash, row.encoding, () => {
					if (
						bytesToHex(sha256(serializeEditorFormat(candidate.format))) !== bytesToHex(sha256(tags))
					)
						throw new Error("EDITOR_FORMAT_MISMATCH");
					this.format = root;
					this.rawEncoding = { root, encoding: metadata.encoding, bom: metadata.bom };
					this.rawCodecSafe = true;
					this.replaceModel(candidate.model);
					this.formatHistory = new EditorFormatHistory(
						root,
						candidate.model.getAlternativeVersionId(),
						editorEolTag(row.preferredEol as "LF" | "CRLF" | "CR"),
					);
					installed = true;
					return this.version();
				})
			)
				throw new Error("EDITOR_DRAFT_CHANGED");
		} finally {
			if (!installed) candidate.model.dispose();
		}
	}
	private replaceModel(next: editor.ITextModel | null) {
		const restore = [...this.beforeApply].map((listener) => listener(next));
		const old = this.model;
		this.subscription?.dispose();
		this.model = next;
		this.lifetimeId = createEditorLocalId();
		this.formatHistory = undefined;
		this.undoBytes = 0;
		this.watchModel();
		for (const listener of restore) listener();
		// Every attached view switches/detaches before disposing the old shared model.
		old?.dispose();
	}
	private watchModel() {
		this.subscription =
			this.model?.onDidChangeContent((event) => {
				if (!this.applying) {
					for (const change of event.changes ?? [])
						this.undoBytes += (change.rangeLength + change.text.length) * 2 + 64;
					if (this.formatHistory && this.model) {
						try {
							this.format = this.formatHistory.change(
								event,
								this.model.getAlternativeVersionId(),
								this.model.getLineCount() - 1,
							);
						} catch {
							this.rawCodecSafe = false;
							this.format = undefined;
							this.formatHistory.protected = true;
							this.session.setFormatFailure();
						}
					}
					this.session.change(this.version());
				}
			}) ?? null;
	}
	private version() {
		if (!this.model) throw new Error("Editor is not ready");
		return {
			modelLifetime: this.lifetimeId,
			revision: this.model.getVersionId(),
			alternativeVersionId: this.model.getAlternativeVersionId(),
			length: this.model.getValueLength(),
		};
	}
	getSnapshot = () => this.session.state;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	private emit() {
		this.draftCheckpoint?.changed();
		for (const listener of this.listeners) listener();
	}
	get protected() {
		return (
			sessionExitBlocked(this.session.state) ||
			!!this.session.state.confirmation ||
			!!this.session.state.conflict
		);
	}
	setVisible(visible: boolean) {
		if (this.visible === visible) return;
		this.visible = visible;
		if (!visible) {
			this.session.cancelBackgroundVerification();
			this.session.cancelRawLoad();
		} else if (this.protocol === "raw-v2" && !this.session.state.loaded) void this.ensureLoaded();
	}
	ensureLoaded(): Promise<void> {
		if (
			this.disposed ||
			this.session.state.invalidated ||
			this.session.state.loaded ||
			(this.protocol === "raw-v2" && !this.visible)
		)
			return Promise.resolve();
		if (this.loading) return this.loading;
		const generation = this.generation;
		this.loading = (async () => {
			if (!this.model && this.protocol !== "raw-v2") {
				const model = await createWorkingCopyModel(this.options.path, this.key);
				if (this.disposed || generation !== this.generation) {
					model.dispose();
					return;
				}
				this.model = model;
				this.watchModel();
			}
			await this.session.load();
		})().finally(() => {
			this.loading = null;
			this.emit();
			const state = this.session.state;
			// Reveal may precede completion of the old cancellation. Retry only that
			// uninstalled, error-free raw load after its candidate has been disposed.
			if (
				this.protocol === "raw-v2" &&
				this.visible &&
				!this.disposed &&
				!state.loaded &&
				!state.loading &&
				!state.invalidated &&
				!state.error
			)
				void this.ensureLoaded();
		});
		return this.loading;
	}
	invalidate(reason: string) {
		this.generation++;
		this.session.invalidate(reason);
		if (this.seed)
			void editorDocumentApi.release(this.options.narratorId, this.seed.docId).catch(() => {});
		this.seed = undefined;
	}
	discardRetainedDraft(): boolean {
		if (!this.session.discardRetainedDraft()) return false;
		this.dispose();
		return true;
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.generation++;
		this.draftCheckpoint?.dispose();
		this.subscription?.dispose();
		this.session.dispose();
		this.model?.dispose();
		this.model = null;
		this.admissionBytes = 0;
		if (this.seed)
			void editorDocumentApi.release(this.options.narratorId, this.seed.docId).catch(() => {});
		this.seed = undefined;
		this.beforeApply.clear();
		this.listeners.clear();
	}
}
