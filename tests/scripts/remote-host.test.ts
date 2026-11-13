import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteHost } from "../../remote-host";
import {
	configureRemoteBootstrap,
	importRemoteFrontend,
	readRemoteFrontendCatalog,
	setRemoteFrontendDisabled,
} from "../../remote-host/store";
import { buildRemoteFrontendArtifact } from "../../scripts/lib/remote-frontend-artifact";
import { REMOTE_FRONTEND_CAPABILITY } from "../../shared/remote-access/application";
import { remoteFrontendArtifactNames } from "../../shared/remote-access/frontend-manifest";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function artifact(root: string, version: string, commit = "a".repeat(40)) {
	const input = join(root, `input-${version}`),
		output = join(root, `package-${version}`);
	await mkdir(join(input, ".vite"), { recursive: true });
	await writeFile(
		join(input, "bootstrap.js"),
		`globalThis.bootstrapVersion=${JSON.stringify(version)};`,
	);
	await writeFile(
		join(input, "mount.js"),
		`export function mount(){return ${JSON.stringify(version)}}`,
	);
	await writeFile(
		join(input, ".vite/manifest.json"),
		JSON.stringify({
			bootstrap: { isEntry: true, name: "bootstrap", file: "bootstrap.js" },
			mount: { isEntry: true, name: "mount", file: "mount.js" },
		}),
	);
	const manifest = await buildRemoteFrontendArtifact({
		root,
		inputDir: input,
		outputDir: output,
		target: {
			repository: "owner/repo",
			version,
			commit,
			capability: REMOTE_FRONTEND_CAPABILITY,
		},
	});
	return {
		manifest,
		manifestPath: join(output, remoteFrontendArtifactNames(version).manifest),
		output,
	};
}
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "nf-remote-host-"));
	roots.push(root);
	return { root, storePath: join(root, "store") };
}
function request(path: string, init?: RequestInit) {
	return new Request(`http://127.0.0.1:8787${path}`, init);
}

describe("immutable multiversion remote host", () => {
	test("imports two exact versions; shell remains pinned and missing chunks/API never return HTML", async () => {
		const f = await fixture(),
			a = await artifact(f.root, "1.2.3"),
			b = await artifact(f.root, "1.2.4");
		await importRemoteFrontend({ storePath: f.storePath, manifestPath: a.manifestPath });
		await importRemoteFrontend({ storePath: f.storePath, manifestPath: b.manifestPath });
		await configureRemoteBootstrap(f.storePath, a.manifest.buildId);
		const host = await createRemoteHost({ storePath: f.storePath, allowLocalhost: true });
		const catalog = await (await host.assetHandler(request("/remote/catalog.json")))?.json();
		expect(catalog.entries).toHaveLength(2);
		const shellResponse = await host.assetHandler(request("/projects/deep-link"));
		expect(shellResponse?.headers.get("content-security-policy")).toContain("media-src blob:;");
		expect(shellResponse?.headers.get("content-security-policy")).not.toContain("media-src 'self'");
		const shell = await shellResponse?.text();
		expect(shell).toContain(`/remote/frontends/${a.manifest.buildId}/bootstrap.js`);
		expect(shell).not.toContain(b.manifest.buildId);
		for (const item of [a, b]) {
			const path = `/remote/frontends/${item.manifest.buildId}/mount.js`,
				response = await host.assetHandler(request(path));
			expect(response?.status).toBe(200);
			expect(response?.headers.get("content-type")).toContain("javascript");
			expect(await response?.text()).toContain(item.manifest.nfVersion);
			const head = await host.assetHandler(request(path, { method: "HEAD" }));
			expect(head?.body).toBeNull();
			expect(head?.headers.get("content-length")).toBe(
				String(item.manifest.files.find((file) => file.path === "mount.js")?.size),
			);
		}
		for (const path of [
			"/api/projects",
			"/ws/narrator",
			"/assets/missing.js",
			`/remote/frontends/${a.manifest.buildId}/missing.js`,
			`/remote/frontends/${a.manifest.buildId}/%2e%2e/secret`,
			"/unknown.css",
		]) {
			expect((await host.assetHandler(request(path)))?.status).toBe(404);
		}
		expect((await host.assetHandler(request("/", { method: "POST" })))?.status).toBe(405);
	}, 15000);
	test("idempotent same-content import never overwrites a build or accepts changed raw manifest", async () => {
		const f = await fixture(),
			a = await artifact(f.root, "1.2.3");
		await importRemoteFrontend({ storePath: f.storePath, manifestPath: a.manifestPath });
		await expect(
			importRemoteFrontend({ storePath: f.storePath, manifestPath: a.manifestPath }),
		).resolves.toEqual(a.manifest);
		const installed = join(f.storePath, "frontends", a.manifest.buildId, "manifest.json"),
			before = await readFile(installed, "utf8");
		await writeFile(a.manifestPath, JSON.stringify(a.manifest));
		await expect(
			importRemoteFrontend({ storePath: f.storePath, manifestPath: a.manifestPath }),
		).rejects.toThrow("IMMUTABLE_CONFLICT");
		expect(await readFile(installed, "utf8")).toBe(before);
		expect((await readdir(f.storePath)).some((name) => name.startsWith(".remote-import-"))).toBe(
			false,
		);
	}, 15000);
	test("disabling immediately changes catalog and serving without choosing a newer bootstrap", async () => {
		const f = await fixture(),
			a = await artifact(f.root, "1.2.3");
		await importRemoteFrontend({ storePath: f.storePath, manifestPath: a.manifestPath });
		const host = await createRemoteHost({
			storePath: f.storePath,
			bootstrapBuildId: a.manifest.buildId,
			allowLocalhost: true,
		});
		await setRemoteFrontendDisabled(f.storePath, a.manifest.buildId, true);
		expect((await readRemoteFrontendCatalog(f.storePath)).entries[0].disabled).toBe(true);
		expect(
			(await host.assetHandler(request(`/remote/frontends/${a.manifest.buildId}/mount.js`)))
				?.status,
		).toBe(404);
		expect((await host.assetHandler(request("/")))?.status).toBe(503);
		await setRemoteFrontendDisabled(f.storePath, a.manifest.buildId, false);
		expect((await host.assetHandler(request("/")))?.status).toBe(200);
	}, 15000);
	test("per-instance HTTPS origins are isolated; unsafe origin and modified installed bytes fail closed", async () => {
		const f = await fixture(),
			a = await artifact(f.root, "1.2.3");
		await importRemoteFrontend({ storePath: f.storePath, manifestPath: a.manifestPath });
		const host = await createRemoteHost({
			storePath: f.storePath,
			bootstrapBuildId: a.manifest.buildId,
			instanceDomain: "remote.example",
		});
		for (const id of ["a".repeat(52), "b".repeat(52)]) {
			const response = await host.assetHandler(new Request(`https://${id}.remote.example/`));
			expect(response?.status).toBe(200);
			expect(response?.headers.get("access-control-allow-origin")).toBeNull();
		}
		expect((await host.assetHandler(new Request("https://evil.remote.example/")))?.status).toBe(
			421,
		);
		const file = join(f.storePath, "frontends", a.manifest.buildId, "mount.js");
		await writeFile(file, "tampered");
		expect(
			(
				await host.assetHandler(
					new Request(
						`https://${"a".repeat(52)}.remote.example/remote/frontends/${a.manifest.buildId}/mount.js`,
					),
				)
			)?.status,
		).toBe(404);
		await expect(
			createRemoteHost({
				storePath: f.storePath,
				bootstrapBuildId: a.manifest.buildId,
				allowLocalhost: true,
			}),
		).rejects.toThrow();
	}, 15000);
	test("same release cannot select two active builds and disabled predecessors remain immutable", async () => {
		const f = await fixture(),
			a = await artifact(f.root, "1.2.3");
		await mkdir(join(f.root, "variant"));
		const b = await artifact(join(f.root, "variant"), "1.2.3", "b".repeat(40));
		await importRemoteFrontend({ storePath: f.storePath, manifestPath: a.manifestPath });
		await expect(
			importRemoteFrontend({ storePath: f.storePath, manifestPath: b.manifestPath }),
		).rejects.toThrow("SELECTION_AMBIGUOUS");
		await setRemoteFrontendDisabled(f.storePath, a.manifest.buildId, true);
		await importRemoteFrontend({ storePath: f.storePath, manifestPath: b.manifestPath });
		const catalog = await readRemoteFrontendCatalog(f.storePath);
		expect(
			catalog.entries.filter((entry) => !entry.disabled).map((entry) => entry.buildId),
		).toEqual([b.manifest.buildId]);
		expect(
			await readFile(join(f.storePath, "frontends", a.manifest.buildId, "mount.js"), "utf8"),
		).toContain("1.2.3");
	}, 15000);
	test("stream concurrency is bounded and cancellation releases capacity without GC cleanup", async () => {
		const f = await fixture(),
			a = await artifact(f.root, "1.2.3");
		await importRemoteFrontend({ storePath: f.storePath, manifestPath: a.manifestPath });
		const host = await createRemoteHost({
				storePath: f.storePath,
				bootstrapBuildId: a.manifest.buildId,
				allowLocalhost: true,
			}),
			path = `/remote/frontends/${a.manifest.buildId}/mount.js`,
			responses: Response[] = [];
		try {
			for (let i = 0; i < 128; i++) {
				const response = await host.assetHandler(request(path));
				expect(response?.status).toBe(200);
				if (response) responses.push(response);
			}
			expect((await host.assetHandler(request(path)))?.status).toBe(503);
			await responses.pop()?.body?.cancel();
			const next = await host.assetHandler(request(path));
			expect(next?.status).toBe(200);
			await next?.body?.cancel();
		} finally {
			for (const response of responses) await response.body?.cancel();
		}
		const stop = new AbortController(),
			response = await host.assetHandler(request(path, { signal: stop.signal }));
		stop.abort();
		await response?.body?.cancel();
		const final = await host.assetHandler(request(path));
		expect(final?.status).toBe(200);
		expect(await final?.text()).toContain("1.2.3");
	}, 15000);
	test("cancellation and single-writer collision do not mutate catalog or delete another lock", async () => {
		const f = await fixture(),
			a = await artifact(f.root, "1.2.3");
		await expect(
			importRemoteFrontend({
				storePath: f.storePath,
				manifestPath: a.manifestPath,
				signal: AbortSignal.abort(new Error("cancelled")),
			}),
		).rejects.toThrow("cancelled");
		await mkdir(f.storePath, { mode: 0o700 });
		const lock = join(f.storePath, ".remote-host.lock");
		await writeFile(lock, "owned elsewhere");
		await expect(
			importRemoteFrontend({ storePath: f.storePath, manifestPath: a.manifestPath }),
		).rejects.toThrow();
		expect(await readFile(lock, "utf8")).toBe("owned elsewhere");
		expect((await readRemoteFrontendCatalog(f.storePath)).entries).toHaveLength(0);
	}, 15000);
});
