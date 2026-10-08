/** Immutable effective configuration captured before an asynchronous update check. */
export type UpdateSourceIdentity =
	| { source: "github"; repository: string; channel: "stable" | "beta"; platform: string }
	| {
			source: "update-server";
			serverUrl: string;
			product: string;
			channel: "stable" | "beta";
			platform: string;
	  };

/** A selector for the verified local artifact, not an authorization token. */
export interface PreparedUpdateIdentity {
	id: string;
	version: string;
	sha512: string;
	sizeBytes: number;
	/** Old metadata cannot truthfully recover its original source from today's settings. */
	sourceIdentity: UpdateSourceIdentity | null;
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function parseUpdateSourceIdentity(value: unknown): UpdateSourceIdentity | null {
	const item = record(value);
	if (
		!item ||
		(item.channel !== "stable" && item.channel !== "beta") ||
		typeof item.platform !== "string" ||
		!/^[a-z0-9-]{1,64}$/.test(item.platform)
	)
		return null;
	if (item.source === "github") {
		if (typeof item.repository !== "string" || item.repository.length > 256) return null;
		const repository = item.repository.trim().toLowerCase();
		if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) return null;
		return { source: "github", repository, channel: item.channel, platform: item.platform };
	}
	if (
		item.source !== "update-server" ||
		typeof item.serverUrl !== "string" ||
		item.serverUrl.length > 4096 ||
		typeof item.product !== "string" ||
		!item.product ||
		item.product.length > 256
	)
		return null;
	try {
		const url = new URL(item.serverUrl);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		url.pathname = url.pathname.replace(/\/+$/, "");
		return {
			source: "update-server",
			serverUrl: url.toString().replace(/\/+$/, ""),
			product: item.product,
			channel: item.channel,
			platform: item.platform,
		};
	} catch {
		return null;
	}
}

export function updateSourceIdentityKey(value: unknown): string | null {
	const source = parseUpdateSourceIdentity(value);
	if (!source) return null;
	return JSON.stringify(
		source.source === "github"
			? [source.source, source.repository, source.channel, source.platform]
			: [source.source, source.serverUrl, source.product, source.channel, source.platform],
	);
}

export function sameUpdateSourceIdentity(left: unknown, right: unknown): boolean {
	const key = updateSourceIdentityKey(left);
	return key !== null && key === updateSourceIdentityKey(right);
}

/** Never attach today's recommendation to an unproven legacy prepared artifact. */
export function preparedMatchesRelease(
	prepared: PreparedUpdateIdentity | undefined,
	release:
		| {
				version: string;
				sha512: string;
				files: Array<{ size: number }>;
				sourceIdentity?: UpdateSourceIdentity;
		  }
		| undefined,
): boolean {
	return (
		!!prepared &&
		!!release &&
		prepared.version === release.version &&
		prepared.sha512 === release.sha512 &&
		prepared.sizeBytes === release.files[0]?.size &&
		sameUpdateSourceIdentity(prepared.sourceIdentity, release.sourceIdentity)
	);
}
