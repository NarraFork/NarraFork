import { isIP } from "node:net";

export function isSecureDirectDeviceUrl(value: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(value.trim());
	} catch {
		return false;
	}
	if (parsed.protocol === "wss:") return true;
	if (parsed.protocol !== "ws:") return false;
	return isLoopbackIpLiteral(parsed.hostname);
}

function isLoopbackIpLiteral(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	const family = isIP(host);
	if (family === 4) return host.split(".")[0] === "127";
	if (family === 6) return host === "::1" || host === "0:0:0:0:0:0:0:1";
	return false;
}
