import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { isValidGitHubRepository } from "../../shared/github-repository";
import { MAX_RELEASE_PATCH_BYTES } from "../../shared/release-patch";
import { isValidReleaseVersion } from "../../shared/release-version";
import { byteLimit, hashReleaseFile, type ReleaseAssetDownloader } from "./ci-release-io";

type PatchFetch = (url: string, init: RequestInit) => Promise<Response>;

export function resolveMirrorPatchProxyOrigin(value?: string): string | undefined {
	if (value === undefined || value === "") return undefined;
	const invalid = () => new Error("NF_MIRROR_PATCH_PROXY_ORIGIN must be an HTTPS origin");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw invalid();
	}
	if (url.protocol !== "https:" || (value !== url.origin && value !== `${url.origin}/`))
		throw invalid();
	return url.origin;
}

interface PatchDownload {
	repository: string;
	tag: string;
	assetId: number;
	name: string;
	size: number;
	sha256: string;
	outputPath: string;
	signal: AbortSignal;
}

/** Only call with a public patch descriptor matched against the official release and index. */
export async function downloadMirrorPatchFromSource(
	patch: PatchDownload,
	origin: string | undefined,
	official: ReleaseAssetDownloader,
	fetchImpl: PatchFetch = fetch,
	timeoutMs = 60_000,
): Promise<void> {
	const { repository, tag, assetId, name, size, sha256, outputPath, signal } = patch;
	signal.throwIfAborted();
	if (origin) {
		const proxy = resolveMirrorPatchProxyOrigin(origin);
		if (
			!isValidGitHubRepository(repository) ||
			!tag.startsWith("v") ||
			!isValidReleaseVersion(tag.slice(1)) ||
			!/^[a-zA-Z0-9._+-]+\.zstd-patch$/.test(name) ||
			!Number.isSafeInteger(size) ||
			size <= 0 ||
			size > MAX_RELEASE_PATCH_BYTES ||
			!/^[a-f0-9]{64}$/.test(sha256)
		)
			throw new Error("Invalid public patch identity");
		const url = `${proxy}/https://github.com/${repository.split("/").map(encodeURIComponent).join("/")}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
		const attempt = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
		let ownsOutput = false;
		try {
			const response = await fetchImpl(url, {
				redirect: "manual",
				credentials: "omit",
				headers: { "Accept-Encoding": "identity" },
				signal: attempt,
			});
			const length = response.headers.get("content-length");
			const encoding = response.headers.get("content-encoding");
			if (
				response.status !== 200 ||
				response.redirected ||
				!response.body ||
				(length !== null && length !== String(size)) ||
				(encoding !== null && encoding.toLowerCase() !== "identity") ||
				response.headers.has("content-range")
			) {
				void response.body?.cancel().catch(() => {});
				throw new Error("Invalid proxy patch response");
			}
			const output = createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
			output.once("open", () => {
				ownsOutput = true;
			});
			await pipeline(response.body, byteLimit(size), output, { signal: attempt });
			const actual = await hashReleaseFile(outputPath, size, attempt);
			if (actual.size !== size || actual.sha256 !== sha256)
				throw new Error("Proxy patch integrity mismatch");
			attempt.throwIfAborted();
			return;
		} catch {
			if (ownsOutput) await rm(outputPath, { force: true });
			signal.throwIfAborted();
			// Never log the response, proxy URL or arbitrary errors from this host.
			console.warn("Mirror patch acceleration failed; trying the official GitHub asset");
		}
	}
	await official({ repository, assetId, size, outputPath, signal });
}
