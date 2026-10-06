/** Shared by the iframe vendor and the Bun-only plugin compiler. */
export const PLUGIN_UI_RUNTIME_VERSION = 1;

export const PLUGIN_UI_SHARED_MODULES = {
	react: "React",
	"react/jsx-runtime": "JsxRuntime",
	"react-dom/client": "ReactDOMClient",
	"@mantine/core": "MantineCore",
	"@mantine/hooks": "MantineHooks",
} as const;
