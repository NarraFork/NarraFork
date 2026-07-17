import { afterEach, describe, expect, test } from "bun:test";
import {
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginPackageStore } from "@server/services/plugin-package-store";

const fixturePackage = fileURLToPath(
	new URL("../../fixtures/plugins/packages/valid-package", import.meta.url),
);
const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-store-"));
	tempRoots.push(root);
	return root;
}

async function copyFixture(root: string, name = "package"): Promise<string> {
	const destination = join(root, name);
	await cp(fixturePackage, destination, { recursive: true });
	return destination;
}

async function mutateManifest(
	packagePath: string,
	update: (manifest: Record<string, unknown>) => void,
): Promise<void> {
	const manifestPath = join(packagePath, "manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
	update(manifest);
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function makeZipSlipArchive(root: string): Promise<string> {
	const sourceRoot = join(root, "zip-source");
	const evilRoot = join(sourceRoot, "evil");
	await mkdir(evilRoot, { recursive: true });
	await writeFile(join(evilRoot, "escape.txt"), "escape");
	const archive = join(root, "escape.nfplugin");
	const process = Bun.spawn(["zip", "-q", archive, "../zip-source/evil/escape.txt"], {
		cwd: sourceRoot,
		stdout: "ignore",
		stderr: "pipe",
	});
	const exitCode = await process.exited;
	if (exitCode !== 0)
		throw new Error(
			`zip failed: ${new TextDecoder().decode(await new Response(process.stderr).arrayBuffer())}`,
		);
	return archive;
}

afterEach(async () => {
	for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("PluginPackageStore", () => {
	test("installs a valid package into an immutable hash directory and updates current atomically", async () => {
		const root = await makeTempRoot();
		const store = new PluginPackageStore(root);
		const result = await store.install(fixturePackage);

		expect(result.pluginId).toBe("com.example.hello");
		expect(result.version).toBe("1.0.0");
		expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
		expect(result.packagePath).toBe(
			join(root, "packages", result.pluginId, result.version, result.hash),
		);
		expect(result.alreadyInstalled).toBe(false);
		expect((await store.readCurrent()).plugins[result.pluginId]).toEqual({
			version: result.version,
			hash: result.hash,
		});
		expect((await readdir(join(root, "staging"))).length).toBe(0);
	});

	test("rejects archive path traversal before extraction", async () => {
		const root = await makeTempRoot();
		const archiveRoot = await makeTempRoot();
		const archive = await makeZipSlipArchive(archiveRoot);
		const store = new PluginPackageStore(root);

		await expect(store.install(archive)).rejects.toThrow(/escapes|absolute|invalid/i);
		expect(await Bun.file(join(root, "current.json")).exists()).toBe(false);
		expect((await readdir(join(root, "staging"))).length).toBe(0);
	});

	test("rejects a source symlink that escapes the package root", async () => {
		if (process.platform === "win32") return;
		const root = await makeTempRoot();
		const sourceRoot = await copyFixture(root, "source");
		const outside = join(root, "outside.txt");
		await writeFile(outside, "outside");
		await symlink(outside, join(sourceRoot, "escape.txt"));

		await expect(new PluginPackageStore(root).install(sourceRoot)).rejects.toThrow(/symlink/i);
	});

	test("rejects unknown and malformed manifests without executing the entry", async () => {
		const root = await makeTempRoot();
		const unknown = await copyFixture(root, "unknown");
		await mutateManifest(unknown, (manifest) => {
			manifest.unknownField = "must be rejected";
		});
		await expect(new PluginPackageStore(root).install(unknown)).rejects.toThrow(/manifest/i);

		const malformed = await copyFixture(root, "malformed");
		await writeFile(join(malformed, "manifest.json"), "not json");
		await expect(new PluginPackageStore(root).install(malformed)).rejects.toThrow(/manifest/i);
	});

	test("deduplicates an identical hash without overwriting the existing package", async () => {
		const root = await makeTempRoot();
		const store = new PluginPackageStore(root);
		const first = await store.install(fixturePackage);
		const second = await store.install(fixturePackage);

		expect(second.hash).toBe(first.hash);
		expect(second.packagePath).toBe(first.packagePath);
		expect(second.alreadyInstalled).toBe(true);
		expect(
			(await readdir(join(root, "packages", first.pluginId, first.version))).filter(
				(name) => name === first.hash,
			),
		).toHaveLength(1);
	});

	test("keeps the old current pointer when an atomic current update fails", async () => {
		const root = await makeTempRoot();
		const firstStore = new PluginPackageStore(root);
		const first = await firstStore.install(fixturePackage);
		const nextPackage = await copyFixture(root, "next");
		await mutateManifest(nextPackage, (manifest) => {
			manifest.version = "1.0.1";
		});
		const failingStore = new PluginPackageStore({
			root,
			renameCurrent: async () => {
				throw new Error("simulated pointer failure");
			},
		});

		await expect(failingStore.install(nextPackage)).rejects.toThrow(/atomically update/i);
		expect((await firstStore.readCurrent()).plugins[first.pluginId]).toEqual({
			version: first.version,
			hash: first.hash,
		});
		expect((await lstat(first.packagePath)).isDirectory()).toBe(true);
	});

	test("serializes shared current updates, enforces CAS, and cleans stale staging", async () => {
		const root = await makeTempRoot();
		const first = new PluginPackageStore(root);
		const second = new PluginPackageStore(root);
		const pointerA = { version: "1.0.0", hash: "a".repeat(64) };
		const pointerB = { version: "2.0.0", hash: "b".repeat(64) };
		await Promise.all([
			first.setCurrent("com.example.a", pointerA, { expectedCurrent: null }),
			second.setCurrent("com.example.b", pointerB, { expectedCurrent: null }),
		]);
		expect((await first.readCurrent()).plugins).toEqual({
			"com.example.a": pointerA,
			"com.example.b": pointerB,
		});
		await expect(
			first.setCurrent("com.example.a", pointerB, {
				expectedCurrent: { version: "9.0.0", hash: "c".repeat(64) },
			}),
		).rejects.toThrow(/pointer changed/i);
		await mkdir(join(root, "staging", "stale"), { recursive: true });
		await writeFile(join(root, "staging", "stale", "leftover"), "stale");
		expect(await first.cleanupStaging()).toBe(1);
		expect(await Bun.file(join(root, "staging", "stale", "leftover")).exists()).toBe(false);
	});

	test("does not execute the server entry while installing", async () => {
		const root = await makeTempRoot();
		const result = await new PluginPackageStore(root).install(fixturePackage);
		expect(result.manifest.server?.entry).toBe("server/index.js");
	});
});
