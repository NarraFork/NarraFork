/** Public, bounded machine metadata. Human release notes live outside this catalog. */
export const UPDATE_INDEX_BRANCH = "narrafork-updates";
export const UPDATE_INDEX_FILE = "update-index-v1.json";
export const MAX_UPDATE_INDEX_BYTES = 256 * 1024;
export const MAX_UPDATE_INDEX_RELEASE_BYTES = 96 * 1024;
export const MAX_UPDATE_INDEX_RELEASES = 32;
export const MAX_UPDATE_NOTES_BYTES = 1024 * 1024;
export const UPDATE_INDEX_PLATFORMS: Readonly<Record<string, string>> = {
	"linux-x64": "linux-x64",
	"linux-x64-baseline": "linux-x64-baseline",
	"linux-arm64": "linux-arm64",
	"darwin-x64": "macos-x64",
	"darwin-arm64": "macos-arm64",
	"win-x64": "windows-x64.exe",
	"win-x64-baseline": "windows-x64-baseline.exe",
	"win-arm64": "windows-arm64.exe",
};
export interface UpdateIndexAsset {
	name: string;
	size: number;
	sha256: string;
}
export interface UpdateIndexPatch extends UpdateIndexAsset {
	fromVersion: string;
	metadata: UpdateIndexAsset;
}
export interface UpdateIndexBinary extends UpdateIndexAsset {
	platform: string;
	sha512: string;
	metadata: UpdateIndexAsset;
	patches: UpdateIndexPatch[];
}
export interface UpdateIndexNotes {
	path: string;
	size: number;
	sha256: string;
}
export interface UpdateIndexRelease {
	version: string;
	tag: string;
	commit: string;
	prerelease: boolean;
	publishedAt: string;
	notes?: UpdateIndexNotes;
	files: UpdateIndexBinary[];
}
export interface UpdateIndexV1 {
	schemaVersion: 1;
	repository: string;
	generation: number;
	generatedAt: string;
	channels: { stable: string | null; beta: string | null };
	releases: UpdateIndexRelease[];
}
export interface UpdateNotesV1 {
	schemaVersion: 1;
	repository: string;
	version: string;
	notes: string | { en: string; "zh-CN": string };
}
