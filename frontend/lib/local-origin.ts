/**
 * Is the browser running on the same machine as the NarraFork server?
 *
 * Some actions only make sense in that case. "Open in file explorer" is the clear
 * example: `POST /api/fs/reveal` runs `explorer`/`open`/`xdg-open` **on the server
 * host**, so from a remote browser it either does nothing visible or pops a window
 * on someone else's desktop. The action succeeds, which is why it cannot be
 * discovered by trying it — hence the gate is on visibility.
 *
 * The test is the page's own hostname, not a server-reported capability: the server
 * cannot know whether a given request came from its own console or from across the
 * network, and it is the *browser side* of the pair that decides whether a desktop
 * window would be seen. A loopback origin is the one form that guarantees both ends
 * are the same machine.
 *
 * Deliberately not treated as local:
 *  - private-network literals (`192.168.x.x`, `10.x.x.x`) — same LAN, different desktop
 *  - hostnames that happen to resolve to loopback — not knowable in the browser
 *
 * Failing closed on anything unparseable keeps a hostile or exotic origin from
 * quietly counting as local.
 */

import { isLoopbackHost } from "@frontend/lib/device-install-url";

export function isLoopbackBrowserOrigin(win?: Window): boolean {
	const target = win ?? (typeof window === "undefined" ? undefined : window);
	if (!target) return false;
	try {
		const hostname = target.location?.hostname;
		if (!hostname) return false;
		return isLoopbackHost(hostname);
	} catch {
		// Cross-origin or stripped location objects: treat as remote.
		return false;
	}
}
