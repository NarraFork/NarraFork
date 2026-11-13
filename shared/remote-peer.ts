/** Optional Go/Pion component. No filesystem, environment or network access. */
export const REMOTE_PEER_PLATFORMS = [
	"linux-amd64",
	"linux-arm64",
	"darwin-amd64",
	"darwin-arm64",
	"windows-amd64",
	"windows-arm64",
] as const;
export type RemotePeerPlatform = (typeof REMOTE_PEER_PLATFORMS)[number];
export const REMOTE_PEER_MANIFEST_FILENAME = "narrafork-remote-peer-manifest.json";
export const REMOTE_PEER_LICENSE_FILES = ["remote-peer-LICENSES.txt"] as const;
export const REMOTE_PEER_PROTOCOL_VERSION = 2;
export const REMOTE_PEER_BINARY_MAX_BYTES = 32 * 1024 * 1024;
export const REMOTE_PEER_MANIFEST_MAX_BYTES = 64 * 1024;
export interface RemotePeerDistribution {
	version: string;
	protocolVersion: number;
	tag: string;
}
export interface RemotePeerPlatformArtifact {
	filename: string;
	size: number;
	sha256: string;
}
export interface RemotePeerManifest {
	version: string;
	protocolVersion: number;
	releasedAt: string;
	platforms: Partial<Record<RemotePeerPlatform, RemotePeerPlatformArtifact>>;
}
export interface RemotePeerLicense {
	name: string;
	size: number;
	sha256: string;
}
export interface RemotePeerReleaseManifest {
	schemaVersion: 1;
	repository: string;
	tag: string;
	commit: string;
	manifest: RemotePeerManifest;
	licenses: RemotePeerLicense[];
}
export function isRemotePeerPlatform(value: string): value is RemotePeerPlatform {
	return (REMOTE_PEER_PLATFORMS as readonly string[]).includes(value);
}
export function remotePeerDistFilename(platform: RemotePeerPlatform): string {
	if (!isRemotePeerPlatform(platform)) throw new Error("Unsupported remote peer platform");
	return `narrafork-remote-peer-${platform}${platform.startsWith("windows-") ? ".exe" : ""}`;
}
export function remotePeerPublishedFilename(version: string, platform: RemotePeerPlatform): string {
	return remotePeerDistFilename(platform).replace(
		"narrafork-remote-peer-",
		`narrafork-remote-peer-${version}-`,
	);
}
export function remotePeerCachedFilename(version: string, platform: RemotePeerPlatform): string {
	return remotePeerPublishedFilename(version, platform);
}
/** Explicit current-host selection; x64 baseline builds use the same Go v1 binary. */
export function resolveRemotePeerPlatform(os: string, arch: string): RemotePeerPlatform | null {
	const goOs = os === "win32" ? "windows" : os;
	const goArch = arch === "x64" ? "amd64" : arch;
	const candidate = `${goOs}-${goArch}`;
	return isRemotePeerPlatform(candidate) ? candidate : null;
}
