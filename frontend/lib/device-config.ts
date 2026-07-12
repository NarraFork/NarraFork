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

export function buildDeviceRunCommand(
	connectionMode: DeviceConnectionMode,
	slug: string,
	tokenInput: DeviceTokenInput = "file",
): string {
	const tokenArgument =
		tokenInput === "stdin" ? "--token-stdin" : "--token-file /path/to/device-token";
	if (connectionMode === "direct") {
		return `narrafork-executor \\\n  --listen 0.0.0.0:7900 \\\n  --tls-cert /path/to/executor.crt \\\n  --tls-key /path/to/executor.key \\\n  --device ${slug} \\\n  ${tokenArgument} \\\n  --allow-root /path/to/workspace`;
	}
	return `narrafork-executor \\\n  --server wss://<narrafork-host>/ws/device \\\n  --device ${slug} \\\n  ${tokenArgument} \\\n  --allow-root /path/to/workspace`;
}
