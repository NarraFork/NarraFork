import { describe, expect, test } from "bun:test";
import { REMOTE_FRONTEND_CAPABILITY, type RemoteBackendIdentity } from "./application";
import {
	parseRemoteFrontendCatalog,
	type RemoteFrontendCatalog,
	type RemoteFrontendCatalogEntry,
	remoteFrontendManifestPath,
	selectRemoteFrontend,
} from "./frontend-catalog";
import {
	computeRemoteFrontendBuildId,
	isRemoteFrontendAssetPath,
	parseRemoteFrontendManifest,
	type RemoteFrontendManifest,
	remoteFrontendArtifactNames,
} from "./frontend-manifest";

const digest = "a".repeat(64);
const manifest: RemoteFrontendManifest = {
	schemaVersion: 1,
	repository: "NarraFork/NarraFork",
	nfVersion: "0.9.12",
	sourceCommit: "b".repeat(40),
	buildId: digest,
	capability: { ...REMOTE_FRONTEND_CAPABILITY },
	entry: "app.js",
	bootstrap: "bootstrap.js",
	css: ["assets/app.css"],
	files: [
		{ path: "app.js", size: 10, sha256: digest },
		{ path: "bootstrap.js", size: 20, sha256: digest },
		{ path: "assets/app.css", size: 5, sha256: digest },
	],
	archive: { name: "narrafork-0.9.12-remote-frontend.tar.gz", size: 35, sha256: digest },
};
const backend: RemoteBackendIdentity = {
	nfVersion: "0.9.12",
	sourceCommit: "b".repeat(40),
	repository: manifest.repository,
	bootstrapAbi: 1,
	apiEpoch: 1,
	wireVersion: 2,
	capabilities: ["projects"],
};
function entry(nfVersion = "0.9.12", buildId = digest): RemoteFrontendCatalogEntry {
	return {
		buildId,
		nfVersion,
		repository: manifest.repository,
		bootstrapAbi: 1,
		apiEpoch: 1,
		wireVersion: 2,
		manifestPath: remoteFrontendManifestPath(buildId),
		manifestSha256: digest,
		disabled: false,
	};
}
function catalog(entries = [entry()]): RemoteFrontendCatalog {
	return { schemaVersion: 1, bootstrapAbi: 1, entries };
}

describe("remote frontend immutable static manifest", () => {
	test("parses the declared static file set and derives only exact-version filenames", () => {
		expect(parseRemoteFrontendManifest(manifest)).toEqual(manifest);
		expect(remoteFrontendArtifactNames("0.9.12")).toEqual({
			archive: manifest.archive.name,
			manifest: "narrafork-0.9.12-remote-frontend.manifest.json",
		});
	});
	test("rejects path authorities, traversal, encoding and cross-platform file ambiguity", () => {
		for (const path of [
			"/root.js",
			"../evil.js",
			"assets/../app.js",
			"assets//app.js",
			"C:/app.js",
			"assets\\app.js",
			"%2e%2e/app.js",
			"https://elsewhere/app.js",
			"app.js?token=x",
			"app.js#secret",
			"CON",
			"assets/NUL.txt",
			"assets/trailing.",
		])
			expect(isRemoteFrontendAssetPath(path)).toBe(false);
		expect(isRemoteFrontendAssetPath("assets/route-$id-abc.js")).toBe(true);
	});
	test("requires known capabilities and pins archive identity", () => {
		for (const value of [
			{ ...manifest, host: "https://elsewhere.invalid" },
			{ ...manifest, capability: { ...manifest.capability, wireVersion: 1 } },
			{ ...manifest, sourceCommit: "main" },
			{
				...manifest,
				archive: { ...manifest.archive, name: "narrafork-0.9.13-remote-frontend.tar.gz" },
			},
			{ ...manifest, archive: { ...manifest.archive, size: 128 * 1024 * 1024 + 1 } },
		])
			expect(() => parseRemoteFrontendManifest(value)).toThrow();
	});
	test("rejects undeclared entry, duplicated names, links and file/directory collisions", () => {
		for (const value of [
			{ ...manifest, entry: "missing.js" },
			{ ...manifest, files: [...manifest.files, manifest.files[0]] },
			{ ...manifest, files: [...manifest.files, { ...manifest.files[0], path: "APP.js" }] },
			{ ...manifest, files: [...manifest.files, { path: "assets", size: 1, sha256: digest }] },
			{
				...manifest,
				files: [
					...manifest.files,
					{ path: "linked.js", size: 1, sha256: digest, link: "../../secret" },
				],
			},
			{
				...manifest,
				files: [...manifest.files, { path: "manifest.json", size: 1, sha256: digest }],
			},
		])
			expect(() => parseRemoteFrontendManifest(value)).toThrow();
	});
	test("build identity binds source and file bytes without a self-hash cycle", async () => {
		const first = await computeRemoteFrontendBuildId(manifest);
		expect(first).toMatch(/^[a-f0-9]{64}$/);
		expect(
			await computeRemoteFrontendBuildId({ ...manifest, files: [...manifest.files].reverse() }),
		).toBe(first);
		expect(await computeRemoteFrontendBuildId({ ...manifest, nfVersion: "0.9.13" })).not.toBe(
			first,
		);
		expect(
			await computeRemoteFrontendBuildId({ ...manifest, sourceCommit: "c".repeat(40) }),
		).not.toBe(first);
		expect(
			await computeRemoteFrontendBuildId({
				...manifest,
				files: manifest.files.map((file) => ({ ...file, sha256: "c".repeat(64) })),
			}),
		).not.toBe(first);
	});
});

describe("hosted multi-version selection", () => {
	test("selects each backend's exact release rather than the newest entry", () => {
		const older = entry("0.9.12");
		const newer = entry("0.9.13", "c".repeat(64));
		const available = parseRemoteFrontendCatalog(catalog([newer, older]));
		expect(selectRemoteFrontend(available, backend)).toEqual(older);
		expect(selectRemoteFrontend(available, { ...backend, nfVersion: "0.9.13" })).toEqual(newer);
		expect(() => selectRemoteFrontend(available, { ...backend, nfVersion: "0.9.14" })).toThrow(
			"NOT_AVAILABLE",
		);
	});
	test("disabled exact versions do not fall back to another build or release", () => {
		expect(() =>
			selectRemoteFrontend(
				catalog([{ ...entry(), disabled: true }, entry("0.9.13", "c".repeat(64))]),
				backend,
			),
		).toThrow("DISABLED");
	});
	test("permits replacing a disabled compatible build but never two active choices", () => {
		const replacement = entry("0.9.12", "c".repeat(64));
		expect(
			selectRemoteFrontend(catalog([{ ...entry(), disabled: true }, replacement]), backend),
		).toEqual(replacement);
		expect(() => parseRemoteFrontendCatalog(catalog([entry(), replacement]))).toThrow("AMBIGUOUS");
	});
	test("rejects manifest cross-origin, wrong build directory and unexpected authority", () => {
		for (const value of [
			catalog([{ ...entry(), manifestPath: "https://evil.invalid/manifest.json" }]),
			catalog([{ ...entry(), manifestPath: `/remote/frontends/${"b".repeat(64)}/manifest.json` }]),
			{ ...catalog(), latest: digest },
			catalog([entry(), entry()]),
		])
			expect(() => parseRemoteFrontendCatalog(value)).toThrow();
	});
	test("repository and protocol epochs are never substituted", () => {
		expect(() =>
			selectRemoteFrontend(catalog([{ ...entry(), repository: "fork/nf" }]), backend),
		).toThrow("NOT_AVAILABLE");
		expect(() => selectRemoteFrontend(catalog([{ ...entry(), wireVersion: 3 }]), backend)).toThrow(
			"NOT_AVAILABLE",
		);
	});
});
