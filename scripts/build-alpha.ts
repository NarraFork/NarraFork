import {
	chmodSync,
	copyFileSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHelperDistributionDependencies } from "../shared/helper-distribution";
import { CURRENT_RECOVERY_MANIFEST_VERSIONS } from "../shared/update-identity";
import {
	type BinaryMetadata,
	formatChecksumsReport,
	formatSha256Sums,
} from "./lib/binary-metadata";
import { ALPHA_BUILD_LOCK, frontendBuildDirectory, resolveBuildProfile } from "./lib/build-profile";
import { verifyCiSidecar } from "./lib/ci-build-strict";

function artifactNames(version: string): string[] {
	const binary = `narrafork-${version}-linux-x64-baseline`;
	return [
		binary,
		`${binary}.metadata.json`,
		`narrafork-${version}-SHA256SUMS`,
		`narrafork-${version}-checksums.txt`,
	];
}

function resolveArchivePath(path: string): string {
	try {
		return realpathSync(path);
	} catch (error) {
		const parent = dirname(path);
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === path) throw error;
		return join(resolveArchivePath(parent), basename(path));
	}
}

function isWithin(path: string, directory: string): boolean {
	const fromDirectory = relative(directory, path);
	return (
		!isAbsolute(fromDirectory) && fromDirectory !== ".." && !fromDirectory.startsWith(`..${sep}`)
	);
}

/** Archive links keep targets in place; dist moves protect backups from compiler writes. */
function backupExisting(
	directory: string,
	names: string[],
	keepTargets = false,
): string | undefined {
	const existing = names.filter((name) => {
		try {
			if (!lstatSync(join(directory, name)).isFile()) {
				throw new Error(`Expected a regular artifact: ${join(directory, name)}`);
			}
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	});
	if (existing.length === 0) return;
	const backup = mkdtempSync(join(directory, ".build-alpha-backup-"));
	for (const name of existing) {
		(keepTargets ? linkSync : renameSync)(join(directory, name), join(backup, name));
	}
	console.log(`Previous alpha artifacts: ${backup}`);
	return backup;
}

function readSmallFile(path: string): string {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.size > 64 * 1024) throw new Error(`Invalid alpha artifact: ${path}`);
	return readFileSync(path, "utf8");
}

function parseVersion(version: string): [bigint, bigint, bigint, bigint?] | undefined {
	const match =
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-alpha\.(0|[1-9]\d*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
			version,
		);
	if (!match || match[0] !== version) return;
	return [
		BigInt(match[1]),
		BigInt(match[2]),
		BigInt(match[3]),
		match[4] === undefined ? undefined : BigInt(match[4]),
	];
}

function hasCompletedArtifacts(directory: string, version: string): boolean {
	try {
		const [name, sidecar, sums, report] = artifactNames(version);
		const metadata = JSON.parse(readSmallFile(join(directory, sidecar))) as BinaryMetadata;
		const binary = lstatSync(join(directory, name));
		return (
			metadata.name === name &&
			metadata.version === version &&
			metadata.platform === "linux-x64-baseline" &&
			metadata.target === "bun-linux-x64-baseline" &&
			/^[a-f0-9]{64}$/.test(metadata.sha256) &&
			binary.isFile() &&
			binary.size > 0 &&
			binary.size === metadata.size &&
			!!(binary.mode & 0o111) &&
			readSmallFile(join(directory, sums)) === formatSha256Sums([metadata]) &&
			readSmallFile(join(directory, report)) === formatChecksumsReport(version, [metadata])
		);
	} catch {
		return false;
	}
}

/** Advance complete top-level records and skip occupied slots without reading binaries. */
export function selectNextAlphaVersion(options: {
	sourceVersion: string;
	distDir: string;
	archiveDir: string;
}): string {
	const source = parseVersion(options.sourceVersion);
	if (!source) {
		throw new Error(
			`Expected a stable or numbered alpha SemVer in package.json: ${options.sourceVersion}`,
		);
	}
	let next: [bigint, bigint, bigint, bigint] = [
		source[0],
		source[1],
		source[2] + (source[3] === undefined ? 1n : 0n),
		(source[3] ?? 0n) + 1n,
	];
	const occupied = new Set<string>();
	for (const directory of [options.distDir, options.archiveDir]) {
		let entries: string[];
		try {
			entries = readdirSync(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		for (const entry of entries) {
			occupied.add(entry);
			const match = /^narrafork-(.+)-linux-x64-baseline\.metadata\.json$/.exec(entry);
			if (!match || match[0] !== entry) continue;
			const parsed = parseVersion(match[1]);
			if (!parsed || parsed[3] === undefined) continue;
			const previous: typeof next = [parsed[0], parsed[1], parsed[2], parsed[3]];
			const difference = previous.findIndex((value, index) => value !== next[index]);
			if (difference !== -1 && previous[difference] < next[difference]) continue;
			if (!hasCompletedArtifacts(directory, match[1])) continue;
			next = previous;
			next[3] += 1n;
		}
	}
	for (;;) {
		const version = `${next[0]}.${next[1]}.${next[2]}-alpha.${next[3]}`;
		if (!artifactNames(version).some((name) => occupied.has(name))) return version;
		next[3] += 1n;
	}
}

function requireNewArtifacts(directory: string, names: string[]): void {
	for (const name of names) {
		const path = join(directory, name);
		try {
			lstatSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		throw new Error(
			`Automatic alpha artifact already exists: ${path}; set VERSION explicitly to rebuild`,
		);
	}
}

async function verifyArtifacts(directory: string, version: string): Promise<BinaryMetadata> {
	const [name, sidecar, sums, report] = artifactNames(version);
	const metadata = JSON.parse(readSmallFile(join(directory, sidecar))) as BinaryMetadata;
	const verified = await verifyCiSidecar(join(directory, name), {
		name,
		platformId: "linux-x64-baseline",
		target: "bun-linux-x64-baseline",
		version,
		commit: metadata.commit,
		repository: metadata.repository ?? "",
		helperDistribution: createHelperDistributionDependencies(),
		recoveryManifestVersions: CURRENT_RECOVERY_MANIFEST_VERSIONS,
	});
	if (
		!(lstatSync(join(directory, name)).mode & 0o111) ||
		readSmallFile(join(directory, sums)) !== formatSha256Sums([verified]) ||
		readSmallFile(join(directory, report)) !== formatChecksumsReport(version, [verified])
	) {
		throw new Error("Alpha executable permissions or aggregate checksums do not match metadata");
	}
	return verified;
}

export async function buildAlpha(options: {
	root: string;
	version?: string;
	archiveDir: string;
	env?: NodeJS.ProcessEnv;
	installArchiveFile?: typeof renameSync;
}): Promise<void> {
	const { root } = options;
	const requestedVersion = options.version ?? "auto";
	const automatic = requestedVersion === "auto";
	const profileVersion = automatic ? "0.0.0-alpha.1" : requestedVersion;
	const env = options.env ?? process.env;
	if (resolveBuildProfile(profileVersion, {}).name !== "diagnostic") {
		throw new Error(`Expected a valid alpha SemVer, received: ${requestedVersion}`);
	}
	if (
		resolveBuildProfile(profileVersion, {
			CI: env.CI,
			GITHUB_ACTIONS: env.GITHUB_ACTIONS,
			NF_BUILD_RELEASE_CONTEXT: env.NF_BUILD_RELEASE_CONTEXT,
		}).name !== "diagnostic"
	) {
		throw new Error("build-alpha requires a local environment without CI or release context");
	}
	const archive = resolve(root, options.archiveDir);
	const dist = join(root, "dist");
	const lock = join(root, ALPHA_BUILD_LOCK);
	const resolvedArchive = resolveArchivePath(archive);
	if (resolvedArchive === resolveArchivePath(dist)) {
		throw new Error("ARCHIVE_DIR must differ from dist");
	}
	for (const reserved of [
		lock,
		frontendBuildDirectory(root, false),
		join(root, "frontend", "public"),
	]) {
		if (isWithin(archive, reserved) || isWithin(resolvedArchive, resolveArchivePath(reserved))) {
			throw new Error(`ARCHIVE_DIR cannot be inside build-owned or public directory: ${reserved}`);
		}
	}
	try {
		mkdirSync(lock, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(`Alpha build is locked; inspect ${lock} before removing it`);
		}
		throw error;
	}
	const packagePath = join(root, "package.json");
	let original: Buffer | undefined;
	let temporary: Buffer | undefined;
	let changedPackage = false;
	let packageIdentity: { ino: number; dev: number } | undefined;
	const packageMatches = (expected: Buffer) => {
		const current = lstatSync(packagePath);
		return (
			current.isFile() &&
			current.ino === packageIdentity?.ino &&
			current.dev === packageIdentity?.dev &&
			readFileSync(packagePath).equals(expected)
		);
	};
	let child: ReturnType<typeof Bun.spawn> | undefined;
	let interrupted: NodeJS.Signals | undefined;
	const interrupt = (signal: NodeJS.Signals) => {
		interrupted ??= signal;
		if (child?.exitCode === null) child.kill(signal);
	};
	const restorePackage = () => {
		if (changedPackage && original && temporary) {
			if (!packageMatches(temporary)) {
				throw new Error(
					`package.json changed; original preserved at ${lock}/package.json.original`,
				);
			}
			writeFileSync(packagePath, original);
		}
		rmSync(lock, { recursive: true });
	};
	const onInt = () => interrupt("SIGINT");
	const onTerm = () => interrupt("SIGTERM");
	process.on("SIGINT", onInt);
	process.on("SIGTERM", onTerm);
	const checkPackage = () => {
		if (!temporary || !packageMatches(temporary)) {
			throw new Error("package.json changed during the alpha build; external changes retained");
		}
		if (interrupted) throw new Error(`Alpha build cancelled (${interrupted})`);
	};
	try {
		const packageStat = lstatSync(packagePath);
		if (!packageStat.isFile()) throw new Error("package.json must be a regular file");
		packageIdentity = packageStat;
		original = readFileSync(packagePath);
		const source = original.toString("utf8");
		const pkg = JSON.parse(source);
		const versionField = /("version"\s*:\s*)"[^"\\]*"/g;
		if ([...source.matchAll(versionField)].length !== 1) {
			throw new Error("package.json must contain exactly one version field");
		}
		const runtime = Bun.spawnSync([process.execPath, "--version"], { cwd: root, timeout: 5000 });
		if (
			runtime.exitCode !== 0 ||
			runtime.stdout.toString().trim() !== Bun.version ||
			pkg.packageManager !== `bun@${Bun.version}`
		) {
			throw new Error(`build-alpha requires ${pkg.packageManager}; running bun@${Bun.version}`);
		}
		const version = automatic
			? selectNextAlphaVersion({ sourceVersion: pkg.version, distDir: dist, archiveDir: archive })
			: requestedVersion;
		console.log(`Alpha version: ${version}${automatic ? " (auto)" : ""}`);
		temporary = Buffer.from(source.replace(versionField, `$1${JSON.stringify(version)}`));
		writeFileSync(join(lock, "package.json.original"), original, { flag: "wx", mode: 0o600 });
		const names = artifactNames(version);
		if (automatic) {
			requireNewArtifacts(dist, names);
			requireNewArtifacts(archive, names);
		}
		mkdirSync(dist, { recursive: true });
		if (!automatic) backupExisting(dist, names);
		if (!packageMatches(original)) {
			throw new Error("package.json changed before the alpha build; external changes retained");
		}
		changedPackage = true;
		writeFileSync(packagePath, temporary);
		child = Bun.spawn(
			[
				process.execPath,
				"scripts/build-cross-platform.ts",
				"--platform=linux-x64-baseline",
				"--release-ci",
				"--alpha-frontend",
			],
			{ cwd: root, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
		);
		const code = await child.exited;
		checkPackage();
		if (code !== 0) throw new Error(`Alpha build failed (${code})`);
		const metadata = await verifyArtifacts(dist, version);
		checkPackage();
		mkdirSync(archive, { recursive: true, mode: 0o700 });
		const staging = mkdtempSync(join(archive, ".build-alpha-stage-"));
		let backup: string | undefined;
		const replaced: string[] = [];
		try {
			for (const name of names) {
				copyFileSync(join(dist, name), join(staging, name));
				chmodSync(join(staging, name), lstatSync(join(dist, name)).mode & 0o777);
			}
			const copied = await verifyArtifacts(staging, version);
			if (JSON.stringify(copied) !== JSON.stringify(metadata)) {
				throw new Error("Alpha artifacts changed while archiving");
			}
			checkPackage();
			if (automatic) requireNewArtifacts(archive, names);
			else backup = backupExisting(archive, names, true);
			const install = options.installArchiveFile ?? (automatic ? linkSync : renameSync);
			for (const name of names) {
				checkPackage();
				install(join(staging, name), join(archive, name));
				replaced.push(name);
			}
			const archived = await verifyArtifacts(archive, version);
			checkPackage();
			if (
				archived.sha256 !== metadata.sha256 ||
				(lstatSync(join(archive, names[0])).mode & 0o777) !==
					(lstatSync(join(dist, names[0])).mode & 0o777)
			) {
				throw new Error("Archived alpha checksum or permissions changed");
			}
			console.log(`Alpha ${version} archived to ${archive}; SHA256 ${archived.sha256}`);
		} catch (error) {
			const rollbackErrors: unknown[] = [];
			for (const name of replaced.reverse()) {
				try {
					const previous = backup && join(backup, name);
					if (previous && existsSync(previous)) renameSync(previous, join(archive, name));
					else rmSync(join(archive, name), { force: true });
				} catch (rollbackError) {
					rollbackErrors.push(rollbackError);
				}
			}
			if (rollbackErrors.length > 0) {
				throw new AggregateError(
					[error, ...rollbackErrors],
					`Alpha archive rollback incomplete; backup: ${backup}`,
				);
			}
			throw error;
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}
	} finally {
		process.removeListener("SIGINT", onInt);
		process.removeListener("SIGTERM", onTerm);
		restorePackage();
	}
}

if (import.meta.main) {
	try {
		await buildAlpha({
			root: join(import.meta.dir, ".."),
			version: process.argv[2] ?? "auto",
			archiveDir: process.argv[3] ?? ".build-alpha-archive",
		});
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
