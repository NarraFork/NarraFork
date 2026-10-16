/**
 * `bun run dev:all` runs two servers: Vite serves the app (default 7778) and this
 * process is only the API (7779). The listen address is the API. The address a
 * person should open is the Vite origin, passed as `NARRAFORK_DEV_APP_URL`.
 *
 * Production and `bun run dev` (API only) leave the variable unset, so the
 * banner keeps advertising the listener.
 */

export const DEV_APP_URL_ENV = "NARRAFORK_DEV_APP_URL";

/** Port `dev:all` binds the API to so it does not collide with Vite. */
export const DEV_ALL_BACKEND_PORT = "7779";

export const DEFAULT_DEV_FRONTEND_PORT = "7778";

/** Origin Vite serves when `dev:all` starts it. Honors `VITE_PORT` when it is a TCP port. */
export function devFrontendOrigin(env: NodeJS.ProcessEnv = process.env): string {
	const raw = env.VITE_PORT?.trim();
	const port = raw && isTcpPort(raw) ? raw : DEFAULT_DEV_FRONTEND_PORT;
	return `http://localhost:${port}`;
}

/** Child env for the API process spawned by `dev:all`. */
export function devAllBackendEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return {
		...base,
		PORT: DEV_ALL_BACKEND_PORT,
		[DEV_APP_URL_ENV]: devFrontendOrigin(base),
	};
}

/**
 * URL printed in the startup banner and passed to the browser opener.
 * A valid dev-app origin replaces the listen URL; anything else keeps it.
 */
export function resolveAdvertisedAppUrl(input: {
	listenUrl: string;
	devAppUrl?: string | null;
}): string {
	return parseHttpOrigin(input.devAppUrl) ?? input.listenUrl;
}

function parseHttpOrigin(value: string | null | undefined): string | null {
	if (!value?.trim()) return null;
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	if (!url.hostname || url.username || url.password) return null;
	if (url.pathname !== "/" && url.pathname !== "") return null;
	if (url.search || url.hash) return null;
	const port = url.port || (url.protocol === "https:" ? "443" : "80");
	if (!isTcpPort(port)) return null;
	return url.origin;
}

function isTcpPort(value: string): boolean {
	if (!/^\d+$/.test(value)) return false;
	const port = Number(value);
	return port >= 1 && port <= 65535;
}
