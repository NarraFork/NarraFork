export type DeviceConnectionMode = "reverse" | "direct";
export type DeviceTokenInput = "file" | "stdin";

export function isValidOptionalDeviceSlug(value: string): boolean {
	return !value.trim() || /^[a-z0-9_-]{2,64}$/.test(value.trim());
}

export function isWebSocketUrl(value: string): boolean {
	try {
		const url = new URL(value.trim());
		if (url.protocol === "wss:") return true;
		if (url.protocol !== "ws:") return false;
		return isLoopbackIpLiteral(url.hostname);
	} catch {
		return false;
	}
}

function isLoopbackIpLiteral(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
	const octets = host.split(".");
	return (
		octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part)) && octets[0] === "127"
	);
}

/**
 * Derive the device WebSocket URL from the URL the browser is currently using.
 *
 * The admin's browser reached this server somehow, so its origin is a far better
 * default than a placeholder. Falls back to the placeholder when no origin is
 * available (non-browser callers, tests).
 */
export function deviceWsUrlFromOrigin(serverBaseUrl?: string): string {
	if (!serverBaseUrl) return "wss://<narrafork-host>/ws/device";
	try {
		const url = new URL(serverBaseUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return "wss://<narrafork-host>/ws/device";
		}
		const scheme = url.protocol === "https:" ? "wss:" : "ws:";
		return `${scheme}//${url.host}/ws/device`;
	} catch {
		return "wss://<narrafork-host>/ws/device";
	}
}

export function buildDeviceRunCommand(
	connectionMode: DeviceConnectionMode,
	slug: string,
	tokenInput: DeviceTokenInput = "file",
	options: { serverBaseUrl?: string } = {},
): string {
	const tokenArgument =
		tokenInput === "stdin" ? "--token-stdin" : "--token-file /path/to/device-token";
	if (connectionMode === "direct") {
		return `narrafork-executor \\\n  --listen 0.0.0.0:7900 \\\n  --tls-cert /path/to/executor.crt \\\n  --tls-key /path/to/executor.key \\\n  --device ${slug} \\\n  ${tokenArgument} \\\n  --allow-root /path/to/workspace`;
	}
	const serverUrl = deviceWsUrlFromOrigin(options.serverBaseUrl);
	return `narrafork-executor \\\n  --server ${serverUrl} \\\n  --device ${slug} \\\n  ${tokenArgument} \\\n  --allow-root /path/to/workspace`;
}
