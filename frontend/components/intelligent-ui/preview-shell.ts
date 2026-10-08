import { readHostMantineTokens } from "@frontend/components/plugins/asset-shell";
import { readHostTokens, renderTokenCss } from "@frontend/components/plugins/host-tokens";
import type { PreviewBundle } from "./preview-loader";

export interface PreviewTheme {
	colorScheme: "light" | "dark";
	tokenCss: string;
}

export function readPreviewTheme(): PreviewTheme {
	return {
		colorScheme: document.documentElement.dataset.mantineColorScheme === "light" ? "light" : "dark",
		// More specific than Mantine's generated variables, including its scheme selectors.
		tokenCss: `:root:root:root{${readHostMantineTokens()}}\n${renderTokenCss(readHostTokens())}`,
	};
}

function scriptJson(value: unknown): string {
	return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

/**
 * The host fetches the trusted shared runtime without credentials. The opaque frame has no
 * host DOM access, bridge, or token; CSP blocks ordinary resource loads and connections, while
 * untrusted code can still navigate its own frame. JS/CSS are JSON data, never interpolated into
 * raw script/style HTML.
 */
export function createPreviewShell(
	bundle: PreviewBundle,
	theme: PreviewTheme,
	failureMessage: string,
): string {
	const config = scriptJson({
		runtimeJs: bundle.runtimeJs,
		runtimeCss: bundle.runtimeCss,
		js: bundle.js,
		css: bundle.css,
		theme,
		failureMessage,
	});
	return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data: blob:; font-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; media-src 'none'">
<meta name="referrer" content="no-referrer">
<style>html,body,#root{min-height:100%;margin:0}body{background:var(--mantine-color-body);color:var(--mantine-color-text);font-family:var(--mantine-font-family,system-ui)}#root{padding:16px;box-sizing:border-box}#failure{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px}</style>
</head><body><div id="root"></div><pre id="failure" role="alert" hidden></pre><script>
(() => {
  const config = ${config};
  // Only a teardown hint. Browsers allow self-navigation even with connect-src 'none'.
  window.addEventListener("pagehide", () => parent.postMessage({type:"narrafork:preview-left"}, "*"), {once:true});
  window.addEventListener("message", event => {
    if (event.source === parent && event.data?.type === "narrafork:preview-check")
      parent.postMessage({type:"narrafork:preview-present", id:event.data.id}, "*");
  });
  const failure = document.getElementById("failure");
  const fail = (error) => {
    failure.hidden = false;
    failure.textContent = config.failureMessage + (error && error.message ? "\\n" + String(error.message).slice(0, 2000) : "");
  };
  window.addEventListener("error", event => fail(event.error || new Error(event.message)));
  window.addEventListener("unhandledrejection", event => fail(event.reason));
  const style = (text) => {
    const element = document.createElement("style");
    element.textContent = text;
    document.head.appendChild(element);
    return element;
  };
  const script = (text) => {
    const element = document.createElement("script");
    element.textContent = text;
    document.head.appendChild(element);
    element.remove();
  };
  try {
    style(config.runtimeCss);
    style(config.css);
    const tokens = style(config.theme.tokenCss);
    document.documentElement.dataset.mantineColorScheme = config.theme.colorScheme;
    script(config.runtimeJs);
    script(config.js);
    // Drop the bootstrap's duplicate source strings once the browser has parsed them.
    config.runtimeJs = config.runtimeCss = config.js = config.css = "";
    const runtime = globalThis.__nfPluginRuntime;
    const App = globalThis.__nfIntelligentUiApp;
    if (!runtime || !App) throw new Error("UI runtime or default App export is unavailable");
    const { React, ReactDOMClient, MantineCore } = runtime;
    class Boundary extends React.Component {
      constructor(props) { super(props); this.state = { failed: false }; }
      static getDerivedStateFromError() { return { failed: true }; }
      componentDidCatch(error) { fail(error); }
      render() { return this.state.failed ? null : this.props.children; }
    }
    let updateTheme;
    function Preview() {
      const [scheme, setScheme] = React.useState(config.theme.colorScheme);
      updateTheme = setScheme;
      return React.createElement(MantineCore.MantineProvider, {
        theme: runtime.theme,
        cssVariablesResolver: MantineCore.v8CssVariablesResolver,
        forceColorScheme: scheme,
        colorSchemeManager: { get: () => scheme, set: () => {}, subscribe: () => {}, unsubscribe: () => {}, clear: () => {} }
      }, React.createElement(Boundary, null, React.createElement(App)));
    }
    ReactDOMClient.createRoot(document.getElementById("root")).render(React.createElement(Preview));
    window.addEventListener("message", event => {
      if (event.source !== parent || event.data?.type !== "narrafork:preview-theme") return;
      const theme = event.data.theme;
      if (!theme || !["light", "dark"].includes(theme.colorScheme) || typeof theme.tokenCss !== "string" || theme.tokenCss.length > 65536) return;
      config.theme = theme;
      tokens.textContent = theme.tokenCss;
      document.documentElement.dataset.mantineColorScheme = theme.colorScheme;
      updateTheme?.(theme.colorScheme);
    });
  } catch (error) { fail(error); }
})();
</script></body></html>`;
}
