import { createHash } from "node:crypto";
import { parseMirrorSnapshot } from "../../shared/independent-update-mirror";
import {
	MAX_RELAY_PAYLOAD_BYTES,
	MAX_RELAY_READY_BYTES,
	mirrorJobTimeoutMs,
	parseRelayReady,
	RELAY_CLOCK_SKEW_MS,
	RELAY_TTL_MS,
	type RelayKind,
	type RelayReadyManifest,
	relayObjectPath,
	relayReadyDirectory,
	relayScanDates,
	validateMirrorJobTimeoutMs,
} from "../../shared/mirror-relay";
import { WebDavClient } from "../../shared/webdav-transport";
import type { MirrorRelaySettings } from "../lib/mirror-relay-config";
import type { StorageBackend } from "../storage/types";
import { MirrorIngestError, type MirrorIngestService, parseTools } from "./mirror-ingest";

const STATE_MAX_BYTES = 512 * 1024;
const STATE_MAX_ENTRIES = 1024;
const DISCOVERY_MAX_BUCKETS = 12;
const DISCOVERY_TIMEOUT_MS = 60_000;
const JOB_TIMEOUT_MS = 25 * 60_000;
const MAX_JOB_BYTES = 4 * 1024 ** 3;
const KINDS: RelayKind[] = ["main", "helpers", "executor", "remote-peer"];
const HASH = /^[a-f0-9]{64}$/;
type Phase = "COMMITTED" | "STALE" | "CONFLICT" | "RETRY";
interface Entry {
	phase: Phase;
	expiresAt: number;
	nextRetryAt: number;
	attempts: number;
}
interface PullState {
	schemaVersion: 1;
	feed: string;
	entries: Record<string, Entry>;
}
interface Candidate {
	product: string;
	repository: string;
	kind: RelayKind;
	date: string;
	manifestHash: string;
}
export interface RelayPullEvent {
	code: string;
	manifestHash?: string;
	kind?: RelayKind;
	inputBytes?: number;
	durationMs?: number;
}
interface PullOptions {
	fetchImpl?: typeof fetch;
	now?: () => number;
	onEvent?: (event: RelayPullEvent) => void;
	/** Tests/embedded callers may shorten, never extend, the fixed overall budget. */
	jobTimeoutMs?: number;
}
export interface RelayPollResult {
	committed: number;
	failed: number;
	skipped: number;
}
function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function stateKey(job: Candidate): string {
	return digest(Buffer.from(`${job.product}:${job.kind}:${job.date}:${job.manifestHash}`));
}
function parseState(raw: Buffer, feed: string): PullState {
	if (raw.length > STATE_MAX_BYTES) throw new Error("Relay state exceeds byte limit");
	const value = JSON.parse(raw.toString("utf8")) as PullState;
	if (
		value?.schemaVersion !== 1 ||
		value.feed !== feed ||
		!value.entries ||
		typeof value.entries !== "object" ||
		Array.isArray(value.entries) ||
		Object.keys(value).some((k) => !["schemaVersion", "feed", "entries"].includes(k)) ||
		Object.keys(value.entries).length > STATE_MAX_ENTRIES
	)
		throw new Error("Invalid relay state");
	for (const [id, entry] of Object.entries(value.entries)) {
		if (
			!HASH.test(id) ||
			!entry ||
			!["COMMITTED", "STALE", "CONFLICT", "RETRY"].includes(entry.phase) ||
			!Number.isSafeInteger(entry.expiresAt) ||
			!Number.isSafeInteger(entry.nextRetryAt) ||
			!Number.isSafeInteger(entry.attempts) ||
			entry.attempts < 0 ||
			entry.attempts > 64 ||
			Object.keys(entry).some((k) => !["phase", "expiresAt", "nextRetryAt", "attempts"].includes(k))
		)
			throw new Error("Invalid relay state entry");
	}
	return value;
}

/** Optional single-flight worker. Neither construction nor disabled startup performs network IO. */
export class MirrorRelayPuller {
	readonly #client: WebDavClient;
	readonly #now: () => number;
	readonly #jobTimeoutMs: number | undefined;
	readonly #event: (event: RelayPullEvent) => void;
	readonly #controller = new AbortController();
	#timer: ReturnType<typeof setTimeout> | undefined;
	#active: Promise<RelayPollResult> | undefined;
	#cursor = 0;
	#running = false;
	#stopped = false;

	constructor(
		private readonly storage: StorageBackend,
		private readonly ingest: MirrorIngestService,
		private readonly settings: MirrorRelaySettings,
		options: PullOptions = {},
	) {
		if (settings.totalTimeoutMs !== undefined) validateMirrorJobTimeoutMs(settings.totalTimeoutMs);
		this.#client = new WebDavClient(settings.webdav, { fetchImpl: options.fetchImpl });
		this.#now = options.now ?? Date.now;
		this.#jobTimeoutMs = options.jobTimeoutMs;
		if (
			this.#jobTimeoutMs !== undefined &&
			(!Number.isSafeInteger(this.#jobTimeoutMs) ||
				this.#jobTimeoutMs < 1 ||
				this.#jobTimeoutMs > (settings.totalTimeoutMs ?? JOB_TIMEOUT_MS))
		)
			throw new Error("Relay job budget may only shorten the fixed overall timeout");
		this.#event = (event) => {
			try {
				options.onEvent?.(event);
			} catch {
				/* Diagnostics must not alter the transaction. */
			}
		};
	}

	start(): void {
		if (this.#running || this.#stopped) return;
		this.#running = true;
		this.#schedule(0);
	}

	#schedule(delay: number): void {
		if (!this.#running || this.#stopped) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.pollOnce()
				.catch(() => this.#event({ code: "POLL_FAILED" }))
				.finally(() => this.#schedule(this.settings.pollIntervalMs));
		}, delay);
		this.#timer.unref?.();
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		this.#running = false;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#controller.abort();
		await this.#active?.catch(() => {});
	}

	pollOnce(): Promise<RelayPollResult> {
		if (this.#active) return this.#active;
		if (this.#stopped) return Promise.resolve({ committed: 0, failed: 0, skipped: 0 });
		const task = this.#poll();
		this.#active = task;
		void task
			.finally(() => {
				if (this.#active === task) this.#active = undefined;
			})
			.catch(() => {});
		return task;
	}

	#statePath(product: string): string {
		return `mirror-relay-state/${this.settings.webdav.feed}/${product}.json`;
	}

	async #loadState(product: string): Promise<PullState> {
		const path = this.#statePath(product);
		const size = await this.storage.getFileSize(path);
		if (size !== null && size > STATE_MAX_BYTES) throw new Error("Invalid relay state size");
		const raw = size === null ? null : await this.storage.getFile(path);
		const state = raw
			? parseState(raw, this.settings.webdav.feed)
			: {
					schemaVersion: 1 as const,
					feed: this.settings.webdav.feed,
					entries: {},
				};
		for (const [id, entry] of Object.entries(state.entries))
			if (entry.expiresAt + RELAY_CLOCK_SKEW_MS + 24 * 60 * 60_000 < this.#now())
				delete state.entries[id];
		return state;
	}

	async #saveState(product: string, state: PullState): Promise<void> {
		if (!this.storage.saveAtomicFile) throw new Error("Relay requires atomic state storage");
		const raw = Buffer.from(JSON.stringify(state));
		if (raw.length > STATE_MAX_BYTES || Object.keys(state.entries).length > STATE_MAX_ENTRIES)
			throw new Error("Relay state exceeds limit");
		await this.storage.saveAtomicFile(this.#statePath(product), raw, this.#controller.signal);
	}

	async #poll(): Promise<RelayPollResult> {
		const result: RelayPollResult = { committed: 0, failed: 0, skipped: 0 };
		const dates = relayScanDates(this.#now());
		const buckets = this.settings.products.flatMap((p) =>
			KINDS.flatMap((kind) => dates.map((date) => ({ ...p, kind, date }))),
		);
		const states = new Map<string, PullState>();
		const candidates: Candidate[] = [];
		const discoverySignal = AbortSignal.any([
			this.#controller.signal,
			AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
		]);
		for (let i = 0; i < Math.min(DISCOVERY_MAX_BUCKETS, buckets.length); i++) {
			if (discoverySignal.aborted) break;
			const bucket = buckets[this.#cursor % buckets.length];
			this.#cursor = (this.#cursor + 1) % buckets.length;
			try {
				let state = states.get(bucket.product);
				if (!state) {
					state = await this.#loadState(bucket.product);
					states.set(bucket.product, state);
				}
				const path = relayReadyDirectory(
					this.settings.webdav.feed,
					bucket.product,
					bucket.kind,
					bucket.date,
				);
				const entries = await this.#client.list(path, {
					maxEntries: 32,
					maxBytes: 256 * 1024,
					signal: discoverySignal,
				});
				for (const entry of entries) {
					if (entry.isCollection || !/^[a-f0-9]{64}\.json$/.test(entry.name))
						throw new Error("Unexpected relay ready entry");
					const candidate = { ...bucket, manifestHash: entry.name.slice(0, -5) };
					const old = state.entries[stateKey(candidate)];
					if (old && (old.phase !== "RETRY" || old.nextRetryAt > this.#now())) {
						result.skipped++;
						continue;
					}
					candidates.push(candidate);
				}
			} catch {
				if (!this.#controller.signal.aborted) this.#event({ code: "DISCOVERY_FAILED" });
			}
		}
		// Use persisted retry times, not a global cursor modulo a changing discovery group.
		// Untouched jobs win ties; previously attempted jobs rotate by their last retry deadline.
		const ordered = candidates.sort(
			(a, b) =>
				(states.get(a.product)?.entries[stateKey(a)]?.nextRetryAt ?? 0) -
				(states.get(b.product)?.entries[stateKey(b)]?.nextRetryAt ?? 0),
		);
		for (const job of ordered.slice(0, 4)) {
			if (this.#controller.signal.aborted) break;
			const state = states.get(job.product);
			if (!state) continue;
			const id = stateKey(job);
			if (!state.entries[id] && Object.keys(state.entries).length >= STATE_MAX_ENTRIES) {
				result.failed++;
				this.#event({ code: "STATE_LIMIT", manifestHash: job.manifestHash, kind: job.kind });
				continue;
			}
			const start = this.#now();
			// Unsigned failures must not slide their retention window on every retry.
			let expiresAt = Date.parse(`${job.date}T00:00:00.000Z`) + 24 * 60 * 60_000 + RELAY_TTL_MS;
			const signal = AbortSignal.any([
				this.#controller.signal,
				AbortSignal.timeout(
					this.#jobTimeoutMs ?? this.settings.totalTimeoutMs ?? mirrorJobTimeoutMs(job.kind),
				),
			]);
			try {
				const readyPath = `${relayReadyDirectory(this.settings.webdav.feed, job.product, job.kind, job.date)}/${job.manifestHash}.json`;
				const raw = await this.#client.getBytes(readyPath, MAX_RELAY_READY_BYTES, signal);
				if (!raw) throw new Error("Relay ready unavailable");
				const manifest = parseRelayReady(raw, this.settings.signingKey, {
					...job,
					feed: this.settings.webdav.feed,
					now: this.#now(),
				});
				expiresAt = Date.parse(manifest.expiresAt);
				const inputBytes = await this.#import(manifest, signal);
				state.entries[id] = { phase: "COMMITTED", expiresAt, nextRetryAt: 0, attempts: 0 };
				await this.#saveState(job.product, state);
				result.committed++;
				this.#event({
					code: "COMMITTED",
					manifestHash: job.manifestHash,
					kind: job.kind,
					inputBytes,
					durationMs: this.#now() - start,
				});
			} catch (error) {
				if (this.#controller.signal.aborted) break;
				const code = error instanceof MirrorIngestError ? error.code : "IMPORT_FAILED";
				const phase: Phase =
					code === "STALE_CANONICAL_SNAPSHOT"
						? "STALE"
						: code === "CANONICAL_SNAPSHOT_CONFLICT" || code === "TOOLS_METADATA_CONFLICT"
							? "CONFLICT"
							: "RETRY";
				const attempts = Math.min((state.entries[id]?.attempts ?? 0) + 1, 64);
				state.entries[id] = {
					phase,
					expiresAt,
					attempts,
					nextRetryAt: this.#now() + Math.min(10 * 60_000, 10_000 * 2 ** Math.min(attempts - 1, 6)),
				};
				try {
					await this.#saveState(job.product, state);
				} catch {
					this.#event({ code: "STATE_WRITE_FAILED" });
				}
				result.failed++;
				this.#event({
					code: phase === "RETRY" ? "IMPORT_FAILED" : phase,
					manifestHash: job.manifestHash,
					kind: job.kind,
					durationMs: this.#now() - start,
				});
			}
		}
		return result;
	}

	async #import(manifest: RelayReadyManifest, signal: AbortSignal): Promise<number> {
		const raw = await this.#client.getBytes(
			relayObjectPath(manifest, manifest.payload.sha256),
			MAX_RELAY_PAYLOAD_BYTES,
			signal,
		);
		if (!raw || raw.byteLength !== manifest.payload.size || digest(raw) !== manifest.payload.sha256)
			throw new Error("Relay payload size/hash mismatch");
		const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
		if (manifest.kind !== "main") {
			// Validate the signed small payload before fetching any large component object.
			const projection = parseTools(payload, manifest.repository, manifest.kind, manifest.tag);
			const binaries = projection.binaries ?? [];
			const bytes = binaries.reduce((sum, a) => sum + a.size, raw.byteLength);
			if (!Number.isSafeInteger(bytes) || bytes > MAX_JOB_BYTES)
				throw new Error("Relay component import byte budget exceeded");
			for (const asset of binaries) {
				signal.throwIfAborted();
				const stream = await this.#client.getStream(
					relayObjectPath(manifest, asset.sha256),
					asset.size,
					signal,
				);
				if (!stream) throw new Error("Relay component binary unavailable");
				try {
					await this.ingest.ingestAsset(manifest.product, asset, stream, signal, "relay");
				} finally {
					if (!stream.locked) await stream.cancel().catch(() => {});
				}
			}
			await this.ingest.commitTools(manifest.product, manifest.kind, manifest.tag, payload, signal);
			return bytes;
		}
		const snapshot = parseMirrorSnapshot(payload, manifest.repository);
		if (`v${snapshot.targetVersion}` !== manifest.tag) throw new Error("Relay target tag mismatch");
		const bytes = snapshot.assets.reduce((sum, asset) => sum + asset.size, raw.byteLength);
		if (!Number.isSafeInteger(bytes) || bytes > MAX_JOB_BYTES)
			throw new Error("Relay import byte budget exceeded");
		for (const asset of snapshot.assets) {
			signal.throwIfAborted();
			const stream = await this.#client.getStream(
				relayObjectPath(manifest, asset.sha256),
				asset.size,
				signal,
			);
			if (!stream) throw new Error("Relay asset unavailable");
			try {
				await this.ingest.ingestAsset(manifest.product, asset, stream, signal, "relay");
			} finally {
				if (!stream.locked) await stream.cancel().catch(() => {});
			}
		}
		await this.ingest.commitMain(manifest.product, snapshot, signal);
		return bytes;
	}
}
