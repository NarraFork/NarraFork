import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { buildPluginUi, pluginUiSharedRuntime } from "@frontend/build/plugin-ui-bun";
import { buildPluginUiRuntime } from "@frontend/build/plugin-ui-runtime";
import { PLUGIN_UI_RUNTIME_VERSION } from "@frontend/plugin-runtime/contract";

let temporary: string;
type RuntimeModule = Record<string, unknown>;
interface TestContext {
	__nfPluginRuntime: {
		version: number;
		React: RuntimeModule;
		ReactDOMClient: RuntimeModule;
		MantineCore: RuntimeModule;
		MantineHooks: RuntimeModule;
		JsxRuntime: RuntimeModule;
	};
	pluginPanel: Record<string, unknown> & { element: { type: unknown } };
	result: unknown[];
}
let host: TestContext;
beforeAll(async () => {
	temporary = await mkdtemp(join(tmpdir(), "nf-plugin-ui-test-"));
	const bundle = await buildPluginUiRuntime();
	host = {} as TestContext;
	runInNewContext(bundle.js, host);
}, 60_000);
afterAll(async () => {
	await rm(temporary, { recursive: true, force: true });
});

async function buildSource(source: string) {
	const file = join(temporary, "input.tsx");
	await writeFile(file, source);
	return buildPluginUi(file);
}

describe("Bun shared UI adapter", () => {
	for (const development of [false, true]) {
		it(`executes an IIFE with real host identities (${development ? "development" : "production"})`, async () => {
			const output = await buildPluginUi(join(import.meta.dir, "fixtures/plugin-panel.tsx"), {
				development,
			});
			const code = await output.text();
			const context = { __nfPluginRuntime: host.__nfPluginRuntime } as TestContext;
			runInNewContext(code, context);
			const panel = context.pluginPanel;
			const runtime = host.__nfPluginRuntime;
			expect(runtime.version).toBe(PLUGIN_UI_RUNTIME_VERSION);
			expect(panel.React).toBe(runtime.React.default);
			expect(panel.useState).toBe(runtime.React.useState);
			expect(panel.createRoot).toBe(runtime.ReactDOMClient.createRoot);
			expect(panel.Button).toBe(runtime.MantineCore.Button);
			expect(panel.useDisclosure).toBe(runtime.MantineHooks.useDisclosure);
			expect(panel.jsx).toBe(runtime.JsxRuntime.jsx);
			expect(panel.element.type).toBe(runtime.MantineCore.Button);
			expect(panel.mode).toBe("production");
			expect(code.length).toBeLessThan(20_000);
			expect(code).not.toContain("react-stack-bottom-frame");
			expect(code).not.toContain("node_modules");
			expect(code).not.toMatch(/^\s*(?:export|import)\s/m);
			for (const runtime of [undefined, {}, { version: 999 }]) {
				expect(() => runInNewContext(code, { __nfPluginRuntime: runtime })).toThrow(
					"Plugin UI runtime unavailable or incompatible",
				);
			}
		});
	}

	it("runs the standalone CLI with bounded diagnostics", async () => {
		const destination = join(temporary, "panel.iife.js");
		const script = join(import.meta.dir, "../../../scripts/build-plugin-ui.ts");
		const result = spawnSync(
			process.execPath,
			[script, join(import.meta.dir, "fixtures/plugin-panel.tsx"), destination, "--development"],
			{ encoding: "utf8", timeout: 20_000, maxBuffer: 16_384 },
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("CSS must be declared separately");
		const context = { __nfPluginRuntime: host.__nfPluginRuntime } as TestContext;
		runInNewContext(await readFile(destination, "utf8"), context);
		expect(context.pluginPanel.useState).toBe(host.__nfPluginRuntime.React.useState);
		const invalid = spawnSync(process.execPath, [script], {
			encoding: "utf8",
			timeout: 20_000,
			maxBuffer: 16_384,
		});
		expect(invalid.status).toBe(1);
		expect(invalid.stderr).toContain("Usage:");
	});
	it("rejects oversized plugin output", async () => {
		await expect(
			buildSource(`globalThis.large = ${JSON.stringify("x".repeat(2 * 1024 * 1024))};`),
		).rejects.toThrow("2 MiB");
	});
	it("rejects development-only React exports absent from the production host", async () => {
		await expect(buildSource('import { act } from "react"; globalThis.act = act;')).rejects.toThrow(
			"act",
		);
	});
	it("rejects nonexistent named exports at build time", async () => {
		await expect(
			buildSource('import { notARealExport } from "react"; globalThis.value = notARealExport;'),
		).rejects.toThrow("notARealExport");
	});
	for (const path of [
		"react/jsx-dev-runtime",
		"react-dom",
		"react-dom/server",
		"react/compiler-runtime",
		"@mantine/core/internal",
		"@mantine/notifications",
	]) {
		it(`rejects unsupported shared module ${path}`, async () => {
			await expect(buildSource(`import ${JSON.stringify(path)};`)).rejects.toThrow(
				"Unsupported shared UI module",
			);
		});
	}
	for (const path of ["./panel.css", "@mantine/core/styles.css"]) {
		it(`requires manifest CSS instead of ${path}`, async () => {
			await expect(buildSource(`import ${JSON.stringify(path)};`)).rejects.toThrow("manifest");
		});
	}
	it("rejects extra emitted assets", async () => {
		await writeFile(join(temporary, "asset.png"), "test");
		await expect(
			buildSource('import image from "./asset.png"; globalThis.image = image;'),
		).rejects.toThrow("one IIFE");
	});
	it("works as a reusable BunPlugin with re-exports and namespace imports", async () => {
		await writeFile(join(temporary, "reexport.ts"), 'export { useState } from "react";');
		const file = join(temporary, "consumer.ts");
		await writeFile(
			file,
			'import * as React from "react"; import { useState } from "./reexport"; globalThis.result = [React.useState, useState];',
		);
		const result = await Bun.build({
			entrypoints: [file],
			format: "iife",
			target: "browser",
			plugins: [pluginUiSharedRuntime()],
		});
		expect(result.success).toBe(true);
		const context = { __nfPluginRuntime: host.__nfPluginRuntime } as TestContext;
		const output = result.outputs[0];
		if (!output) throw new Error("Missing bundle output");
		runInNewContext(await output.text(), context);
		expect(context.result[0]).toBe(host.__nfPluginRuntime.React.useState);
		expect(context.result[1]).toBe(host.__nfPluginRuntime.React.useState);
	});
});
