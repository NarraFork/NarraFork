import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runPublicationProcess } from "../../scripts/lib/ci-publication-runtime";
import { CI_BUNDLE_LIMIT, CI_DISK_RESERVE } from "../../scripts/lib/ci-release-io";
import { MAX_RELEASE_BUNDLE_BYTES } from "../../scripts/lib/ci-release-restore";
import { MAX_RELEASE_BINARY_BYTES, MAX_RELEASE_PATCH_BYTES } from "../../shared/release-patch";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Run the actual embedded extractor against synthetic ZIP64 entry descriptors.
 * Reaching bundle.open is the acceptance marker: no payload bytes are materialized. */
async function descriptorPreflight(mode: "platform" | "bundle", name: string, size: number) {
	const root = await mkdtemp(join(process.cwd(), ".narrafork/release-budget-"));
	roots.push(root);
	const source = await readFile(
		join(
			process.cwd(),
			`scripts/lib/ci-release-${mode === "platform" ? "build-restore" : "restore"}.ts`,
		),
		"utf8",
	);
	const script = /const EXTRACT(?:_BUNDLE)? = `([\s\S]*?)`;/u.exec(source)?.[1];
	if (!script) throw new Error("Missing production ZIP extraction script");
	const binary = "narrafork-1.2.0-linux-x64";
	const entries =
		mode === "platform"
			? [
					[binary, size],
					[`${binary}.metadata.json`, 1],
				]
			: [
					["manifest.json", 1],
					[`dist/${name}`, size],
				];
	const args =
		mode === "platform"
			? [
					"archive.zip",
					root,
					"platform",
					binary,
					String(MAX_RELEASE_BINARY_BYTES),
					String(CI_DISK_RESERVE),
				]
			: [
					"archive.zip",
					root,
					String(CI_BUNDLE_LIMIT),
					String(MAX_RELEASE_BINARY_BYTES),
					String(MAX_RELEASE_PATCH_BYTES),
					String(CI_DISK_RESERVE),
				];
	return runPublicationProcess(
		"python3",
		[
			"-I",
			"-c",
			`
import json, os, re, resource, shutil, stat, sys, types, zipfile
entries = []
for name, size in json.loads(sys.argv[1]):
    entry = zipfile.ZipInfo(name)
    entry.file_size = size
    entry.external_attr = stat.S_IFREG << 16
    entries.append(entry)
class DescriptorArchive:
    def __init__(self, *args): pass
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def infolist(self): return entries
    def open(self, *args):
        print('accepted-before-payload')
        raise SystemExit(0)
zipfile.ZipFile = DescriptorArchive
shutil.disk_usage = lambda path: types.SimpleNamespace(free=2**50)
os.stat = lambda path: types.SimpleNamespace(st_size=1)
script = sys.argv[2]
sys.argv = ['extract'] + sys.argv[3:]
try:
    exec(script)
except ValueError as error:
    print(str(error))
`,
			JSON.stringify(entries),
			script,
			...args,
		],
		{
			timeoutMs: 10_000,
			maximumOutputBytes: 4096,
		},
	);
}

describe("release producer and ZIP restoration byte budgets", () => {
	test("bundle default/hard budget accounts for archive plus eight full binaries and patches", () => {
		expect(CI_BUNDLE_LIMIT).toBe(96 * 1024 ** 3);
		expect(MAX_RELEASE_BUNDLE_BYTES).toBe(CI_BUNDLE_LIMIT);
		expect(CI_DISK_RESERVE).toBe(4 * 1024 ** 3);
		const expanded = 8 * MAX_RELEASE_BINARY_BYTES + 16 * MAX_RELEASE_PATCH_BYTES + 1024 ** 3;
		expect(2 * expanded).toBeLessThan(CI_BUNDLE_LIMIT);
	});
	for (const mode of ["platform", "bundle"] as const) {
		for (const size of [1024 ** 3 + 1, MAX_RELEASE_BINARY_BYTES])
			test(`${mode} accepts ${size} byte binary descriptor without reading payload`, async () => {
				expect(await descriptorPreflight(mode, "narrafork-1.2.0-linux-x64", size)).toContain(
					"accepted-before-payload",
				);
			});
		test(`${mode} rejects 4GiB plus one byte before payload`, async () => {
			expect(
				await descriptorPreflight(mode, "narrafork-1.2.0-linux-x64", MAX_RELEASE_BINARY_BYTES + 1),
			).toContain("size limit");
		});
	}
	test("bundle patch remains capped at 512MiB", async () => {
		expect(MAX_RELEASE_PATCH_BYTES).toBe(512 * 1024 ** 2);
		const name = "narrafork-1.2.0-linux-x64.from-1.1.0.zstd-patch";
		expect(await descriptorPreflight("bundle", name, MAX_RELEASE_PATCH_BYTES)).toContain(
			"accepted-before-payload",
		);
		expect(await descriptorPreflight("bundle", name, MAX_RELEASE_PATCH_BYTES + 1)).toContain(
			"size limit",
		);
	});
	test("bundle metadata did not inherit the binary limit", async () => {
		expect(
			await descriptorPreflight("bundle", "narrafork-1.2.0-linux-x64.metadata.json", 64 * 1024 + 1),
		).toContain("size limit");
	});
});
