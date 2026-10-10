import { describe, expect, test } from "bun:test";
import {
	createHelperDistributionDependencies,
	getHelperAssetName,
	HELPER_BINARY_MAX_BYTES,
	HELPER_CATALOG_VERSION,
	HELPER_PLATFORMS,
	HELPER_RELEASE_TAG,
	HELPER_TOOL_VERSIONS,
	HELPER_TOOLS,
	helperSourceIdentity,
	normalizeHelperSource,
	parseExecutorReleaseManifest,
	parseHelperDistributionDependencies,
	parseHelperManifest,
} from "./helper-distribution";
import { EXECUTOR_PLATFORMS, executorPublishedFilename } from "./remote-executor";

function catalog() {
	return {
		schemaVersion: 1,
		repository: "fork/repo",
		tag: HELPER_RELEASE_TAG,
		commit: "a".repeat(40),
		catalogVersion: HELPER_CATALOG_VERSION,
		files: HELPER_TOOLS.flatMap((tool) =>
			HELPER_PLATFORMS.map((platform) => ({
				tool,
				platform,
				toolVersion: HELPER_TOOL_VERSIONS[tool],
				name: getHelperAssetName(tool, platform),
				size: 256,
				sha256: "b".repeat(64),
			})),
		),
		licenses: [{ name: "LICENSE-ripgrep.txt", size: 100, sha256: "c".repeat(64) }],
	};
}
describe("pure helper distribution contract", () => {
	test("declared build dependencies bind the immutable catalog and exact executor release", () => {
		const value = createHelperDistributionDependencies("0.8.3");
		expect(parseHelperDistributionDependencies(value, "0.8.3")).toEqual(value);
		expect(() => parseHelperDistributionDependencies(value, "0.8.4")).toThrow();
		expect(() => createHelperDistributionDependencies("latest")).toThrow();
		expect(() => createHelperDistributionDependencies("0.8.3", 2)).toThrow();
		expect(() =>
			parseHelperDistributionDependencies({ ...value, url: "https://evil.test" }),
		).toThrow();
		expect(() =>
			parseHelperDistributionDependencies({
				...value,
				executor: { ...value.executor, tag: "executor-latest" },
			}),
		).toThrow();
	});
	test("fixed catalog has exactly twelve original filenames", () => {
		expect(parseHelperManifest(catalog(), { repository: "fork/repo" }).files).toHaveLength(12);
		expect(getHelperAssetName("rg", "windows-x64")).toBe("rg-win64.exe");
		expect(getHelperAssetName("zstd", "darwin-arm64")).toBe("zstd-darwin-arm64");
	});
	for (const [name, mutate] of [
		[
			"foreign repo",
			(value: ReturnType<typeof catalog>) => {
				value.repository = "other/repo";
			},
		],
		[
			"wrong tag",
			(value: ReturnType<typeof catalog>) => {
				value.tag = "helpers-latest";
			},
		],
		[
			"short commit",
			(value: ReturnType<typeof catalog>) => {
				value.commit = "abc123";
			},
		],
		[
			"duplicate platform/tool",
			(value: ReturnType<typeof catalog>) => {
				value.files[1] = { ...value.files[0] };
			},
		],
		[
			"missing platform",
			(value: ReturnType<typeof catalog>) => {
				value.files.pop();
			},
		],
		[
			"oversized binary",
			(value: ReturnType<typeof catalog>) => {
				value.files[0].size = HELPER_BINARY_MAX_BYTES + 1;
			},
		],
		[
			"wrong version",
			(value: ReturnType<typeof catalog>) => {
				value.files[0].toolVersion = "0.0.1" as (typeof value.files)[number]["toolVersion"];
			},
		],
		[
			"path injection",
			(value: ReturnType<typeof catalog>) => {
				value.files[0].name = "../rg";
			},
		],
		[
			"no licenses",
			(value: ReturnType<typeof catalog>) => {
				value.licenses = [];
			},
		],
	] as const)
		test(`rejects ${name}`, () => {
			const value = catalog();
			mutate(value);
			expect(() => parseHelperManifest(value, { repository: "fork/repo" })).toThrow();
		});
	test("rejects external URL fields, unknown platforms, oversized JSON and commit mismatch", () => {
		const value = catalog();
		expect(() =>
			parseHelperManifest({ ...value, url: "https://evil.test/a" }, { repository: "fork/repo" }),
		).toThrow();
		expect(() =>
			parseHelperManifest(
				{
					...value,
					files: value.files.map((entry, i) =>
						i ? entry : { ...entry, platform: "linux-riscv64" },
					),
				},
				{ repository: "fork/repo" },
			),
		).toThrow();
		expect(() =>
			parseHelperManifest(value, { repository: "fork/repo", commit: "d".repeat(40) }),
		).toThrow();
		expect(() =>
			parseHelperManifest(
				{ ...value, padding: "é".repeat(64 * 1024) },
				{ repository: "fork/repo" },
			),
		).toThrow();
	});
	test("source normalization defaults to GitHub and never consults retained personal server", () => {
		expect(normalizeHelperSource({ serverUrl: "https://personal.example" }).source).toBe("github");
		expect(
			helperSourceIdentity(
				normalizeHelperSource({ source: "github", githubRepository: "Fork/Repo" }),
			),
		).toBe("github:fork/repo");
		expect(() =>
			normalizeHelperSource({
				source: "update-server",
				serverUrl: "https://user:secret@example.com",
			}),
		).toThrow();
	});
	test("executor wrapper requires exact version, protocol and all six platforms", () => {
		const version = "0.5.24";
		const value = {
			schemaVersion: 1,
			repository: "fork/repo",
			tag: `executor-v${version}`,
			commit: "a".repeat(40),
			licenses: catalog().licenses,
			manifest: {
				version,
				protocolVersion: 1,
				releasedAt: "2026-01-01T00:00:00Z",
				platforms: Object.fromEntries(
					EXECUTOR_PLATFORMS.map((platform) => [
						platform,
						{
							filename: executorPublishedFilename(version, platform),
							size: 256,
							sha256: "b".repeat(64),
						},
					]),
				),
			},
		};
		const expected = { repository: "fork/repo", version, protocolVersion: 1 };
		expect(parseExecutorReleaseManifest(value, expected).manifest.version).toBe(version);
		expect(() => parseExecutorReleaseManifest(value, { ...expected, version: "0.5.25" })).toThrow();
		expect(() =>
			parseExecutorReleaseManifest(value, { ...expected, protocolVersion: 2 }),
		).toThrow();
		expect(() =>
			parseExecutorReleaseManifest(
				{
					...value,
					manifest: {
						...value.manifest,
						platforms: { ...value.manifest.platforms, "linux-riscv64": {} },
					},
				},
				expected,
			),
		).toThrow();
	});
});
