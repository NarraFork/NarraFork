import {
	parseRemoteBackendIdentity,
	type RemoteBackendIdentity,
	remoteFrontendCompatibilityKey,
} from "@shared/remote-access/application";
import {
	parseRemoteFrontendCatalog,
	selectRemoteFrontend,
} from "@shared/remote-access/frontend-catalog";
import {
	computeRemoteFrontendBuildId,
	parseRemoteFrontendManifest,
	type RemoteFrontendManifest,
} from "@shared/remote-access/frontend-manifest";

const JSON_LIMIT = 1024 * 1024;
export function sameOriginStaticUrl(path: string, origin: string): URL {
	const url = new URL(path, origin);
	if (
		url.origin !== new URL(origin).origin ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		/[\\%]/.test(path) ||
		path.split("/").some((segment) => segment === "." || segment === "..")
	)
		throw new Error("REMOTE_STATIC_URL_INVALID");
	return url;
}
async function readStaticBytes(
	url: URL,
	fetcher: typeof fetch,
	maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
	const response = await fetcher(url, {
		redirect: "error",
		credentials: "omit",
		cache: "no-cache",
		signal: AbortSignal.timeout(30_000),
	});
	if (
		!response.ok ||
		response.redirected ||
		(response.url && new URL(response.url).origin !== url.origin)
	)
		throw new Error("REMOTE_STATIC_FETCH_FAILED");
	if (Number(response.headers.get("content-length")) > maxBytes) {
		void response.body?.cancel();
		throw new Error("REMOTE_STATIC_TOO_LARGE");
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("REMOTE_STATIC_EMPTY");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				throw new Error("REMOTE_STATIC_TOO_LARGE");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
export function integrity(sha: string): string {
	if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error("REMOTE_HASH_INVALID");
	return `sha256-${btoa(String.fromCharCode(...(sha.match(/../g) ?? []).map((part) => Number.parseInt(part, 16))))}`;
}

/** Exact identity selection. Never latest, peer version, semver range or arbitrary origin. */
export async function selectRemoteBuild(
	identity: RemoteBackendIdentity,
	origin: string,
	fetcher: typeof fetch = fetch,
): Promise<{ manifest: RemoteFrontendManifest; assetBase: string; entryUrl: string }> {
	const backend = parseRemoteBackendIdentity(identity);
	const catalogBytes = await readStaticBytes(
		sameOriginStaticUrl("/remote/catalog.json", origin),
		fetcher,
		JSON_LIMIT,
	);
	const catalog = parseRemoteFrontendCatalog(JSON.parse(new TextDecoder().decode(catalogBytes)));
	const selected = selectRemoteFrontend(catalog, backend);
	if (!selected) throw new Error("REMOTE_FRONTEND_NOT_AVAILABLE");
	const assetBase = sameOriginStaticUrl(`/remote/frontends/${selected.buildId}/`, origin).href;
	const expectedManifestPath = `/remote/frontends/${selected.buildId}/manifest.json`;
	if (selected.manifestPath !== expectedManifestPath)
		throw new Error("REMOTE_MANIFEST_PATH_INVALID");
	const bytes = await readStaticBytes(
		sameOriginStaticUrl(selected.manifestPath, origin),
		fetcher,
		JSON_LIMIT,
	);
	if ((await sha256(bytes)) !== selected.manifestSha256)
		throw new Error("REMOTE_MANIFEST_HASH_MISMATCH");
	const manifest = parseRemoteFrontendManifest(JSON.parse(new TextDecoder().decode(bytes)));
	if (
		manifest.buildId !== selected.buildId ||
		remoteFrontendCompatibilityKey({
			...backend,
			repository: manifest.repository,
			nfVersion: manifest.nfVersion,
			bootstrapAbi: manifest.capability.bootstrapAbi,
			apiEpoch: manifest.capability.apiEpoch,
			wireVersion: manifest.capability.wireVersion,
		}) !== remoteFrontendCompatibilityKey(backend)
	)
		throw new Error("REMOTE_MANIFEST_IDENTITY_MISMATCH");
	if ((await computeRemoteFrontendBuildId(manifest)) !== manifest.buildId)
		throw new Error("REMOTE_BUILD_ID_MISMATCH");
	const entryUrl = sameOriginStaticUrl(new URL(manifest.entry, assetBase).href, origin).href;
	if (!entryUrl.startsWith(assetBase)) throw new Error("REMOTE_ENTRY_PATH_INVALID");
	return { manifest, assetBase, entryUrl };
}
