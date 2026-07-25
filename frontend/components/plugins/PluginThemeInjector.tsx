import { useEffect } from "react";
import { pluginThemeKey, usePluginThemePref, usePluginThemes } from "../../hooks/usePluginThemes";

/** The `<style>` element id that holds all enabled plugin theme rules. */
export const PLUGIN_THEME_STYLE_ELEMENT_ID = "plugin-themes";
/** The `<html>` attribute that selects the active plugin theme. */
export const PLUGIN_THEME_ATTRIBUTE = "data-plugin-theme";

/**
 * Injects plugin-contributed theme CSS into the host document and toggles the
 * active theme via a single `<html>` attribute.
 *
 * Performance: all enabled themes are pre-injected into one `<style>` element
 * as `[data-plugin-theme="…"] { … }` rules. Switching themes only mutates the
 * `data-plugin-theme` attribute, which triggers a native style recalc with zero
 * React re-render — the same mechanism as OLED mode. The style element is only
 * rewritten when the set of available themes actually changes.
 *
 * Safety: the CSS here is the server's compiled output built from whitelisted
 * design tokens (never raw plugin CSS). Theme tokens are zero-JS, so `ui.theme`
 * is deliberately NOT gated on a capability grant; the gate is per-user
 * enablement, and the server only returns themes this user turned on. If the
 * active theme disappears (plugin disabled, uninstalled, or the user turned it
 * off) this component clears the selection so the app falls back to the default
 * look instead of a dangling attribute.
 */
export function PluginThemeInjector() {
	const { themes } = usePluginThemes();
	const [activeKey, setActiveKey] = usePluginThemePref();

	// Keep the pre-injected <style> in sync with the available themes.
	useEffect(() => {
		if (typeof document === "undefined") return;
		let style = document.getElementById(PLUGIN_THEME_STYLE_ELEMENT_ID) as HTMLStyleElement | null;
		if (themes.length === 0) {
			// No themes available: drop the style element entirely.
			style?.remove();
			return;
		}
		if (!style) {
			style = document.createElement("style");
			style.id = PLUGIN_THEME_STYLE_ELEMENT_ID;
			document.head.appendChild(style);
		}
		const css = themes.map((theme) => theme.css).join("\n");
		if (style.textContent !== css) style.textContent = css;
	}, [themes]);

	// Apply / clear the active theme attribute, falling back when it vanishes.
	useEffect(() => {
		if (typeof document === "undefined") return;
		const root = document.documentElement;
		if (!activeKey) {
			root.removeAttribute(PLUGIN_THEME_ATTRIBUTE);
			return;
		}
		// Only apply the attribute once the matching theme is actually available;
		// otherwise clear the stale preference so we never point at a missing rule.
		const available = themes.some((theme) => pluginThemeKey(theme) === activeKey);
		if (available) {
			root.setAttribute(PLUGIN_THEME_ATTRIBUTE, activeKey);
		} else {
			root.removeAttribute(PLUGIN_THEME_ATTRIBUTE);
			// If the theme list has loaded and the active theme is gone for good,
			// forget the preference so the UI selector reflects reality.
			if (themes.length > 0) setActiveKey(null);
		}
	}, [themes, activeKey, setActiveKey]);

	return null;
}
