import { isCompiledRuntime } from "../lib/runtime-target";
import { materializeBuiltinPlugins } from "./materialize";

/** Quota ships as an installable archive, not a second catalog-only builtin package. */
export const BUILTIN_PLUGIN_ROOTS: readonly string[] = [];

export function resolveBuiltinPluginRoots(): Promise<readonly string[]> {
	return BUILTIN_PLUGIN_ROOTS.length && isCompiledRuntime()
		? materializeBuiltinPlugins()
		: Promise.resolve(BUILTIN_PLUGIN_ROOTS);
}
