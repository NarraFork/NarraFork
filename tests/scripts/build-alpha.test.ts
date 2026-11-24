import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	closeSync,
	existsSync,
	fstatSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAlpha, selectNextAlphaVersion } from "../../scripts/build-alpha";
import {
	computeBinaryMetadataFromBuffer,
	formatChecksumsReport,
	formatMetadataJson,
	formatSha256Sums,
} from "../../scripts/lib/binary-metadata";

const ROOT = join(import.meta.dir, "../..");
const VERSION = "0.9.11-alpha.1";
const NAME = `narrafork-${VERSION}-linux-x64-baseline`;
const NAMES = [
	NAME,
	`${NAME}.metadata.json`,
	`narrafork-${VERSION}-SHA256SUMS`,
	`narrafork-${VERSION}-checksums.txt`,
];
const dirs: string[] = [];
afterEach(() => {
	for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(mode = "success") {
	const root = mkdtempSync(join(tmpdir(), "narrafork-build-alpha-test-"));
	dirs.push(root);
	mkdirSync(join(root, "scripts"));
	mkdirSync(join(root, "dist"));
	const original = Buffer.from(
		`{\r\n\t"version": "0.9.9",\r\n\t"packageManager": "bun@${Bun.version}",\r\n\t"note": "保留格式"\r\n}\r\n`,
	);
	writeFileSync(join(root, "package.json"), original);
	writeFileSync(
		join(root, "scripts/build-cross-platform.ts"),
		`
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeBinaryMetadata, formatMetadataJson } from ${JSON.stringify(join(ROOT, "scripts/lib/binary-metadata.ts"))};
import { frontendBuildDirectory } from ${JSON.stringify(join(ROOT, "scripts/lib/build-profile.ts"))};
import { writeBuildAggregates } from ${JSON.stringify(join(ROOT, "scripts/lib/ci-build-strict.ts"))};
import { createHelperDistributionDependencies } from ${JSON.stringify(join(ROOT, "shared/helper-distribution.ts"))};
import { CURRENT_RECOVERY_MANIFEST_VERSIONS } from ${JSON.stringify(join(ROOT, "shared/update-identity.ts"))};
const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const mode = process.env.ALPHA_FIXTURE_MODE;
writeFileSync(join(root, "invocation.json"), JSON.stringify({ args: process.argv.slice(2), version: pkg.version }), { flag: "wx" });
if (mode === "external") {
	writeFileSync(join(root, "package.json"), JSON.stringify({ ...pkg, note: "external edit" }));
	process.exit(0);
}
if (mode === "signal") {
	for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
		writeFileSync(join(root, "signal"), signal);
		process.exit(1);
	});
	writeFileSync(join(root, "ready"), "ready");
	setInterval(() => {}, 1000);
	await new Promise(() => {});
}
const frontend = frontendBuildDirectory(root, process.argv.includes("--alpha-frontend"));
mkdirSync(frontend, { recursive: true });
writeFileSync(join(frontend, "index.html"), pkg.version);
const binary = join(root, "dist", "narrafork-" + pkg.version + "-linux-x64-baseline");
writeFileSync(binary, "#!/bin/sh\\necho alpha fixture\\n");
chmodSync(binary, 0o751);
if (mode === "failure") process.exit(23);
const metadata = computeBinaryMetadata(binary, {
	version: pkg.version, platformId: "linux-x64-baseline", target: "bun-linux-x64-baseline",
	commit: "a".repeat(40), repository: "Fork/Custom", buildDate: "2026-11-03T00:00:00.000Z",
	helperDistribution: createHelperDistributionDependencies(),
	recoveryManifestVersions: CURRENT_RECOVERY_MANIFEST_VERSIONS,
});
writeFileSync(binary + ".metadata.json", formatMetadataJson(metadata));
writeBuildAggregates(join(root, "dist"), pkg.version, [metadata]);
if (mode === "corrupt") writeFileSync(binary, "changed after checksums");
`,
	);
	const env = {
		...process.env,
		CI: "0",
		GITHUB_ACTIONS: "0",
		NF_BUILD_RELEASE_CONTEXT: "0",
		ALPHA_FIXTURE_MODE: mode,
	};
	return { root, version: VERSION, archiveDir: join(root, "archive"), env, original };
}

function seedArtifacts(directory: string, version: string) {
	mkdirSync(directory, { recursive: true });
	const name = `narrafork-${version}-linux-x64-baseline`;
	const contents = Buffer.from(`previous ${version}`);
	const metadata = computeBinaryMetadataFromBuffer(name, contents, {
		version,
		platformId: "linux-x64-baseline",
		target: "bun-linux-x64-baseline",
		commit: "a".repeat(40),
		buildDate: "2026-11-03T00:00:00.000Z",
	});
	writeFileSync(join(directory, name), contents);
	chmodSync(join(directory, name), 0o751);
	writeFileSync(join(directory, `${name}.metadata.json`), formatMetadataJson(metadata));
	writeFileSync(join(directory, `narrafork-${version}-SHA256SUMS`), formatSha256Sums([metadata]));
	writeFileSync(
		join(directory, `narrafork-${version}-checksums.txt`),
		formatChecksumsReport(version, [metadata]),
	);
}

function expectRestored(options: ReturnType<typeof fixture>) {
	expect(readFileSync(join(options.root, "package.json"))).toEqual(options.original);
	expect(existsSync(join(options.root, ".build-alpha.lock"))).toBe(false);
}

test("builds once through the strict entry, preserves colliding artifacts and archives all four files", async () => {
	const options = fixture();
	const frontend = join(options.root, "dist", "frontend");
	mkdirSync(frontend);
	writeFileSync(join(frontend, "index.html"), "regular frontend");
	mkdirSync(options.archiveDir);
	for (const directory of [join(options.root, "dist"), options.archiveDir]) {
		for (const name of NAMES) writeFileSync(join(directory, name), `previous ${name}`);
		writeFileSync(join(directory, "older-version"), "keep");
	}
	const oldBinary = openSync(join(options.archiveDir, NAME), "r");
	try {
		const inode = fstatSync(oldBinary).ino;
		await buildAlpha(options);
		expectRestored(options);
		expect(readFileSync(join(frontend, "index.html"), "utf8")).toBe("regular frontend");
		expect(JSON.parse(readFileSync(join(options.root, "invocation.json"), "utf8"))).toEqual({
			args: ["--platform=linux-x64-baseline", "--release-ci", "--alpha-frontend"],
			version: VERSION,
		});
		for (const name of NAMES) {
			expect(readFileSync(join(options.archiveDir, name))).toEqual(
				readFileSync(join(options.root, "dist", name)),
			);
		}
		expect(statSync(join(options.archiveDir, NAME)).mode & 0o777).toBe(0o751);
		expect(statSync(join(options.archiveDir, NAME)).ino).not.toBe(inode);
		expect(readFileSync(oldBinary, "utf8")).toBe(`previous ${NAME}`);
		for (const directory of [join(options.root, "dist"), options.archiveDir]) {
			const backups = readdirSync(directory).filter((name) =>
				name.startsWith(".build-alpha-backup-"),
			);
			expect(backups).toHaveLength(1);
			expect(readdirSync(join(directory, backups[0])).sort()).toEqual([...NAMES].sort());
			expect(readFileSync(join(directory, backups[0], NAME), "utf8")).toBe(`previous ${NAME}`);
			expect(readFileSync(join(directory, "older-version"), "utf8")).toBe("keep");
		}
	} finally {
		closeSync(oldBinary);
	}
});

test("rolls back a partial archive update while preserving existing targets and removing new files", async () => {
	const options = fixture();
	mkdirSync(options.archiveDir);
	const existing = NAMES.filter((name) => !name.endsWith(".metadata.json"));
	for (const name of existing) writeFileSync(join(options.archiveDir, name), `previous ${name}`);
	const inode = statSync(join(options.archiveDir, NAME)).ino;
	let renames = 0;
	await expect(
		buildAlpha({
			...options,
			installArchiveFile: (source, destination) => {
				if (++renames === 1) {
					for (const name of existing) {
						expect(readFileSync(join(options.archiveDir, name), "utf8")).toBe(`previous ${name}`);
					}
				}
				if (renames === 3) throw new Error("fixture archive rename failed");
				renameSync(source, destination);
			},
		}),
	).rejects.toThrow("fixture archive rename failed");
	expect(renames).toBe(3);
	expectRestored(options);
	for (const name of existing) {
		expect(readFileSync(join(options.archiveDir, name), "utf8")).toBe(`previous ${name}`);
	}
	expect(statSync(join(options.archiveDir, NAME)).ino).toBe(inode);
	expect(existsSync(join(options.archiveDir, `${NAME}.metadata.json`))).toBe(false);
	expect(
		readdirSync(options.archiveDir).some((name) => name.startsWith(".build-alpha-stage-")),
	).toBe(false);
});

test.each(["failure", "corrupt"])("restores package and skips archiving after %s", async (mode) => {
	const options = fixture(mode);
	await expect(buildAlpha(options)).rejects.toThrow();
	expectRestored(options);
	expect(existsSync(options.archiveDir)).toBe(false);
});

test("automatic archiving rolls back without overwriting a concurrent artifact", async () => {
	const options = fixture();
	const version = "0.9.10-alpha.1";
	const checksum = `narrafork-${version}-SHA256SUMS`;
	await expect(
		buildAlpha({
			...options,
			version: "auto",
			installArchiveFile: (source, destination) => {
				if (destination === join(options.archiveDir, checksum)) {
					writeFileSync(destination, "concurrent artifact", { flag: "wx" });
				}
				linkSync(source, destination);
			},
		}),
	).rejects.toThrow("EEXIST");
	expectRestored(options);
	expect(readdirSync(options.archiveDir)).toEqual([checksum]);
	expect(readFileSync(join(options.archiveDir, checksum), "utf8")).toBe("concurrent artifact");
});

test("rejects an archive symlink pointing to dist", async () => {
	const options = fixture();
	symlinkSync(join(options.root, "dist"), options.archiveDir, "junction");
	await expect(buildAlpha(options)).rejects.toThrow("ARCHIVE_DIR must differ from dist");
	expectRestored(options);
	expect(existsSync(join(options.root, "invocation.json"))).toBe(false);
});

test.each([
	".build-alpha.lock",
	".build-alpha.lock/archive",
	"dist/frontend/archive",
	"frontend/public/archive",
])("rejects an archive under %s before running the builder", async (archiveDir) => {
	const options = fixture();
	await expect(buildAlpha({ ...options, archiveDir })).rejects.toThrow("build-owned or public");
	expectRestored(options);
	expect(existsSync(join(options.root, "invocation.json"))).toBe(false);
});

test("rejects a new archive below a symlink to the frontend output", async () => {
	const options = fixture();
	const frontend = join(options.root, "dist", "frontend");
	mkdirSync(frontend);
	symlinkSync(frontend, options.archiveDir, "junction");
	await expect(
		buildAlpha({ ...options, archiveDir: join(options.archiveDir, "not-yet-created") }),
	).rejects.toThrow("build-owned or public");
	expectRestored(options);
	expect(existsSync(join(options.root, "invocation.json"))).toBe(false);
});

test("automatically selects the numeric maximum across dist and archive and restores package bytes", async () => {
	const options = fixture();
	const selection = {
		sourceVersion: "0.9.9",
		distDir: join(options.root, "dist"),
		archiveDir: options.archiveDir,
	};
	seedArtifacts(selection.distDir, "0.9.9-alpha.99");
	seedArtifacts(selection.distDir, "0.9.11-alpha.9");
	expect(selectNextAlphaVersion(selection)).toBe("0.9.11-alpha.10");
	seedArtifacts(options.archiveDir, "0.9.11-alpha.10");
	seedArtifacts(join(selection.distDir, ".build-alpha-backup-fixture"), "99.0.0-alpha.1");
	seedArtifacts(options.archiveDir, "9.0.0-alpha.1");
	rmSync(join(options.archiveDir, "narrafork-9.0.0-alpha.1-linux-x64-baseline"));
	expect(selectNextAlphaVersion(selection)).toBe("0.9.11-alpha.11");
	expect(selectNextAlphaVersion({ ...selection, sourceVersion: "0.9.11" })).toBe("0.9.12-alpha.1");
	await buildAlpha({ ...options, version: "auto" });
	expectRestored(options);
	expect(JSON.parse(readFileSync(join(options.root, "invocation.json"), "utf8")).version).toBe(
		"0.9.11-alpha.11",
	);
	for (const directory of [selection.distDir, options.archiveDir]) {
		expect(existsSync(join(directory, "narrafork-0.9.11-alpha.11-linux-x64-baseline"))).toBe(true);
	}
});

test("starts automatic alpha versions from the source package and skips occupied artifact slots", async () => {
	const options = fixture();
	const selection = {
		sourceVersion: "0.9.9",
		distDir: join(options.root, "dist"),
		archiveDir: options.archiveDir,
	};
	expect(selectNextAlphaVersion(selection)).toBe("0.9.10-alpha.1");
	expect(selectNextAlphaVersion({ ...selection, sourceVersion: "0.9.10-alpha.9" })).toBe(
		"0.9.10-alpha.10",
	);
	const partial = join(selection.distDir, "narrafork-0.9.10-alpha.1-linux-x64-baseline");
	writeFileSync(partial, "partial build");
	mkdirSync(options.archiveDir);
	const archivedPartial = join(options.archiveDir, "narrafork-0.9.10-alpha.2-SHA256SUMS");
	writeFileSync(archivedPartial, "partial archive");
	expect(selectNextAlphaVersion(selection)).toBe("0.9.10-alpha.3");
	await buildAlpha({ ...options, version: undefined });
	expectRestored(options);
	expect(readFileSync(partial, "utf8")).toBe("partial build");
	expect(readFileSync(archivedPartial, "utf8")).toBe("partial archive");
	expect(JSON.parse(readFileSync(join(options.root, "invocation.json"), "utf8")).version).toBe(
		"0.9.10-alpha.3",
	);
});

test("accepts an alpha version override", async () => {
	const options = { ...fixture(), version: "0.9.11-alpha.2" };
	await buildAlpha(options);
	expectRestored(options);
	expect(existsSync(join(options.archiveDir, "narrafork-0.9.11-alpha.2-linux-x64-baseline"))).toBe(
		true,
	);
});

test("rejects invalid versions and release environments before invoking the builder", async () => {
	const options = fixture();
	for (const version of [
		"0.9.11",
		"0.9.11-beta.1",
		"0.9.11-alpha.01",
		"../alpha",
		"0.9.11-alpha.1\n",
	]) {
		await expect(buildAlpha({ ...options, version })).rejects.toThrow("valid alpha SemVer");
	}
	await expect(buildAlpha({ ...options, env: { ...options.env, CI: "true" } })).rejects.toThrow(
		"local environment",
	);
	expectRestored(options);
	expect(existsSync(join(options.root, "invocation.json"))).toBe(false);
});

test("leaves an external package edit untouched with the original bytes available for recovery", async () => {
	const options = fixture("external");
	await expect(buildAlpha(options)).rejects.toThrow("original preserved");
	expect(JSON.parse(readFileSync(join(options.root, "package.json"), "utf8")).note).toBe(
		"external edit",
	);
	expect(readFileSync(join(options.root, ".build-alpha.lock/package.json.original"))).toEqual(
		options.original,
	);
	expect(existsSync(options.archiveDir)).toBe(false);
});

test("refuses an existing lock without touching package or invoking a child", async () => {
	const options = fixture();
	mkdirSync(join(options.root, ".build-alpha.lock"));
	await expect(buildAlpha({ ...options, version: "auto" })).rejects.toThrow("locked");
	expect(readFileSync(join(options.root, "package.json"))).toEqual(options.original);
	expect(existsSync(join(options.root, "invocation.json"))).toBe(false);
});

test.each([
	"SIGINT",
	"SIGTERM",
] as const)("forwards %s only to its build child and restores package", async (signal) => {
	const options = fixture("signal");
	const launcher = join(options.root, "launcher.ts");
	writeFileSync(
		launcher,
		`import { buildAlpha } from ${JSON.stringify(join(ROOT, "scripts/build-alpha.ts"))};
try { await buildAlpha(${JSON.stringify({ root: options.root, version: options.version, archiveDir: options.archiveDir })}); }
catch { process.exitCode = 1; }
`,
	);
	const child = Bun.spawn([process.execPath, launcher], {
		cwd: options.root,
		env: options.env,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	try {
		const deadline = Date.now() + 3000;
		while (!existsSync(join(options.root, "ready")) && Date.now() < deadline) await Bun.sleep(10);
		expect(existsSync(join(options.root, "ready"))).toBe(true);
		child.kill(signal);
		expect(await child.exited).not.toBe(0);
		expect(readFileSync(join(options.root, "signal"), "utf8")).toBe(signal);
		expectRestored(options);
		expect(existsSync(options.archiveDir)).toBe(false);
	} finally {
		if (child.exitCode === null) child.kill("SIGTERM");
		await child.exited;
	}
});
