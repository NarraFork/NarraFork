/**
 * Dockview component-map wiring for plugin panels.
 *
 * WHY IT IS NOT IN `PluginDockPanel.tsx`
 * ------------------------------------
 * `@vitejs/plugin-react` only treats a module as a VALID Fast Refresh boundary when every
 * export is a component. These three exports are a string constant, a plain object and a
 * higher-order function, so keeping them next to `PluginDockPanel` produced:
 *
 *     invalidate /components/plugins/PluginDockPanel.tsx: Could not Fast Refresh
 *       ("withPluginDockviewComponent" export is incompatible)
 *
 * That invalidation propagates to importers, and a chain reaching the entry ends in a full
 * page reload rather than a hot update.
 *
 * `pluginDockviewComponents` is a component MAP, not a component: Fast Refresh's
 * `isLikelyComponentType` check does not accept an object of components, which is why the
 * capitalised-name convention would not have saved it either.
 */

import { PluginDockPanel } from "./PluginDockPanel";

/** Dockview component key under which plugin panels are registered. */
export const PLUGIN_DOCKVIEW_COMPONENT = "plugin" as const;

/** Add the plugin panel to an existing Dockview component map. */
export function withPluginDockviewComponent<T extends Record<string, unknown>>(components: T) {
	return { ...components, [PLUGIN_DOCKVIEW_COMPONENT]: PluginDockPanel };
}

/** Dockview component map containing only the plugin panel. */
export const pluginDockviewComponents = { [PLUGIN_DOCKVIEW_COMPONENT]: PluginDockPanel };
