import { isValidGitHubRepository } from "../github-repository";
import { isValidReleaseVersion } from "../release-version";
import {
	parseRemoteFrontendCapability,
	type RemoteFrontendCapability,
	remoteContractObject,
} from "./application";

export const REMOTE_FRONTEND_MANIFEST_MAX_BYTES = 1024 * 1024;
export const REMOTE_FRONTEND_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
export const REMOTE_FRONTEND_EXPANDED_MAX_BYTES = 512 * 1024 * 1024;
export const REMOTE_FRONTEND_FILE_MAX_BYTES = 64 * 1024 * 1024;
export const REMOTE_FRONTEND_MAX_FILES = 4096;

export interface RemoteFrontendFile {
	path: string;
	size: number;
	sha256: string;
}
export interface RemoteFrontendManifest {
	schemaVersion: 1;
	repository: string;
	nfVersion: string;
	sourceCommit: string;
	buildId: string;
	capability: RemoteFrontendCapability;
	entry: string;
	bootstrap: string;
	css: string[];
	files: RemoteFrontendFile[];
	archive: { name: string; size: number; sha256: string };
}
export type RemoteFrontendBuildInput = Pick<
	RemoteFrontendManifest,
	| "repository"
	| "nfVersion"
	| "sourceCommit"
	| "capability"
	| "entry"
	| "bootstrap"
	| "css"
	| "files"
>;

export function isRemoteFrontendDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
export function isRemoteFrontendVersion(value: unknown): value is string {
	return typeof value === "string" && value.length <= 64 && isValidReleaseVersion(value);
}

/** A URL-safe relative regular-file path, never a filesystem or origin authority. */
export function isRemoteFrontendAssetPath(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		value.length < 1 ||
		value.length > 240 ||
		!/^(?:[A-Za-z0-9_+$.-]+\/)*[A-Za-z0-9_+$.-]+$/.test(value)
	)
		return false;
	return value
		.split("/")
		.every(
			(part) =>
				part !== "." &&
				part !== ".." &&
				!part.endsWith(".") &&
				!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
		);
}

export function remoteFrontendArtifactNames(version: string) {
	if (!isRemoteFrontendVersion(version)) throw new Error("REMOTE_FRONTEND_VERSION_INVALID");
	return {
		archive: `narrafork-${version}-remote-frontend.tar.gz`,
		manifest: `narrafork-${version}-remote-frontend.manifest.json`,
	};
}
function size(value: unknown, maximum: number, allowEmpty = false): number {
	if (
		!Number.isSafeInteger(value) ||
		(value as number) < (allowEmpty ? 0 : 1) ||
		(value as number) > maximum
	)
		throw new Error("REMOTE_FRONTEND_SIZE_INVALID");
	return value as number;
}
function assetPath(value: unknown): string {
	if (!isRemoteFrontendAssetPath(value)) throw new Error("REMOTE_FRONTEND_PATH_INVALID");
	return value;
}
function digest(value: unknown): string {
	if (!isRemoteFrontendDigest(value)) throw new Error("REMOTE_FRONTEND_DIGEST_INVALID");
	return value;
}

/** This parses identities; archive contents still require byte/hash verification before serving. */
export function parseRemoteFrontendManifest(value: unknown): RemoteFrontendManifest {
	const text = JSON.stringify(value);
	if (
		typeof text !== "string" ||
		new TextEncoder().encode(text).byteLength > REMOTE_FRONTEND_MANIFEST_MAX_BYTES
	)
		throw new Error("REMOTE_FRONTEND_MANIFEST_TOO_LARGE");
	const record = remoteContractObject(value, [
		"schemaVersion",
		"repository",
		"nfVersion",
		"sourceCommit",
		"buildId",
		"capability",
		"entry",
		"bootstrap",
		"css",
		"files",
		"archive",
	]);
	if (
		record.schemaVersion !== 1 ||
		typeof record.repository !== "string" ||
		!isValidGitHubRepository(record.repository) ||
		!isRemoteFrontendVersion(record.nfVersion) ||
		typeof record.sourceCommit !== "string" ||
		!/^[a-f0-9]{40}$/.test(record.sourceCommit)
	)
		throw new Error("REMOTE_FRONTEND_IDENTITY_INVALID");
	const capability = parseRemoteFrontendCapability(record.capability);
	const entry = assetPath(record.entry);
	const bootstrap = assetPath(record.bootstrap);
	if (!/\.m?js$/.test(entry) || !/\.m?js$/.test(bootstrap) || entry === bootstrap)
		throw new Error("REMOTE_FRONTEND_ENTRY_INVALID");
	if (!Array.isArray(record.css) || record.css.length > 256)
		throw new Error("REMOTE_FRONTEND_CSS_INVALID");
	const css = record.css.map(assetPath);
	if (new Set(css).size !== css.length || css.some((path) => !path.endsWith(".css")))
		throw new Error("REMOTE_FRONTEND_CSS_INVALID");
	if (
		!Array.isArray(record.files) ||
		record.files.length < 2 ||
		record.files.length > REMOTE_FRONTEND_MAX_FILES
	)
		throw new Error("REMOTE_FRONTEND_FILES_INVALID");
	const names = new Set<string>();
	const foldedNames = new Set<string>();
	let expanded = 0;
	const files = record.files.map((value): RemoteFrontendFile => {
		const file = remoteContractObject(value, ["path", "size", "sha256"]);
		const path = assetPath(file.path);
		if (names.has(path) || foldedNames.has(path.toLowerCase()) || path === "manifest.json")
			throw new Error("REMOTE_FRONTEND_FILE_DUPLICATE");
		names.add(path);
		foldedNames.add(path.toLowerCase());
		const bytes = size(file.size, REMOTE_FRONTEND_FILE_MAX_BYTES, true);
		expanded += bytes;
		if (expanded > REMOTE_FRONTEND_EXPANDED_MAX_BYTES)
			throw new Error("REMOTE_FRONTEND_EXPANDED_TOO_LARGE");
		return { path, size: bytes, sha256: digest(file.sha256) };
	});
	for (const required of [entry, bootstrap, ...css])
		if (!names.has(required) || files.find((file) => file.path === required)?.size === 0)
			throw new Error("REMOTE_FRONTEND_ENTRY_MISSING");
	// A file may not simultaneously be a directory containing another declared file.
	for (const name of names) {
		const segments = name.split("/");
		for (let index = 1; index < segments.length; index++)
			if (foldedNames.has(segments.slice(0, index).join("/").toLowerCase()))
				throw new Error("REMOTE_FRONTEND_FILE_DIRECTORY_COLLISION");
	}
	const archive = remoteContractObject(record.archive, ["name", "size", "sha256"]);
	if (archive.name !== remoteFrontendArtifactNames(record.nfVersion).archive)
		throw new Error("REMOTE_FRONTEND_ARCHIVE_NAME_INVALID");
	return {
		schemaVersion: 1,
		repository: record.repository,
		nfVersion: record.nfVersion,
		sourceCommit: record.sourceCommit,
		buildId: digest(record.buildId),
		capability,
		entry,
		bootstrap,
		css,
		files,
		archive: {
			name: archive.name,
			size: size(archive.size, REMOTE_FRONTEND_ARCHIVE_MAX_BYTES),
			sha256: digest(archive.sha256),
		},
	};
}

/** Archive bytes/metadata are excluded so there is no build-id/archive self-hash cycle. */
export function remoteFrontendBuildMaterial(input: RemoteFrontendBuildInput): string {
	return JSON.stringify({
		repository: input.repository,
		nfVersion: input.nfVersion,
		sourceCommit: input.sourceCommit,
		capability: parseRemoteFrontendCapability(input.capability),
		entry: input.entry,
		bootstrap: input.bootstrap,
		css: input.css,
		files: [...input.files]
			.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
			.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
	});
}
export async function computeRemoteFrontendBuildId(
	input: RemoteFrontendBuildInput,
): Promise<string> {
	const hash = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(remoteFrontendBuildMaterial(input)),
	);
	return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
