import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
	type GithubPatchStep,
	MAX_RELEASE_BINARY_BYTES,
	MAX_RELEASE_LEGACY_BYTES,
	MAX_RELEASE_PATCH_BYTES,
	MAX_RELEASE_PATCH_STEPS,
	parseReleasePatchName,
	RELEASE_SHA512_RE,
	validateReleasePatchMetadata,
} from "../../shared/release-patch";
import { applyZstdPatchToFile } from "../lib/zstd-patch";
import { validateGithubAssetUrl } from "./github-release-update";
import type { ReleaseInfo, UpdateProgress } from "./update-service";

export const GITHUB_UPDATE_TIMEOUT_MS = 15 * 60_000;

/** One deadline spans every download, reconstruction and fallback, including body reads. */
export function createGithubUpdateDeadline(
	parent?: AbortSignal,
	timeoutMs = GITHUB_UPDATE_TIMEOUT_MS,
): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController();
	const onAbort = () => controller.abort(parent?.reason);
	if (parent?.aborted) onAbort();
	else parent?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(
		() =>
			controller.abort(
				new DOMException("GitHub update exceeded its overall deadline", "TimeoutError"),
			),
		timeoutMs,
	);
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", onAbort);
		},
	};
}

interface DownloadOptions {
	signal: AbortSignal;
	onProgress?: (bytes: number) => void;
	timeoutMs?: number;
}

/** Seams stay file-based: tests never need a compiled executable or a live update server. */
export interface GithubUpdateDependencies {
	downloadPatch: (step: GithubPatchStep, path: string, options: DownloadOptions) => Promise<void>;
	downloadFull: (release: ReleaseInfo, path: string, options: DownloadOptions) => Promise<void>;
	resolveZstd: (signal: AbortSignal) => Promise<string | null>;
	applyPatch?: typeof applyZstdPatchToFile;
	onFallback?: (error: unknown) => void;
}

async function verifyFileIdentity(
	path: string,
	size: number,
	sha512: string,
	signal: AbortSignal,
): Promise<void> {
	signal.throwIfAborted();
	if ((await stat(path)).size !== size) throw new Error("GitHub patch binary size mismatch");
	const hash = createHash("sha512");
	let bytes = 0;
	for await (const chunk of createReadStream(path, { signal })) {
		bytes += chunk.length;
		if (bytes > size) throw new Error("GitHub patch binary exceeds announced size");
		hash.update(chunk);
	}
	signal.throwIfAborted();
	if (bytes !== size || hash.digest("base64") !== sha512) {
		throw new Error("GitHub patch binary SHA512 mismatch");
	}
}

/** Recheck trusted discovery descriptors at execution time, before any patch payload request. */
function validateChain(release: ReleaseInfo, currentVersion: string): GithubPatchStep[] {
	const github = release._github;
	const chain = github?.patchChain;
	if (!github || !chain?.length || chain.length > MAX_RELEASE_PATCH_STEPS) {
		throw new Error("No bounded GitHub patch chain available");
	}
	const finalSize = release.files[0]?.size;
	if (
		!Number.isSafeInteger(finalSize) ||
		!finalSize ||
		finalSize <= 0 ||
		finalSize > MAX_RELEASE_BINARY_BYTES ||
		!RELEASE_SHA512_RE.test(release.sha512) ||
		release.files[0]?.sha512 !== release.sha512
	)
		throw new Error("Invalid GitHub full binary identity");
	validateGithubAssetUrl(github.downloadUrl, github.repository, release.version, release.path);
	let version = currentVersion;
	let previous: GithubPatchStep["meta"] | undefined;
	let patchTotal = 0;
	return chain.map((step, index) => {
		const meta = validateReleasePatchMetadata(step.meta, {
			fromVersion: version,
			toVersion: step.toVersion,
			patchSize: step.patchSize,
			...(index === chain.length - 1
				? { newFileSize: finalSize, newFileSha512: release.sha512 }
				: {}),
		});
		if (
			step.fromVersion !== version ||
			(index === chain.length - 1 && step.toVersion !== release.version)
		) {
			throw new Error("GitHub patch versions do not connect to the selected release");
		}
		if (
			previous &&
			(previous.newFileSize !== meta.oldFileSize || previous.newFileSha512 !== meta.oldFileSha512)
		) {
			throw new Error("GitHub patch intermediate identities do not connect");
		}
		patchTotal += meta.patchSize;
		if (patchTotal > MAX_RELEASE_PATCH_BYTES || patchTotal >= finalSize) {
			throw new Error("GitHub patch chain exceeds its total-byte budget or full download size");
		}
		// Keep old dictionary assets compatible without letting large binaries enter the JS heap.
		if (
			meta.mode !== "patch-from" &&
			Math.max(meta.oldFileSize, meta.newFileSize, meta.patchSize) > MAX_RELEASE_LEGACY_BYTES
		)
			throw new Error("GitHub legacy patch exceeds its small-input memory budget");
		const binaryName = release.path.replace(`-${release.version}-`, `-${step.toVersion}-`);
		const patchName = decodeURIComponent(new URL(step.url).pathname.split("/").at(-1) ?? "");
		const parsed = parseReleasePatchName(binaryName, patchName);
		if (!parsed || (parsed.fromVersion && parsed.fromVersion !== step.fromVersion)) {
			throw new Error("GitHub patch filename does not match its binary or source version");
		}
		validateGithubAssetUrl(step.url, github.repository, step.toVersion, patchName);
		validateGithubAssetUrl(
			step.metaUrl,
			github.repository,
			step.toVersion,
			`${patchName}.meta.json`,
		);
		version = step.toVersion;
		previous = meta;
		return { ...step, meta };
	});
}

/** Publish only to an exclusively-created destination; never remove a pre-existing file. */
async function publishVerifiedFile(source: string, destination: string, signal: AbortSignal) {
	signal.throwIfAborted();
	const handle = await open(destination, "wx", 0o600);
	try {
		await pipeline(createReadStream(source), handle.createWriteStream(), { signal });
		signal.throwIfAborted();
	} catch (error) {
		await handle.close();
		await unlink(destination);
		throw error;
	}
	await handle.close();
}

/** All intermediates belong to one private directory and are removed before full fallback. */
export async function downloadGithubUpdateToFile(
	options: {
		release: ReleaseInfo;
		currentVersion: string;
		basePath: string | null;
		outputPath: string;
		signal: AbortSignal;
		onProgress?: (progress: UpdateProgress) => void;
	},
	dependencies: GithubUpdateDependencies,
): Promise<"zstd" | "full"> {
	const { release, signal, onProgress } = options;
	if (
		release.source !== "github" ||
		!release._github ||
		release._github.repository.toLowerCase() !== release.repository?.toLowerCase()
	)
		throw new Error("GitHub descriptor repository does not match the selected release");
	let strategy: "full" | "zstd" = release._github.patchChain?.length ? "zstd" : "full";
	let fallback = false;
	const progress = (phase: UpdateProgress["phase"], bytes: number, total: number) =>
		onProgress?.({
			phase,
			bytesDownloaded: bytes,
			totalBytes: total,
			percent: total ? Math.round((bytes / total) * 100) : 0,
			strategy,
			fallback,
		});
	signal.throwIfAborted();
	let directory: string | undefined;
	let ownsOutput = false;
	try {
		try {
			const chain = validateChain(release, options.currentVersion);
			const total = chain.reduce((bytes, step) => bytes + step.patchSize, 0);
			progress("downloading", 0, total);
			if (!options.basePath) throw new Error("No current executable for GitHub delta");
			await verifyFileIdentity(
				options.basePath,
				chain[0].meta.oldFileSize,
				chain[0].meta.oldFileSha512,
				signal,
			);
			const needsCli = chain.some((step) => step.meta.mode === "patch-from");
			const zstdPath = needsCli ? await dependencies.resolveZstd(signal) : undefined;
			signal.throwIfAborted();
			if (needsCli && !zstdPath) throw new Error("No local zstd CLI for GitHub delta");
			directory = await mkdtemp(join(dirname(options.outputPath), ".github-patch-"));
			let downloaded = 0;
			let sourcePath = options.basePath;
			for (const [index, step] of chain.entries()) {
				signal.throwIfAborted();
				const patchPath = join(directory, `step-${index}.zstd-patch`);
				const outputPath = join(directory, `step-${index}.binary`);
				await dependencies.downloadPatch(step, patchPath, {
					signal,
					timeoutMs: GITHUB_UPDATE_TIMEOUT_MS,
					onProgress: (bytes) => progress("downloading", downloaded + bytes, total),
				});
				signal.throwIfAborted();
				if ((await stat(patchPath)).size !== step.patchSize)
					throw new Error("GitHub patch payload size mismatch");
				if (step.meta.mode !== "patch-from") {
					// Recheck the actual input after the payload download, immediately before
					// the bounded legacy decoder can read its files into memory.
					await verifyFileIdentity(
						sourcePath,
						step.meta.oldFileSize,
						step.meta.oldFileSha512,
						signal,
					);
				}
				downloaded += step.patchSize;
				progress("applying", downloaded, total);
				await (dependencies.applyPatch ?? applyZstdPatchToFile)({
					oldFilePath: sourcePath,
					patchFilePath: patchPath,
					outputFilePath: outputPath,
					meta: step.meta,
					zstdPath: zstdPath ?? undefined,
					signal,
					timeoutMs: 10 * 60_000,
					maxOutputBytes:
						step.meta.mode === "patch-from" ? MAX_RELEASE_BINARY_BYTES : MAX_RELEASE_LEGACY_BYTES,
				});
				await verifyFileIdentity(
					outputPath,
					step.meta.newFileSize,
					step.meta.newFileSha512,
					signal,
				);
				await unlink(patchPath);
				if (sourcePath !== options.basePath) await unlink(sourcePath);
				sourcePath = outputPath;
			}
			await publishVerifiedFile(sourcePath, options.outputPath, signal);
			ownsOutput = true;
			return "zstd";
		} catch (error) {
			// User cancellation / overall timeout must never start another network request.
			signal.throwIfAborted();
			fallback = strategy === "zstd";
			strategy = "full";
			dependencies.onFallback?.(error);
		} finally {
			if (directory) {
				await rm(directory, { recursive: true, force: true });
				directory = undefined;
			}
		}
		// The full transport exclusively creates its file and owns cleanup on failure.
		signal.throwIfAborted();
		const total = release.files[0]?.size ?? 0;
		progress("downloading", 0, total);
		await dependencies.downloadFull(release, options.outputPath, {
			signal,
			timeoutMs: GITHUB_UPDATE_TIMEOUT_MS,
			onProgress: (bytes) => progress("downloading", bytes, total),
		});
		ownsOutput = true;
		// Production full transport validates size/hash; also verify injected transports here.
		await verifyFileIdentity(options.outputPath, total, release.sha512, signal);
		return "full";
	} catch (error) {
		if (ownsOutput) await rm(options.outputPath, { force: true });
		throw error;
	} finally {
		// No steps survive success, abort, decode error, download error or full fallback.
		if (directory) await rm(directory, { recursive: true, force: true });
	}
}
