/**
 * Access to the host's shared UI runtime (React + Mantine).
 *
 * The panel runs in a sandboxed iframe — a separate realm — so it cannot import the host's
 * React. Instead the host injects a runtime bundle that installs `globalThis.__nfPluginRuntime`
 * before this plugin's entry executes, and this module is the only place that reads it.
 *
 * Two things are deliberate:
 *
 * - **The version check is fatal.** A mismatch means the host shipped a runtime this panel
 *   was not built against (a React or Mantine major bump). Rendering anyway would produce
 *   subtly broken components or a stack trace from inside library code; failing here names
 *   the actual problem.
 * - **Nothing is imported from `react` or `@mantine/core` anywhere in the UI sources.** Doing
 *   so would bundle a second copy into the plugin artifact, defeating the point of a shared
 *   runtime and giving the panel a React that is not the one its components were mounted
 *   with. Everything goes through this module.
 */

/** Runtime shape the host guarantees. Mirrors `frontend/plugin-runtime/vendor.ts`. */
interface HostPluginRuntime {
	version: number;
	// biome-ignore lint/suspicious/noExplicitAny: the host's module namespaces, typed at use site
	React: any;
	// biome-ignore lint/suspicious/noExplicitAny: the host's module namespaces, typed at use site
	ReactDOMClient: any;
	// biome-ignore lint/suspicious/noExplicitAny: the host's module namespaces, typed at use site
	JsxRuntime: any;
	// biome-ignore lint/suspicious/noExplicitAny: the host's module namespaces, typed at use site
	MantineCore: any;
	// biome-ignore lint/suspicious/noExplicitAny: the host's module namespaces, typed at use site
	MantineHooks: any;
	// biome-ignore lint/suspicious/noExplicitAny: the host's Mantine theme object
	theme: any;
}

/** Runtime major this panel is built against. */
const SUPPORTED_RUNTIME_VERSION = 1;

export class HostRuntimeUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HostRuntimeUnavailableError";
	}
}

function readRuntime(): HostPluginRuntime {
	const candidate = (globalThis as { __nfPluginRuntime?: unknown }).__nfPluginRuntime;
	if (!candidate || typeof candidate !== "object") {
		throw new HostRuntimeUnavailableError(
			'The host UI runtime is missing. This view declares `runtime: "host-react"`, so the host should have injected React and Mantine before loading it.',
		);
	}
	const runtime = candidate as HostPluginRuntime;
	if (runtime.version !== SUPPORTED_RUNTIME_VERSION) {
		throw new HostRuntimeUnavailableError(
			`The host UI runtime is version ${String(runtime.version)}, but this view was built for version ${SUPPORTED_RUNTIME_VERSION}. Update the plugin to match the host.`,
		);
	}
	if (!runtime.React || !runtime.MantineCore || !runtime.ReactDOMClient) {
		throw new HostRuntimeUnavailableError("The host UI runtime is incomplete.");
	}
	return runtime;
}

const hostRuntime = readRuntime();

export const React = hostRuntime.React;
export const MantineCore = hostRuntime.MantineCore;
export const MantineHooks = hostRuntime.MantineHooks;
export const hostTheme = hostRuntime.theme;
export const createRoot = hostRuntime.ReactDOMClient.createRoot;

// The automatic JSX transform compiles to these; re-exported through `./shim/jsx-runtime`.
export const jsx = hostRuntime.JsxRuntime.jsx;
export const jsxs = hostRuntime.JsxRuntime.jsxs;
export const Fragment = hostRuntime.JsxRuntime.Fragment;

export const useState = hostRuntime.React.useState;
export const useEffect = hostRuntime.React.useEffect;
export const useCallback = hostRuntime.React.useCallback;
export const useMemo = hostRuntime.React.useMemo;
export const useRef = hostRuntime.React.useRef;
