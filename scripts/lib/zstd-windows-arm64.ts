import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Compile a self-contained zstd CLI with native Win32 threads and no optional codecs.
 * Source/archive and llvm-mingw versions are pinned by the acquisition entrypoint.
 * No legacy codecs or assembly are required for NarraFork's zstd patch updates.
 */
export function windowsArm64ZstdCommand(
	sourceDir: string,
	compiler: string,
	output: string,
): string[] {
	const sourceDirs = [
		"lib/common",
		"lib/compress",
		"lib/decompress",
		"lib/dictBuilder",
		"programs",
	];
	const sources = sourceDirs.flatMap((dir) =>
		readdirSync(join(sourceDir, dir))
			.filter((name) => name.endsWith(".c"))
			.sort()
			.map((name) => join(sourceDir, dir, name)),
	);
	return [
		compiler,
		"-O2",
		"-DNDEBUG",
		`-ffile-prefix-map=${sourceDir}=zstd`,
		"-static",
		"-s",
		"-Wl,--no-insert-timestamp",
		"-DZSTD_MULTITHREAD=1",
		"-DZSTD_LEGACY_SUPPORT=0",
		"-DZSTD_DISABLE_ASM=1",
		"-DXXH_NAMESPACE=ZSTD_",
		...sourceDirs.map((dir) => `-I${join(sourceDir, dir)}`),
		...sources,
		"-o",
		output,
	];
}
