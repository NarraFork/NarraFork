/**
 * Git configuration that keeps a server-side git command from running repository code.
 *
 * A checkout's configuration can name programs git runs on its own: hooks (`core.hooksPath`
 * may be relative and point inside the worktree, e.g. Husky's ignored `.husky/_`), an fsmonitor,
 * clean/smudge/process filters and merge drivers selected by `.gitattributes`, an external diff,
 * a signing program, an ssh command or a credential helper. A command the server runs in a
 * checkout an agent could write to must not run any of them: nobody approved that code.
 *
 * The overrides are passed as `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`
 * (git ≥ 2.31): command-scope configuration, above every file scope, and inherited by the git
 * subprocesses a command starts itself (`git worktree remove` runs `git status`). Filters are
 * named per driver, so the configured driver names are read first (`DRIVER_CONFIG_QUERY`,
 * reading configuration never runs anything) and each one is emptied: an empty command is no
 * filter. A merge driver cannot be emptied that way, so a command that would merge refuses when
 * one is configured.
 */
import { DEV_NULL } from "./platform";

/** Configuration that disables every program git would run on its own, except filters. */
export const GIT_NO_EXEC_CONFIG: ReadonlyArray<readonly [string, string]> = [
	["core.hooksPath", DEV_NULL],
	["core.fsmonitor", "false"],
	["core.untrackedCache", "false"],
	["diff.external", ""],
	["commit.gpgSign", "false"],
	["tag.gpgSign", "false"],
	["core.sshCommand", ""],
	["credential.helper", ""],
	["core.askPass", ""],
];

/** Lists configured filter and merge drivers: `key\nvalue\0` records. */
export const DRIVER_CONFIG_QUERY = [
	"config",
	"-z",
	"--get-regexp",
	"^(filter|merge)\\..+\\.(clean|smudge|process|driver)$",
] as const;

export interface GitDrivers {
	filters: string[];
	mergeDrivers: string[];
}

/** Parse {@link DRIVER_CONFIG_QUERY} output (exit 1 with no output means none). */
export function parseDriverConfig(stdout: string): GitDrivers {
	const filters = new Set<string>();
	const mergeDrivers = new Set<string>();
	for (const record of stdout.split("\0")) {
		const key = record.split("\n", 1)[0] ?? "";
		const last = key.lastIndexOf(".");
		if (last <= 0) continue;
		if (key.startsWith("filter.")) filters.add(key.slice("filter.".length, last));
		else if (key.startsWith("merge.") && key.endsWith(".driver"))
			mergeDrivers.add(key.slice("merge.".length, last));
	}
	return { filters: [...filters].filter(Boolean), mergeDrivers: [...mergeDrivers].filter(Boolean) };
}

/** Overrides that empty every named filter driver (and stop git requiring one). */
export function filterNeutralizers(filters: readonly string[]): Array<readonly [string, string]> {
	return filters.flatMap((name) => [
		[`filter.${name}.clean`, ""] as const,
		[`filter.${name}.smudge`, ""] as const,
		[`filter.${name}.process`, ""] as const,
		[`filter.${name}.required`, "false"] as const,
	]);
}

/** The environment carrying configuration overrides (replaces any inherited GIT_CONFIG_*). */
export function gitConfigEnv(
	entries: ReadonlyArray<readonly [string, string]>,
): Record<string, string> {
	const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
	entries.forEach(([key, value], index) => {
		env[`GIT_CONFIG_KEY_${index}`] = key;
		env[`GIT_CONFIG_VALUE_${index}`] = value;
	});
	return env;
}

/** `diff` and `log -p` style arguments that never run external diff or textconv programs. */
export function noExternalDiffArgs(args: readonly string[]): string[] {
	return args[0] === "diff"
		? ["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)]
		: [...args];
}
