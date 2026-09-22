/**
 * Host-path scrubbing for model-catalog error surfaces.
 *
 * Catalog I/O failures are raised on the host filesystem (`~/.narrafork/model-catalog/...`),
 * and `String(error)` for a Node system error embeds the absolute path — including the OS
 * username. `update.lastError` is served to every session (GET / and GET /v2 need only
 * requireSessionAuth), and the route `onError` body used to echo `error.message` verbatim.
 * Neither surface may carry a host path.
 */

function basenameOf(path: string): string {
	const parts = path.split(/[/\\]/).filter(Boolean);
	return parts[parts.length - 1] ?? "path";
}

/**
 * Replace host filesystem paths with their basename. Leaves URLs and ordinary prose alone:
 * a catalog download error that mentions `HTTP 302` must stay readable, and a URL is not a
 * host path leak.
 */
export function stripHostPaths(text: string): string {
	return text
		.replace(/~[/\\][^\s'"`<>|]*/g, (path) => basenameOf(path))
		.replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s'"`<>|]*/g, (path) => basenameOf(path))
		.replace(
			/(?:^|[\s'"`(=,[])(\/(?:home|Users|var|tmp|opt|root|mnt|media|private|Applications|Windows|proc|etc|usr)[^\s'"`<>|]*)/g,
			(full, path: string) => full.replace(path, basenameOf(path)),
		);
}

/** Render an error for `lastError` / response bodies: no absolute host paths, bounded length. */
export function sanitizeCatalogErrorText(error: unknown): string {
	const raw = error instanceof Error ? error.message || error.name : String(error);
	return stripHostPaths(raw).slice(0, 500);
}

/**
 * True when the error looks like host I/O (Node system `code`, or a message that named a
 * filesystem path). Those become a stable `CATALOG_IO_ERROR` body; intentional validation
 * prose without paths is kept after scrubbing.
 */
export function isHostIoError(error: unknown): boolean {
	if (error != null && typeof error === "object" && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string" && code.length > 0) return true;
	}
	const raw = error instanceof Error ? error.message : String(error);
	return /(?:^|[\s'"`(=,[])(?:~[/\\]|[A-Za-z]:[\\/]|\\\\|\/(?:home|Users|var|tmp|opt|root|mnt|media|private|Applications|Windows|proc|etc|usr))/.test(
		raw,
	);
}

/** Stable wire body for unexpected non-AppError failures on the model-catalog route. */
export const CATALOG_IO_ERROR_BODY = {
	error: "Model catalog operation failed",
	code: "CATALOG_IO_ERROR",
} as const;
