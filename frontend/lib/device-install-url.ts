/**
 * The base URL baked into a generated install command.
 *
 * The browser's own origin is the best available default: it demonstrably reaches
 * this server. But it is only a default — split-horizon DNS, VPN-only names, and
 * "the admin is on localhost while the target machine is not" all mean the operator
 * may need to override it, which is why the field is editable and remembered.
 *
 * The predicates here mirror `server/lib/executor-enrollment-policy.ts` so the UI
 * can disable automatic key delivery instead of letting the operator submit and be
 * refused. The server remains the enforcement point; this is presentation.
 */

const STORAGE_KEY = "narrafork_device_install_base_url";

function parse(value: string): URL | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	try {
		const url = new URL(trimmed);
		return url.protocol === "http:" || url.protocol === "https:" ? url : null;
	} catch {
		return null;
	}
}

export function isLoopbackHost(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host === "localhost") return true;
	if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
	const octets = host.split(".");
	return (
		octets.length === 4 &&
		octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
		octets[0] === "127"
	);
}

/** Private-network literal (RFC 1918 / CGNAT / link-local / IPv6 ULA) or loopback. */
export function isPrivateNetworkHost(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (isLoopbackHost(host)) return true;

	const octets = host.split(".");
	if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part))) {
		const parts = octets.map(Number);
		if (parts.some((part) => part > 255)) return false;
		const [a, b] = parts as [number, number, number, number];
		if (a === 10) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 100 && b >= 64 && b <= 127) return true;
		if (a === 169 && b === 254) return true;
		return false;
	}
	if (host.includes(":")) {
		if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
		if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
	}
	return false;
}

/**
 * Would automatic key delivery be accepted for this base URL?
 *
 * Optimistic on the private-network case: whether plaintext LAN enrollment is
 * permitted depends on a server setting the browser does not have, so the option
 * stays offered and the server decides. Only the case that can never be allowed —
 * plaintext http on a routable address — is disabled here, because that one is
 * knowable client-side and disabling it explains itself.
 */
export function isEnrollableServerBaseUrl(value: string): boolean {
	const url = parse(value);
	// An empty or unparseable value means "let the server decide from the request
	// origin", so do not pre-emptively disable the option.
	if (!url) return true;
	if (url.protocol === "https:") return true;
	return isPrivateNetworkHost(url.hostname);
}

/**
 * A loopback base URL is almost always a mistake worth flagging: it works for the
 * admin's own browser and is unreachable from the machine being enrolled. Not an
 * error, though — enrolling an executor onto the NarraFork host itself is legitimate.
 */
export function isLoopbackServerBaseUrl(value: string): boolean {
	const url = parse(value);
	return !!url && isLoopbackHost(url.hostname);
}

/** Origin to prefill: the operator's last explicit choice, else this page's origin. */
export function suggestedInstallServerBaseUrl(): string {
	try {
		const remembered = window.localStorage.getItem(STORAGE_KEY);
		if (remembered && parse(remembered)) return remembered;
	} catch {
		// Private mode / disabled storage: fall through to the current origin.
	}
	try {
		return window.location.origin;
	} catch {
		return "";
	}
}

export function rememberInstallServerBaseUrl(value: string): void {
	const url = parse(value);
	if (!url) return;
	try {
		window.localStorage.setItem(STORAGE_KEY, value.trim());
	} catch {
		// Persisting the preference is a convenience, never a requirement.
	}
}
