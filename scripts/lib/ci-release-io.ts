import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isValidGitHubRepository } from "../../shared/github-repository";
import { MAX_RELEASE_BINARY_BYTES } from "../../shared/release-patch";
import { isValidReleaseVersion } from "../../shared/release-version";
import { updateServerChildEnvironment } from "../../shared/update-server-child-env";
import type { GhRunner } from "./github-release";

export const CI_TEXT_LIMIT = 1024 * 1024;
export const CI_METADATA_LIMIT = 64 * 1024;
export const CI_DOWNLOAD_TIMEOUT = 15 * 60 * 1000;
/** Default and hard disk budget (archive + expanded): eight 4GiB binaries, up to
 * sixteen 512MiB patches, frontend and metadata, with bounded ZIP overhead. */
export const CI_BUNDLE_LIMIT = 96 * 1024 ** 3;
export const CI_PLATFORM_ARTIFACT_LIMIT = MAX_RELEASE_BINARY_BYTES + 2 * 1024 ** 2;
export const CI_DISK_RESERVE = 4 * 1024 ** 3;

/** Known logical input/output sizes, not measured network traffic or partial failure bytes. */
export interface ReleasePhaseDetails {
	platform?: string;
	version?: string;
	fromVersion?: string;
	inputBytes?: number;
	outputBytes?: number;
	fileCount?: number;
	targetCount?: number;
	baselineCount?: number;
}

const releasePhaseScope = new AsyncLocalStorage<number>();
let releasePhaseId = 0;

function releasePhaseDetails(details: ReleasePhaseDetails): ReleasePhaseDetails {
	const safe: ReleasePhaseDetails = {};
	if (
		typeof details.platform === "string" &&
		/^(?:linux|win|windows|darwin|macos)-(?:x64(?:-baseline)?|amd64|arm64)$/.test(details.platform)
	)
		safe.platform = details.platform;
	for (const key of ["version", "fromVersion"] as const) {
		const value = details[key];
		if (typeof value === "string" && value.length <= 128 && isValidReleaseVersion(value))
			safe[key] = value;
	}
	for (const key of [
		"inputBytes",
		"outputBytes",
		"fileCount",
		"targetCount",
		"baselineCount",
	] as const) {
		const value = details[key];
		if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) safe[key] = value;
	}
	return safe;
}

function releasePhaseNow(): number | undefined {
	try {
		const value = performance.now();
		return Number.isFinite(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function writeReleasePhase(
	phase: string,
	id: number,
	parentId: number | undefined,
	state: "start" | "end",
	details: ReleasePhaseDetails,
	result?: {
		durationMs?: number;
		timingUnavailable?: boolean;
		status: "success" | "error" | "cancelled";
		errorKind?: string;
	},
) {
	try {
		console.info(
			JSON.stringify({
				event: "release.phase",
				phase: /^[a-z][a-z0-9.-]{0,95}$/.test(phase) ? phase : "unknown",
				id,
				...(parentId === undefined ? {} : { parentId }),
				state,
				timestamp: new Date().toISOString(),
				...releasePhaseDetails(details),
				// This is the controller's RSS snapshot, NOT zstd child RSS or a peak measurement.
				controllerRssBytes: process.memoryUsage.rss(),
				...result,
			}),
		);
	} catch {
		// Observability failures must never replace an integrity/cancellation error or its result.
	}
}

/** Emits bounded phase boundaries without adding IO, changing cancellation, or wrapping errors. */
export async function timeReleasePhase<T>(
	phase: string,
	details: ReleasePhaseDetails,
	operation: () => T | Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	const id = ++releasePhaseId;
	const parentId = releasePhaseScope.getStore();
	const start = releasePhaseNow();
	let status: "success" | "error" | "cancelled" = "success";
	let errorKind: "Error" | "AbortError" | "TimeoutError" | undefined;
	writeReleasePhase(phase, id, parentId, "start", details);
	try {
		return await releasePhaseScope.run(id, operation);
	} catch (error) {
		errorKind = "Error";
		try {
			const name = (error as { name?: unknown } | null)?.name;
			if (name === "AbortError" || name === "TimeoutError") errorKind = name;
		} catch {
			// An exotic thrown object's getter is not part of the operation's failure contract.
		}
		status =
			errorKind !== "TimeoutError" && (signal?.aborted || errorKind === "AbortError")
				? "cancelled"
				: "error";
		throw error;
	} finally {
		const end = releasePhaseNow();
		writeReleasePhase(phase, id, parentId, "end", details, {
			...(start === undefined || end === undefined
				? { timingUnavailable: true }
				: { durationMs: Math.max(0, Math.round(end - start)) }),
			status,
			...(errorKind ? { errorKind } : {}),
		});
	}
}

/** CI queries are read-only, noninteractive and bounded before collecting output. */
export const runCiGh: GhRunner = (args) =>
	execFileSync("gh", args, {
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: CI_TEXT_LIMIT,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...updateServerChildEnvironment(), GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" },
	});

async function openReleaseStream(path: string, signal?: AbortSignal) {
	signal?.throwIfAborted();
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		return handle.createReadStream({ signal });
	} catch (error) {
		await handle.close();
		throw error;
	}
}

export async function hashReleaseFile(
	path: string,
	maximum = MAX_RELEASE_BINARY_BYTES,
	signal?: AbortSignal,
): Promise<{ size: number; sha256: string; sha512: string }> {
	signal?.throwIfAborted();
	const stat = await lstat(path);
	if (!stat.isFile() || stat.size <= 0 || stat.size > maximum)
		throw new Error(`Invalid release file size/type: ${path}`);
	const sha256 = createHash("sha256");
	const sha512 = createHash("sha512");
	let size = 0;
	for await (const chunk of await openReleaseStream(path, signal)) {
		size += chunk.length;
		if (size > maximum) throw new Error(`Release file exceeds limit: ${path}`);
		sha256.update(chunk);
		sha512.update(chunk);
	}
	if (size !== stat.size) throw new Error(`Release file changed while reading: ${path}`);
	return { size, sha256: sha256.digest("hex"), sha512: sha512.digest("base64") };
}

export async function readReleaseText(path: string, maximum = CI_TEXT_LIMIT): Promise<string> {
	const stat = await lstat(path);
	if (!stat.isFile() || stat.size <= 0 || stat.size > maximum)
		throw new Error(`Invalid release text size/type: ${path}`);
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of await openReleaseStream(path)) {
		size += chunk.length;
		if (size > maximum) throw new Error(`Release text exceeds limit: ${path}`);
		chunks.push(chunk);
	}
	if (size !== stat.size) throw new Error(`Release text changed while reading: ${path}`);
	return Buffer.concat(chunks, size).toString("utf8");
}

export function byteLimit(maximum: number): Transform {
	let size = 0;
	return new Transform({
		transform(chunk: Buffer, _encoding, done) {
			size += chunk.length;
			done(size > maximum ? new Error("Release stream exceeds byte limit") : null, chunk);
		},
	});
}

export async function copyReleaseFile(
	source: string,
	destination: string,
	maximum: number,
	signal?: AbortSignal,
): Promise<void> {
	await pipeline(
		await openReleaseStream(source, signal),
		byteLimit(maximum),
		createWriteStream(destination, { flags: "wx", mode: 0o600 }),
		{ signal },
	);
}

export interface DownloadReleaseAssetOptions {
	repository: string;
	assetId: number;
	size: number;
	outputPath: string;
	signal?: AbortSignal;
}
export type ReleaseAssetDownloader = (options: DownloadReleaseAssetOptions) => Promise<void>;

/** gh follows GitHub's authenticated asset redirects; bytes never accumulate on the JS heap. */
export const downloadReleaseAsset: ReleaseAssetDownloader = async (options) => {
	if (
		!isValidGitHubRepository(options.repository) ||
		!Number.isSafeInteger(options.assetId) ||
		options.assetId <= 0 ||
		!Number.isSafeInteger(options.size) ||
		options.size <= 0 ||
		options.size > MAX_RELEASE_BINARY_BYTES
	)
		throw new Error("Invalid baseline asset download identity");
	options.signal?.throwIfAborted();
	const signal = AbortSignal.any([
		AbortSignal.timeout(CI_DOWNLOAD_TIMEOUT),
		...(options.signal ? [options.signal] : []),
	]);
	const child = spawn(
		"gh",
		[
			"api",
			`repos/${options.repository}/releases/assets/${options.assetId}`,
			"-H",
			"Accept: application/octet-stream",
		],
		{
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...updateServerChildEnvironment(), GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" },
		},
	);
	let diagnostic = "";
	let diagnosticBytes = 0;
	child.stderr.on("data", (chunk: Buffer) => {
		diagnosticBytes += chunk.length;
		if (diagnosticBytes <= CI_METADATA_LIMIT) diagnostic += chunk.toString("utf8");
		else child.kill("SIGKILL");
	});
	const completion = new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) =>
			code === 0 && diagnosticBytes <= CI_METADATA_LIMIT
				? resolve()
				: reject(new Error(`Baseline asset download failed: ${diagnostic.slice(0, 8192)}`)),
		);
	});
	const abort = () => {
		child.kill("SIGKILL");
	};
	signal.addEventListener("abort", abort, { once: true });
	let ownsOutput = false;
	const output = createWriteStream(options.outputPath, { flags: "wx", mode: 0o600 });
	output.once("open", () => {
		ownsOutput = true;
	});
	const transfer = pipeline(child.stdout, byteLimit(options.size), output, { signal });
	try {
		await Promise.all([completion, transfer]);
		const stat = await lstat(options.outputPath);
		if (stat.size !== options.size) throw new Error("Baseline download size mismatch");
		signal.throwIfAborted();
	} catch (error) {
		child.kill("SIGKILL");
		await Promise.allSettled([completion, transfer]);
		if (ownsOutput) await rm(options.outputPath, { force: true });
		throw error;
	} finally {
		signal.removeEventListener("abort", abort);
	}
};
