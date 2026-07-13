/**
 * Shared type definitions for the update server.
 */

/** Supported platform identifiers */
export type Platform =
	| "darwin-arm64"
	| "darwin-x64"
	| "linux-x64"
	| "linux-x64-baseline"
	| "linux-arm64"
	| "win-x64"
	| "win-x64-baseline";

/** Release channel */
export type Channel = "stable" | "beta";

/** Token role */
export type TokenRole = "admin" | "upload";

/** Stored token record */
export interface TokenRecord {
	id: string;
	name: string;
	/** bcrypt hash of the token */
	tokenHash: string;
	role: TokenRole;
	createdAt: string;
}

/** Server configuration persisted to config.json */
export interface ServerConfig {
	port: number;
	host: string;
	dataDir: string;
	tokens: TokenRecord[];
	storage: {
		type: "local";
	};
	cors: {
		enabled: boolean;
		origins: string[];
	};
}

/** Per-platform file info stored in meta.json */
export interface PlatformFileInfo {
	filename: string;
	size: number;
	sha512: string;
	hasZstdPatch: boolean;
	/** Legacy/canonical patch base retained for rollback compatibility. */
	zstdPatchFromVersion?: string;
	/** All versioned direct patch bases available for this target binary. */
	zstdPatchFromVersions?: string[];
}

/** Release metadata stored as meta.json per version */
export interface ReleaseMeta {
	version: string;
	channel: Channel;
	releaseDate: string;
	/** Release notes — plain string or localized { "en": "...", "zh-CN": "..." } */
	releaseNotes?: string | Record<string, string>;
	platforms: Record<string, PlatformFileInfo>;
}

/** Response from the check-update endpoint */
export interface CheckUpdateResponse {
	updateAvailable: boolean;
	currentVersion?: string;
	version?: string;
	releaseDate?: string;
	/** Release notes for the latest version */
	releaseNotes?: string | Record<string, string>;
	platform?: string;
	file?: {
		filename: string;
		size: number;
		sha512: string;
	};
	zstdPatch?: {
		fromVersion: string;
		patchSize: number;
		url: string;
		metaUrl: string;
	} | null;
	patchChain?: Array<{
		fromVersion: string;
		toVersion: string;
		patchSize: number;
		url: string;
		metaUrl: string;
	}>;
	/** Release notes for each version in the update path */
	releaseNotesPerVersion?: Array<{
		version: string;
		releaseDate: string;
		releaseNotes?: string | Record<string, string>;
	}>;
}

/** Zstd patch metadata */
export interface ZstdPatchMeta {
	fromVersion: string;
	toVersion: string;
	stableEnd: number;
	newTailSize: number;
	patchSize: number;
	newFileSize: number;
	newFileSha512: string;
}

/** Release list item */
export interface ReleaseListItem {
	version: string;
	channel: Channel;
	releaseDate: string;
	releaseNotes?: string | Record<string, string>;
	platforms: string[];
}
