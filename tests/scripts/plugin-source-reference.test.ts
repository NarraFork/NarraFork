import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import archiver from "archiver";
import { parsePluginSourceServerArgs } from "../../scripts/plugin-source-server";
import { parsePluginPublishArgs, publishPluginSource } from "../../scripts/publish-plugin-source";
import {
	createPluginSourceFeed,
	PLUGIN_SOURCE_FEED_IDENTITY,
	PLUGIN_SOURCE_FEED_MARKER,
} from "../../server/lib/plugins/source-feed";
import { PluginPackageStore } from "../../server/services/plugin-package-store";
import {
	createPluginSignaturePayload,
	digestPluginDirectory,
} from "../../server/services/plugin-signature";
import { pluginWebsiteUpdateResponseSchema } from "../../shared/plugin-source";

const pluginId = "io.example.legacy-feed";
const origin = "https://plugins.example";
const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await server.stop(true);
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
	const root = await mkdtemp(join(process.cwd(), ".narrafork", "plugin-source-reference-test-"));
	roots.push(root);
	const publicRoot = join(root, "public");
	return { root, publicRoot };
}

async function makeArchive(
	root: string,
	version = "1.0.0",
	code = "throw new Error('plugin-must-not-execute-on-publish');",
) {
	const path = join(root, `${crypto.randomUUID()}.nfplugin`);
	const zip = archiver("zip", { zlib: { level: 9 } });
	const done = pipeline(zip, createWriteStream(path, { flags: "wx" }));
	zip.append(
		JSON.stringify({
			schemaVersion: 1,
			pluginId,
			version,
			displayName: "Legacy source-free plugin",
			engine: { runtime: "bun", hostApi: ">=1.0 <2", rpc: "narrafork.rpc/1" },
			server: { entry: "server/index.js", protocol: "narrafork.rpc/1" },
			permissions: { host: [] },
		}),
		{ name: "manifest.json", date: new Date("2000-01-01T00:00:00Z") },
	);
	zip.append(code, { name: "server/index.js", date: new Date("2000-01-01T00:00:00Z") });
	await zip.finalize();
	await done;
	return path;
}

async function publish(root: string, publicRoot: string, version = "1.0.0", code?: string) {
	const archive = await makeArchive(root, version, code);
	const metadata = await publishPluginSource({
		archive,
		root: publicRoot,
		pluginId,
		publicOrigin: origin,
	});
	return { archive, metadata };
}

async function serve(publicRoot: string) {
	const app = await createPluginSourceFeed({ root: publicRoot, publicOrigin: origin });
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, idleTimeout: 30 });
	servers.push(server);
	return { app, server, base: `http://127.0.0.1:${server.port}` };
}

describe("deployable plugin source reference", () => {
	test("publishes an old source-free plugin without executing its server and serves a strict HTTP feed", async () => {
		const { root, publicRoot } = await fixture();
		const { archive, metadata } = await publish(root, publicRoot);
		expect(metadata.latest?.compatibility?.hostApi).toBe(">=1.0 <2");
		expect(metadata.latest?.version).toBe("1.0.0");
		const { base } = await serve(publicRoot);
		const response = await fetch(
			`${base}/v1/plugins/${pluginId}/latest?pluginId=${pluginId}&currentVersion=0.1.0&hostApiVersion=original-host-value&channel=stable`,
			{ headers: { Host: "attacker.example" } },
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const document = pluginWebsiteUpdateResponseSchema.parse(await response.json());
		expect(document.latest?.artifact.url.startsWith(`${origin}/assets/`)).toBe(true);
		expect(document.latest?.artifact.url).not.toContain("attacker");
		const digest = document.latest?.artifact.sha256 ?? "";
		const asset = await fetch(`${base}/assets/${digest}.nfplugin`);
		expect(asset.status).toBe(200);
		expect(new Uint8Array(await asset.arrayBuffer())).toEqual(
			new Uint8Array(await readFile(archive)),
		);
		expect(asset.headers.get("etag")).toBe(`"${digest}"`);
		const head = await fetch(`${base}/assets/${digest}.nfplugin`, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(head.headers.get("content-length")).toBe(String(document.latest?.artifact.size));
	}, 60000);

	test("a higher version atomically replaces latest; downgrade and changed same-version archives keep it intact", async () => {
		const { root, publicRoot } = await fixture();
		await publish(root, publicRoot, "1.0.0");
		const { metadata } = await publish(root, publicRoot, "1.1.0");
		const latestPath = join(publicRoot, "plugins", pluginId, "latest.json");
		const before = await readFile(latestPath, "utf8");
		const changed = await makeArchive(root, "1.1.0", "console.info('different content');");
		await expect(
			publishPluginSource({ archive: changed, root: publicRoot, pluginId, publicOrigin: origin }),
		).rejects.toThrow("cannot change archive content");
		const older = await makeArchive(root, "1.0.0");
		await expect(
			publishPluginSource({ archive: older, root: publicRoot, pluginId, publicOrigin: origin }),
		).rejects.toThrow("cannot downgrade");
		expect(await readFile(latestPath, "utf8")).toBe(before);
		expect(metadata.latest?.version).toBe("1.1.0");
	}, 60000);

	test("invalid archives, wrong IDs and signature requirements do not publish a latest pointer", async () => {
		const { root, publicRoot } = await fixture();
		const archive = await makeArchive(root);
		await expect(
			publishPluginSource({
				archive,
				root: publicRoot,
				pluginId: "io.example.other",
				publicOrigin: origin,
			}),
		).rejects.toThrow("validation failed");
		await expect(
			publishPluginSource({
				archive,
				root: publicRoot,
				pluginId,
				publicOrigin: origin,
				requireSignature: true,
			}),
		).rejects.toThrow("validation failed");
		const invalid = join(root, "invalid.nfplugin");
		await writeFile(invalid, "not an archive");
		await expect(
			publishPluginSource({ archive: invalid, root: publicRoot, pluginId, publicOrigin: origin }),
		).rejects.toThrow("validation failed");
		const { base } = await serve(publicRoot);
		expect(await (await fetch(`${base}/v1/plugins/${pluginId}/latest`)).json()).toEqual({
			schemaVersion: 1,
			pluginId,
			latest: null,
		});
	}, 60000);

	test("cannot mistake a nonempty installed/configuration directory for a public source", async () => {
		const { root, publicRoot } = await fixture();
		await mkdir(publicRoot);
		await writeFile(join(publicRoot, "settings.json"), "private");
		await expect(
			createPluginSourceFeed({ root: publicRoot, publicOrigin: origin }),
		).rejects.toThrow("not an initialized");
		const archive = await makeArchive(root);
		await expect(
			publishPluginSource({ archive, root: publicRoot, pluginId, publicOrigin: origin }),
		).rejects.toThrow("not an initialized");
	});

	test("no arbitrary paths, release directory listing or private files are available over HTTP", async () => {
		const { root, publicRoot } = await fixture();
		await publish(root, publicRoot);
		await writeFile(join(publicRoot, "settings.json"), "never-public");
		const { base } = await serve(publicRoot);
		for (const path of [
			"/",
			"/settings.json",
			"/public-plugin-source.json",
			"/assets/settings.json",
			"/assets/..%2Fsettings.json",
			"/v1/plugins/..%2Fprivate/latest",
		]) {
			const response = await fetch(`${base}${path}`);
			expect(response.status).not.toBe(200);
			expect(await response.text()).not.toContain("never-public");
		}
		expect(
			(await fetch(`${base}/v1/plugins/${pluginId}/latest?pluginId=io.example.other`)).status,
		).toBe(400);
		expect((await fetch(`${base}/v1/plugins/${pluginId}/latest?channel=preview`)).status).toBe(400);
	}, 60000);

	test("oversized, malformed, foreign and symlinked metadata fail closed without leaking content", async () => {
		const { root, publicRoot } = await fixture();
		const { metadata } = await publish(root, publicRoot);
		const { base } = await serve(publicRoot);
		const latestPath = join(publicRoot, "plugins", pluginId, "latest.json");
		for (const value of [
			"x".repeat(65537),
			"{not-json",
			JSON.stringify({ ...metadata, pluginId: "io.example.other" }),
		]) {
			await writeFile(latestPath, value);
			const response = await fetch(`${base}/v1/plugins/${pluginId}/latest`);
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({ error: "invalid_public_release" });
		}
		await rm(latestPath);
		const outside = join(root, "outside.json");
		await writeFile(outside, JSON.stringify(metadata));
		await symlink(outside, latestPath, "file");
		expect((await fetch(`${base}/v1/plugins/${pluginId}/latest`)).status).toBe(503);
	}, 60000);

	test("CLI requires an explicit publication root, pins its public origin and rejects unknown/duplicate arguments", () => {
		expect(() => parsePluginPublishArgs([])).toThrow("Missing");
		const args = [
			"--archive=plugin.nfplugin",
			"--root=public",
			`--plugin-id=${pluginId}`,
			`--origin=${origin}`,
		];
		expect(parsePluginPublishArgs(args).publicOrigin).toBe(origin);
		expect(() => parsePluginPublishArgs([...args, "--origin=https://other.example"])).toThrow(
			"duplicate",
		);
		expect(() => parsePluginPublishArgs([...args, "--secret=private"])).toThrow("Invalid");
		expect(() => parsePluginSourceServerArgs([])).toThrow("explicit --root");
		expect(parsePluginSourceServerArgs(["--root=public"]).host).toBe("127.0.0.1");
		expect(() => parsePluginSourceServerArgs(["--root=public", "--host=0.0.0.0"])).toThrow(
			"HTTPS origin",
		);
		expect(() =>
			parsePluginSourceServerArgs(["--root=public", "--origin=http://public.example"]),
		).toThrow("HTTPS");
	});

	test("the public marker is exact and is not a substitute for package signature trust", async () => {
		const { publicRoot } = await fixture();
		await mkdir(publicRoot);
		await writeFile(
			join(publicRoot, PLUGIN_SOURCE_FEED_MARKER),
			JSON.stringify({ ...PLUGIN_SOURCE_FEED_IDENTITY, privileged: true }),
		);
		await expect(
			createPluginSourceFeed({ root: publicRoot, publicOrigin: origin }),
		).rejects.toThrow("not an initialized");
	});
});

test("reference download concurrency is bounded and cancellation releases its slot", async () => {
	const { publicRoot } = await fixture();
	await mkdir(publicRoot);
	await writeFile(
		join(publicRoot, PLUGIN_SOURCE_FEED_MARKER),
		JSON.stringify({ kind: "narrafork-plugin-source", schemaVersion: 1 }),
	);
	await mkdir(join(publicRoot, "assets"));
	const digest = "c".repeat(64);
	await writeFile(join(publicRoot, "assets", `${digest}.nfplugin`), new Uint8Array(256 * 1024));
	const app = await createPluginSourceFeed({
		root: publicRoot,
		publicOrigin: origin,
		maxConcurrentDownloads: 1,
	});
	const first = await app.request(`/assets/${digest}.nfplugin`);
	expect(first.status).toBe(200);
	try {
		expect((await app.request(`/assets/${digest}.nfplugin`)).status).toBe(503);
	} finally {
		await first.body?.cancel();
	}
	const next = await app.request(`/assets/${digest}.nfplugin`);
	expect(next.status).toBe(200);
	await next.body?.cancel();
	expect(
		(await app.request(`/v1/plugins/${pluginId}/latest?currentVersion=${"x".repeat(8192)}`)).status,
	).toBe(414);
});

test("republication cannot adopt a symlinked content-addressed asset", async () => {
	const { root, publicRoot } = await fixture();
	const { archive, metadata } = await publish(root, publicRoot);
	const asset = join(publicRoot, "assets", `${metadata.latest?.artifact.sha256}.nfplugin`);
	const latest = join(publicRoot, "plugins", pluginId, "latest.json");
	const before = await readFile(latest, "utf8");
	await rm(asset);
	await symlink(archive, asset, "file");
	await expect(
		publishPluginSource({ archive, root: publicRoot, pluginId, publicOrigin: origin }),
	).rejects.toThrow("not a valid regular file");
	expect(await readFile(latest, "utf8")).toBe(before);
}, 60000);

test("cancelled publication never creates a public release directory", async () => {
	const { root, publicRoot } = await fixture();
	const archive = await makeArchive(root);
	const controller = new AbortController();
	controller.abort(new Error("publication-cancelled"));
	await expect(
		publishPluginSource({
			archive,
			root: publicRoot,
			pluginId,
			publicOrigin: origin,
			signal: controller.signal,
		}),
	).rejects.toThrow("publication-cancelled");
	await expect(readFile(join(publicRoot, PLUGIN_SOURCE_FEED_MARKER))).rejects.toThrow();
});

test("a real signed archive needs an explicitly trusted publisher key and scope", async () => {
	const { root, publicRoot } = await fixture();
	const archive = await makeArchive(root);
	const store = new PluginPackageStore({ root: join(root, "signing-fixture") });
	const installed = await store.install(archive, { updateCurrent: false });
	const digest = await digestPluginDirectory(installed.packagePath);
	const keys = generateKeyPairSync("ed25519");
	const payload = {
		algorithm: "ed25519" as const,
		keyId: "feed-publisher",
		pluginId,
		version: "1.0.0",
		...digest,
	};
	const signature = sign(null, createPluginSignaturePayload(payload), keys.privateKey).toString(
		"base64",
	);
	const signedArchive = join(root, "signed.nfplugin");
	const zip = archiver("zip", { zlib: { level: 9 } });
	const done = pipeline(zip, createWriteStream(signedArchive, { flags: "wx" }));
	zip.directory(installed.packagePath, false);
	zip.append(JSON.stringify({ ...payload, signature }), { name: "signature.json" });
	await zip.finalize();
	await done;
	const keyring = join(root, "public-keys.json");
	const publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
	await writeFile(
		keyring,
		JSON.stringify([{ keyId: "feed-publisher", publicKey, pluginIds: [pluginId] }]),
	);
	const metadata = await publishPluginSource({
		archive: signedArchive,
		root: publicRoot,
		pluginId,
		publicOrigin: origin,
		keyring,
		requireSignature: true,
	});
	expect(metadata.latest?.version).toBe("1.0.0");
	const latest = join(publicRoot, "plugins", pluginId, "latest.json");
	const before = await readFile(latest, "utf8");
	await writeFile(
		keyring,
		JSON.stringify([{ keyId: "feed-publisher", publicKey, pluginIds: ["io.example.foreign"] }]),
	);
	await expect(
		publishPluginSource({
			archive: signedArchive,
			root: publicRoot,
			pluginId,
			publicOrigin: origin,
			keyring,
			requireSignature: true,
		}),
	).rejects.toThrow("validation failed");
	expect(await readFile(latest, "utf8")).toBe(before);
}, 60000);
