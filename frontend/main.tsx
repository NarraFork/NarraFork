// MUST stay the first import: it installs runtime built-ins that older Safari/WebKit
// lacks (Array.prototype.at, findLast/findLastIndex, Object.hasOwn, structuredClone,
// AbortSignal.timeout, AbortSignal.any). Vite's `safari14` target down-levels syntax
// only, so a shim installed after another module's top-level code has already run
// would be too late. See that file's header for the Safari 14 virtual-list flicker
// this prevents.
import "@frontend/lib/legacy-browser-polyfills";
import { reportReactRenderError } from "@frontend/lib/hmr-guard";
import "@frontend/lib/dom-mutation-guard";
import "@mantine/core/styles.css";
import "@mantine/dates/styles.css";
import "@mantine/notifications/styles.css";
import "@mantine/tiptap/styles.css";
import { installPinchZoomGuard } from "@frontend/lib/pinch-zoom-guard";
/*
 * The plain store, NOT `hooks/usePluginThemes`.
 *
 * That hook module reaches React Query and the whole `lib/api` barrel — 53 modules that
 * would then sit on THIS module's import graph. Since the entry cannot accept HMR
 * updates and has no importer above it, editing any of them would reload the page. See
 * `lib/plugin-theme-pref-store.ts` for the full explanation.
 */
import { readActivePluginThemeKey } from "@frontend/lib/plugin-theme-pref-store";
import "@frontend/styles/oled.css";
import "@frontend/styles/blur-anim.css";
import "@frontend/styles/nav-collapsed.css";
import "@frontend/styles/safe-area.css";
// WCO (installed-PWA title-bar fusion): gated entirely on html[data-nf-wco].
import "@frontend/styles/wco.css";
import "@frontend/styles/toast.css";
// Tool-call shimmer classes (card face + compact row text). Global because BOTH
// narrator render paths paint these and vlist may not import the chunk path — see
// each stylesheet's header.
import "@frontend/styles/card-shimmer.css";
import "@frontend/styles/trace-shimmer.css";
// The touch scroll-to-top button's mount fade — a keyframe inline styles cannot
// declare; see the stylesheet's header.
import "@frontend/styles/vlist-touch-scroll-top.css";

/*
 * Deep import rather than the `components/plugins` barrel, for the same reason as the
 * theme store above: the barrel re-exports every plugin component, so importing one
 * function through it puts all of them on the entry's graph.
 */
import { syncPluginUiContributions } from "@frontend/components/plugins/registry";
import { createBrowserHistory } from "@tanstack/react-router";
import React from "react";
import ReactDOM from "react-dom/client";
/*
 * The React tree lives in `App.tsx`, NOT here.
 *
 * This module runs bootstrap side effects at module scope, so `@vitejs/plugin-react`
 * can never treat it as a valid Fast Refresh boundary. Defining a component here made
 * it an INVALID boundary instead, and since the entry has no accepting importer above
 * it, every propagated update ended in `location.reload()` — editing any high fan-in
 * module (`lib/query-client`, `hooks/useBranding`, `components/plugins`) reloaded the
 * whole page. See `App.tsx`'s header for the measurement.
 *
 * ⚠️ Do not move components back into this file, and keep the imports below limited to
 * bootstrap concerns.
 */
import { App } from "./App";
import { cleanupStaleNarratorDockLayouts } from "./components/narrator/dock/narrator-dock-layout";
import { isPublicNarratorSharePath } from "./lib/app-path-classify";
import { getRouterBasepath } from "./lib/base-path";
import { installHostBridge } from "./lib/host-bridge";
import { getInitialNamespaces, initI18n } from "./lib/i18n";

/**
 * Apply the persisted plugin theme attribute before React mounts so the first
 * paint already reflects the user's choice (no flash of the default theme). The
 * actual CSS rules are injected by <PluginThemeInjector /> once the theme list
 * loads; setting the attribute early is cheap and safe even before the rules
 * exist.
 */
function applyInitialPluginTheme() {
	try {
		const key = readActivePluginThemeKey();
		if (key) document.documentElement.setAttribute("data-plugin-theme", key);
	} catch {
		// Ignore storage/DOM access failures.
	}
}

async function bootstrap() {
	const isPublicShare = isPublicNarratorSharePath(window.location.pathname, getRouterBasepath());
	if (!isPublicShare) applyInitialPluginTheme();
	/*
	 * Session handoff with an editor host that embeds this app (the VS Code extension).
	 *
	 * Installed BEFORE the router mounts so an injected token is in storage by the time
	 * the first authenticated query runs — otherwise the panel would flash its login page
	 * and then replace it, which reads as a failed login rather than a resumed session.
	 *
	 * Returns null (and installs nothing) unless this document is a deliberately embedded
	 * panel; see `lib/host-bridge.ts` for the guards.
	 */
	if (!isPublicShare) installHostBridge();
	// Before React mounts, so the first gesture on the first paint is already
	// covered. Safari in a browser tab ignores index.html's `user-scalable=no`, and
	// a component-level handler is structurally too late (see pinch-zoom-guard.ts).
	installPinchZoomGuard();
	/*
	 * History is created HERE, not in `App`, so a Fast Refresh of the React tree cannot
	 * replace it. A fresh history would reset the URL bar's session entries and detach
	 * the router from the browser's back/forward stack.
	 */
	const history = createBrowserHistory();

	// Sweep focus-dock layouts unopened for >30 days (best-effort, never throws).
	if (!isPublicShare) cleanupStaleNarratorDockLayouts();

	await initI18n(getInitialNamespaces(window.location.pathname));
	if (!isPublicShare) void syncPluginUiContributions().catch(() => {});

	// biome-ignore lint/style/noNonNullAssertion: root element always exists
	ReactDOM.createRoot(document.getElementById("root")!, {
		/*
		 * Let the dev-only HMR guard see render errors an error boundary handled.
		 *
		 * Every route has a CatchBoundary (see `defaultErrorComponent` in App.tsx), so a
		 * stale-module-graph failure inside a route becomes an error card and never
		 * reaches `window.onerror` — the guard's one-time reload would never fire.
		 *
		 * Supplying these options REPLACES React's default handlers, which are the
		 * ones that log to the console, so each handler logs explicitly to keep the
		 * error (and its component stack) visible in devtools.
		 */
		onCaughtError: (error, errorInfo) => {
			console.error(error, errorInfo?.componentStack ?? "");
			reportReactRenderError(error);
		},
		onUncaughtError: (error, errorInfo) => {
			console.error(error, errorInfo?.componentStack ?? "");
			reportReactRenderError(error);
		},
	}).render(
		<React.StrictMode>
			<App history={history} />
		</React.StrictMode>,
	);
}

void bootstrap();
