import { createHash, randomUUID } from "node:crypto";
import {
	createRelayReady,
	mirrorTransferTimeoutMs,
	type RelayReadyManifest,
	relayBucketExpired,
	relayDate,
	relayObjectPath,
	relayReadyDirectory,
	relayReadyPath,
} from "../../shared/mirror-relay";
import {
	validateWebDavConfig,
	WebDavClient,
	type WebDavConfig,
} from "../../shared/webdav-transport";

export interface MirrorRelayStageOptions {
	config: WebDavConfig;
	signingKey: string;
	client?: Pick<WebDavClient, "ensureCollection" | "put" | "list" | "deleteCollection">;
	now?: () => Date;
	jobId?: string;
}
export interface MirrorRelayStageResult {
	manifestHash: string;
	expiresAt: string;
	retention: "COMPLETE" | "RETENTION_INCOMPLETE";
}
export function resolveMirrorTransport(
	env: Record<string, string | undefined>,
): "direct" | "webdav" {
	const transport = env.NF_MIRROR_TRANSPORT ?? "direct";
	if (transport !== "direct" && transport !== "webdav")
		throw new Error("NF_MIRROR_TRANSPORT must be direct or webdav; no automatic fallback");
	return transport;
}
export function resolveMirrorRelayConfig(
	env: Record<string, string | undefined>,
): MirrorRelayStageOptions {
	const username = env.NF_MIRROR_WEBDAV_USERNAME;
	const password = env.NF_MIRROR_WEBDAV_PASSWORD;
	const bearerToken = env.NF_MIRROR_WEBDAV_TOKEN;
	if ((bearerToken && (username || password)) || (!bearerToken && (!username || !password)))
		throw new Error("WebDAV requires exactly one complete Basic or Bearer authentication method");
	const config: WebDavConfig = {
		url: env.NF_MIRROR_WEBDAV_URL ?? "",
		feed: env.NF_MIRROR_WEBDAV_FEED ?? "default",
		...(env.NF_MIRROR_TRANSFER_TIMEOUT_MINUTES
			? { transferTimeoutMs: mirrorTransferTimeoutMs(env.NF_MIRROR_TRANSFER_TIMEOUT_MINUTES) }
			: {}),
		auth: bearerToken
			? { bearerToken }
			: { username: username as string, password: password as string },
	};
	validateWebDavConfig(config);
	const signingKey = env.NF_MIRROR_RELAY_SIGNING_KEY ?? "";
	if (!/^[A-Za-z0-9+/]{43}=$/.test(signingKey) || Buffer.from(signingKey, "base64").length !== 32)
		throw new Error("Relay signing key must be a base64 encoded 32-byte key");
	return { config, signingKey };
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Reuses the producer's GitHub authority checks; DAV acceptance is never server verification. */
export class MirrorRelayStage {
	private readonly client: NonNullable<MirrorRelayStageOptions["client"]>;
	private readonly manifest: RelayReadyManifest;
	private readonly uploaded = new Map<string, number>();
	private readonly inFlight = new Map<string, { size: number; pending: Promise<void> }>();
	private objectsReady?: Promise<void>;
	private failed = false;
	private initialized?: Promise<void>;
	private payloadReady = false;
	private retention: MirrorRelayStageResult["retention"] = "RETENTION_INCOMPLETE";
	constructor(
		identity: {
			kind: "main" | "helpers" | "executor" | "remote-peer";
			repository: string;
			tag: string;
		},
		private readonly options: MirrorRelayStageOptions,
		private readonly signal: AbortSignal,
	) {
		validateWebDavConfig(options.config);
		this.client = options.client ?? new WebDavClient(options.config);
		const now = (options.now ?? (() => new Date()))();
		this.manifest = {
			schemaVersion: 1,
			feed: options.config.feed,
			product: "narrafork",
			kind: identity.kind,
			repository: identity.repository,
			tag: identity.tag,
			jobId: options.jobId ?? randomUUID(),
			createdAt: now.toISOString(),
			expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60_000).toISOString(),
			payload: { size: 1, sha256: "0".repeat(64) },
		};
		// Validate identity, paths and signing key before any DAV request.
		createRelayReady(this.manifest, options.signingKey);
	}
	private get readyDirectory() {
		return relayReadyDirectory(
			this.manifest.feed,
			this.manifest.product,
			this.manifest.kind,
			relayDate(Date.parse(this.manifest.createdAt)),
		);
	}
	private async checkCapacity() {
		const entries = await this.client.list(this.readyDirectory, {
			maxEntries: 32,
			maxBytes: 256 * 1024,
			signal: this.signal,
		});
		if (entries.some((entry) => entry.isCollection || !/^[a-f0-9]{64}\.json$/.test(entry.name)))
			throw new Error("Unexpected relay ready bucket entry");
		if (entries.length >= 32) throw new Error("Relay ready date bucket is full");
	}
	private async initialize() {
		this.initialized ??= (async () => {
			await this.client.ensureCollection(this.readyDirectory, this.signal);
			await this.checkCapacity();
			await this.cleanup();
		})();
		await this.initialized;
	}
	private async cleanup() {
		const signal = AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]);
		try {
			const now = (this.options.now ?? (() => new Date()))();
			const date = relayDate(Date.parse(this.manifest.createdAt));
			const readyRoot = this.readyDirectory.slice(0, this.readyDirectory.lastIndexOf(`/${date}`));
			const object = relayObjectPath(this.manifest, this.manifest.payload.sha256);
			// Remove exactly date/job/objects/hash; a feed may itself equal the UTC date.
			const batchRoot = object.split("/").slice(0, -4).join("/");
			const buckets = new Map<string, Set<string>>();
			for (const root of [readyRoot, batchRoot]) {
				const entries = await this.client.list(root, {
					maxEntries: 256,
					maxBytes: 256 * 1024,
					signal,
				});
				for (const entry of entries) {
					if (!entry.isCollection || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
					if (relayDate(Date.parse(`${entry.name}T00:00:00.000Z`)) !== entry.name) continue;
					if (!relayBucketExpired(entry.name, now.getTime())) continue;
					const paths = buckets.get(entry.name) ?? new Set<string>();
					paths.add(`${root}/${entry.name}`);
					buckets.set(entry.name, paths);
				}
			}
			let incomplete = buckets.size > 12;
			for (const [, paths] of [...buckets].sort(([a], [b]) => a.localeCompare(b)).slice(0, 12)) {
				for (const path of paths) {
					signal.throwIfAborted();
					try {
						await this.client.deleteCollection(path, signal);
					} catch {
						incomplete = true;
					}
				}
			}
			this.retention = incomplete ? "RETENTION_INCOMPLETE" : "COMPLETE";
		} catch {
			this.retention = "RETENTION_INCOMPLETE";
		}
	}
	async uploadObject(
		asset: { name: string; size: number; sha256: string },
		body: ReadableStream<Uint8Array> | Uint8Array,
	) {
		const existing = this.inFlight.get(asset.sha256);
		const size = existing?.size ?? this.uploaded.get(asset.sha256);
		if (size !== undefined) {
			if (body instanceof ReadableStream) void body.cancel().catch(() => {});
			if (size !== asset.size) {
				this.failed = true;
				throw new Error("Conflicting relay object size");
			}
			await existing?.pending;
			return;
		}
		const pending = (async () => {
			try {
				if (this.failed) throw new Error("Relay stage already failed");
				await this.initialize();
				this.signal.throwIfAborted();
				const path = relayObjectPath(this.manifest, asset.sha256);
				this.objectsReady ??= this.client.ensureCollection(
					path.slice(0, path.lastIndexOf("/")),
					this.signal,
				);
				await this.objectsReady;
				const result = await this.client.put(path, body, asset, this.signal);
				if (result !== "created")
					throw new Error(
						"Relay object conditional-create conflict; existence is not verification",
					);
				this.uploaded.set(asset.sha256, asset.size);
			} catch (error) {
				this.failed = true;
				throw error;
			} finally {
				if (body instanceof ReadableStream && !body.locked) void body.cancel().catch(() => {});
			}
		})();
		this.inFlight.set(asset.sha256, { size: asset.size, pending });
		try {
			await pending;
		} finally {
			this.inFlight.delete(asset.sha256);
		}
	}
	async preparePayload(projection: unknown, maxBytes: number) {
		if (this.failed || this.inFlight.size)
			throw new Error("Relay assets must settle successfully before payload");
		const bytes = new TextEncoder().encode(JSON.stringify(projection));
		if (bytes.length > Math.min(maxBytes, 1024 * 1024))
			throw new Error("Relay commit payload exceeds byte limit");
		this.manifest.payload = { size: bytes.length, sha256: sha256(bytes) };
		await this.uploadObject({ name: "commit-payload.json", ...this.manifest.payload }, bytes);
		this.payloadReady = true;
	}
	async publish(revalidate: () => Promise<void>): Promise<MirrorRelayStageResult> {
		if (this.failed || this.inFlight.size)
			throw new Error("Relay stage has failed or active uploads");
		if (!this.payloadReady) throw new Error("Relay payload must be staged before ready");
		await this.checkCapacity();
		await revalidate();
		if ((this.options.now ?? (() => new Date()))().getTime() >= Date.parse(this.manifest.expiresAt))
			throw new Error("Relay staging expired before ready publication");
		this.signal.throwIfAborted();
		const { manifestHash, bytes } = createRelayReady(this.manifest, this.options.signingKey);
		const result = await this.client.put(
			relayReadyPath(this.manifest, manifestHash),
			bytes,
			{ size: bytes.length, sha256: sha256(bytes) },
			this.signal,
		);
		if (result !== "created") throw new Error("Relay ready conditional-create conflict");
		return { manifestHash, expiresAt: this.manifest.expiresAt, retention: this.retention };
	}
}

/** Strict small receipt comparison, never compatibility GET of uploaded assets. */
export function assertServerVerified(
	value: unknown,
	identity: Record<string, string | number>,
	assets: { name: string; size: number; sha256: string }[],
) {
	const receipt = value as Record<string, unknown> | null;
	const verified = receipt?.verified;
	if (
		!receipt ||
		receipt.schemaVersion !== 1 ||
		receipt.verification !== "server-sha256" ||
		Object.entries(identity).some(([key, expected]) => {
			const actual = receipt[key];
			return key === "repository" && typeof actual === "string" && typeof expected === "string"
				? actual.toLowerCase() !== expected.toLowerCase()
				: actual !== expected;
		}) ||
		!Array.isArray(verified) ||
		verified.length !== assets.length ||
		assets.some(
			(asset) =>
				verified.filter(
					(actual) =>
						actual &&
						actual.name === asset.name &&
						actual.size === asset.size &&
						actual.sha256 === asset.sha256,
				).length !== 1,
		)
	)
		throw new Error(
			"Missing or mismatched server-sha256 commit receipt; upgrade the update server (asset GET fallback is disabled)",
		);
}
