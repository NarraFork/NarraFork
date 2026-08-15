#!/usr/bin/env bun
/**
 * Make installed dependencies loadable by Cottontail, Electrobun's main-process runtime.
 *
 * Cottontail 0.2.3 cannot load a module that uses a static `import`, ends with a `//`
 * comment, and lacks a trailing newline — its async module wrapper appends `})` after the
 * source, and the comment swallows it. See scripts/lib/cottontail-module-patch.ts for the
 * full analysis and the minimal reproduction.
 *
 * Appending one newline is a semantic no-op, idempotent, and self-disabling once upstream
 * fixes the loader. Run after installing dependencies:
 *
 *     bun scripts/patch-cottontail-modules.ts             # patch node_modules
 *     bun scripts/patch-cottontail-modules.ts --check     # report only, exit 1 if work remains
 *     bun scripts/patch-cottontail-modules.ts --dir=path  # patch a specific tree
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	isPatchableFile,
	needsTrailingNewline,
	type PatchSummary,
	shouldScanDirectory,
} from "./lib/cottontail-module-patch";

interface Options {
	dir: string;
	check: boolean;
	verbose: boolean;
}

function parseArgs(argv: string[]): Options {
	let dir = "node_modules";
	let check = false;
	let verbose = false;
	for (const arg of argv) {
		if (arg === "--check") check = true;
		else if (arg === "--verbose" || arg === "-v") verbose = true;
		else if (arg.startsWith("--dir=")) dir = arg.slice("--dir=".length);
		else if (arg === "--help" || arg === "-h") {
			console.log(
				"Usage: bun scripts/patch-cottontail-modules.ts [--dir=node_modules] [--check] [--verbose]",
			);
			process.exit(0);
		} else {
			console.error(`patch-cottontail-modules: unknown argument: ${arg}`);
			process.exit(2);
		}
	}
	return { dir, check, verbose };
}

/** Track which package each patched file belongs to, for a readable summary. */
function packageOf(filePath: string): string {
	const match = filePath.match(/node_modules[/\\]((?:@[^/\\]+[/\\])?[^/\\]+)/);
	return match ? match[1].replace(/\\/g, "/") : "(root)";
}

function patchTree(
	root: string,
	options: Options,
): PatchSummary & { byPackage: Map<string, number> } {
	const summary = { scanned: 0, patched: 0, byPackage: new Map<string, number>() };

	// Iterative walk: a deep dependency tree can exceed the call stack when recursing.
	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		let entries: ReturnType<typeof readdirSync>;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			// Unreadable or vanished directory (e.g. a broken symlink) is not fatal.
			continue;
		}

		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (shouldScanDirectory(entry.name)) stack.push(path);
				continue;
			}
			// Skip symlinks: rewriting through one would mutate a shared store (e.g. a
			// global package cache) outside this project.
			if (!entry.isFile()) continue;
			if (!isPatchableFile(entry.name)) continue;

			summary.scanned++;
			let source: string;
			try {
				source = readFileSync(path, "utf8");
			} catch {
				continue;
			}
			if (!needsTrailingNewline(source)) continue;

			summary.patched++;
			const pkg = packageOf(path);
			summary.byPackage.set(pkg, (summary.byPackage.get(pkg) ?? 0) + 1);
			if (options.verbose) console.log(`  ${options.check ? "would patch" : "patched"} ${path}`);
			if (!options.check) writeFileSync(path, `${source}\n`);
		}
	}

	return summary;
}

const options = parseArgs(process.argv.slice(2));
const root = resolve(options.dir);
const summary = patchTree(root, options);

const verb = options.check ? "need patching" : "patched";
console.log(
	`patch-cottontail-modules: scanned ${summary.scanned} files, ${summary.patched} ${verb}`,
);

if (summary.patched > 0) {
	const top = [...summary.byPackage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
	for (const [pkg, count] of top) console.log(`  ${String(count).padStart(5)} ${pkg}`);
	const remaining = summary.byPackage.size - top.length;
	if (remaining > 0) console.log(`  … and ${remaining} more package(s)`);
}

// --check is for CI: a non-zero exit means dependencies would fail to load under Cottontail.
if (options.check && summary.patched > 0) process.exit(1);
