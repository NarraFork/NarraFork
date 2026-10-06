/** Bun-only plugin compiler; never import from Vite's worker configuration.
 * CSS is deliberately not bundled: declare panel CSS separately in the manifest.
 * Mantine's stylesheet is already injected by the iframe shell.
 */

import * as MantineCore from "@mantine/core";
import * as MantineHooks from "@mantine/hooks";
import type { BunPlugin } from "bun";
import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import * as ReactDOMClient from "react-dom/client";
import { PLUGIN_UI_RUNTIME_VERSION, PLUGIN_UI_SHARED_MODULES } from "../plugin-runtime/contract";

const modules = { React, ReactDOMClient, JsxRuntime, MantineCore, MantineHooks };
const namespace = "nf-plugin-runtime";
const sharedFilter = /^(react(?:-dom)?|@mantine\/[^/]+)(?:\/.*)?$/;

/** Virtual ESM means Bun itself validates named imports, including re-exports.
 * Export names come from the installed host modules, not a hand-maintained API list.
 * No module implementation is included in the generated source.
 */
export function pluginUiSharedRuntime(): BunPlugin {
	return {
		name: "narrafork-plugin-shared-runtime",
		setup(build) {
			build.onResolve({ filter: sharedFilter }, ({ path }) => {
				if (!Object.hasOwn(PLUGIN_UI_SHARED_MODULES, path)) {
					throw new Error(
						`Unsupported shared UI module: ${path}. Use a supported root import; CSS must be declared separately in the manifest.`,
					);
				}
				// Explicit .mjs prevents Bun inheriting React's CommonJS package format,
				// which otherwise bypasses missing-export validation and breaks default identity.
				return {
					path: `${PLUGIN_UI_SHARED_MODULES[path as keyof typeof PLUGIN_UI_SHARED_MODULES]}.mjs`,
					namespace,
				};
			});
			build.onResolve({ filter: /\.(?:css|scss|sass|less)(?:[?#].*)?$/ }, ({ path }) => {
				throw new Error(
					`Plugin UI CSS imports are not supported: ${path}. Declare CSS separately in the manifest; Mantine CSS is supplied by the host.`,
				);
			});
			build.onLoad({ filter: /.*/, namespace }, ({ path }) => {
				const key = path.slice(0, -4) as keyof typeof modules;
				const exports = Object.keys(modules[key]).filter(
					(name) =>
						/^[A-Za-z_$][\w$]*$/.test(name) &&
						// React's production host does not expose these development-only helpers.
						!(key === "React" && (name === "act" || name === "captureOwnerStack")),
				);
				return {
					loader: "js",
					contents: `import { runtime } from "__nf_runtime_check__";
const shared = runtime[${JSON.stringify(key)}];
if (!shared) throw new Error("Plugin UI shared module unavailable: ${key}");
function readExport(name) {
 if (!(name in shared)) throw new Error("Plugin UI shared export unavailable: ${key}." + name);
 return shared[name];
}
${exports.map((name, index) => `const e${index} = /* @__PURE__ */ readExport(${JSON.stringify(name)}); export { e${index} as ${name} };`).join("\n")}`,
				};
			});
			build.onResolve({ filter: /^__nf_runtime_check__$/ }, () => ({
				path: "check",
				namespace: `${namespace}-check`,
			}));
			build.onLoad({ filter: /.*/, namespace: `${namespace}-check` }, () => ({
				loader: "js",
				contents: `const runtime = globalThis.__nfPluginRuntime;
if (!runtime || runtime.version !== ${PLUGIN_UI_RUNTIME_VERSION}) throw new Error("Plugin UI runtime unavailable or incompatible: expected version ${PLUGIN_UI_RUNTIME_VERSION}, received " + (runtime?.version ?? "missing"));
export { runtime };`,
			}));
		},
	};
}

export const PLUGIN_UI_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** A standalone build, not a host runtime replacement. Both modes use production JSX
 * because the host contract exposes jsx-runtime, never jsx-dev-runtime.
 * `development` only disables minification; NODE_ENV stays production to match the host.
 * Callers needing a hard cancellation deadline should run in a subprocess (see CLI).
 */
export async function buildPluginUi(entrypoint: string, options: { development?: boolean } = {}) {
	const result = await Bun.build({
		entrypoints: [entrypoint],
		throw: false,
		target: "browser",
		format: "iife",
		splitting: false,
		minify: !options.development,
		jsx: { runtime: "automatic", importSource: "react", development: false },
		define: { "process.env.NODE_ENV": JSON.stringify("production") },
		plugins: [pluginUiSharedRuntime()],
	});
	if (!result.success) {
		let diagnostics = "";
		for (const log of result.logs) {
			diagnostics += `${String(log)}\n`.slice(0, 16_384 - diagnostics.length);
			if (diagnostics.length >= 16_384) break;
		}
		throw new Error(diagnostics || "Plugin UI build failed");
	}
	if (result.outputs.length !== 1 || result.outputs[0]?.kind !== "entry-point") {
		throw new Error(
			"Plugin UI must produce one IIFE only; declare CSS/assets separately in the manifest.",
		);
	}
	const output = result.outputs[0];
	if (output.size > PLUGIN_UI_MAX_OUTPUT_BYTES)
		throw new Error("Plugin UI output exceeds 2 MiB limit");
	return output;
}
