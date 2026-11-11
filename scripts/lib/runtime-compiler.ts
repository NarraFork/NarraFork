import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { BunPlugin } from "bun";
import {
	PLUGIN_UI_RUNTIME_CSS_PATH,
	PLUGIN_UI_RUNTIME_JS_PATH,
} from "../../frontend/plugin-runtime/paths";
import { compiledWorkerBuildEntrypoints } from "../../server/lib/compiled-worker";
import { createHelperDistributionDependencies } from "../../shared/helper-distribution";
import { assetsUnder, collectBuildModules } from "./build-materials";
import { resolveBuildGitHubRepository } from "./build-repository";
import { nativeTarget, readNativeFile, validatePtyDependency } from "./ci-build-native";
import { COMPILED_BUILD_OPTIONS, runtimeBuildDefines } from "./compiled-build";

export function runtimeAssets(root: string, frontend: boolean): Map<string, string> {
	const built = join(root, "dist/frontend");
	if (frontend) {
		if (!existsSync(join(built, "index.html"))) {
			throw new Error(
				"Frontend assets are missing. Run bun run build before start/build:runtime --frontend.",
			);
		}
		return assetsUnder(built);
	}
	const assets = assetsUnder(join(root, "frontend/public"));
	for (const path of [PLUGIN_UI_RUNTIME_JS_PATH, PLUGIN_UI_RUNTIME_CSS_PATH]) {
		if (existsSync(join(built, path))) assets.set(`/${path}`, join(built, path));
	}
	return assets;
}

/** Freeze the installed host binding, never download or probe a source runtime at startup. */
function localParcelLoader(root: string): string {
	const target = `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
	let { watcher } = nativeTarget(target);
	if (process.platform === "linux") {
		const { familySync } = require(join(root, "node_modules/detect-libc/lib/detect-libc.js"));
		if (familySync() === "musl") watcher = watcher.replace(/-glibc$/, "-musl");
	}
	const native = join(root, `node_modules/@parcel/watcher-${watcher}/watcher.node`);
	readNativeFile(native, watcher);
	// Windows still uses bun-pty. Unix uses Bun.Terminal, but preserve the installed
	// native embedding branch for all hosts, as the release recipe does.
	validatePtyDependency(root, target);
	return `import binding from ${JSON.stringify(native)};\nexport function loadParcelNativeBinding() { return binding; }\n`;
}

/** In-memory replacements only: concurrently running/source builds never see generated-file churn. */
function runtimeBuildPlugin(root: string, modules: ReadonlyMap<string, string>): BunPlugin {
	return {
		name: "narrafork-local-runtime-materials",
		setup(build) {
			build.onResolve({ filter: /(?:^|[\\/])generated[\\/][^\\/]+$/ }, (args) => {
				const path = args.path.startsWith("@server/")
					? resolve(root, "server", args.path.slice("@server/".length))
					: resolve(dirname(args.importer), args.path);
				if (dirname(path) !== join(root, "server/generated")) return;
				const name = `${basename(path).replace(/\.ts$/, "")}.ts`;
				if (!modules.has(name)) return;
				return { path: join(root, "server/generated", name), namespace: "nf-generated" };
			});
			build.onLoad({ filter: /.*/, namespace: "nf-generated" }, (args) => ({
				contents: modules.get(basename(args.path)) as string,
				loader: "ts",
				resolveDir: dirname(args.path),
			}));
		},
	};
}

/** Kept small so integration tests can compile a real isolated graph with the production recipe. */
export async function compileRuntimeBundle(options: {
	root: string;
	entrypoints: string[];
	outfile: string;
	buildId: string;
	repository: string;
	modules: ReadonlyMap<string, string>;
}): Promise<void> {
	const result = await Bun.build({
		...COMPILED_BUILD_OPTIONS,
		throw: false,
		entrypoints: options.entrypoints,
		define: {
			...runtimeBuildDefines(options.buildId, true),
			__NARRAFORK_BUILD_REPOSITORY__: JSON.stringify(options.repository),
		},
		plugins: [runtimeBuildPlugin(options.root, options.modules)],
		compile: {
			executablePath: process.execPath,
			outfile: options.outfile,
			autoloadBunfig: false,
			autoloadTsconfig: false,
			autoloadPackageJson: false,
		},
	});
	if (!result.success) throw new Error(result.logs.slice(0, 30).map(String).join("\n"));
}

async function compileApplication(
	root: string,
	outfile: string,
	buildId: string,
	frontend: boolean,
) {
	const repository = resolveBuildGitHubRepository({ root });
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	let commit = "";
	try {
		commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			cwd: root,
			encoding: "utf8",
			timeout: 5000,
			maxBuffer: 4096,
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch {
		// Source archives need not contain Git metadata.
	}
	const modules = await collectBuildModules(root, runtimeAssets(root, frontend), {
		version: pkg.version ?? "0.0.0",
		commit,
		platform: `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`,
		repository,
		helperDistribution: createHelperDistributionDependencies(),
	});
	modules.set("parcel-native-loader.ts", localParcelLoader(root));
	await compileRuntimeBundle({
		root,
		entrypoints: ["./server/index.ts", ...compiledWorkerBuildEntrypoints()].map((path) =>
			resolve(root, path),
		),
		outfile,
		buildId,
		repository,
		modules,
	});
}

if (import.meta.main) {
	try {
		const [root, outfile, buildId, frontend] = process.argv.slice(2);
		if (!root || !outfile || !buildId || !["true", "false"].includes(frontend ?? "")) {
			throw new Error("Runtime compiler requires root, output, buildId and frontend mode");
		}
		await compileApplication(root, outfile, buildId, frontend === "true");
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
