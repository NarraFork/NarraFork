import type { EditorRecoveryScope } from "@shared/editor-document";
import { editorDocumentApi } from "../../../lib/api/editor-documents";
import { EDITOR_CACHE_LIMITS, type EditorCacheItem, EditorModelCache } from "./editor-model-cache";
import { EditorWorkingCopy, type WorkingCopyOptions } from "./editor-working-copy";

interface Entry extends EditorCacheItem {
	copy: EditorWorkingCopy;
	canonicalKey: string;
	references: number;
	viewReferences: number;
	visible: number;
	evictionListeners: Set<() => void>;
	removeListener: () => void;
}
export interface EditorDocumentLease {
	copy: EditorWorkingCopy;
	setVisible(visible: boolean): void;
	release(): void;
}
export interface EditorRecoveryLease {
	/** One independently authorized recovery owner, never a duplicate editable view lease. */
	retainedCopies: readonly EditorWorkingCopy[];
	release(): void;
}

/** Realm-local only. A path (even an absolute path) is NEVER an authorization identity. */
export class EditorDocumentRegistry {
	private entries = new Set<Entry>();
	private recoveryBodies = new Set<{ bytes: number }>();
	reserveRecovery(bytes: number) {
		if (!Number.isFinite(bytes) || bytes < 0) throw new Error("Invalid recovery reservation");
		const cost = { bytes };
		this.recoveryBodies.add(cost);
		const release = this.cache.reserve({ models: 0, bytes });
		return () => {
			if (this.recoveryBodies.delete(cost)) release();
		};
	}
	private cache: EditorModelCache<Entry>;
	constructor(limits = EDITOR_CACHE_LIMITS, now = Date.now) {
		this.cache = new EditorModelCache<Entry>(limits, now);
	}
	private pendingLoads = 0;
	private tabs = 0;
	registerTab() {
		this.tabs++;
		return () => {
			this.tabs--;
		};
	}
	/** Explicit bounded metadata diagnostics; never reads text/snapshots/undo stacks. */
	diagnostics() {
		let models = 0,
			admittedModels = 0,
			bytes = 0,
			docs = 0,
			loads = this.pendingLoads,
			visible = 0,
			pinnedBytes = 0;
		const pinReasons: Record<string, number> = {};
		for (const cost of this.recoveryBodies) {
			bytes += cost.bytes;
			pinnedBytes += cost.bytes;
		}
		if (this.recoveryBodies.size) pinReasons["recovery-candidate"] = this.recoveryBodies.size;
		for (const entry of this.entries) {
			const cost = entry.copy.resourceCosts;
			models += entry.copy.model ? 1 : 0;
			admittedModels += cost.models;
			bytes += cost.bytes;
			docs += cost.documents;
			loads += cost.loads;
			visible += entry.visible;
			const reasons = entry.pins();
			if (reasons.length) pinnedBytes += cost.bytes;
			for (const reason of reasons) pinReasons[reason] = (pinReasons[reason] ?? 0) + 1;
		}
		return {
			tabs: this.tabs,
			workingCopies: this.entries.size,
			models,
			admittedModels,
			estimatedBytes: bytes,
			pinnedBytes,
			docs,
			loads,
			visibleConsumers: visible,
			pinReasons,
		};
	}
	private canonical = new Map<string, Entry>();
	private generations = new Map<string, number>();
	private removeUnload: (() => void) | undefined;
	private watchUnload() {
		if (this.removeUnload || typeof window === "undefined") return;
		const flush = () => {
			for (const entry of this.entries) entry.copy.draftCheckpoint?.flush();
		};
		const listener = (event: BeforeUnloadEvent) => {
			flush();
			if (![...this.entries].some((entry) => entry.copy.protected)) return;
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", listener);
		window.addEventListener("pagehide", flush);
		document.addEventListener("visibilitychange", flush);
		this.removeUnload = () => {
			window.removeEventListener("beforeunload", listener);
			window.removeEventListener("pagehide", flush);
			document.removeEventListener("visibilitychange", flush);
		};
	}
	async acquire(
		options: WorkingCopyOptions,
		signal: AbortSignal,
		onEvicted?: () => void,
	): Promise<EditorDocumentLease> {
		const generation = this.generations.get(options.narratorId) ?? 0;
		// Each new consumer is reauthorized. No provisional sharing without a complete known scope.
		this.pendingLoads++;
		const descriptor = await (options.readOnlySource
			? Promise.resolve(undefined)
			: editorDocumentApi.create(
					options.narratorId,
					{
						path: options.path,
						deviceId: options.deviceId,
						origin: options.origin(),
						...(options.protocol === "raw-v2"
							? { protocol: "raw-v2" as const, encodingHint: options.encodingHint }
							: {}),
					},
					signal,
				)
		).finally(() => {
			this.pendingLoads--;
		});
		const releaseExtra = () => {
			if (descriptor)
				void editorDocumentApi.release(options.narratorId, descriptor.docId).catch(() => {});
		};
		if (signal.aborted || generation !== (this.generations.get(options.narratorId) ?? 0)) {
			releaseExtra();
			signal.throwIfAborted();
			const fallback =
				"Editor authorization changed. The previous draft was preserved; reopen the file in its new context.";
			throw new Error(options.translate?.("identityChanged", fallback) ?? fallback);
		}
		const canonicalKey = descriptor?.resourceKey
			? `${descriptor.protocol ?? "text-v1"}:${descriptor.stableResourceKey ?? descriptor.resourceKey}`
			: undefined;
		let entry = canonicalKey ? this.canonical.get(canonicalKey) : undefined;
		if (entry?.copy.getSnapshot().invalidated) entry = undefined;
		if (entry) releaseExtra();
		else {
			const copy = new EditorWorkingCopy(options, descriptor);
			const owned: Entry = {
				copy,
				canonicalKey: canonicalKey ?? copy.key,
				references: 0,
				viewReferences: 0,
				visible: 0,
				evictionListeners: new Set(),
				removeListener: () => {},
				cost: () => copy.resourceCosts,
				pins: () => [
					...(owned.visible ? ["visible"] : []),
					...(owned.references > owned.viewReferences ? ["recovery"] : []),
					...copy.pinReasons,
				],
				evict: () => this.evict(owned),
			};
			entry = owned;
			entry.removeListener = copy.subscribe(() => this.collect(owned));
			this.entries.add(entry);
			this.cache.add(entry);
			this.canonical.set(entry.canonicalKey, entry);
			this.watchUnload();
		}
		if (descriptor?.recoveryKey) {
			const related = [...this.entries].filter(
				(other) =>
					other !== entry &&
					other.copy.recoveryKey === descriptor.recoveryKey &&
					other.copy.options.path === options.path,
			);
			// Only a same-protocol binding comparison proves an authorization change.
			// Once proved, freeze every corresponding copy, including other protocols.
			if (
				related.some(
					(other) =>
						!other.copy.getSnapshot().invalidated &&
						other.copy.protocol === entry.copy.protocol &&
						other.copy.key !== entry.copy.key,
				)
			)
				for (const other of related)
					other.copy.invalidate(
						options.translate?.(
							"identityChanged",
							"Editor authorization changed; the previous draft was preserved.",
						) ?? "Editor authorization changed; the previous draft was preserved.",
					);
		}
		const viewing = entry;
		viewing.viewReferences++;
		viewing.references++;
		viewing.visible++;
		viewing.copy.setVisible(true);
		this.cache.used(viewing);
		this.cache.enforce();
		if (onEvicted) viewing.evictionListeners.add(onEvicted);
		let released = false;
		let visible = true;
		const setVisible = (next: boolean) => {
			if (released || visible === next || !this.entries.has(viewing)) return;
			visible = next;
			viewing.visible += next ? 1 : -1;
			// Start idle time on last visible detach, not on background metadata updates.
			this.cache.used(viewing);
			viewing.copy.setVisible(viewing.visible > 0);
			this.collect(viewing);
		};
		return {
			copy: entry.copy,
			setVisible,
			release: () => {
				if (released) return;
				setVisible(false);
				released = true;
				if (onEvicted) viewing.evictionListeners.delete(onEvicted);
				viewing.viewReferences--;
				viewing.references--;
				this.collect(viewing);
			},
		};
	}
	/** Recovery authorization does not open or authorize the current file. The optional
	 * exclusion merely prevents presenting an ordinarily reacquired working copy twice. */
	async discoverRetained(
		options: WorkingCopyOptions,
		signal: AbortSignal,
		exclude: Promise<EditorWorkingCopy | null> = Promise.resolve(null),
		authorizeScope?: (signal: AbortSignal) => Promise<EditorRecoveryScope>,
	): Promise<EditorRecoveryLease> {
		const origin = options.origin();
		const generation = this.generations.get(options.narratorId) ?? 0;
		// A settled ordinary view needs no additional recovery request just because it
		// was hidden. Do not wait on a pending/failed gate: recovery remains independent.
		const alreadyViewing = await Promise.race([exclude, Promise.resolve(undefined)]);
		signal.throwIfAborted();
		if (generation !== (this.generations.get(options.narratorId) ?? 0))
			throw new Error(
				options.translate?.("identityChanged", "Editor authorization changed") ??
					"Editor authorization changed",
			);
		const candidates = [...this.entries].filter(
			(entry) =>
				entry.copy !== alreadyViewing &&
				(!alreadyViewing || entry.copy.protocol === alreadyViewing.protocol) &&
				entry.copy.recoveryKey &&
				entry.copy.protected &&
				entry.copy.options.narratorId === options.narratorId &&
				entry.copy.options.deviceId === options.deviceId &&
				entry.copy.options.origin() === origin &&
				entry.copy.options.path === options.path,
		);
		if (!candidates.length) return { retainedCopies: [], release: () => {} };
		// The path above is only a UI filter. ONLY this fresh, server-verified owner scope
		// may expose a previous draft; JWT/cache hints and a successful create are not proof.
		const scope = await (authorizeScope
			? authorizeScope(signal)
			: editorDocumentApi.recoveryScope(
					options.narratorId,
					{ deviceId: options.deviceId, origin },
					signal,
				));
		let removeAbort: (() => void) | undefined;
		const current = await Promise.race([
			exclude,
			new Promise<never>((_resolve, reject) => {
				const abort = () => reject(signal.reason);
				removeAbort = () => signal.removeEventListener("abort", abort);
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) abort();
			}),
		]).finally(() => removeAbort?.());
		signal.throwIfAborted();
		if (generation !== (this.generations.get(options.narratorId) ?? 0))
			throw new Error(
				options.translate?.("identityChanged", "Editor authorization changed") ??
					"Editor authorization changed",
			);
		const retained = candidates.filter(
			(entry) =>
				this.entries.has(entry) &&
				entry.copy !== current &&
				(!current || entry.copy.protocol === current.protocol) &&
				entry.copy.recoveryKey === scope.recoveryKey &&
				entry.copy.protected &&
				!entry.copy.getSnapshot().discarded,
		);
		for (const entry of retained) {
			entry.copy.invalidate(
				options.translate?.(
					"identityChanged",
					"Editor authorization changed; the previous draft was preserved.",
				) ?? "Editor authorization changed; the previous draft was preserved.",
			);
			entry.references++;
		}
		let released = false;
		return {
			retainedCopies: retained.map((entry) => entry.copy),
			release: () => {
				if (released) return;
				released = true;
				for (const entry of retained) {
					entry.references--;
					this.collect(entry);
				}
			},
		};
	}
	canDiscardRetained(copy: EditorWorkingCopy) {
		const entry = [...this.entries].find((candidate) => candidate.copy === copy);
		const state = copy.getSnapshot();
		return (
			!!entry &&
			entry.viewReferences === 0 &&
			!!state.invalidated &&
			state.phase === "idle" &&
			!state.checkingReceipt
		);
	}
	/** Called only after explicit user confirmation. Never dispose a model attached to an old view. */
	discardRetained(copy: EditorWorkingCopy): boolean {
		const entry = [...this.entries].find((candidate) => candidate.copy === copy);
		if (!entry || entry.viewReferences !== 0 || !copy.discardRetainedDraft()) return false;
		if (this.canonical.get(entry.canonicalKey) === entry) this.canonical.delete(entry.canonicalKey);
		this.entries.delete(entry);
		this.cache.remove(entry);
		entry.removeListener();
		if (!this.entries.size) {
			this.removeUnload?.();
			this.removeUnload = undefined;
		}
		return true;
	}
	private evict(entry: Entry) {
		if (!this.entries.delete(entry)) return;
		if (this.canonical.get(entry.canonicalKey) === entry) this.canonical.delete(entry.canonicalKey);
		entry.removeListener();
		entry.copy.dispose();
		for (const listener of entry.evictionListeners) listener();
		entry.evictionListeners.clear();
		if (!this.entries.size) {
			this.removeUnload?.();
			this.removeUnload = undefined;
		}
	}
	private collect(entry: Entry) {
		// Defer past React/StrictMode cleanup and the current save/content event.
		queueMicrotask(() => {
			if (!this.entries.has(entry)) return;
			if (
				!entry.visible &&
				!entry.copy.protected &&
				!entry.copy.hasResourcePins &&
				entry.references === entry.viewReferences &&
				(!entry.copy.getSnapshot().loaded ||
					(!entry.references && entry.copy.getSnapshot().invalidated))
			) {
				this.cache.remove(entry);
				this.evict(entry);
			} else this.cache.enforce();
		});
	}
	invalidateNarrator(narratorId: string, reason: string) {
		this.generations.set(narratorId, (this.generations.get(narratorId) ?? 0) + 1);
		for (const entry of this.entries.values())
			if (entry.copy.options.narratorId === narratorId) entry.copy.invalidate(reason);
	}
	/** Realm teardown only (isolated fixtures / realm owner), never panel or workspace cleanup.
	 * Normal UI teardown MUST release leases instead, preserving protected drafts. */
	shutdown() {
		this.cache.clear();
		for (const entry of this.entries) this.evict(entry);
	}
	/** Dirty/inflight orphans remain owned until explicitly resolved; never silently discard them. */
	get size() {
		return this.entries.size;
	}
}
export const editorDocumentRegistry = new EditorDocumentRegistry();
