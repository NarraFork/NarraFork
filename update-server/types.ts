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
	hasBlockmap: boolean;
	hasZstdPatch: boolean;
	zstdPatchFromVersion?: string;
	/** Whether the full binary file is available for download. */
	hasFullFile?: boolean;
}

/** Release metadata stored as meta.json per version */
export interface ReleaseMeta {
	version: string;
	channel: Channel;
	releaseDate: string;
	releaseNotes?: string;
	platforms: Record<string, PlatformFileInfo>;
}

/** Response from the check-update endpoint */
export interface CheckUpdateResponse {
	updateAvailable: boolean;
	currentVersion?: string;
	version?: string;
	releaseDate?: string;
	releaseNotes?: string;
	platform?: string;
	file?: {
		filename: string;
		size: number;
		sha512: string;
	};
	/** Whether the full binary is available for download (false = delta only). */
	hasFullFile?: boolean;
	blockmap?: {
		url: string;
	};
	zstdPatch?: {
		fromVersion: string;
		patchSize: number;
		url: string;
		metaUrl: string;
	} | null;
}

/** Zstd patch metadata (matches server/lib/blockmap.ts ZstdPatchMeta) */
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
	releaseNotes?: string;
	platforms: string[];
}
