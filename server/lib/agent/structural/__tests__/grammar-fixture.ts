/**
 * Seed the test-isolated grammar cache from the developer's real one.
 *
 * Tests run under an isolated `NARRAFORK_HOME` (see tests/preload.ts), so
 * `~/.narrafork/grammars` is empty even on a machine that has grammars installed —
 * which would skip every accurate-path assertion exactly where it is most useful.
 * Copying the real file in keeps the isolation (nothing is written to the user's
 * home) while letting the tree-sitter tests actually run locally. In CI, or on a
 * machine that never installed a grammar, there is nothing to copy and the
 * dependent tests skip as designed rather than failing.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { grammarCachePath, isGrammarInstalled } from "../grammar-store";

/**
 * The host account's home, not the isolated one.
 *
 * `tests/preload.ts` rewrites HOME/USERPROFILE, and Bun's `homedir()` follows them,
 * so the plain call resolves to the isolated temp dir. The preload keeps the real
 * value in `NARRAFORK_ORIGINAL_HOME` for callers like this one that must reach the
 * host's own files.
 */
function hostHome(): string {
	return process.env.NARRAFORK_ORIGINAL_HOME?.trim() || homedir();
}

/**
 * Make `languageId` available in the isolated cache if the host has it.
 * Returns whether the grammar is usable afterwards.
 */
export function ensureGrammarFixture(languageId: string): boolean {
	if (isGrammarInstalled(languageId)) return true;

	const source = join(hostHome(), ".narrafork", "grammars", `tree-sitter-${languageId}.wasm`);
	if (!existsSync(source)) return false;

	const target = grammarCachePath(languageId);
	try {
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(source, target);
	} catch {
		return false;
	}
	return isGrammarInstalled(languageId);
}
