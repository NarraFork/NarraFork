import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "@server/lib/agent/execution/local-backend";
import { compilePreview } from "@server/services/intelligent-ui/compiler";
import { collectSources } from "@server/services/intelligent-ui/files";
import puppeteer, { type Page } from "puppeteer-core";

function appSource(label: string): string {
	return `import React, { useState } from "react";
import { Button, TextInput } from "@mantine/core";
import "./style.css";
export default function App() {
	const [count, setCount] = React.useState(0);
	const [name, setName] = useState("");
	return <form id="app" onSubmit={event => event.preventDefault()}>
		<p id="version">${label}</p>
		<TextInput label="Name" id="name" placeholder="Your name" value={name} onChange={event => setName(event.currentTarget.value)} />
		<Button id="increment" onClick={() => setCount(count + 1)}>Count {count}</Button>
	</form>;
}`;
}

interface FixtureControls {
	theme(value: "light" | "dark"): void;
	mount(value: boolean): void;
	share(value: boolean): void;
	logout(): void;
	login(): void;
	switchAccount(): void;
	tokens(css: string): void;
}
declare global {
	interface Window {
		previewFixture: FixtureControls;
	}
}

async function clickText(page: Page, text: string) {
	await page.waitForFunction(
		(label) =>
			[...document.querySelectorAll("button")].some((button) => button.textContent === label),
		{},
		text,
	);
	await page.evaluate(
		(label) =>
			[...document.querySelectorAll("button")]
				.find((button) => button.textContent === label)
				?.click(),
		text,
	);
}
async function previewFrame(page: Page) {
	const element = await page.waitForSelector('iframe[title="Demo preview"]');
	const frame = await element?.contentFrame();
	if (!frame) throw new Error("Missing preview frame");
	await frame.waitForSelector("#increment", { timeout: 5000 });
	return frame;
}

const browserTest = process.env.BROWSER_EXECUTABLE ? test : test.skip;
browserTest(
	"actual opaque iframe: default Mantine controls, live theme, refresh, close, logout and public summary",
	async () => {
		const [fixture, runtime] = await Promise.all([
			Bun.build({
				entrypoints: [new URL("./preview.browser.fixture.tsx", import.meta.url).pathname],
				target: "browser",
				define: { "process.env.NODE_ENV": '"production"' },
			}),
			Bun.build({
				entrypoints: [new URL("../../plugin-runtime/vendor.ts", import.meta.url).pathname],
				target: "browser",
				format: "iife",
				minify: true,
				define: { "process.env.NODE_ENV": '"production"' },
			}),
		]);
		if (!fixture.success || !runtime.success)
			throw new AggregateError([...fixture.logs, ...runtime.logs], "Browser fixture build failed");
		const text = async (build: typeof fixture, extension: string) => {
			const output = build.outputs.find((file) => file.path.endsWith(extension));
			if (!output) throw new Error(`Missing ${extension} output`);
			return output.text();
		};
		const [script, css, runtimeJs, runtimeCss] = await Promise.all([
			text(fixture, ".js"),
			text(fixture, ".css"),
			text(runtime, ".js"),
			text(runtime, ".css"),
		]);
		const temporary = await mkdtemp(join(tmpdir(), "nf-file-ui-browser-"));
		const root = await realpath(temporary);
		const directory = join(root, ".narrafork", "intelligent_ui", "demo-123");
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "style.css"), "#app { max-width: 600px; }");
		const backend = new LocalBackend();
		let builds = 0;
		let failBuild = false;
		let navigateImmediately = false;
		const received: { path: string; token: string | null; cookie: string | null }[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const path = new URL(request.url).pathname;
				received.push({
					path,
					token: request.headers.get("Authorization"),
					cookie: request.headers.get("Cookie"),
				});
				if (path.includes("/api/")) {
					builds++;
					if (failBuild)
						return Response.json({ error: "App.tsx:7: broken source" }, { status: 422 });
					// Exercise the real file reader/compiler, not a hand-written JS preview result.
					const navigation = navigateImmediately
						? `location.replace(${JSON.stringify(new URL("/escape", request.url).href)});\n`
						: "";
					await writeFile(join(directory, "App.tsx"), navigation + appSource(`Fresh ${builds}`));
					const sources = await collectSources(
						backend,
						directory,
						async (path) => path,
						request.signal,
					);
					const bundle = await compilePreview(sources, request.signal);
					return Response.json({
						...bundle,
						directory,
						entry: "App.tsx",
						files: sources.map((source) => source.path),
					});
				}
				if (path === "/empty-navigation") return new Response(null, { status: 204 });
				if (path === "/escape")
					return new Response("<p>external destination</p>", {
						headers: { "Content-Type": "text/html" },
					});
				const assets: Record<string, [string, string]> = {
					"/nf/fixture.js": [script, "text/javascript"],
					"/nf/fixture.css": [css, "text/css"],
					"/nf/plugin-runtime/vendor.js": [runtimeJs, "text/javascript"],
					"/nf/plugin-runtime/vendor.css": [runtimeCss, "text/css"],
				};
				if (assets[path])
					return new Response(assets[path][0], { headers: { "Content-Type": assets[path][1] } });
				return new Response(
					'<!doctype html><html><head><base href="/nf/"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>',
					{
						headers: {
							"Content-Type": "text/html",
							"Set-Cookie": "fixture_secret=private; Path=/",
						},
					},
				);
			},
		});
		let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
		try {
			browser = await puppeteer.launch({
				executablePath: process.env.BROWSER_EXECUTABLE,
				headless: true,
				args: ["--no-sandbox"],
				timeout: 15000,
			});
			const page = await browser.newPage();
			page.setDefaultTimeout(5000);
			await page.setViewport({ width: 1100, height: 900 });
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(String(error)));
			await page.goto(`http://127.0.0.1:${server.port}/nf/`, {
				waitUntil: "networkidle0",
				timeout: 15000,
			});
			expect(builds).toBe(0);
			expect(await page.$("iframe")).toBeNull();
			expect(received.some((request) => request.path.includes("/plugin-runtime/"))).toBe(false);
			await clickText(page, "Open preview");
			let frame = await previewFrame(page);
			expect(builds).toBe(1);
			expect(await frame.$eval("#version", (node) => node.textContent)).toBe("Fresh 1");
			expect(
				await frame.$eval("#increment", (node) => getComputedStyle(node).backgroundColor),
			).not.toBe("rgba(0, 0, 0, 0)");
			expect(await frame.$eval("#name", (node) => getComputedStyle(node).borderTopStyle)).toBe(
				"solid",
			);
			expect(await frame.evaluate(() => document.documentElement.dataset.mantineColorScheme)).toBe(
				"dark",
			);
			expect(await page.$eval("iframe", (node) => node.getAttribute("sandbox"))).toBe(
				"allow-scripts",
			);
			expect(
				await frame.evaluate(() => {
					try {
						return parent.document.title;
					} catch {
						return "opaque";
					}
				}),
			).toBe("opaque");
			expect(
				await frame.evaluate(() =>
					fetch("/nf/api/leak").then(
						() => "allowed",
						() => "blocked",
					),
				),
			).toBe("blocked");
			expect(
				await frame.evaluate(() => (globalThis as unknown as { narrafork?: unknown }).narrafork),
			).toBeUndefined();
			for (const request of received.filter((entry) => entry.path.includes("/plugin-runtime/"))) {
				expect(request.token).toBeNull();
				expect(request.cookie).toBeNull();
			}
			expect(received.find((entry) => entry.path.includes("/api/"))?.token).toBe(
				"Bearer fixture-private-token",
			);

			await frame.click("#increment");
			await frame.type("#name", "keep this input");
			await page.evaluate(() => window.previewFixture.theme("light"));
			await frame.waitForFunction(
				() => document.documentElement.dataset.mantineColorScheme === "light",
			);
			expect(await frame.$eval("#name", (node) => (node as HTMLInputElement).value)).toBe(
				"keep this input",
			);
			await page.evaluate(() => {
				window.previewFixture.theme("dark");
				document.documentElement.dataset.oled = "true";
				window.previewFixture.tokens(
					':root[data-oled="true"] { --mantine-color-body: #000000; --mantine-primary-color-filled: #aa3399; }',
				);
			});
			await frame.waitForFunction(
				() => getComputedStyle(document.body).backgroundColor === "rgb(0, 0, 0)",
			);
			expect(
				await frame.evaluate(() =>
					getComputedStyle(document.documentElement).getPropertyValue("--nf-color-primary").trim(),
				),
			).toBe("#aa3399");
			await page.evaluate(() =>
				window.previewFixture.tokens(':root[data-oled="true"] { --mantine-color-body: #010203; }'),
			);
			await frame.waitForFunction(
				() => getComputedStyle(document.body).backgroundColor === "rgb(1, 2, 3)",
			);
			expect(await frame.$eval("#increment", (node) => node.textContent)).toBe("Count 1");
			expect(builds).toBe(1);

			await clickText(page, "Refresh from files");
			frame = await previewFrame(page);
			await frame.waitForFunction(
				() => document.getElementById("version")?.textContent === "Fresh 2",
			);
			expect(await frame.$eval("#name", (node) => (node as HTMLInputElement).value)).toBe("");
			expect(await frame.$eval("#increment", (node) => node.textContent)).toBe("Count 0");
			await page.keyboard.press("Escape");
			await page.waitForFunction(() => !document.querySelector("iframe"));
			await clickText(page, "Open preview");
			frame = await previewFrame(page);
			expect(builds).toBe(3);
			await page.evaluate(() => window.previewFixture.logout());
			await page.waitForFunction(() => !document.querySelector("iframe"));
			await page.evaluate(() => window.previewFixture.login());
			await clickText(page, "Open preview");
			await previewFrame(page);
			await page.evaluate(() => window.previewFixture.switchAccount());
			await page.waitForFunction(() => !document.querySelector("iframe"));
			await page.evaluate(() => window.previewFixture.login());
			await clickText(page, "Open preview");
			await previewFrame(page);
			await page.evaluate(() => window.previewFixture.mount(false));
			await page.waitForFunction(() => !document.querySelector("iframe"));
			await page.evaluate(() => {
				window.previewFixture.mount(true);
				window.previewFixture.share(true);
			});
			await page.waitForFunction(() =>
				document.body.textContent?.includes("Shared preview unavailable"),
			);
			const beforeShare = builds;
			expect(await page.$("button")).toBeNull();
			expect(await page.$("iframe")).toBeNull();
			expect(builds).toBe(beforeShare);

			await page.evaluate(() => window.previewFixture.share(false));
			failBuild = true;
			await clickText(page, "Open preview");
			await page.waitForFunction(() =>
				document.body.textContent?.includes("App.tsx:7: broken source"),
			);
			expect(await page.$("iframe")).toBeNull();
			await page.keyboard.press("Escape");
			failBuild = false;
			await page.setViewport({ width: 390, height: 844 });
			await clickText(page, "Open preview");
			frame = await previewFrame(page);
			expect(await page.$('[role="dialog"]')).not.toBeNull();
			expect(await page.evaluate(() => document.body.textContent)).toContain(
				"Do not preview secret files",
			);
			// A sandbox is not an outbound firewall: even 204 navigation can send data
			// without committing another document or firing a second load event.
			let destination = `http://127.0.0.1:${server.port}/empty-navigation`;
			let navigationResponse = page.waitForResponse(destination);
			await frame.evaluate((url) => location.replace(url), destination);
			expect((await navigationResponse).status()).toBe(204);
			expect(await page.$("iframe")).not.toBeNull();
			destination = `http://127.0.0.1:${server.port}/escape`;
			navigationResponse = page.waitForResponse(destination);
			await frame.evaluate((url) => location.replace(url), destination);
			await navigationResponse;
			await page.waitForFunction(() => !document.querySelector("iframe"));
			await page.waitForFunction(() =>
				document.body.textContent?.includes("a request may already have been sent"),
			);
			await page.keyboard.press("Escape");
			// Also exercise top-level navigation before the srcdoc's first load completes.
			navigateImmediately = true;
			navigationResponse = page.waitForResponse(destination);
			await clickText(page, "Open preview");
			await navigationResponse;
			await page.waitForFunction(() =>
				document.body.textContent?.includes("a request may already have been sent"),
			);
			expect(await page.$("iframe")).toBeNull();
			for (const request of received.filter((entry) => entry.path === "/escape"))
				expect(request.token).toBeNull();
			expect(errors).toEqual([]);
		} finally {
			await browser?.close();
			server.stop(true);
			await rm(temporary, { recursive: true, force: true });
		}
	},
	60000,
);
