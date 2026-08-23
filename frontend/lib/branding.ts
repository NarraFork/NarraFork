/**
 * Client-side branding: cache the instance name/colour and apply it to the DOM.
 *
 * Two consumers cannot go through React state and are therefore fed by
 * `applyBranding` instead:
 *   - `index.html`'s inline boot script, which runs before any bundle loads and
 *     reads the localStorage mirror written here;
 *   - `lib/favicon.ts` and `lib/notification.ts`, which are plain modules called
 *     from event handlers rather than components.
 *
 * The localStorage mirror exists to kill the first-paint flash. `/api/branding` is
 * a network round trip, and until it resolves the tab would read "NarraFork" —
 * which is precisely the ambiguity this feature removes. Last-known values are
 * applied synchronously on load and corrected when the response arrives. Same
 * pattern index.html already uses for the colour scheme.
 */

import {
	DEFAULT_BRAND_ICON_COLOR,
	DEFAULT_BRAND_NAME,
	type ResolvedBranding,
	resolveBranding,
} from "@shared/branding";

/** Keys are read verbatim by the inline script in index.html — keep them in sync. */
export const BRAND_NAME_STORAGE_KEY = "narrafork_brand_name";
export const BRAND_ICON_COLOR_STORAGE_KEY = "narrafork_brand_icon_color";

/** Recolouring endpoints. Requested only when the colour is not the default. */
export const BRAND_FAVICON_URL = "/api/branding/favicon.svg";
export const BRAND_APPLE_TOUCH_ICON_URL = "/api/branding/apple-touch-icon.png";
export const BRAND_NOTIFICATION_ICON_URL = "/api/branding/icon-192.png";

/** Static defaults, used whenever the instance has not customized its colour. */
export const DEFAULT_FAVICON_URL = "/favicon.svg";
export const DEFAULT_APPLE_TOUCH_ICON_URL = "/apple-touch-icon-180x180.png";
export const DEFAULT_NOTIFICATION_ICON_URL = "/pwa-192x192.png";

type BrandingListener = (branding: ResolvedBranding) => void;

const listeners = new Set<BrandingListener>();

/**
 * Current branding. Seeded from the localStorage mirror so modules that read it
 * during startup (favicon, notifications) get the last known values rather than
 * flashing the default.
 */
let current: ResolvedBranding = readStoredBranding();

function readStoredBranding(): ResolvedBranding {
	try {
		return resolveBranding({
			name: localStorage.getItem(BRAND_NAME_STORAGE_KEY) ?? undefined,
			iconColor: localStorage.getItem(BRAND_ICON_COLOR_STORAGE_KEY) ?? undefined,
		});
	} catch {
		// Storage can be unavailable (private mode, blocked third-party context).
		return resolveBranding(undefined);
	}
}

function writeStoredBranding(branding: ResolvedBranding): void {
	try {
		// The default name/colour are REMOVED rather than written, so clearing a
		// custom brand actually clears the mirror; storing "NarraFork" would leave
		// index.html setting a title it did not need to set.
		if (branding.name === DEFAULT_BRAND_NAME) {
			localStorage.removeItem(BRAND_NAME_STORAGE_KEY);
		} else {
			localStorage.setItem(BRAND_NAME_STORAGE_KEY, branding.name);
		}
		if (branding.iconColor === DEFAULT_BRAND_ICON_COLOR) {
			localStorage.removeItem(BRAND_ICON_COLOR_STORAGE_KEY);
		} else {
			localStorage.setItem(BRAND_ICON_COLOR_STORAGE_KEY, branding.iconColor);
		}
	} catch {
		// A failed mirror only costs the next load its instant title; the fetched
		// value is already applied in this session.
	}
}

/** URL for the tab favicon under the current branding. */
export function brandFaviconUrl(branding: ResolvedBranding = current): string {
	return branding.iconColor === DEFAULT_BRAND_ICON_COLOR ? DEFAULT_FAVICON_URL : BRAND_FAVICON_URL;
}

/** URL for the notification icon under the current branding. */
export function brandNotificationIconUrl(branding: ResolvedBranding = current): string {
	return branding.iconColor === DEFAULT_BRAND_ICON_COLOR
		? DEFAULT_NOTIFICATION_ICON_URL
		: BRAND_NOTIFICATION_ICON_URL;
}

function setLinkHref(selector: string, href: string): void {
	const link = document.querySelector<HTMLLinkElement>(selector);
	// Compare before assigning: writing the same href re-triggers an icon fetch in
	// some browsers, and this runs on every branding update.
	if (link && link.getAttribute("href") !== href) link.setAttribute("href", href);
}

/**
 * Apply branding to the document and notify plain-module consumers.
 *
 * Idempotent, so it is safe to call on every query settle.
 */
export function applyBranding(input: Partial<ResolvedBranding> | undefined): ResolvedBranding {
	const branding = resolveBranding(input);
	// Unchanged means "do not replace the snapshot object and do not notify".
	// `getCurrentBranding` backs a `useSyncExternalStore` snapshot, so handing back
	// a fresh-but-equal object would re-render every subscriber on each query settle
	// and each StrictMode double-invoked effect.
	const unchanged = current.name === branding.name && current.iconColor === branding.iconColor;

	// The DOM writes run regardless. They are not a consequence of the value
	// *changing* but of this being the module that owns those attributes: the initial
	// state was set by index.html's inline script, whose storage read can fail
	// independently of this one. Both helpers already no-op on equal values.
	try {
		if (document.title !== branding.name) document.title = branding.name;
		setLinkHref('link[rel="icon"]', brandFaviconUrl(branding));
		setLinkHref(
			'link[rel="apple-touch-icon"]',
			branding.iconColor === DEFAULT_BRAND_ICON_COLOR
				? DEFAULT_APPLE_TOUCH_ICON_URL
				: BRAND_APPLE_TOUCH_ICON_URL,
		);
	} catch {
		// A DOM that refuses these writes must not break the app.
	}

	if (unchanged) return current;

	current = branding;
	writeStoredBranding(branding);

	for (const listener of listeners) {
		try {
			listener(branding);
		} catch {
			// One bad listener must not stop the others.
		}
	}

	return branding;
}

/** Last applied branding, without triggering a fetch. */
export function getCurrentBranding(): ResolvedBranding {
	return current;
}

/**
 * Subscribe to branding changes.
 *
 * Does NOT fire on subscribe: it backs `useSyncExternalStore`, whose contract is
 * that the current value comes from the snapshot getter and the subscription only
 * signals *changes*. Callers that need the value up front read
 * `getCurrentBranding()`.
 */
export function onBrandingChange(listener: BrandingListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
