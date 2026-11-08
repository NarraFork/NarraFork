import { join } from "node:path";
import { isCompiledRuntime } from "../lib/runtime-target";
import { materializeBuiltinPlugins } from "./materialize";

/**
 * Plugins that ship inside the application bundle.
 *
 * A builtin plugin is an ordinary plugin package: same `manifest.json`, same manifest
 * validation, same runtime lifecycle and health accounting, same enable/disable semantics.
 * The single difference is distribution — it has no install step, no package-store record and
 * no capability grant, because it is already on disk as part of the application and shares the
 * application's trust root. Everything that does not apply for that reason is listed in the
 * plugin's README under "与外部插件的标准差异".
 *
 * These roots are handed to `PluginCatalog`, which reads them through the *same* package
 * reader it uses for installed packages, so a malformed builtin manifest fails exactly like a
 * malformed installed one instead of silently degrading.
 */
export const BUILTIN_PLUGIN_ROOTS: readonly string[] = [join(import.meta.dir, "apikey-quota")];

/**
 * The roots to read in *this* process.
 *
 * From source, the checked-out packages are already on disk and are used directly. In a
 * compiled single-file binary `import.meta.dir` points inside `$bunfs`, so the source path
 * names nothing that exists; the packages were embedded at build time and have to be written
 * back out first (see `materialize.ts`). Resolving this once here keeps the catalog's contract
 * unchanged — it still receives plain directories and reads them through the ordinary package
 * reader.
 */
export function resolveBuiltinPluginRoots(): Promise<readonly string[]> {
	return isCompiledRuntime() ? materializeBuiltinPlugins() : Promise.resolve(BUILTIN_PLUGIN_ROOTS);
}
