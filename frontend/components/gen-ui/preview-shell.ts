import { readHostMantineTokens } from "@frontend/components/plugins/asset-shell";
import { readHostTokens, renderTokenCss } from "@frontend/components/plugins/host-tokens";
import type { PreviewTheme } from "@shared/gen-ui-preview-shell";

export {
	createPreviewShell,
	type PreviewShellOptions,
	type PreviewShellSource,
	type PreviewTheme,
} from "@shared/gen-ui-preview-shell";

export function readPreviewTheme(): PreviewTheme {
	return {
		colorScheme: document.documentElement.dataset.mantineColorScheme === "light" ? "light" : "dark",
		// More specific than Mantine's generated variables, including its scheme selectors.
		tokenCss: `:root:root:root{${readHostMantineTokens()}}\n${renderTokenCss(readHostTokens())}`,
	};
}
