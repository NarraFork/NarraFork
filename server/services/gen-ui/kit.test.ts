import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalBackend } from "@server/lib/agent/execution/local-backend";
import type { WorkspaceContext } from "@shared/workspace-context";
import { buildKit, type KitBuildRun, readKit, readKitBundle } from "./kit";
import { kitFileSha256, resetKitSigningKeyForTest, signKitFields } from "./kit-signature";

const KIT = ".narrafork/gen_ui/kit";
// Worktrees may resolve dependencies from the main checkout rather than their own root.
const REPO_MODULES = resolve(fileURLToPath(import.meta.resolve("vite/package.json")), "../..");
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Builds are signed with a key in the NarraFork home: keep it out of the developer's.
const savedHome = process.env.NARRAFORK_HOME;
let signingHome = "";
beforeAll(async () => {
	signingHome = await mkdtemp(join(tmpdir(), "nf-ui-kit-home-"));
	process.env.NARRAFORK_HOME = signingHome;
	resetKitSigningKeyForTest();
});
afterAll(async () => {
	if (savedHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = savedHome;
	resetKitSigningKeyForTest();
	await rm(signingHome, { recursive: true, force: true });
});

async function project(files: Record<string, string>, contextKey = "workspace") {
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
		contextKey,
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
	const runs: KitBuildRun[] = [];
	/**
	 * Stands in for Vite: while the build runs, writes `js` where the build says its bundle
	 * goes (nothing when null), and `extra` files beside it.
	 */
	const vite =
		(js: string | null, extra: Record<string, string> = {}, code = 0) =>
		async (run: KitBuildRun) => {
			runs.push(run);
			await mkdir(dirname(run.bundlePath), { recursive: true });
			if (js !== null) await writeFile(run.bundlePath, js);
			for (const [name, content] of Object.entries(extra))
				await writeFile(join(dirname(run.bundlePath), name), content);
			return { code, log: `vite exited ${code}` };
		};
	const build = (runCommand: ReturnType<typeof vite>) =>
		buildKit(backend, workspace, { ...options, runCommand });
	const record = async (js: string, extra: Record<string, string> = {}) => {
		const result = await build(vite(js, extra));
		if (!result.ok) throw new Error(`build failed: ${result.log}`);
		return result;
	};
	return { root, backend, workspace, options, written, runs, read, bundle, vite, build, record };
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

	test("a build that exits 0 without writing its bundle records nothing", async () => {
		const f = await project({ [`${KIT}/kit.json`]: manifest([{ name: "A", from: "./a" }]) });
		const missing = await f.build(f.vite(null));
		expect(missing.ok).toBe(false);
		expect(missing.bundle).toMatch(/^dist\/kit-[0-9a-f]{12}\.js$/);
		expect(missing.log).toContain(`did not produce ${missing.bundle}`);
		expect((await f.read()).status.state).toBe("unbuilt");
		// The seam ran in place of the backend, in the Vite root, for this bundle path.
		expect(f.runs).toHaveLength(1);
		expect(f.runs[0]?.cwd).toBe(f.root);
		expect(f.runs[0]?.bundlePath).toBe(
			join(f.root, KIT, ".staging", missing.bundle.replace(/^dist\//, "")),
		);
		// A bundle under any OTHER name is not this build's output.
		await writeFile(join(f.root, KIT, "dist/kit.js"), "stale");
		expect((await f.build(f.vite(null))).ok).toBe(false);
		// Writing it and failing is a failure.
		expect((await f.build(f.vite("globalThis.__nfKit = {};", {}, 1))).ok).toBe(false);
		expect((await f.read()).status.state).toBe("unbuilt");
		await expect(f.bundle()).rejects.toThrow("no built component kit");
	});

	test("a file already at the bundle path that the build does not write is not adopted", async () => {
		const f = await project({ [`${KIT}/kit.json`]: manifest([{ name: "A", from: "./a" }]) });
		const { bundle } = await f.build(f.vite(null));
		// The agent puts its own bundle exactly where this build looks.
		await writeFile(join(f.root, KIT, bundle), "globalThis.__nfKit = { planted: true };");
		const result = await f.build(f.vite(null));
		expect(result.ok).toBe(false);
		expect(result.bundle).toBe(bundle);
		expect(result.log).toContain("did not produce");
		expect((await f.read()).status).toEqual({ state: "unbuilt", components: [] });
		await expect(f.bundle()).rejects.toThrow("no built component kit");
		expect(existsSync(join(f.root, KIT, "dist/kit.meta.json"))).toBe(false);
	});

	test("what the build writes is signed, recorded and served", async () => {
		const f = await project({ [`${KIT}/kit.json`]: manifest([{ name: "A", from: "./a" }]) });
		const { bundle } = await f.build(f.vite(null));
		await writeFile(join(f.root, KIT, "dist/kit.js"), "stale");
		f.written.length = 0;
		// An older Vite names the stylesheet style.css; it is still found.
		const recorded = await f.build(f.vite("globalThis.__nfKit = {};", { "style.css": ".a{}" }));
		expect(recorded.ok).toBe(true);
		expect(recorded.bundle).toBe(bundle);
		expect(recorded.status).toMatchObject({ state: "ready", components: ["A"] });
		// Every file the build writes went through the write authorization.
		const publishedJs = recorded.bundle.replace(/^dist\//, "");
		const publishedCss = publishedJs.replace(/\.js$/, ".css");
		expect(f.written.map((path) => path.replaceAll("\\", "/").split("/").pop())).toEqual([
			"entry.generated.ts",
			"vite.kit.config.mjs",
			".staging",
			"dist",
			publishedJs,
			publishedCss,
			"kit.meta.json",
		]);
		const meta = JSON.parse(await readFile(join(f.root, KIT, "dist/kit.meta.json"), "utf8"));
		expect(meta.signature).toMatch(/^[0-9a-f]{64}$/);
		expect(meta.workspace).toBe("workspace");
		expect(meta.jsSha256).toBe(
			new Bun.CryptoHasher("sha256").update("globalThis.__nfKit = {};").digest("hex"),
		);
		// Older Vite emits style.css; what is signed is this build's own stylesheet name.
		expect(meta.css).toBe(publishedCss);
		expect(existsSync(join(f.root, KIT, "dist/style.css"))).toBe(false);
		expect((await f.read()).status).toMatchObject({ state: "ready", hash: recorded.status.hash });
		expect(await f.bundle()).toMatchObject({
			js: "globalThis.__nfKit = {};",
			css: ".a{}",
			hasSetup: false,
			hash: recorded.status.hash as string,
		});
		// The bundle left over from before this scheme is garbage once a build commits.
		expect(await dist(f.root)).not.toContain("kit.js");
	});

	test("a bundle or stylesheet changed after the build is not what gets served", async () => {
		const f = await project({ [`${KIT}/kit.json`]: manifest([{ name: "A", from: "./a" }]) });
		const built = await f.record("globalThis.__nfKit = {};", { "style.css": ".a{}" });
		const js = join(f.root, KIT, built.bundle);
		const cssName = built.bundle.replace(/^dist\//, "").replace(/\.js$/, ".css");
		const original = await readFile(js);
		const flipped = Buffer.from(original);
		flipped[0] = (flipped[0] as number) ^ 1;
		await writeFile(js, flipped);
		// Status trusts the signature and does not re-read the bundle. Serving does.
		expect((await f.read()).status.hash).toBe(built.status.hash as string);
		await expect(f.bundle()).rejects.toThrow("no built component kit");
		// Put back, it is the signed bundle again; the stylesheet is covered as well.
		await writeFile(js, original);
		expect((await f.bundle()).js).toBe("globalThis.__nfKit = {};");
		await writeFile(join(f.root, KIT, "dist", cssName), "body{background:url(//x)}");
		await expect(f.bundle()).rejects.toThrow("no built component kit");
	});

	test("hand-written metadata is never served, whatever bundle it names", async () => {
		const f = await project({
			[`${KIT}/kit.json`]: manifest([{ name: "A", from: "./a" }]),
			[`${KIT}/dist/kit.js`]: "globalThis.__nfKit = { planted: true };",
			[`${KIT}/dist/kit-0123456789ab.js`]: "globalThis.__nfKit = { planted: true };",
		});
		const unsigned = {
			version: 1,
			fingerprint: "f",
			hash: "h1",
			builtAt: "2026-01-01T00:00:00.000Z",
			components: ["A"],
			hasSetup: false,
			css: null,
		};
		const metaPath = join(f.root, KIT, "dist/kit.meta.json");
		for (const meta of [
			// Recorded before bundles were named after their inputs: means kit.js.
			unsigned,
			{ ...unsigned, js: "kit-0123456789ab.js", generation: 1 },
			{
				...unsigned,
				js: "kit-0123456789ab.js",
				generation: 1,
				jsSha256: "0".repeat(64),
				cssSha256: "",
				signature: "0".repeat(64),
			},
		]) {
			await writeFile(metaPath, JSON.stringify(meta));
			expect((await f.read()).status).toEqual({ state: "unbuilt", components: [] });
			await expect(f.bundle()).rejects.toThrow("no built component kit");
		}
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
		const attempt = await f.build(f.vite(null));
		expect(attempt.ok).toBe(false);
		expect(attempt.bundle).not.toBe(first.bundle);
		expect(attempt.status).toMatchObject({ state: "ready", hash: first.status.hash });
		expect((await f.bundle()).js).toBe("first");
		// A retry of the failed attempt looks in the same place.
		expect((await f.build(f.vite(null))).bundle).toBe(attempt.bundle);
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
		const result = await f.build(f.vite(null));
		expect(result.ok).toBe(false);
		await writeFile(
			join(f.root, KIT, "kit.json"),
			JSON.stringify({ version: 1, root: "../..", components: [{ name: "A", from: "./a" }] }),
		);
		await expect(f.build(f.vite(null))).rejects.toThrow("root");
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
			await expect(f.build(f.vite(null))).rejects.toThrow("outside the workspace");
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
		const result = await f.build(f.vite(null));
		expect(result.log).toContain("did not produce");
	});

	test("a stylesheet the build does not write is not signed, wherever it was planted", async () => {
		const f = await project({ [`${KIT}/kit.json`]: manifest([{ name: "A", from: "./a" }]) });
		await mkdir(join(f.root, KIT, ".staging"), { recursive: true });
		await mkdir(join(f.root, KIT, "dist"), { recursive: true });
		await writeFile(join(f.root, KIT, ".staging/style.css"), ".planted{}");
		await writeFile(join(f.root, KIT, "dist/style.css"), ".planted{}");
		const recorded = await f.record("globalThis.__nfKit = {};");
		expect((await f.bundle()).css).toBe("");
		const meta = JSON.parse(await readFile(join(f.root, KIT, "dist/kit.meta.json"), "utf8"));
		expect(meta.css).toBeNull();
		expect(existsSync(join(f.root, KIT, "dist/style.css"))).toBe(false);
		expect(recorded.bundle.endsWith(".js")).toBe(true);
	});

	test("a planted stylesheet is not adopted when the build writes a different one", async () => {
		const f = await project({ [`${KIT}/kit.json`]: manifest([{ name: "A", from: "./a" }]) });
		const { bundle } = await f.build(f.vite(null));
		const cssName = bundle.replace(/^dist\//, "").replace(/\.js$/, ".css");
		await mkdir(join(f.root, KIT, ".staging"), { recursive: true });
		await writeFile(join(f.root, KIT, ".staging/style.css"), ".planted{}");
		await writeFile(join(f.root, KIT, "dist/style.css"), ".planted{}");
		await writeFile(join(f.root, KIT, "dist", cssName), ".planted{}");
		const recorded = await f.record("globalThis.__nfKit = {};", { "style.css": ".built{}" });
		expect(recorded.bundle).toBe(bundle);
		expect((await f.bundle()).css).toBe(".built{}");
		expect(await readFile(join(f.root, KIT, "dist", cssName), "utf8")).toBe(".built{}");
		expect(existsSync(join(f.root, KIT, "dist/style.css"))).toBe(false);
	});

	test("a failed rebuild leaves the stylesheet the workspace is serving", async () => {
		const f = await project({ [`${KIT}/kit.json`]: manifest([{ name: "A", from: "./a" }]) });
		const js = "globalThis.__nfKit = {};";
		const css = ".served{color:red}";
		const fields = {
			version: 1 as const,
			workspace: "workspace",
			fingerprint: "f",
			hash: "h1",
			builtAt: "2026-01-01T00:00:00.000Z",
			components: ["A"],
			hasSetup: false,
			js: "kit-0123456789ab.js",
			css: "style.css",
			generation: 4,
			jsSha256: kitFileSha256(new TextEncoder().encode(js)),
			cssSha256: kitFileSha256(new TextEncoder().encode(css)),
		};
		await mkdir(join(f.root, KIT, "dist"), { recursive: true });
		await writeFile(join(f.root, KIT, "dist", fields.js), js);
		await writeFile(join(f.root, KIT, "dist/style.css"), css);
		await writeFile(
			join(f.root, KIT, "dist/kit.meta.json"),
			JSON.stringify({ ...fields, signature: await signKitFields(fields) }),
		);
		expect((await f.bundle()).css).toBe(css);
		// Vite before 6 would overwrite dist/style.css. The command writes staging instead.
		const failed = await f.build(f.vite("nope", { "style.css": ".pwned{}" }, 1));
		expect(failed.ok).toBe(false);
		expect(await readFile(join(f.root, KIT, "dist/style.css"), "utf8")).toBe(css);
		expect(await f.bundle()).toMatchObject({ js, css });
	});

	test("a signed kit copied into another workspace is not served", async () => {
		const source = await project(
			{ [`${KIT}/kit.json`]: manifest([{ name: "A", from: "./a" }]) },
			"alpha",
		);
		await source.record("globalThis.__nfKit = {};");
		const dest = await project(
			{ [`${KIT}/kit.json`]: manifest([{ name: "A", from: "./a" }]) },
			"beta",
		);
		await mkdir(join(dest.root, KIT, "dist"), { recursive: true });
		for (const file of await readdir(join(source.root, KIT, "dist"))) {
			await writeFile(
				join(dest.root, KIT, "dist", file),
				await readFile(join(source.root, KIT, "dist", file)),
			);
		}
		expect((await dest.read()).status).toEqual({ state: "unbuilt", components: [] });
		await expect(dest.bundle()).rejects.toThrow("no built component kit");
		const metaPath = join(dest.root, KIT, "dist/kit.meta.json");
		const copied = JSON.parse(await readFile(metaPath, "utf8")) as { workspace: string };
		copied.workspace = "beta";
		await writeFile(metaPath, JSON.stringify(copied));
		expect((await dest.read()).status.state).toBe("unbuilt");
		expect((await source.bundle()).js).toBe("globalThis.__nfKit = {};");
	});

	test("a second build is refused while the first is still signing", async () => {
		const f = await project({ [`${KIT}/kit.json`]: manifest([{ name: "A", from: "./a" }]) });
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = f.build(async (run) => {
			await gate;
			await mkdir(dirname(run.bundlePath), { recursive: true });
			await writeFile(run.bundlePath, "globalThis.__nfKit = {};");
			return { code: 0, log: "held" };
		});
		try {
			await expect(f.build(f.vite("other"))).rejects.toThrow("Another component kit build");
			release();
			const result = await first;
			expect(result.ok).toBe(true);
			expect((await f.bundle()).js).toBe("globalThis.__nfKit = {};");
		} finally {
			release();
			await first.catch(() => {});
		}
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
		expect(result.command).toStartWith("bun --bun ");
		expect(result.command).toContain("node_modules/vite/bin/vite.js");
		expect(result.command).toContain(`${KIT}/vite.kit.config.mjs`);
		expect(result.status).toMatchObject({ state: "ready", components: ["Button", "Card"] });
		// What Vite wrote is signed, and only the signed bytes are served.
		const meta = JSON.parse(await readFile(join(f.root, KIT, "dist/kit.meta.json"), "utf8"));
		expect(meta.signature).toMatch(/^[0-9a-f]{64}$/);
		expect(meta.cssSha256).toMatch(/^[0-9a-f]{64}$/);
		const bundle = await f.bundle();
		expect(bundle.hash).toBe(result.status.hash as string);
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
