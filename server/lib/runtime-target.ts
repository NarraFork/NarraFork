/**
 * How this process was started: from source (dev/`bun run`) or from a `bun build --compile` binary.
 *
 * Both shapes need different resolution strategies for anything path-based — worker entry points,
 * subprocess argv — so the check lived duplicated in several modules. It belongs in one place.
 *
 * Why moving it here is safe: inside a compiled binary EVERY module reports the binary itself as
 * `import.meta.url` (`file:///$bunfs/root/<name>`), not its own source path. The check therefore
 * describes the runtime, not the asking file, and gives the same answer from any module. (That same
 * property is why relative worker specifiers must be probed rather than resolved once — see
 * `compiled-worker.ts`.)
 */

declare const __NARRAFORK_RUNTIME_BUILD_ID__: string;
declare const __NARRAFORK_LOCAL_RUNTIME__: boolean;

/** Embedded in every entry of one build; source development has no frozen identity. */
export const RUNTIME_BUILD_ID: string | null =
	typeof __NARRAFORK_RUNTIME_BUILD_ID__ === "string" ? __NARRAFORK_RUNTIME_BUILD_ID__ : null;

/** Local launch artifacts are compiled, but are not self-updating release installations. */
export const IS_LOCAL_RUNTIME =
	typeof __NARRAFORK_LOCAL_RUNTIME__ !== "undefined" && __NARRAFORK_LOCAL_RUNTIME__;

/** True when running inside a compiled single-file binary. */
export function isCompiledRuntime(): boolean {
	const url = import.meta.url;
	return url.includes("$bunfs/") || url.includes("%7EBUN/");
}
