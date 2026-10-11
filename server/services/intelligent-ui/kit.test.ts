import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { LocalBackend } from "@server/lib/agent/execution/local-backend";
import type { WorkspaceContext } from "@shared/workspace-context";
import { buildKit, readKit, readKitBundle } from "./kit";

const KIT = ".narrafork/intelligent_ui/kit";
const REPO_MODULES = resolve(import.meta.dir, "../../../node_modules");
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(files: Record<string, string>) {
	const root = await mkdtemp(join(tmpdir(), "nf-ui-kit-"));
	roots.push(root);
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), content);
	}
	const backend = new LocalBackend();
	const workspace: WorkspaceContext = {
		revision: 1,
		deviceId: "local",
		cwd: root,
		pathFlavor: backend.pathFlavor === "windows" ? "windows" : "posix",
		contextKey: "workspace",
		capabilities: { switchDirectory: true },
	};
	const written: string[] = [];
	const options = {
		authorize: async (path: string) => path,
		authorizeWrite: async (path: string) => {
			written.push(path);
		},
		signal: new AbortController().signal,
	};
	const read = () => readKit(backend, workspace, options.authorize, options.signal);
	const bundle = () => readKitBundle(backend, workspace, options.authorize, options.signal);
	/** Stand in for a build: put a bundle where `kit_build` says this build writes it. */
	const record = async (js: string, extra: Record<string, string> = {}) => {
		const attempt = await buildKit(backend, workspace, { ...options, skipBuild: true });
		if (attempt.ok) return attempt;
		await mkdir(join(root, KIT, "dist"), { recursive: true });
		await writeFile(join(root, KIT, attempt.bundle), js);
		for (const [name, content] of Object.entries(extra))
			await writeFile(join(root, KIT, "dist", name), content);
		return buildKit(backend, workspace, { ...options, skipBuild: true });
	};
	return { root, backend, workspace, options, written, read, bundle, record };
}

const manifest = (components: unknown[], extra: Record<string, unknown> = {}) =>
	JSON.stringify({ version: 1, components, ...extra });
const dist = async (root: string) => (await readdir(join(root, KIT, "dist"))).sort();

/** A small Vite + React project whose config must NOT leak into the kit build. */
const VITE_PROJECT: Record<string, string> = {
	"package.json": '{ "name": "kit-fixture", "private": true, "type": "module" }',
	"bun.lock": "",
	"vite.config.ts": `import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({
	plugins: [react()],
	resolve: { alias: { "@": resolve(__dirname, "src") } },
	// Application settings a library build has to ignore.
	build: { rollupOptions: { input: resolve(__dirname, "index.html"), external: ["react"] } },
});
`,
	"src/index.css": ":root { --brand: #e8590c; }",
	"src/components/button.css": ".acme-btn { border: 2px solid var(--brand); }",
	"src/components/Button.tsx": `import type { ReactNode } from "react";
import "./button.css";
export function Button({ children }: { children?: ReactNode }) {
	return <button type="button" className="acme-btn">{children}</button>;
}
`,
	"src/components/Card.tsx": `import { type ReactNode, useState } from "react";
export default function Card({ title, children }: { title: string; children?: ReactNode }) {
	const [open] = useState(true);
	return <section data-open={open}><h3>{title}</h3>{children}</section>;
}
`,
	[`${KIT}/setup.tsx`]: `import type { ReactNode } from "react";
export default function Setup({ children }: { children?: ReactNode }) {
	return <div data-kit-setup="acme">{children}</div>;
}
`,
	[`${KIT}/kit.json`]: manifest(
		[
			{ name: "Button", from: "@/components/Button" },
			{ name: "Card", from: "@/components/Card", export: "default" },
		],
		{ setup: "./setup.tsx", styles: ["@/index.css"] },
	),
};

describe("component kit state", () => {
	test("no kit.json means the built-in runtime, with nothing read or written", async () => {
		const f = await project({ "package.json": "{}" });
		expect((await f.read()).status).toEqual({ state: "builtin", components: [] });
		await expect(f.bundle()).rejects.toThrow("no built component kit");
	});

	test("a manifest without a bundle is unbuilt; a malformed one is invalid, not an exception", async () => {
		const f = await project({ [`${KIT}/kit.json`]: manifest([{ name: "A", from: "./a" }]) });
		expect((await f.read()).status.state).toBe("unbuilt");
		await writeFile(join(f.root, KIT, "kit.json"), "{ not json");
		const broken = (await f.read()).status;
		expect(broken.state).toBe("invalid");
		expect(broken.reason).toBeTruthy();
		await writeFile(join(f.root, KIT, "kit.json"), manifest([{ name: "lower", from: "./a" }]));
		expect((await f.read()).status.reason).toContain("PascalCase");
	});

	test("skip_build records the bundle this build names and refuses to invent a missing one", async () => {
		const f = await project({ [`${KIT}/kit.json`]: manifest([{ name: "A", from: "./a" }]) });
		const missing = await buildKit(f.backend, f.workspace, { ...f.options, skipBuild: true });
		expect(missing.ok).toBe(false);
		expect(missing.bundle).toMatch(/^dist\/kit-[0-9a-f]{12}\.js$/);
		expect(missing.log).toContain(`did not produce ${missing.bundle}`);
		expect((await f.read()).status.state).toBe("unbuilt");
		// A bundle under any OTHER name is not this build's output.
		await mkdir(join(f.root, KIT, "dist"), { recursive: true });
		await writeFile(join(f.root, KIT, "dist/kit.js"), "stale");
		expect((await buildKit(f.backend, f.workspace, { ...f.options, skipBuild: true })).ok).toBe(
			false,
		);
		await writeFile(join(f.root, KIT, missing.bundle), "globalThis.__nfKit = {};");
		await writeFile(join(f.root, KIT, "dist/style.css"), ".a{}");
		f.written.length = 0;
		const recorded = await buildKit(f.backend, f.workspace, { ...f.options, skipBuild: true });
		expect(recorded.ok).toBe(true);
		expect(recorded.bundle).toBe(missing.bundle);
		expect(recorded.status).toMatchObject({ state: "ready", components: ["A"] });
		// Every generated file went through the write authorization.
		expect(f.written.map((path) => path.replaceAll("\\", "/").split("/").pop())).toEqual([
			"entry.generated.ts",
			"vite.kit.config.mjs",
			"kit.meta.json",
		]);
		// An older Vite names the stylesheet style.css; it is still found.
		expect(await f.bundle()).toMatchObject({
			js: "globalThis.__nfKit = {};",
			css: ".a{}",
			hasSetup: false,
			hash: recorded.status.hash as string,
		});
		// The bundle left over from before this scheme is garbage once a build commits.
		expect(await dist(f.root)).not.toContain("kit.js");
	});

	test("editing the manifest makes the kit stale while the built bundle keeps being served", async () => {
		const f = await project({ [`${KIT}/kit.json`]: manifest([{ name: "A", from: "./a" }]) });
		const built = await f.record("first");
		expect((await f.read()).status.state).toBe("ready");
		await writeFile(
			join(f.root, KIT, "kit.json"),
			manifest([
				{ name: "A", from: "./a" },
				{ name: "B", from: "./b" },
			]),
		);
		const stale = (await f.read()).status;
		expect(stale.state).toBe("stale");
		// Still the bundle that exists: the new component is not claimed until rebuilt.
		expect(stale.components).toEqual(["A"]);
		expect(stale.hash).toBe(built.status.hash as string);
		expect((await f.bundle()).js).toBe("first");
	});

	test("a rebuild never reuses the serving bundle's name, and the old one goes only on success", async () => {
		const f = await project({ [`${KIT}/kit.json`]: manifest([{ name: "A", from: "./a" }]) });
		const first = await f.record("first");
		// Same inputs, next build: a different file, so a failure cannot clobber `first`.
		const attempt = await buildKit(f.backend, f.workspace, { ...f.options, skipBuild: true });
		expect(attempt.ok).toBe(false);
		expect(attempt.bundle).not.toBe(first.bundle);
		expect(attempt.status).toMatchObject({ state: "ready", hash: first.status.hash });
		expect((await f.bundle()).js).toBe("first");
		// A retry of the failed attempt looks in the same place.
		expect((await buildKit(f.backend, f.workspace, { ...f.options, skipBuild: true })).bundle).toBe(
			attempt.bundle,
		);
		const second = await f.record("second");
		expect(second.ok).toBe(true);
		expect(second.status.hash).not.toBe(first.status.hash);
		expect((await f.bundle()).js).toBe("second");
		const files = await dist(f.root);
		expect(files).toContain(second.bundle.replace("dist/", ""));
		expect(files).not.toContain(first.bundle.replace("dist/", ""));
	});

	test("metadata is a workspace file: names in it cannot point the host outside dist/", async () => {
		const f = await project({
			[`${KIT}/kit.json`]: manifest([{ name: "A", from: "./a" }]),
			"secret.js": "TOP SECRET",
		});
		await f.record("real");
		const metaPath = join(f.root, KIT, "dist/kit.meta.json");
		const meta = JSON.parse(await readFile(metaPath, "utf8"));
		for (const tampered of [
			{ ...meta, js: "../../../../secret.js" },
			{ ...meta, js: "..\\..\\..\\..\\secret.js" },
			{ ...meta, css: "../../../../secret.js" },
			{ ...meta, js: "kit-0123456789ab.js/../../../../../secret.js" },
			{ ...meta, components: Array.from({ length: 5000 }, (_, i) => `C${i}`) },
		]) {
			await writeFile(metaPath, JSON.stringify(tampered));
			// Unusable metadata is "not built", never a read of the path it names.
			expect((await f.read()).status.state).toBe("unbuilt");
			await expect(f.bundle()).rejects.toThrow("no built component kit");
		}
	});

	test("the manifest root may not point outside the workspace", async () => {
		const f = await project({
			[`${KIT}/kit.json`]: manifest([{ name: "A", from: "./a" }], { root: "apps/web" }),
		});
		// A missing directory inside the workspace is a build failure, not a traversal.
		const result = await buildKit(f.backend, f.workspace, { ...f.options, skipBuild: true });
		expect(result.ok).toBe(false);
		await writeFile(
			join(f.root, KIT, "kit.json"),
			JSON.stringify({ version: 1, root: "../..", components: [{ name: "A", from: "./a" }] }),
		);
		await expect(buildKit(f.backend, f.workspace, f.options)).rejects.toThrow("root");
		expect((await f.read()).status.state).toBe("invalid");
	});

	test("files the manifest names by path must be the workspace's own", async () => {
		const f = await project({ [`${KIT}/kit.json`]: manifest([{ name: "A", from: "./a" }]) });
		const outside = [
			{ components: [{ name: "A", from: "../../../../outside/Secret" }] },
			{ components: [{ name: "A", from: "..\\..\\..\\..\\outside\\Secret" }] },
			{ components: [{ name: "A", from: "C:\\Windows\\win.ini" }] },
			{ components: [{ name: "A", from: "./a" }], styles: ["../../../../outside.css"] },
			{ components: [{ name: "A", from: "./a" }], setup: "../../../../outside/setup.tsx" },
		];
		for (const extra of outside) {
			await writeFile(join(f.root, KIT, "kit.json"), JSON.stringify({ version: 1, ...extra }));
			f.written.length = 0;
			await expect(
				buildKit(f.backend, f.workspace, { ...f.options, skipBuild: true }),
			).rejects.toThrow("outside the workspace");
			// Refused before anything is generated.
			expect(f.written).toEqual([]);
		}
		// Paths inside the workspace, package names and aliases are the project's business.
		await writeFile(
			join(f.root, KIT, "kit.json"),
			manifest(
				[
					{ name: "A", from: "../../../src/A" },
					{ name: "B", from: "@acme/ui" },
					{ name: "C", from: "@/components/C" },
				],
				{ styles: ["../../../src/app.css"], setup: "./setup.tsx" },
			),
		);
		const result = await buildKit(f.backend, f.workspace, { ...f.options, skipBuild: true });
		expect(result.log).toContain("did not produce");
	});
});

// Runs the repository's own Vite against a throwaway project. Skipped only where the
// dependency tree cannot be linked in (no node_modules, or no permission to link).
describe("component kit build (real Vite)", () => {
	async function linked() {
		const f = await project(VITE_PROJECT);
		if (!existsSync(join(REPO_MODULES, "vite"))) return null;
		try {
			await symlink(
				REPO_MODULES,
				join(f.root, "node_modules"),
				process.platform === "win32" ? "junction" : "dir",
			);
		} catch {
			return null;
		}
		return f;
	}

	test("bundles the project's components, setup and styles through its own Vite config", async () => {
		const f = await linked();
		if (!f) return;
		const result = await buildKit(f.backend, f.workspace, f.options);
		if (!result.ok) throw new Error(`kit build failed:\n${result.log}`);
		expect(result.command).toBe(
			`bunx vite build --mode production --config "${KIT}/vite.kit.config.mjs"`,
		);
		expect(result.status).toMatchObject({ state: "ready", components: ["Button", "Card"] });
		const bundle = await f.bundle();
		expect(bundle.hasSetup).toBe(true);
		// Global stylesheet and component stylesheet both made it into the one CSS file.
		expect(bundle.css).toContain("--brand");
		expect(bundle.css).toContain(".acme-btn");
		// Self-contained: React is inside, despite the app config externalising it, and
		// no Node-only reference is left for the browser to trip over.
		expect(bundle.js).not.toContain("process.env");
		// Built for production even though this test process is not: a development JSX
		// transform would call a function the production React does not export.
		expect(process.env.NODE_ENV).not.toBe("production");
		expect(bundle.js).not.toContain("jsxDEV");
		const scope: Record<string, unknown> = {};
		new Function("globalThis", bundle.js)(scope);
		const kit = scope.__nfKit as {
			React: { version: string };
			Setup: unknown;
			components: Record<string, unknown>;
		};
		expect(Object.keys(kit.components)).toEqual(["Button", "Card"]);
		expect(typeof kit.components.Button).toBe("function");
		expect(typeof kit.Setup).toBe("function");
		expect(kit.React.version).toMatch(/^\d+\./);
		// Only the kit's own artifacts were produced: one bundle, its stylesheet, metadata.
		expect(await readFile(join(f.root, KIT, "entry.generated.ts"), "utf8")).toContain("__nfKit");
		expect(existsSync(join(f.root, "dist"))).toBe(false);
		const name = result.bundle.replace("dist/", "").replace(".js", "");
		expect(await dist(f.root)).toEqual([`${name}.css`, `${name}.js`, "kit.meta.json"].sort());
	}, 120_000);

	test("a failed update leaves the kit the workspace was using exactly as it was", async () => {
		const f = await linked();
		if (!f) return;
		const first = await buildKit(f.backend, f.workspace, f.options);
		if (!first.ok) throw new Error(`kit build failed:\n${first.log}`);
		const working = await f.bundle();

		// The update the user approved does not compile.
		await writeFile(
			join(f.root, KIT, "kit.json"),
			manifest([{ name: "Missing", from: "@/components/DoesNotExist" }]),
		);
		const broken = await buildKit(f.backend, f.workspace, f.options);
		expect(broken.ok).toBe(false);
		expect(broken.log).toContain("DoesNotExist");
		expect(broken.log.length).toBeLessThan(40_000);
		// Out of date, but still there, still the same bytes, still listing what it has.
		expect(broken.status).toMatchObject({
			state: "stale",
			hash: first.status.hash,
			components: ["Button", "Card"],
		});
		expect(await f.bundle()).toEqual(working);

		// Fixed: the new bundle replaces the old one, which is then removed.
		await writeFile(
			join(f.root, KIT, "kit.json"),
			manifest([{ name: "Button", from: "@/components/Button" }]),
		);
		const fixed = await buildKit(f.backend, f.workspace, f.options);
		if (!fixed.ok) throw new Error(`kit build failed:\n${fixed.log}`);
		expect(fixed.status.components).toEqual(["Button"]);
		expect((await f.bundle()).hash).not.toBe(working.hash);
		const files = await dist(f.root);
		expect(files.filter((file) => file.endsWith(".js"))).toEqual([
			fixed.bundle.replace("dist/", ""),
		]);
	}, 180_000);
});
