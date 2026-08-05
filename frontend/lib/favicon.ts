/**
 * Favicon alert manager.
 *
 * When a subscribed narrator changes to a notification-worthy state
 * (done / waiting / error / reflecting) while the tab is not focused, we swap
 * the browser tab favicon to an "alert" variant that overlays a colored
 * notification dot on top of the normal NarraFork logo.  The dot color
 * reflects the kind of change, matching the in-app narrator status colors:
 *
 *   - error      → red    (a narrator hit an error)
 *   - waiting    → yellow (a narrator is waiting for permission)
 *   - unread     → green  (a narrator finished / has unread output)
 *   - reflecting → teal (a narrator is running an automated reflection gate)
 *
 * Alerts are tracked per narrator.  The favicon shows the highest-severity
 * color among all active alerts (error > waiting > unread > reflecting).  An
 * alert is cleared when:
 *   - the user reads it (the tab regains focus / becomes visible) — clears all
 *   - the originating narrator resolves the state (e.g. a reflection ends and
 *     it returns to "working") — clears that narrator only
 */

const DEFAULT_FAVICON_HREF = "/favicon.svg";

export type FaviconAlertKind = "reflecting" | "unread" | "waiting" | "error";

// Severity ordering — higher number wins when multiple alerts stack up.
const ALERT_SEVERITY: Record<FaviconAlertKind, number> = {
	reflecting: 0,
	unread: 1,
	waiting: 2,
	error: 3,
};

// Dot colors, matching the in-app narrator status palette (Mantine 6-shade):
//   teal-6 / green-6 / yellow-6 / red-6.
//
// `reflecting` is orange to match `status-registry`'s substatus colour — a running gate
// is interactive, so it joins the attention family (its shield SHAPE is what separates it
// from a plain permission prompt). Keep these in sync: the favicon is the one place the
// palette is hard-coded rather than read from CSS variables.
const ALERT_COLOR: Record<FaviconAlertKind, string> = {
	reflecting: "#fd7e14",
	unread: "#40c057",
	waiting: "#fab005",
	error: "#fa5252",
};

/** Build the alert favicon: the NarraFork fork logo + a colored dot. */
function buildAlertSvg(dotColor: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#4c6ef5"/>
  <g fill="none" stroke="#fff" stroke-width="32" stroke-linecap="round" stroke-linejoin="round">
    <path d="M256 400 V200"/>
    <path d="M256 200 Q256 160 216 130 L176 108"/>
    <path d="M256 200 Q256 160 296 130 L336 108"/>
  </g>
  <circle cx="176" cy="108" r="24" fill="#fff"/>
  <circle cx="336" cy="108" r="24" fill="#fff"/>
  <circle cx="256" cy="400" r="24" fill="#fff"/>
  <circle cx="400" cy="112" r="104" fill="${dotColor}" stroke="#fff" stroke-width="24"/>
</svg>`;
}

function alertHref(kind: FaviconAlertKind): string {
	return `data:image/svg+xml,${encodeURIComponent(buildAlertSvg(ALERT_COLOR[kind]))}`;
}

// Active alerts keyed by narrator ID, plus the color kind currently painted.
const alerts = new Map<string, FaviconAlertKind>();
let paintedKind: FaviconAlertKind | null = null;
let listenerAttached = false;

function getFaviconLink(): HTMLLinkElement | null {
	return document.querySelector<HTMLLinkElement>('link[rel="icon"]');
}

function applyHref(href: string): void {
	const link = getFaviconLink();
	if (link) link.href = href;
}

/**
 * Recompute the favicon from the set of active alerts: paint the
 * highest-severity color, or restore the default when nothing is pending.
 */
function repaint(): void {
	let winner: FaviconAlertKind | null = null;
	for (const kind of alerts.values()) {
		if (!winner || ALERT_SEVERITY[kind] > ALERT_SEVERITY[winner]) winner = kind;
	}
	if (winner === paintedKind) return;
	paintedKind = winner;
	applyHref(winner ? alertHref(winner) : DEFAULT_FAVICON_HREF);
}

/**
 * Clear favicon alerts.  Pass a narrator ID to clear only that narrator's
 * alert (e.g. it resolved a transient state); omit it to clear everything
 * (e.g. the user read the changes by focusing the tab).
 */
export function clearFaviconAlert(narratorId?: string): void {
	if (narratorId === undefined) {
		if (alerts.size === 0) return;
		alerts.clear();
	} else {
		if (!alerts.delete(narratorId)) return;
	}
	repaint();
}

function handleUserPresence(): void {
	// Becoming visible OR focused both count as "the user is looking".
	if (document.visibilityState === "visible" || document.hasFocus()) {
		clearFaviconAlert();
	}
}

function ensureListener(): void {
	if (listenerAttached) return;
	listenerAttached = true;
	document.addEventListener("visibilitychange", handleUserPresence);
	window.addEventListener("focus", handleUserPresence);
}

/**
 * Flag a narrator's notification-worthy change in the favicon.  No-op when the
 * tab is currently focused (the user is already reading).  The painted color
 * is always the highest severity among all active alerts.
 */
export function setFaviconAlert(narratorId: string, kind: FaviconAlertKind): void {
	// If the user is actively looking at the tab there's nothing to flag.
	if (document.hasFocus() && document.visibilityState === "visible") return;
	ensureListener();
	alerts.set(narratorId, kind);
	repaint();
}
