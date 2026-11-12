import type { BuildConfig } from "bun";

/** Keep local and release builds on the same minified, embedded-asset recipe. */
export const COMPILED_BUILD_OPTIONS = {
	target: "bun",
	minify: true,
	naming: { asset: "[dir]/[name].[ext]" },
	external: ["electron"],
} satisfies Partial<BuildConfig>;

export function runtimeBuildDefines(buildId: string, local: boolean): Record<string, string> {
	return {
		__NARRAFORK_RUNTIME_BUILD_ID__: JSON.stringify(buildId),
		__NARRAFORK_LOCAL_RUNTIME__: JSON.stringify(local),
	};
}

export function compiledBuildArguments(): string[] {
	return [
		"--compile",
		"--minify",
		`--asset-naming=${COMPILED_BUILD_OPTIONS.naming.asset}`,
		...COMPILED_BUILD_OPTIONS.external.map((name) => `--external=${name}`),
		"--no-compile-autoload-bunfig",
		"--no-compile-autoload-tsconfig",
		"--no-compile-autoload-package-json",
	];
}
