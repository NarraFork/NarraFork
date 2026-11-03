import { deriveCustomApiProvidersFromLegacy } from "./custom-api-providers";
import { settings } from "./index";
import type { CustomApiProviderConfig } from "./types";

/**
 * The unified custom API provider list, falling back to the legacy split arrays
 * for settings files that predate `customApiProviders`.
 */
export function currentCustomApiProviders(): CustomApiProviderConfig[] {
	return (
		settings.customApiProviders ??
		deriveCustomApiProvidersFromLegacy(
			settings.openaiProviders,
			settings.anthropicProviders,
			settings.geminiProviders,
		)
	);
}
