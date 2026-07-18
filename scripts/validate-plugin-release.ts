import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { type Manifest, safeParseManifest } from "../server/lib/plugins/manifest";
import { generateSpdxSbom, parseSbom } from "../server/services/plugin-sbom";

const RELEASE_OSES = ["linux", "darwin", "win32"] as const;
const RELEASE_ARCHES = ["x64", "arm64"] as const;
const SBOM_FILE = "sbom.spdx.json";

export interface PluginReleaseMatrixEntry {
	os: (typeof RELEASE_OSES)[number];
	arch: (typeof RELEASE_ARCHES)[number];
	supported: boolean;
}

export interface PluginReleasePackageSummary {
	kind: string;
	pluginId?: string;
	version?: string;
	path: string;
	valid: boolean;
	errors: string[];
	digest?: string;
	entries: string[];
	matrix: PluginReleaseMatrixEntry[];
	sbom: {
		path: string;
		format?: "spdx" | "cyclonedx";
		componentCount: number;
		generatedSpdx: boolean;
	};
}

export interface PluginReleaseValidationSummary {
	valid: boolean;
	packageCount: number;
	matrixCombinationCount: number;
	errors: string[];
	packages: PluginReleasePackageSummary[];
}

function isInsidePath(parent: string, child: string): boolean {
	const normalizedParent = resolve(parent);
	const normalizedChild = resolve(child);
	return (
		normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${sep}`)
	);
}

async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function pathIsRegularFile(packageRoot: string, relativePath: string): Promise<boolean> {
	const path = resolve(packageRoot, relativePath);
	if (!isInsidePath(packageRoot, path)) return false;
	try {
		const [packageRealPath, fileRealPath, stats] = await Promise.all([
			realpath(packageRoot),
			realpath(path),
			lstat(path),
		]);
		return isInsidePath(packageRealPath, fileRealPath) && stats.isFile() && !stats.isSymbolicLink();
	} catch {
		return false;
	}
}

function manifestEntryPaths(manifest: Manifest): string[] {
	const paths = new Set<string>();
	if (manifest.server?.entry) paths.add(manifest.server.entry);
	if (manifest.ui?.entry) paths.add(manifest.ui.entry);
	if (manifest.ui?.style) paths.add(manifest.ui.style);
	for (const view of manifest.contributes.views) {
		paths.add(view.entry);
		if (view.style) paths.add(view.style);
	}
	return [...paths].sort();
}

async function packageFilePaths(root: string): Promise<string[]> {
	const files: string[] = [];
	const walk = async (directory: string): Promise<void> => {
		const entries = await readdir(directory, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink())
				throw new Error(`symlink is not allowed: ${relative(root, path)}`);
			if (entry.isDirectory()) {
				await walk(path);
			} else if (entry.isFile()) {
				files.push(path);
			} else {
				throw new Error(`unsupported package entry: ${relative(root, path)}`);
			}
		}
	};
	await walk(root);
	return files;
}

async function computePackageDigest(root: string): Promise<string> {
	const hash = createHash("sha256");
	for (const path of await packageFilePaths(root)) {
		const relativePath = relative(root, path).split(sep).join("/");
		hash.update(relativePath);
		hash.update("\0");
		hash.update(await readFile(path));
		hash.update("\0");
	}
	return hash.digest("hex");
}

function releaseMatrix(manifest: Manifest): PluginReleaseMatrixEntry[] {
	const supportedOs = new Set(manifest.engine.os ?? RELEASE_OSES);
	const supportedArch = new Set(manifest.engine.arch ?? RELEASE_ARCHES);
	return RELEASE_OSES.flatMap((os) =>
		RELEASE_ARCHES.map((arch) => ({
			os,
			arch,
			supported: supportedOs.has(os) && supportedArch.has(arch),
		})),
	);
}

async function validatePackage(packageRoot: string): Promise<PluginReleasePackageSummary> {
	const kind = basename(packageRoot);
	const errors: string[] = [];
	const summary: PluginReleasePackageSummary = {
		kind,
		path: packageRoot,
		valid: false,
		errors,
		entries: [],
		matrix: [],
		sbom: {
			path: join(packageRoot, SBOM_FILE),
			componentCount: 0,
			generatedSpdx: false,
		},
	};

	let manifest: Manifest;
	try {
		const parsed = safeParseManifest(await readJson(join(packageRoot, "manifest.json")));
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				errors.push(`manifest ${issue.path.join(".") || "root"}: ${issue.message}`);
			}
			return summary;
		}
		manifest = parsed.data;
		summary.pluginId = manifest.pluginId;
		summary.version = manifest.version;
	} catch (error) {
		errors.push(`manifest: ${error instanceof Error ? error.message : String(error)}`);
		return summary;
	}

	summary.entries = manifestEntryPaths(manifest);
	for (const entry of summary.entries) {
		if (!(await pathIsRegularFile(packageRoot, entry))) {
			errors.push(`entry is missing, unsafe, or not a regular file: ${entry}`);
		}
	}
	if (summary.entries.length === 0) errors.push("package has no server or UI entry");

	summary.matrix = releaseMatrix(manifest);
	for (const combination of summary.matrix) {
		if (!combination.supported) {
			errors.push(`release matrix does not support ${combination.os}/${combination.arch}`);
		}
	}

	try {
		const sbom = parseSbom(await readJson(summary.sbom.path));
		summary.sbom.format = sbom.format;
		summary.sbom.componentCount = sbom.components.length;
		if (sbom.format !== "spdx") errors.push(`SBOM must use SPDX, received ${sbom.format}`);
		const packageComponent = sbom.components.find(
			(component) => component.name === manifest.pluginId && component.version === manifest.version,
		);
		if (!packageComponent) {
			errors.push("SBOM does not contain the plugin package and version");
		} else if (manifest.license && packageComponent.license !== manifest.license) {
			errors.push("SBOM package license does not match manifest license");
		}
		const generated = parseSbom(
			generateSpdxSbom(
				[
					{
						id: manifest.pluginId,
						name: manifest.pluginId,
						version: manifest.version,
						license: manifest.license,
						supplier: manifest.publisher?.name ?? manifest.publisher?.id,
					},
				],
				manifest.pluginId,
			),
		);
		summary.sbom.generatedSpdx = generated.format === "spdx";
	} catch (error) {
		errors.push(`SBOM: ${error instanceof Error ? error.message : String(error)}`);
	}

	try {
		summary.digest = await computePackageDigest(packageRoot);
	} catch (error) {
		errors.push(`digest: ${error instanceof Error ? error.message : String(error)}`);
	}

	summary.valid = errors.length === 0;
	return summary;
}

export async function validatePluginRelease(
	pluginsRoot = resolve(process.cwd(), "examples/plugins"),
): Promise<PluginReleaseValidationSummary> {
	const rootEntries = await readdir(pluginsRoot, { withFileTypes: true });
	const packageRoots = rootEntries
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(pluginsRoot, entry.name))
		.sort((left, right) => basename(left).localeCompare(basename(right)));
	const packages = await Promise.all(packageRoots.map(validatePackage));
	const errors = packages.flatMap((item) => item.errors.map((error) => `${item.kind}: ${error}`));
	return {
		valid: errors.length === 0 && packages.length > 0,
		packageCount: packages.length,
		matrixCombinationCount: packages.reduce((total, item) => total + item.matrix.length, 0),
		errors,
		packages,
	};
}

if (import.meta.main) {
	try {
		const summary = await validatePluginRelease(process.argv[2]);
		console.log(JSON.stringify(summary, null, 2));
		if (!summary.valid) process.exitCode = 1;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
