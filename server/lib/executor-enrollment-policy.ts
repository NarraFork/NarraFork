/**
 * May the automated enrollment exchange run over this origin?
 *
 * The one-line installer works by letting the target machine fetch the device key
 * from a public endpoint, which means the key crosses the wire in plaintext at
 * that one moment. Everywhere else in the system it never does: the key only ever
 * participates in the `/ws/device` nonce/HMAC handshake (see
 * `agent/execution/device-auth.ts`). So the transport for that single exchange is
 * the whole security question, and it is answered here rather than inline at the
 * route so it can be tested without a server.
 *
 * Three outcomes, and the middle one is the reason this file exists:
 *
 * - **https, or loopback** — always allowed. Encrypted, or never leaving the host.
 * - **private-network http** — allowed only with an explicit opt-in setting. A LAN
 *   is a far higher bar than the open internet, but it is not encryption, so this
 *   must be a decision someone made, not a default they inherited.
 * - **public http** — never allowed, regardless of settings. Handing a device key
 *   to anyone able to observe internet-path traffic is not a trade worth offering
 *   as a toggle.
 *
 * A refusal is not a dead end: the prompt-based install path still works over
 * plaintext http, because there the script carries no credential at all and the
 * operator types the key in by hand.
 */
import { isIpLiteralHostname, isLoopbackHostname, isPrivateNetworkHostname } from "./public-origin";

export type EnrollmentTransportVerdict =
	| { allowed: true; reason: "https" | "loopback" | "private_network_opt_in" }
	| { allowed: false; reason: "insecure_public" | "private_network_not_enabled" };

export interface EnrollmentTransportInput {
	/** The origin the *target machine* will use, as resolved for the install script. */
	origin: URL;
	/** `settings.devices.allowPlaintextEnrollmentOnPrivateNetwork`. */
	allowPrivateNetworkPlaintext: boolean;
}

export function evaluateEnrollmentTransport(
	input: EnrollmentTransportInput,
): EnrollmentTransportVerdict {
	const { origin, allowPrivateNetworkPlaintext } = input;
	if (origin.protocol === "https:") return { allowed: true, reason: "https" };
	// Loopback plaintext never leaves the machine, so there is nothing to observe.
	if (isLoopbackHostname(origin.hostname)) return { allowed: true, reason: "loopback" };
	if (isPrivateNetworkHostname(origin.hostname)) {
		return allowPrivateNetworkPlaintext
			? { allowed: true, reason: "private_network_opt_in" }
			: { allowed: false, reason: "private_network_not_enabled" };
	}
	return { allowed: false, reason: "insecure_public" };
}

/**
 * Operator-facing explanation for a refusal.
 *
 * `hostname` lets the `insecure_public` message distinguish the two ways to get
 * there: a routable IP literal (the opt-in can never apply) versus a NAME. A
 * hostname that resolves into a private range is refused exactly like a public
 * address — resolution is not verifiable by the server — but saying "publicly
 * routable" to someone staring at `nas.lan` reads as nonsense, so that case gets
 * its own wording.
 */
export function enrollmentRefusalMessage(
	reason: "insecure_public" | "private_network_not_enabled",
	opts: { hostname?: string } = {},
): string {
	if (reason === "private_network_not_enabled") {
		return (
			"Automatic key delivery over plaintext http is disabled. Enable " +
			"devices.allowPlaintextEnrollmentOnPrivateNetwork to allow it on this private " +
			"network, serve NarraFork over https, or install with manual key entry instead."
		);
	}
	if (opts.hostname && !isIpLiteralHostname(opts.hostname)) {
		return (
			"Automatic key delivery over plaintext http is only ever allowed on loopback or, " +
			"with the devices.allowPlaintextEnrollmentOnPrivateNetwork opt-in, on a literal " +
			"private-network IP address. A hostname is never eligible, because the server " +
			"cannot verify which network a name resolves to. Serve NarraFork over https, or " +
			"install with manual key entry instead."
		);
	}
	return (
		"Automatic key delivery requires https on a publicly routable address, because " +
		"the device key would otherwise cross the internet in plaintext. Serve NarraFork " +
		"over https, or install with manual key entry instead."
	);
}
