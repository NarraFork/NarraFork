import { createHash } from "node:crypto";
import { mkdtemp, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HELPER_BINARY_MAX_BYTES,
	HELPER_MANIFEST_FILENAME,
	parseExecutorReleaseManifest,
	parseHelperManifest,
} from "../../shared/helper-distribution";
import {
	MIRROR_ASSET_HEADERS,
	type MirrorAssetDescriptor,
} from "../../shared/independent-update-mirror";
import {
	mirrorJobTimeoutMs,
	mirrorUploadConcurrency,
	validateMirrorJobTimeoutMs,
} from "../../shared/mirror-relay";
import { isValidReleaseVersion } from "../../shared/release-version";
import { EXECUTOR_MANIFEST_FILENAME } from "../../shared/remote-executor";
import { REMOTE_PEER_MANIFEST_FILENAME } from "../../shared/remote-peer";
import { parseRemotePeerReleaseManifest } from "../../shared/remote-peer-manifest";
import { downloadReleaseAsset, hashReleaseFile, timeReleasePhase } from "./ci-release-io";
import {
	currentPublicRelease,
	matchPublicAsset,
	mirrorGhRunner,
	publicTagCommit,
} from "./mirror-public-github";
import {
	assertServerVerified,
	MirrorRelayStage,
	type MirrorRelayStageOptions,
} from "./mirror-relay-stage";
import {
	groupMirrorUploads,
	MirrorUploadPool,
	mirrorUploadDiskBytes,
	orderMirrorUploads,
} from "./mirror-upload-pool";
import { UpdateServerMirrorHttp } from "./update-server-bridge-http";
import {
	assertMirrorPublicationIdentity,
	IndependentMirrorError,
	type IndependentMirrorReceipt,
	type MirrorPublishedOptions,
	mirrorReceipt,
} from "./update-server-main-mirror";

/** GitHub-authorized metadata plus separately streamed, bounded component binaries. */
export async function mirrorPublishedToolsRelease(
	options: MirrorPublishedOptions,
): Promise<IndependentMirrorReceipt> {
	const receipt = mirrorReceipt(options);
	const parentSignal = AbortSignal.any([
		AbortSignal.timeout(
			validateMirrorJobTimeoutMs(options.totalTimeoutMs ?? mirrorJobTimeoutMs(options.kind)),
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
		const kind = options.kind;
		if (kind !== "helpers" && kind !== "executor" && kind !== "remote-peer")
			throw new Error("Invalid auxiliary mirror kind");
		if (
			!options.tag.startsWith(`${kind}-v`) ||
			!isValidReleaseVersion(options.tag.slice(`${kind}-v`.length))
		)
			throw new Error("Exact public component tag required");
		const run = mirrorGhRunner(options.run, signal);
		const remote = await currentPublicRelease(run, options.repository, options.tag);
		const commit = await publicTagCommit(run, options.repository, options.tag);
		assertMirrorPublicationIdentity(options, remote, commit);
		const name =
			kind === "helpers"
				? HELPER_MANIFEST_FILENAME
				: kind === "executor"
					? EXECUTOR_MANIFEST_FILENAME
					: REMOTE_PEER_MANIFEST_FILENAME;
		const manifestAsset = remote.assets.find((a) => a.name === name);
		if (!manifestAsset || manifestAsset.size > 64 * 1024)
			throw new Error("Missing/bounded public component manifest required");
		const read = async (asset: { id: number; size: number; digest: string }) => {
			if (asset.size > 64 * 1024) throw new Error("Auxiliary metadata exceeds 64KiB");
			const content = await run([
				"api",
				`repos/${options.repository}/releases/assets/${asset.id}`,
				"-H",
				"Accept: application/octet-stream",
			]);
			const sha256 = createHash("sha256").update(content).digest("hex");
			if (Buffer.byteLength(content) !== asset.size || asset.digest !== `sha256:${sha256}`)
				throw new Error("Public auxiliary metadata raw bytes mismatch");
			return { content, sha256 };
		};
		const manifestBytes = await read(manifestAsset);
		const raw = JSON.parse(manifestBytes.content);
		const manifest =
			kind === "helpers"
				? parseHelperManifest(raw, { repository: options.repository, commit, tag: options.tag })
				: kind === "executor"
					? parseExecutorReleaseManifest(raw, {
							repository: options.repository,
							commit,
							tag: options.tag,
							version: options.tag.slice("executor-v".length),
							protocolVersion: raw.manifest?.protocolVersion,
						})
					: parseRemotePeerReleaseManifest(raw, {
							repository: options.repository,
							commit,
							tag: options.tag,
							version: options.tag.slice("remote-peer-v".length),
							protocolVersion: raw.manifest?.protocolVersion,
						});
		const version = options.tag.slice(`${kind}-v`.length);
		if (kind === "remote-peer" && remote.prerelease !== version.includes("-"))
			throw new Error("Public remote peer prerelease identity mismatch");
		if (manifest.licenses.length + 1 > 16)
			throw new Error("Auxiliary metadata count exceeds 16 files");
		const binaries: MirrorAssetDescriptor[] = (
			"files" in manifest
				? manifest.files
				: Object.entries(manifest.manifest.platforms).map(([platform, f]) => ({
						name: f.filename,
						size: f.size,
						sha256: f.sha256,
						platform,
					}))
		).map(({ name, size, sha256, platform }) => ({
			name,
			size,
			sha256,
			platform,
			version,
			kind: `${kind}-binary`,
		}));
		for (const binary of binaries) matchPublicAsset(remote, binary);
		const assets = [{ name, size: manifestAsset.size, ...manifestBytes }];
		for (const license of manifest.licenses) {
			const asset = matchPublicAsset(remote, license);
			assets.push({ ...license, ...(await read(asset)) });
		}
		const budget = options.maxTotalBytes ?? 4 * 1024 ** 3;
		if (
			binaries.length > 16 ||
			!Number.isSafeInteger(budget) ||
			budget < 1 ||
			2 * [...assets, ...binaries].reduce((sum, a) => sum + a.size, 0) > budget
		)
			throw new Error("Auxiliary mirror total byte budget exceeded");
		options.reserveAssets?.([...assets, ...binaries]);
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
		const root = `/api/v3/products/narrafork/mirror/tools/${kind}/${encodeURIComponent(options.tag)}`;
		const revalidate = async () => {
			if ((await publicTagCommit(run, options.repository, options.tag)) !== commit)
				throw new Error("Auxiliary source tag changed");
			const current = await currentPublicRelease(run, options.repository, options.tag);
			if (
				current.id !== remote.id ||
				(kind === "remote-peer" && current.prerelease !== remote.prerelease) ||
				JSON.stringify(current.assets) !== JSON.stringify(remote.assets)
			)
				throw new Error("Auxiliary public assets changed");
		};
		const http = stage
			? undefined
			: (options.http ??
				new UpdateServerMirrorHttp(
					options.config as NonNullable<MirrorPublishedOptions["config"]>,
				));
		await revalidate();
		directory = await mkdtemp(join(tmpdir(), "nf-tools-mirror-"));
		const disk = await statfs(directory);
		const groups = groupMirrorUploads(binaries);
		uploadOrder = [...assets, ...binaries];
		if (
			disk.bavail * disk.bsize <
			mirrorUploadDiskBytes(
				groups.map((g) => g.asset),
				pool.concurrency,
			)
		)
			throw new Error("Insufficient component mirror disk budget");
		await pool.run(groups, async ({ asset: binary, names }, index) => {
			const asset = matchPublicAsset(remote, binary);
			const path = join(directory as string, `${index}-${binary.sha256}`);
			try {
				await timeReleasePhase(
					"mirror.github-component",
					{ inputBytes: binary.size, version, platform: binary.platform },
					async () => {
						await (options.downloadAsset ?? downloadReleaseAsset)({
							repository: options.repository,
							assetId: asset.id,
							size: binary.size,
							outputPath: path,
							signal,
						});
						const actual = await hashReleaseFile(path, HELPER_BINARY_MAX_BYTES, signal);
						if (actual.size !== binary.size || actual.sha256 !== binary.sha256)
							throw new Error("Public component binary raw bytes mismatch");
					},
					signal,
				);
				const stream = Bun.file(path).stream();
				try {
					await timeReleasePhase(
						"mirror.component-upload",
						{ inputBytes: binary.size, version, platform: binary.platform },
						async () => {
							if (stage) return stage.uploadObject(binary, stream);
							const ack = await (http as UpdateServerMirrorHttp).putRaw(
								`/api/v3/products/narrafork/mirror/assets/${binary.sha256}`,
								stream,
								{
									maxBytes: HELPER_BINARY_MAX_BYTES,
									expected: binary,
									signal,
									headers: {
										[MIRROR_ASSET_HEADERS.repository]: options.repository,
										[MIRROR_ASSET_HEADERS.kind]: binary.kind,
										[MIRROR_ASSET_HEADERS.name]: binary.name,
										[MIRROR_ASSET_HEADERS.size]: String(binary.size),
										[MIRROR_ASSET_HEADERS.version]: version,
										[MIRROR_ASSET_HEADERS.platform]: binary.platform as string,
									},
								},
							);
							const value = ack as Record<string, unknown> | null;
							if (
								!value ||
								value.schemaVersion !== 1 ||
								value.verification !== "server-sha256" ||
								value.name !== binary.name ||
								value.size !== binary.size ||
								value.sha256 !== binary.sha256
							)
								throw new Error("Missing server-sha256 binary receipt; upgrade the update server");
						},
						signal,
					);
				} catch (error) {
					pool.fail(error);
					throw error;
				} finally {
					if (!stream.locked) await stream.cancel().catch(() => {});
				}
				receipt.uploaded.push(...names);
			} catch (error) {
				pool.fail(error);
				throw error;
			} finally {
				await rm(path, { force: true });
			}
		});
		const projection = {
			schemaVersion: 1,
			repository: options.repository,
			kind,
			tag: options.tag,
			assets,
			binaries,
		};
		if (stage) {
			await pool.run(groupMirrorUploads(assets), async ({ asset, names }) => {
				await stage.uploadObject(asset, new TextEncoder().encode(asset.content));
				receipt.uploaded.push(...names);
			});
			await stage.preparePayload(projection, 1024 * 1024);
			receipt.relay = await stage.publish(revalidate);
			receipt.status = "STAGED_FOR_PULL";
			return receipt;
		}
		await revalidate();
		const result = await (http as UpdateServerMirrorHttp).postJson(root, projection, {
			maxBytes: 1024 * 1024,
			signal,
		});
		assertServerVerified(result, { repository: options.repository, kind, tag: options.tag }, [
			...assets,
			...binaries,
		]);
		receipt.uploaded.push(...assets.map((a) => a.name));
		receipt.verified = [...assets, ...binaries].map((a) => a.name);
		receipt.snapshotCommitted = true;
		receipt.status = "MIRRORED";
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
/** @deprecated A pre-publication bundle/old tool alias never authorizes canonical mirrors. */
export async function prepareUpdateServerToolsMirror(..._args: unknown[]): Promise<never> {
	throw new Error("prepare-bridge is retired; mirror the exact public component tag");
}
export const restoreUpdateServerToolsMirror = prepareUpdateServerToolsMirror;
export const publishUpdateServerToolsMirror = prepareUpdateServerToolsMirror;
