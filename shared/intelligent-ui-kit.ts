/**
 * Component kit: the workspace's own component library, pre-built once into a browser
 * bundle so UI previews compose real project components instead of NarraFork's.
 *
 * Everything lives in ordinary workspace files under `.narrafork/intelligent_ui/kit/`:
 * the agent authors `kit.json` (+ an optional setup wrapper); the host generates the entry
 * and Vite config and runs the project's own Vite to produce `dist/`.
 */
export const INTELLIGENT_UI_KIT_DIRECTORY = ".narrafork/intelligent_ui/kit";
export const INTELLIGENT_UI_KIT_MANIFEST = "kit.json";
export const INTELLIGENT_UI_KIT_ENTRY = "entry.generated.ts";
export const INTELLIGENT_UI_KIT_VITE_CONFIG = "vite.kit.config.mjs";
export const INTELLIGENT_UI_KIT_DIST = "dist";
/**
 * Where Vite writes. Emptied on every build, and not what the browser is served:
 * `dist/` changes only after the host has signed a successful build.
 */
export const INTELLIGENT_UI_KIT_STAGING = ".staging";
/** Bundle of a kit built before bundles were named after their inputs. */
export const INTELLIGENT_UI_KIT_LEGACY_BUNDLE = "kit.js";
export const INTELLIGENT_UI_KIT_META = "kit.meta.json";
/** The global the generated entry assigns; the preview shell and compiler read it. */
export const INTELLIGENT_UI_KIT_GLOBAL = "__nfKit";
/** Virtual module TSX previews import kit components from. */
export const INTELLIGENT_UI_KIT_MODULE = "kit";

export const INTELLIGENT_UI_KIT_LIMITS = Object.freeze({
	manifestBytes: 256 * 1024,
	setupBytes: 512 * 1024,
	components: 200,
	bundleJsBytes: 8 * 1024 * 1024,
	bundleCssBytes: 2 * 1024 * 1024,
	buildTimeoutMs: 180_000,
	buildLogBytes: 24 * 1024,
	catalogChars: 12_000,
});

export interface IntelligentUiKitComponent {
	/** Tag name used in markup and the export name of the `kit` module. */
	name: string;
	/** Module specifier, importable from the kit directory (project alias or relative path). */
	from: string;
	/** Named export, `default`, or `*` for the whole module namespace (`<Name.Part>`). */
	export: string;
	description?: string;
	props?: string;
	example?: string;
}

export interface IntelligentUiKitManifest {
	version: 1;
	/** Vite project root relative to the workspace root; `.` when omitted. */
	root: string;
	/** Module whose default export wraps every preview (theme/providers). */
	setup?: string;
	/** Global stylesheets imported before any component. */
	styles: string[];
	components: IntelligentUiKitComponent[];
}

/**
 * `builtin`: no kit.json, NarraFork's Mantine runtime is used. `unbuilt`: a manifest
 * exists but no bundle. `stale`: inputs changed since the bundle was built (it is still
 * served). `invalid`: the manifest cannot be used as written.
 */
export type IntelligentUiKitState = "builtin" | "unbuilt" | "stale" | "ready" | "invalid";

export interface IntelligentUiKitStatus {
	state: IntelligentUiKitState;
	/** Component names of the BUILT bundle (empty when none is served). */
	components: string[];
	/** Identity of the served bundle; changes whenever it is rebuilt. */
	hash?: string;
	builtAt?: string;
	reason?: string;
}

/** A build/update the user must confirm before the agent may run it. */
export interface IntelligentUiKitRequest {
	id: string;
	kind: "build" | "update";
	state: "pending" | "approved";
	reason: string;
	createdAt: string;
}

/** Host-owned tool metadata describing the kit a result was produced against. */
export interface IntelligentUiKitNotice {
	state: IntelligentUiKitState;
	request?: Pick<IntelligentUiKitRequest, "id" | "kind" | "state">;
}

export interface IntelligentUiKitBundle {
	js: string;
	css: string;
	hash: string;
	components: string[];
	hasSetup: boolean;
}

const NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;
const EXPORT = /^(?:\*|default|[A-Za-z_$][\w$]{0,63})$/;

function specifier(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 512 ||
		// The value is emitted through JSON.stringify; this only rejects what no bundler
		// resolves and what would make a build log unreadable.
		/[\0\r\n]/.test(value)
	)
		throw new Error(`${label} must be a module specifier of at most 512 characters`);
	return value;
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	return value.length > max ? value.slice(0, max) : value;
}

/** Validate an agent-authored manifest. Throws a message the agent can act on. */
export function parseIntelligentUiKitManifest(value: unknown): IntelligentUiKitManifest {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("kit.json must be a JSON object");
	const raw = value as Record<string, unknown>;
	if (raw.version !== 1) throw new Error("kit.json version must be 1");
	const root = raw.root === undefined ? "." : raw.root;
	if (
		typeof root !== "string" ||
		root.length === 0 ||
		root.length > 512 ||
		/^(?:[/\\]|[A-Za-z]:)/.test(root) ||
		root.split(/[/\\]/).includes("..") ||
		/[\0\r\n"'`$]/.test(root)
	)
		throw new Error("kit.json root must be a relative directory inside the workspace");
	if (!Array.isArray(raw.components) || raw.components.length === 0)
		throw new Error("kit.json components must be a non-empty array");
	if (raw.components.length > INTELLIGENT_UI_KIT_LIMITS.components)
		throw new Error(`kit.json lists more than ${INTELLIGENT_UI_KIT_LIMITS.components} components`);
	const seen = new Set<string>();
	const components = raw.components.map((entry, index): IntelligentUiKitComponent => {
		const label = `components[${index}]`;
		if (!entry || typeof entry !== "object" || Array.isArray(entry))
			throw new Error(`${label} must be an object`);
		const item = entry as Record<string, unknown>;
		if (typeof item.name !== "string" || !NAME.test(item.name))
			throw new Error(`${label}.name must be a PascalCase identifier (e.g. "Button")`);
		if (seen.has(item.name)) throw new Error(`Duplicate component name: ${item.name}`);
		seen.add(item.name);
		const exported = item.export === undefined ? item.name : item.export;
		if (typeof exported !== "string" || !EXPORT.test(exported))
			throw new Error(`${label}.export must be a named export, "default" or "*"`);
		const description = optionalText(item.description, `${label}.description`, 400);
		const props = optionalText(item.props, `${label}.props`, 2000);
		const example = optionalText(item.example, `${label}.example`, 2000);
		return {
			name: item.name,
			from: specifier(item.from, `${label}.from`),
			export: exported,
			...(description ? { description } : {}),
			...(props ? { props } : {}),
			...(example ? { example } : {}),
		};
	});
	const styles = raw.styles === undefined ? [] : raw.styles;
	if (!Array.isArray(styles) || styles.length > 32)
		throw new Error("kit.json styles must be an array of at most 32 stylesheets");
	return {
		version: 1,
		root: root.replaceAll("\\", "/").replace(/\/+$/, "") || ".",
		...(raw.setup === undefined || raw.setup === null
			? {}
			: { setup: specifier(raw.setup, "kit.json setup") }),
		styles: styles.map((style, index) => specifier(style, `styles[${index}]`)),
		components,
	};
}

/**
 * The entry Vite bundles. It contains no JSX and no project syntax, so it builds under
 * any project configuration; everything project-specific is behind an import.
 */
export function renderIntelligentUiKitEntry(manifest: IntelligentUiKitManifest): string {
	const lines = [
		"// Generated by NarraFork IntelligentUI from kit.json. Do not edit; kit_build rewrites it.",
		'import * as React from "react";',
		'import * as JsxRuntime from "react/jsx-runtime";',
		'import * as ReactDOMClient from "react-dom/client";',
		...manifest.styles.map((style) => `import ${JSON.stringify(style)};`),
		...(manifest.setup ? [`import Setup from ${JSON.stringify(manifest.setup)};`] : []),
		...manifest.components.map((component, index) => {
			const from = JSON.stringify(component.from);
			if (component.export === "*") return `import * as C${index} from ${from};`;
			if (component.export === "default") return `import C${index} from ${from};`;
			return `import { ${component.export} as C${index} } from ${from};`;
		}),
		`const components = Object.freeze({ ${manifest.components
			.map((component, index) => `${component.name}: C${index}`)
			.join(", ")} });`,
		`(globalThis as Record<string, unknown>).${INTELLIGENT_UI_KIT_GLOBAL} = Object.freeze({`,
		"\tversion: 1,",
		"\tReact,",
		"\tJsxRuntime,",
		"\tReactDOMClient,",
		`\tSetup: ${manifest.setup ? "Setup" : "null"},`,
		"\tcomponents,",
		"});",
		"",
	];
	return lines.join("\n");
}

/** File name stem of a built bundle; also the only shape accepted back from kit.meta.json. */
export const INTELLIGENT_UI_KIT_BUNDLE_NAME = /^kit-[0-9a-f]{12}$/;

/**
 * A bundle is named after the inputs it was built from. A rebuild therefore writes NEW
 * files beside the ones being served and only the metadata switch makes them current, so
 * a build that fails leaves the working kit untouched.
 */
export function intelligentUiKitBundleName(fingerprint: string): string {
	return `kit-${fingerprint.slice(0, 12)}`;
}

/**
 * Wraps the project's own Vite config (plugins, aliases, CSS pipeline) in a one-file
 * IIFE library build. Application entry points and externals are dropped: the bundle must
 * be self-contained, including its own React.
 */
export function renderIntelligentUiKitViteConfig(rootFromKit: string, bundleName: string): string {
	if (!INTELLIGENT_UI_KIT_BUNDLE_NAME.test(bundleName)) throw new Error("Invalid kit bundle name");
	return `// Generated by NarraFork IntelligentUI. Do not edit; kit_build rewrites it.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile, mergeConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, ${JSON.stringify(rootFromKit)});

export default async (env) => {
	const loaded = await loadConfigFromFile(env, undefined, root);
	const merged = mergeConfig(loaded?.config ?? {}, {
		root,
		publicDir: false,
		define: { "process.env.NODE_ENV": JSON.stringify("production") },
		build: {
			outDir: resolve(here, ${JSON.stringify(INTELLIGENT_UI_KIT_STAGING)}),
			// Emptied every build. The served files live in dist/ and are not this directory.
			emptyOutDir: true,
			copyPublicDir: false,
			sourcemap: false,
		},
	});
	// Assigned, not merged: mergeConfig concatenates arrays, and an inherited format
	// list, HTML input or external list would turn this into several conflicting builds.
	merged.build.lib = {
		entry: resolve(here, ${JSON.stringify(INTELLIGENT_UI_KIT_ENTRY)}),
		formats: ["iife"],
		name: "__nfKitBundle",
		fileName: () => ${JSON.stringify(`${bundleName}.js`)},
		cssFileName: ${JSON.stringify(bundleName)},
	};
	delete merged.build.rollupOptions;
	delete merged.build.rolldownOptions;
	delete merged.build.ssr;
	delete merged.build.manifest;
	delete merged.build.ssrManifest;
	return merged;
};
`;
}

/** Compact, bounded catalog the model reads before composing with the kit. */
export function describeIntelligentUiKitCatalog(manifest: IntelligentUiKitManifest): string {
	const parts: string[] = [];
	let used = 0;
	for (const component of manifest.components) {
		const tag = component.export === "*" ? `<${component.name}.*>` : `<${component.name}>`;
		const block = [
			`${tag}${component.description ? ` — ${component.description}` : ""}`,
			...(component.props ? [`  props: ${component.props}`] : []),
			...(component.example ? [`  example: ${component.example}`] : []),
		].join("\n");
		if (used + block.length > INTELLIGENT_UI_KIT_LIMITS.catalogChars) {
			parts.push(`… ${manifest.components.length - parts.length} more components in kit.json`);
			break;
		}
		parts.push(block);
		used += block.length;
	}
	return parts.join("\n");
}

export function readIntelligentUiKitNotice(value: unknown): IntelligentUiKitNotice | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (
		typeof raw.state !== "string" ||
		!["builtin", "unbuilt", "stale", "ready", "invalid"].includes(raw.state)
	)
		return null;
	const request =
		raw.request && typeof raw.request === "object" && !Array.isArray(raw.request)
			? (raw.request as Record<string, unknown>)
			: null;
	const valid =
		request &&
		typeof request.id === "string" &&
		request.id.length <= 64 &&
		(request.kind === "build" || request.kind === "update") &&
		(request.state === "pending" || request.state === "approved");
	return {
		state: raw.state as IntelligentUiKitState,
		...(valid
			? {
					request: {
						id: request.id as string,
						kind: request.kind as "build" | "update",
						state: request.state as "pending" | "approved",
					},
				}
			: {}),
	};
}
