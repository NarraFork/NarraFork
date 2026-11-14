import { createHash } from "node:crypto";
import { mkdtemp, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MIRROR_ASSET_HEADERS,
	type MirrorSnapshotV2,
	mirrorAssetLimit,
	mirrorAssetsForTarget,
} from "../../shared/independent-update-mirror";
import {
	mirrorJobTimeoutMs,
	mirrorUploadConcurrency,
	validateMirrorJobTimeoutMs,
} from "../../shared/mirror-relay";
import { isValidReleaseVersion } from "../../shared/release-version";
import { parseUpdateNotes } from "../../shared/update-index";
import { WebDavError } from "../../shared/webdav-transport";
import {
	downloadReleaseAsset,
	hashReleaseFile,
	type ReleaseAssetDownloader,
	timeReleasePhase,
} from "./ci-release-io";
import type { GhRunner } from "./github-release";
import {
	currentPublicRelease,
	matchPublicAsset,
	mirrorGhRunner,
	type PublicMirrorRelease,
	publicTagCommit,
	readIndexNotes,
	readIndexSnapshot,
} from "./mirror-public-github";
import {
	assertServerVerified,
	MirrorRelayStage,
	type MirrorRelayStageOptions,
	type MirrorRelayStageResult,
} from "./mirror-relay-stage";
import {
	groupMirrorUploads,
	MirrorUploadPool,
	mirrorUploadDiskBytes,
	orderMirrorUploads,
} from "./mirror-upload-pool";
import type { PublicationReceipt } from "./publication-receipt";
import { preparePublishedUpdateIndexRelease } from "./update-index-github";
import {
	BridgeHttpError,
	type UpdateServerMirrorConfig,
	UpdateServerMirrorHttp,
} from "./update-server-bridge-http";

// Only the pinned historical 123 distribution verifier retains the old seal format.
export {
	type MainMirrorSeal,
	type PreparedMainMirror,
	verifyPreparedMainMirror,
} from "./update-server-main-mirror-history";
export const MAIN_MIRROR_TOTAL_TIMEOUT_MS = 25 * 60_000;
/** Source download + upload: at most 4GiB of original assets, matching relay job capacity. */
export const MIRROR_TOTAL_BYTES = 8 * 1024 ** 3;
export const MAIN_MIRROR_SNAPSHOT_TIMEOUT_MS = 25 * 60_000;
export interface IndependentMirrorReceipt {
	schemaVersion: 1;
	kind: "main" | "helpers" | "executor" | "remote-peer";
	repository: string;
	tag: string;
	status:
		| "MIRRORED"
		| "METADATA_ONLY"
		| "STAGED_FOR_PULL"
		| "DRY_RUN"
		| "SKIPPED_UNCONFIGURED"
		| "FAILED";
	transport: "direct" | "webdav";
	verification: "server-sha256" | "pending-server-pull";
	relay?: MirrorRelayStageResult;
	/** Exact bytes accepted by the configured transport; not necessarily committed. */
	uploaded: string[];
	/** Exact committed assets verified by the update server, never runner readback. */
	verified: string[];
	snapshotCommitted: boolean;
	/** Frozen successful publisher identity, when initiated from workflow receipts. */
	publication?: { commit: string; releaseId: number; source: PublicationReceipt["source"] };
	failureCode?: "FAILED_CONFIG" | "CANCELLED" | "MIRROR_FAILED" | "SERVER_RECEIPT_REQUIRED";
}
export class IndependentMirrorError extends Error {
	readonly transportDiagnostic?: { code: string; httpStatus?: number };

	constructor(
		readonly receipt: IndependentMirrorReceipt,
		failure?: unknown,
	) {
		super(
			`Independent mirror ${receipt.failureCode ?? "MIRROR_FAILED"}; GitHub publication is unchanged${receipt.failureCode === "SERVER_RECEIPT_REQUIRED" ? "; upgrade update server for server-sha256 receipts; no asset GET fallback" : ""}`,
		);
		// Never copy arbitrary exception messages/URLs, request headers, response bodies
		// or credentials into the wire receipt or CLI diagnostics.
		try {
			if (failure instanceof WebDavError) {
				const knownCodes = [
					"TIMEOUT",
					"ABORTED",
					"NETWORK_ERROR",
					"HTTP_STATUS",
					"REDIRECT",
					"EARLY_RESPONSE",
					"INTEGRITY",
					"SIZE_LIMIT",
					"SIZE_MISMATCH",
					"INVALID_INPUT",
				];
				const code = failure.code;
				const status = failure.status;
				this.transportDiagnostic = {
					code: knownCodes.includes(code) ? code : "OTHER_WEBDAV_ERROR",
					...(typeof status === "number" &&
					Number.isInteger(status) &&
					status >= 100 &&
					status <= 599
						? { httpStatus: status }
						: {}),
				};
			}
		} catch {
			// Diagnostics must not replace the original failure, including exotic getters.
		}
	}
}
export interface MirrorPublishedOptions {
	kind: "main" | "helpers" | "executor" | "remote-peer";
	repository: string;
	tag: string;
	config?: UpdateServerMirrorConfig;
	transport?: "direct" | "webdav";
	relay?: MirrorRelayStageOptions;
	platforms?: string[];
	dryRun?: boolean;
	signal?: AbortSignal;
	run?: GhRunner;
	/** Test transports retain the exact production read-only contract. */
	http?: UpdateServerMirrorHttp;
	downloadAsset?: ReleaseAssetDownloader;
	maxTotalBytes?: number;
	/** Frozen overall wall-clock deadline, capped at 300 minutes. */
	totalTimeoutMs?: number;
	/** Complete tasks: direct defaults to 2 (old servers), WebDAV to 3; hard cap 8. */
	uploadConcurrency?: number;
	/** A verified workflow receipt freezes the exact public identity throughout producer execution. */
	publication?: PublicationReceipt;
	/** Multiple publications reserve one shared source-download + upload/count budget. */
	reserveAssets?: (assets: { size: number }[]) => void;
}
export function assertMirrorPublicationIdentity(
	options: MirrorPublishedOptions,
	remote: PublicMirrorRelease,
	commit: string,
): void {
	const expected = options.publication;
	if (!expected) return;
	if (
		expected.repository.toLowerCase() !== options.repository.toLowerCase() ||
		expected.kind !== options.kind ||
		expected.tag !== options.tag ||
		expected.commit !== commit ||
		expected.releaseId !== remote.id ||
		expected.assets.length !== remote.assets.length ||
		expected.assets.some(
			(asset) =>
				!remote.assets.some(
					(a) =>
						a.id === asset.id &&
						a.name === asset.name &&
						a.size === asset.size &&
						a.digest === asset.digest,
				),
		)
	)
		throw new Error("Public identity differs from frozen publication receipt");
}
export function mirrorReceipt(
	options: Pick<
		MirrorPublishedOptions,
		"kind" | "repository" | "tag" | "transport" | "publication"
	>,
): IndependentMirrorReceipt {
	return {
		schemaVersion: 1,
		kind: options.kind,
		repository: options.repository,
		tag: options.tag,
		status: "FAILED",
		transport: options.transport ?? "direct",
		verification: options.transport === "webdav" ? "pending-server-pull" : "server-sha256",
		uploaded: [],
		verified: [],
		snapshotCommitted: false,
		...(options.publication
			? {
					publication: {
						commit: options.publication.commit,
						releaseId: options.publication.releaseId,
						source: options.publication.source,
					},
				}
			: {}),
	};
}
function digest(bytes: string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Current public GitHub bytes only: no server history, baseline binary, generation or patch rebuild. */
export async function mirrorPublishedMainRelease(
	options: MirrorPublishedOptions,
): Promise<IndependentMirrorReceipt> {
	const receipt = mirrorReceipt(options);
	const parentSignal = AbortSignal.any([
		AbortSignal.timeout(
			validateMirrorJobTimeoutMs(options.totalTimeoutMs ?? mirrorJobTimeoutMs("main")),
		),
		...(options.signal ? [options.signal] : []),
	]);
	const pool = new MirrorUploadPool(
		mirrorUploadConcurrency(options.uploadConcurrency, options.transport ?? "direct"),
		parentSignal,
	);
	const signal = pool.signal;
	let uploadOrder: { name: string }[] = [];
	let directory: string | undefined;
	try {
		const version = options.tag.slice(1);
		if (options.kind !== "main" || options.tag !== `v${version}` || !isValidReleaseVersion(version))
			throw new Error("Main mirror requires exact vX.Y.Z public tag");
		const run = mirrorGhRunner(options.run, signal);
		const remote = await currentPublicRelease(run, options.repository, options.tag);
		const commit = await publicTagCommit(run, options.repository, options.tag);
		assertMirrorPublicationIdentity(options, remote, commit);
		const verified = await preparePublishedUpdateIndexRelease({
			repository: options.repository,
			version,
			commit,
			run,
			signal,
		});
		let snapshot = await readIndexSnapshot(run, options.repository);
		const target = snapshot.index.releases.find((r) => r.tag === options.tag);
		if (!target || target.commit !== commit)
			throw new Error("Public Release is not confirmed in canonical GitHub index");
		// Repair reader revalidates every sidecar and detects unpaired or unindexed current patch assets.
		const { notes: _notes, ...indexedRelease } = target;
		if (JSON.stringify(indexedRelease) !== JSON.stringify(verified.release))
			throw new Error("Current public Release differs from canonical index");
		if (
			options.platforms &&
			(options.platforms.length !== target.files.length ||
				target.files.some((f) => !options.platforms?.includes(f.platform)))
		)
			throw new Error("Canonical snapshot requires the complete target platform projection");
		for (const file of target.files) matchPublicAsset(remote, file);
		const assets = mirrorAssetsForTarget(snapshot.index, version, 2);
		// Reserve source download + transport upload; assets are never downloaded back.
		const total = 2 * assets.reduce((sum, a) => sum + a.size, 0);
		const budget = options.maxTotalBytes ?? MIRROR_TOTAL_BYTES;
		if (
			!Number.isSafeInteger(budget) ||
			budget <= 0 ||
			budget > MIRROR_TOTAL_BYTES ||
			total > budget ||
			assets.length > 200 ||
			assets.some((asset) => asset.size > mirrorAssetLimit(asset.kind))
		)
			throw new Error("Independent mirror total byte budget exceeded");
		options.reserveAssets?.(assets);
		for (const asset of assets) if (asset.kind !== "notes") matchPublicAsset(remote, asset);
		for (const asset of remote.assets) {
			if (
				(asset.name.endsWith(".zstd-patch") || asset.name.endsWith(".zstd-patch.meta.json")) &&
				!assets.some((a) => a.name === asset.name)
			)
				throw new Error("Unindexed or orphaned current public patch asset");
		}
		let notesRaw: string | undefined;
		if (target.notes) {
			notesRaw = await readIndexNotes(run, options.repository, snapshot.indexCommit, target.notes);
			if (digest(notesRaw) !== target.notes.sha256)
				throw new Error("Canonical notes raw bytes mismatch");
			parseUpdateNotes(JSON.parse(notesRaw), options.repository, version);
		}
		if (options.dryRun) {
			receipt.status = "DRY_RUN";
			return receipt;
		}
		const stage =
			options.transport === "webdav"
				? new MirrorRelayStage(options, options.relay as MirrorRelayStageOptions, signal)
				: undefined;
		if (!stage && !options.config) {
			receipt.status = "SKIPPED_UNCONFIGURED";
			return receipt;
		}
		const http = stage
			? undefined
			: (options.http ??
				new UpdateServerMirrorHttp(options.config as UpdateServerMirrorConfig, {
					requestTimeoutMs: MAIN_MIRROR_SNAPSHOT_TIMEOUT_MS,
				}));
		const root = "/api/v3/products/narrafork/mirror";
		directory = await mkdtemp(join(tmpdir(), "nf-public-mirror-"));
		const disk = await statfs(directory);
		const groups = groupMirrorUploads(assets);
		uploadOrder = assets;
		if (
			disk.bavail * disk.bsize <
			mirrorUploadDiskBytes(
				groups.map((g) => g.asset).filter((a) => a.kind === "patch" || a.kind === "main-binary"),
				pool.concurrency,
			)
		)
			throw new Error("Insufficient independent mirror disk budget");
		await pool.run(groups, async ({ asset, names }, index) => {
			signal.throwIfAborted();
			let stream: ReadableStream<Uint8Array> | undefined;
			let path: string | undefined;
			try {
				if (asset.kind === "patch" || asset.kind === "main-binary") {
					const github = matchPublicAsset(remote, asset);
					path = join(directory as string, `${index}-${asset.sha256}`);
					await timeReleasePhase(
						asset.kind === "patch" ? "mirror.github-patch" : "mirror.github-binary",
						{ inputBytes: asset.size },
						() =>
							(options.downloadAsset ?? downloadReleaseAsset)({
								repository: options.repository,
								assetId: github.id,
								size: asset.size,
								outputPath: path as string,
								signal,
							}),
						signal,
					);
					const actual = await hashReleaseFile(path, mirrorAssetLimit(asset.kind), signal);
					if (actual.size !== asset.size || actual.sha256 !== asset.sha256)
						throw new Error("Public payload raw bytes mismatch");
					stream = Bun.file(path).stream();
				} else {
					const raw =
						asset.kind === "notes"
							? (notesRaw as string)
							: await run([
									"api",
									`repos/${options.repository}/releases/assets/${matchPublicAsset(remote, asset).id}`,
									"-H",
									"Accept: application/octet-stream",
								]);
					if (
						Buffer.byteLength(raw) !== asset.size ||
						digest(raw) !== asset.sha256 ||
						asset.size > mirrorAssetLimit(asset.kind)
					)
						throw new Error("Public metadata raw bytes mismatch");
					if (asset.kind === "notes")
						parseUpdateNotes(JSON.parse(raw), options.repository, version);
					stream = new Blob([raw]).stream();
				}
				const body = stream;
				if (stage) {
					await timeReleasePhase(
						"mirror.webdav-upload",
						{ inputBytes: asset.size, platform: asset.platform, version },
						() => stage.uploadObject(asset, body),
						signal,
					);
					receipt.uploaded.push(...names);
					return;
				}
				const headers: Record<string, string> = {
					[MIRROR_ASSET_HEADERS.kind]: asset.kind,
					[MIRROR_ASSET_HEADERS.name]: asset.name,
					[MIRROR_ASSET_HEADERS.size]: String(asset.size),
					[MIRROR_ASSET_HEADERS.repository]: options.repository,
					[MIRROR_ASSET_HEADERS.version]: version,
					...(asset.platform ? { [MIRROR_ASSET_HEADERS.platform]: asset.platform } : {}),
				};
				const acknowledgement = await timeReleasePhase(
					"mirror.upload",
					{ inputBytes: asset.size },
					() =>
						(http as UpdateServerMirrorHttp).putRaw(`${root}/assets/${asset.sha256}`, body, {
							maxBytes: mirrorAssetLimit(asset.kind),
							expected: asset,
							timeoutMs: 15 * 60_000,
							headers,
							signal,
						}),
					signal,
				);
				const ack = acknowledgement as {
					schemaVersion: number;
					verification: string;
					name: string;
					size: number;
					sha256: string;
				};
				if (
					!ack ||
					ack.schemaVersion !== 1 ||
					ack.verification !== "server-sha256" ||
					ack.name !== asset.name ||
					ack.size !== asset.size ||
					ack.sha256 !== asset.sha256
				)
					throw new Error(
						"Missing or mismatched server-sha256 upload receipt; upgrade the update server (asset GET fallback is disabled)",
					);
				receipt.uploaded.push(...names);
			} catch (error) {
				pool.fail(error);
				throw error;
			} finally {
				if (stream && !stream.locked) await stream.cancel().catch(() => {});
				if (path) await rm(path, { force: true });
			}
		});
		const revalidate = async () => {
			if ((await publicTagCommit(run, options.repository, options.tag)) !== commit)
				throw new Error("Public tag changed during mirror");
			const current = await currentPublicRelease(run, options.repository, options.tag);
			if (
				current.id !== remote.id ||
				JSON.stringify(current.assets) !== JSON.stringify(remote.assets)
			)
				throw new Error("Public asset set changed during mirror");
			const latest = await readIndexSnapshot(run, options.repository);
			const latestTarget = latest.index.releases.find((r) => r.tag === options.tag);
			if (!latestTarget || JSON.stringify(latestTarget) !== JSON.stringify(target))
				throw new Error("Canonical target changed before ready publication");
			if (
				stage &&
				(latest.indexCommit !== snapshot.indexCommit ||
					JSON.stringify(latest.index) !== JSON.stringify(snapshot.index))
			)
				throw new Error("Canonical index changed before ready publication; restage from GitHub");
		};
		if (!stage) await revalidate();
		// Retry a canonical CAS conflict only by consulting GitHub again, never mirror history.
		for (let attempt = 0; attempt < 3; attempt++) {
			const fresh = await readIndexSnapshot(run, options.repository);
			const freshTarget = fresh.index.releases.find((r) => r.tag === options.tag);
			if (!freshTarget || JSON.stringify(freshTarget) !== JSON.stringify(target))
				throw new Error("Canonical target changed or left the index window before snapshot commit");
			snapshot = fresh;
			const projection: MirrorSnapshotV2 = {
				schemaVersion: 2,
				repository: options.repository,
				...snapshot,
				targetVersion: version,
				assets,
			};
			try {
				if (stage) {
					await stage.preparePayload(projection, 320 * 1024);
					receipt.relay = await stage.publish(revalidate);
					receipt.status = "STAGED_FOR_PULL";
					return receipt;
				}
				const acknowledgement = await (http as UpdateServerMirrorHttp).postJson(
					`${root}/snapshot`,
					projection,
					{ maxBytes: 320 * 1024, signal, timeoutMs: MAIN_MIRROR_SNAPSHOT_TIMEOUT_MS },
				);
				assertServerVerified(
					acknowledgement,
					{
						repository: options.repository,
						indexCommit: snapshot.indexCommit,
						generation: snapshot.index.generation,
						targetVersion: version,
					},
					assets,
				);
				receipt.snapshotCommitted = true;
				receipt.verified = assets.map((a) => a.name);
				break;
			} catch (error) {
				if (!(error instanceof BridgeHttpError) || error.status !== 409 || attempt === 2)
					throw error;
			}
		}
		receipt.snapshotCommitted = true;
		receipt.status = assets.some((a) => a.kind === "patch" || a.kind === "main-binary")
			? "MIRRORED"
			: "METADATA_ONLY";
		return receipt;
	} catch (error) {
		receipt.failureCode = parentSignal.aborted
			? "CANCELLED"
			: error instanceof Error && error.message.includes("upgrade the update server")
				? "SERVER_RECEIPT_REQUIRED"
				: "MIRROR_FAILED";
		throw new IndependentMirrorError(receipt, error);
	} finally {
		orderMirrorUploads(receipt.uploaded, uploadOrder);
		if (directory) await rm(directory, { recursive: true, force: true });
	}
}

/** @deprecated Frozen bridge bundles can never authorize a new canonical mirror. */
export async function prepareUpdateServerMainMirror(..._args: unknown[]): Promise<never> {
	throw new Error("prepare-bridge is retired; mirror an already-public GitHub Release");
}
/** @deprecated Use mirrorPublishedGitHubRelease. */
export const restorePreparedMainMirror = prepareUpdateServerMainMirror;
/** @deprecated Use mirrorPublishedGitHubRelease. */
export const publishUpdateServerMainMirror = prepareUpdateServerMainMirror;
