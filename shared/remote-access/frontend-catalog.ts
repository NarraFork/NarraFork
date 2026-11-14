import { isValidGitHubRepository } from "../github-repository";
import {
	parseRemoteBackendIdentity,
	REMOTE_FRONTEND_CAPABILITY,
	type RemoteBackendIdentity,
	remoteContractObject,
	remoteFrontendCompatibilityKey,
} from "./application";
import { isRemoteFrontendDigest, isRemoteFrontendVersion } from "./frontend-manifest";

export const REMOTE_FRONTEND_CATALOG_MAX_BYTES = 1024 * 1024;
export const REMOTE_FRONTEND_CATALOG_MAX_ENTRIES = 256;
export interface RemoteFrontendCatalogEntry {
	buildId: string;
	repository: string;
	nfVersion: string;
	bootstrapAbi: number;
	apiEpoch: number;
	wireVersion: number;
	manifestPath: string;
	manifestSha256: string;
	disabled: boolean;
}
export interface RemoteFrontendCatalog {
	schemaVersion: 1;
	bootstrapAbi: 1;
	entries: RemoteFrontendCatalogEntry[];
}
export function remoteFrontendManifestPath(buildId: string): string {
	if (!isRemoteFrontendDigest(buildId)) throw new Error("REMOTE_FRONTEND_BUILD_ID_INVALID");
	return `/remote/frontends/${buildId}/manifest.json`;
}
function positiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 0x7fffffff;
}
function compatibilityKey(entry: RemoteFrontendCatalogEntry): string {
	return `${entry.repository}:${entry.nfVersion}:${entry.bootstrapAbi}:${entry.apiEpoch}:${entry.wireVersion}`;
}

/** The catalog is host-local availability, not the main-program updater index. */
export function parseRemoteFrontendCatalog(value: unknown): RemoteFrontendCatalog {
	const text = JSON.stringify(value);
	if (
		typeof text !== "string" ||
		new TextEncoder().encode(text).byteLength > REMOTE_FRONTEND_CATALOG_MAX_BYTES
	)
		throw new Error("REMOTE_FRONTEND_CATALOG_TOO_LARGE");
	const record = remoteContractObject(value, ["schemaVersion", "bootstrapAbi", "entries"]);
	if (
		record.schemaVersion !== 1 ||
		record.bootstrapAbi !== REMOTE_FRONTEND_CAPABILITY.bootstrapAbi ||
		!Array.isArray(record.entries) ||
		record.entries.length > REMOTE_FRONTEND_CATALOG_MAX_ENTRIES
	)
		throw new Error("REMOTE_FRONTEND_CATALOG_INVALID");
	const buildIds = new Set<string>();
	const activeKeys = new Set<string>();
	const entries = record.entries.map((value): RemoteFrontendCatalogEntry => {
		const entry = remoteContractObject(value, [
			"buildId",
			"repository",
			"nfVersion",
			"bootstrapAbi",
			"apiEpoch",
			"wireVersion",
			"manifestPath",
			"manifestSha256",
			"disabled",
		]);
		if (
			!isRemoteFrontendDigest(entry.buildId) ||
			typeof entry.repository !== "string" ||
			!isValidGitHubRepository(entry.repository) ||
			!isRemoteFrontendVersion(entry.nfVersion) ||
			!positiveInteger(entry.bootstrapAbi) ||
			!positiveInteger(entry.apiEpoch) ||
			!positiveInteger(entry.wireVersion) ||
			entry.manifestPath !== remoteFrontendManifestPath(entry.buildId) ||
			!isRemoteFrontendDigest(entry.manifestSha256) ||
			typeof entry.disabled !== "boolean"
		)
			throw new Error("REMOTE_FRONTEND_CATALOG_ENTRY_INVALID");
		if (buildIds.has(entry.buildId)) throw new Error("REMOTE_FRONTEND_BUILD_DUPLICATE");
		buildIds.add(entry.buildId);
		const parsed: RemoteFrontendCatalogEntry = {
			buildId: entry.buildId,
			repository: entry.repository,
			nfVersion: entry.nfVersion,
			bootstrapAbi: entry.bootstrapAbi,
			apiEpoch: entry.apiEpoch,
			wireVersion: entry.wireVersion,
			manifestPath: entry.manifestPath,
			manifestSha256: entry.manifestSha256,
			disabled: entry.disabled,
		};
		if (!parsed.disabled) {
			const key = compatibilityKey(parsed);
			if (activeKeys.has(key)) throw new Error("REMOTE_FRONTEND_SELECTION_AMBIGUOUS");
			activeKeys.add(key);
		}
		return parsed;
	});
	return { schemaVersion: 1, bootstrapAbi: 1, entries };
}

/** Missing/disabled/ambiguous versions fail closed; never choose latest or a neighbouring release. */
export function selectRemoteFrontend(
	catalog: RemoteFrontendCatalog,
	backend: RemoteBackendIdentity,
): RemoteFrontendCatalogEntry {
	const parsed = parseRemoteFrontendCatalog(catalog);
	const key = remoteFrontendCompatibilityKey(parseRemoteBackendIdentity(backend));
	const entries = parsed.entries.filter((entry) => compatibilityKey(entry) === key);
	const selected = entries.filter((entry) => !entry.disabled);
	if (selected.length !== 1)
		throw new Error(entries.length ? "REMOTE_FRONTEND_DISABLED" : "REMOTE_FRONTEND_NOT_AVAILABLE");
	return selected[0];
}
