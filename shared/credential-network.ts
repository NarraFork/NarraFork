/**
 * How one credential presents itself on the network: which proxy it leaves through,
 * which client it claims to be, and which device id it sends. Every field is optional;
 * an absent field follows the provider's own setting, so a credential only states what
 * it does differently. Services that pool several accounts use this to keep each
 * account on its own egress and device identity.
 */

export const USER_AGENT_MODES = ["narrafork", "claude-code", "codex", "custom"] as const;
export type CredentialUserAgentMode = (typeof USER_AGENT_MODES)[number];

export const PROXY_MODES = ["default", "direct", "system", "custom"] as const;
export type CredentialProxyMode = (typeof PROXY_MODES)[number];

export interface CredentialNetwork {
	/** `default` (or absent) follows the provider's proxy. */
	proxy?: { mode: CredentialProxyMode; url?: string };
	userAgentMode?: CredentialUserAgentMode;
	/** Used when `userAgentMode` is `custom`. */
	customUserAgent?: string;
	/** Merged over the provider's extra headers; a credential's value wins per header. */
	extraHeaders?: Record<string, string>;
	/** Device / installation id this credential sends; absent = the instance's id. */
	deviceId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MAX_HEADERS = 32;

export class CredentialNetworkError extends Error {
	constructor(
		readonly field: keyof CredentialNetwork | "proxy.url",
		message: string,
	) {
		super(message);
	}
}

/** Parse untrusted input; empty or default values are dropped so absence means "follow". */
export function normalizeCredentialNetwork(input: unknown): CredentialNetwork {
	if (input === null || input === undefined) return {};
	if (typeof input !== "object" || Array.isArray(input))
		throw new CredentialNetworkError("proxy", "Expected an object");
	const source = input as Record<string, unknown>;
	const out: CredentialNetwork = {};

	const proxy = source.proxy as { mode?: unknown; url?: unknown } | undefined;
	if (proxy && typeof proxy === "object" && proxy.mode !== undefined && proxy.mode !== "default") {
		if (!(PROXY_MODES as readonly unknown[]).includes(proxy.mode))
			throw new CredentialNetworkError("proxy", "Unknown proxy mode");
		const mode = proxy.mode as CredentialProxyMode;
		if (mode === "custom") {
			const url = typeof proxy.url === "string" ? proxy.url.trim() : "";
			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				throw new CredentialNetworkError("proxy.url", "Enter a proxy URL such as http://host:port");
			}
			if (!["http:", "https:", "socks5:", "socks5h:"].includes(parsed.protocol))
				throw new CredentialNetworkError("proxy.url", "Proxy URL must be http, https or socks5");
			out.proxy = { mode, url };
		} else out.proxy = { mode };
	}

	const mode = source.userAgentMode;
	if (mode !== undefined && mode !== null && mode !== "") {
		if (!(USER_AGENT_MODES as readonly unknown[]).includes(mode))
			throw new CredentialNetworkError("userAgentMode", "Unknown User-Agent mode");
		out.userAgentMode = mode as CredentialUserAgentMode;
		if (mode === "custom") {
			const ua = typeof source.customUserAgent === "string" ? source.customUserAgent.trim() : "";
			if (!ua || ua.length > 512 || /[\r\n]/.test(ua))
				throw new CredentialNetworkError("customUserAgent", "Enter a single-line User-Agent");
			out.customUserAgent = ua;
		}
	}

	const headers = source.extraHeaders;
	if (headers && typeof headers === "object" && !Array.isArray(headers)) {
		const entries = Object.entries(headers as Record<string, unknown>).filter(([name]) =>
			name.trim(),
		);
		if (entries.length > MAX_HEADERS)
			throw new CredentialNetworkError("extraHeaders", `At most ${MAX_HEADERS} headers`);
		const result: Record<string, string> = {};
		for (const [rawName, value] of entries) {
			const name = rawName.trim();
			if (!HEADER_NAME.test(name) || typeof value !== "string" || /[\r\n]/.test(value))
				throw new CredentialNetworkError("extraHeaders", `Invalid header: ${name}`);
			result[name] = value;
		}
		if (Object.keys(result).length) out.extraHeaders = result;
	}

	const deviceId = source.deviceId;
	if (deviceId !== undefined && deviceId !== null && deviceId !== "") {
		if (typeof deviceId !== "string" || !UUID.test(deviceId))
			throw new CredentialNetworkError("deviceId", "Device id must be a UUID");
		out.deviceId = deviceId.toLowerCase();
	}
	return out;
}

/** A proxy URL with its password replaced, safe to show in a browser or a log. */
export function maskProxyUrl(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.password) parsed.password = "***";
		return parsed.toString().replace(/\/$/, url.endsWith("/") ? "/" : "");
	} catch {
		return url;
	}
}

/** Public form of a credential's network identity: everything except proxy passwords. */
export function publicCredentialNetwork(network: CredentialNetwork | undefined): CredentialNetwork {
	if (!network) return {};
	return network.proxy?.url
		? { ...network, proxy: { ...network.proxy, url: maskProxyUrl(network.proxy.url) } }
		: { ...network };
}

/**
 * An edit sent back from the browser carries the masked proxy URL when the user left it
 * alone; keep the stored URL (with its password) in that case.
 */
export function restoreMaskedProxy(
	next: CredentialNetwork,
	stored: CredentialNetwork | undefined,
): CredentialNetwork {
	const storedUrl = stored?.proxy?.url;
	if (next.proxy?.url && storedUrl && next.proxy.url === maskProxyUrl(storedUrl))
		return { ...next, proxy: { ...next.proxy, url: storedUrl } };
	return next;
}
