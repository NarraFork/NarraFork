/**
 * Shared UI runtime for plugin panels: React + Mantine, exposed on `globalThis`.
 *
 * ## Why a second copy of React exists at all
 *
 * A plugin panel runs in an iframe with `sandbox="allow-scripts"` and no `allow-same-origin`,
 * so it is an opaque origin and a separate JS realm. It cannot reach the host's React
 * instance, its component tree, or its `MantineProvider`. "Sharing" therefore cannot mean
 * sharing an instance — only sharing a *bundle*.
 *
 * That is what this file is: one runtime the host builds once and every plugin panel loads,
 * instead of each plugin bundling its own React and Mantine. Measured on the reference
 * plugin, the difference is ~1.2 KB of plugin code against ~267 KB per plugin.
 *
 * ## Why this matters beyond size
 *
 * The alternative to a shared runtime is each plugin hand-copying the host's theme tokens.
 * Those copies drift the moment the host adjusts a color, and nothing fails loudly when they
 * do — the panel just looks slightly wrong. Importing `mantineTheme` from the host source
 * means a token change lands in plugin panels the next time the host is built.
 *
 * ## Contract with plugins
 *
 * A plugin reads `globalThis.__nfPluginRuntime` and must check `version`. The host injects
 * this file before the plugin entry (see `createPluginAssetShell`), so by the time plugin
 * code runs the global is present — a missing global means the injection failed and the
 * plugin should say so rather than crash with a null dereference.
 *
 * The object is frozen: a panel must not be able to swap the React the *next* panel sees.
 * Freezing is shallow, which is enough — the modules it points at are module namespaces.
 *
 * Only the modules a panel genuinely needs are exposed. `@mantine/notifications` is
 * deliberately absent: notifications belong to the host's own notification area and are
 * reached through the UI SDK's `notifications.show`, not by rendering a second toast stack
 * inside a 720px iframe.
 */

import "@mantine/core/styles.css";
import * as MantineCore from "@mantine/core";
import * as MantineHooks from "@mantine/hooks";
import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import * as ReactDOMClient from "react-dom/client";
import { mantineTheme } from "../lib/mantine-theme";
import { PLUGIN_UI_RUNTIME_VERSION } from "./contract";

/**
 * Bumped only on a breaking change to this object's shape or to a major version of the
 * libraries it exposes. A plugin built against an incompatible runtime must fail with a
 * readable message instead of rendering half a page.
 */
export { PLUGIN_UI_RUNTIME_VERSION } from "./contract";

export interface PluginUiRuntime {
	readonly version: number;
	readonly React: typeof React;
	readonly ReactDOMClient: typeof ReactDOMClient;
	readonly JsxRuntime: typeof JsxRuntime;
	readonly MantineCore: typeof MantineCore;
	readonly MantineHooks: typeof MantineHooks;
	/** The host's theme object, so a panel's `MantineProvider` matches the host. */
	readonly theme: typeof mantineTheme;
}

const runtime: PluginUiRuntime = Object.freeze({
	version: PLUGIN_UI_RUNTIME_VERSION,
	React,
	ReactDOMClient,
	JsxRuntime,
	MantineCore,
	MantineHooks,
	theme: mantineTheme,
});

(globalThis as unknown as { __nfPluginRuntime?: PluginUiRuntime }).__nfPluginRuntime = runtime;
