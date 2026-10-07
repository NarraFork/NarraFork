export type UpdateSource = "github" | "update-server";

export interface UpdateSourceSettings {
	source?: UpdateSource;
	githubRepository?: string;
	serverUrl?: string;
	product?: string;
	channel?: "stable" | "beta";
}

export const DEFAULT_GITHUB_REPOSITORY = "NarraFork/NarraFork";

const LEGACY_UPDATE_SERVER_URL = "https://narrafork-update.b.domexie.cn";

function normalizeServerUrl(value?: string): string {
	const url = value?.trim() || LEGACY_UPDATE_SERVER_URL;
	try {
		const parsed = new URL(url);
		parsed.pathname = parsed.pathname.replace(/\/+$/, "");
		return parsed.toString().replace(/\/+$/, "");
	} catch {
		return url.replace(/\/+$/, "");
	}
}

/** Fingerprint the saved configuration actually used by the active source. */
export function updateSettingsKey(update?: UpdateSourceSettings): string {
	const source = update?.source ?? "github";
	return JSON.stringify([
		source,
		update?.channel ?? "stable",
		...(source === "github"
			? [(update?.githubRepository ?? DEFAULT_GITHUB_REPOSITORY).trim().toLowerCase()]
			: [normalizeServerUrl(update?.serverUrl), update?.product ?? "narrafork"]),
	]);
}

export function sameUpdateSource(
	previous: { source?: UpdateSource; repository?: string },
	next: { source?: UpdateSource; repository?: string },
): boolean {
	// Older responses without a source came only from the update server.
	const source = previous.source ?? "update-server";
	return (
		source === (next.source ?? "update-server") &&
		(source !== "github" ||
			previous.repository?.trim().toLowerCase() === next.repository?.trim().toLowerCase())
	);
}

export function updateCheckErrorKey(code?: string): string {
	switch (code) {
		case "GITHUB_RATE_LIMIT":
		case "RATE_LIMITED":
			return "updateCheckRateLimited";
		case "GITHUB_NOT_FOUND":
		case "REPOSITORY_NOT_FOUND":
		case "REPOSITORY_UNAVAILABLE":
			return "updateCheckRepositoryNotFound";
		case "INVALID_REPOSITORY":
		case "INVALID_GITHUB_REPOSITORY":
			return "updateCheckInvalidRepository";
		case "NO_COMPATIBLE_ASSET":
		case "GITHUB_ASSET_NOT_FOUND":
		case "PLATFORM_UNAVAILABLE":
			return "updateCheckAssetMissing";
		case "INVALID_CONFIGURATION":
			return "updateCheckInvalidConfiguration";
		case "INVALID_METADATA":
			return "updateCheckInvalidMetadata";
		case "NETWORK_ERROR":
		case "TIMEOUT":
			return "updateCheckNetworkFailed";
		case "NO_RELEASE":
			return "updateCheckNoRelease";
		case "SCAN_LIMIT_REACHED":
			return "updateCheckScanLimit";
		case "UPDATE_SOURCE_CHANGED":
			return "updateSourceChanged";
		default:
			return "updateCheckFailed";
	}
}
