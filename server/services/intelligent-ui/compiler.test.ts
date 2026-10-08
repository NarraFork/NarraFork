import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ReactDefault, * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import { compilePreview } from "./compiler";

const signal = () => new AbortController().signal;
function sources(files: Record<string, string>) {
	return Object.entries(files).map(([path, source]) => ({
		path,
		bytes: new TextEncoder().encode(source),
	}));
}
function compile(app: string, files: Record<string, string> = {}) {
	return compilePreview(sources({ "App.tsx": app, ...files }), signal());
}

describe("memory-only UI compiler", () => {
	test("uses the runtime's exact React default and named exports without mounting", async () => {
		const result = await compile(
			'import React, {useState} from "react"; globalThis.observed=[React,useState]; export default function App(){return <div>Continue with NF</div>}',
		);
		const context = {
			__nfPluginRuntime: { React, JsxRuntime },
			observed: [] as unknown[],
			__nfIntelligentUiApp: undefined as unknown,
		};
		runInNewContext(result.js, context);
		expect(context.observed).toEqual([ReactDefault, React.useState]);
		expect(typeof context.__nfIntelligentUiApp).toBe("function");
		expect(result.js).not.toContain("createRoot(");
	});
	test("binds Mantine, Mantine hooks and ReactDOMClient to the built-in runtime", async () => {
		const result = await compile(
			'import {Button} from "@mantine/core"; import {useDisclosure} from "@mantine/hooks"; import {createRoot} from "react-dom/client"; globalThis.observed=[Button,useDisclosure,createRoot]; export default ()=>null;',
		);
		const Button = () => null,
			useDisclosure = () => null,
			createRoot = () => null;
		const context = {
			__nfPluginRuntime: {
				MantineCore: { Button },
				MantineHooks: { useDisclosure },
				ReactDOMClient: { createRoot },
			},
			observed: [] as unknown[],
		};
		runInNewContext(result.js, context);
		expect(context.observed).toEqual([Button, useDisclosure, createRoot]);
	});
	test("resolves relative TSX, TS, JS, JSON, CSS and static image imports", async () => {
		const result = await compile(
			'import {Part} from "./parts/Part"; import "./style.css"; export default Part;',
			{
				"parts/Part.tsx":
					'import label from "../label.json"; import {n} from "./n"; import image from "../image.png"; export function Part(){return <img alt={label.text+n} src={image}/>}',
				"parts/n.ts": 'export {n} from "./data.js";',
				"parts/data.js": "export const n=42;",
				"label.json": '{"text":"hello"}',
				"style.css": '@import "./parts/other.css"; .test { color:red; background:url(image.png) }',
				"parts/other.css": ".other{padding:2px}",
				"image.png": "image-bytes",
			},
		);
		expect(result.css).toContain("data:image/png;base64,");
		expect(result.css).toContain("padding: 2px");
		expect(result.js).toContain("hello");
		expect(result.js).toContain("data:image/png;base64,");
	});
	test.each([
		"../outside",
		"/etc/passwd",
		"lodash",
		"react-dom",
		"@mantine/core/secret",
		"https://example.com/x.js",
		"bun:sqlite",
	])("rejects unauthorized import %s", async (path) => {
		await expect(
			compile(`import x from ${JSON.stringify(path)}; export default x;`),
		).rejects.toThrow();
	});
	test("rejects missing built-in named exports at compilation", async () => {
		await expect(
			compile('import {notARealReactExport} from "react";export default notARealReactExport;'),
		).rejects.toThrow();
	});
	test("rejects macro attributes before any source can execute", async () => {
		await expect(
			compile('import {run} from "./macro.ts" with {type:"macro"}; export default run();', {
				"macro.ts": 'throw new Error("THIS_MUST_NOT_EXECUTE"); export function run(){return null}',
			}),
		).rejects.toThrow("Import attributes");
		await expect(
			compile('import {run} from "./macro.ts" assert {type:"macro"}; export default run();', {
				"macro.ts": "export function run(){return null}",
			}),
		).rejects.toThrow("Import attributes");
	});
	test("does not reject ordinary with/assert text or identifiers", async () => {
		await expect(
			compile(
				'// with assert macro:\nconst assert = true; export default ()=> <div>{assert ? "with" : "assert"}</div>;',
			),
		).resolves.toHaveProperty("js");
	});
	test("rejects dynamic import and require specifiers", async () => {
		await expect(
			compile("const file=globalThis.path; export default ()=>import(file);"),
		).rejects.toThrow("Dynamic import");
		await expect(
			compile("const file=globalThis.path; export default ()=>require(file);"),
		).rejects.toThrow("Dynamic require");
	});
	test("enforces compiler input and amplified output byte limits", async () => {
		await expect(compile("x".repeat(512 * 1024 + 1))).rejects.toThrow("input exceeds");
		await expect(compile(`export default ()=> <>${"<i/>".repeat(125000)}</>`)).rejects.toThrow(
			"4 MiB output limit",
		);
	}, 20_000);
	test("cancellation releases the compiler slot", async () => {
		const controller = new AbortController();
		const pending = compilePreview(
			sources({ "App.tsx": "export default ()=>null" }),
			controller.signal,
		);
		// Let the cached built-in inventory resolve so the worker is actually running.
		await Promise.resolve();
		controller.abort(new Error("cancelled"));
		await expect(pending).rejects.toThrow("cancelled");
		await expect(compile("export default ()=>null")).resolves.toHaveProperty("js");
	});
	test("compiled binary works outside the repository without runtime node_modules", async () => {
		const root = await mkdtemp(join(tmpdir(), "nf-ui-compiled-"));
		try {
			const entry = join(root, "smoke.ts");
			const binary = join(root, "preview-smoke");
			const empty = join(root, "empty");
			await mkdir(empty);
			await writeFile(
				entry,
				`import {compilePreview} from ${JSON.stringify(join(import.meta.dir, "compiler.ts"))}; const result=await compilePreview([{path:'App.tsx',bytes:new TextEncoder().encode('export default ()=> <div>binary</div>')}],new AbortController().signal); if(!result.js.includes('__nfIntelligentUiApp')) throw new Error('bad build'); console.log('compiled-preview-ok');`,
			);
			const built = await Bun.build({
				entrypoints: [entry],
				target: "bun",
				compile: { outfile: binary },
			});
			expect(built.success).toBe(true);
			const process = Bun.spawn([binary], {
				cwd: empty,
				stdout: "pipe",
				stderr: "pipe",
				timeout: 15_000,
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(process.stdout).text(),
				new Response(process.stderr).text(),
				process.exited,
			]);
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			expect(stdout).toContain("compiled-preview-ok");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);
});
