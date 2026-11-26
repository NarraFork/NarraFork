/**
 * A fake `gh` on PATH for the PR flow's tests (G): it records every call (argv, working directory,
 * environment, stdin) and replays the answer the test planned for that subcommand. A subcommand is
 * keyed by its first two words (`pr view`, `auth status`, `repo view`, …; `--version` alone).
 * A planned answer is `{ stdout?, stderr?, exit?, sleepMs? }`, or a list of them used in turn (the
 * last one repeats). Nothing is planned: exit 99 and say so on stderr.
 *
 * The script runs under this very Bun (its absolute path is the shebang), reads its plan from a
 * file next to it, and appends one JSON line per call to its log. POSIX only (a shebang script).
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

export interface FakeGhAnswer {
	stdout?: string;
	stderr?: string;
	exit?: number;
	sleepMs?: number;
}

export type FakeGhPlan = Record<string, FakeGhAnswer | FakeGhAnswer[]>;

export interface FakeGhCall {
	args: string[];
	cwd: string;
	env: Record<string, string>;
	stdin: string;
}

export interface FakeGh {
	/** The directory holding the fake `gh` (put first on PATH by {@link FakeGh.activate}). */
	dir: string;
	setPlan(plan: FakeGhPlan): Promise<void>;
	calls(): Promise<FakeGhCall[]>;
	clearCalls(): Promise<void>;
	/** Put the fake first on PATH. */
	activate(): void;
	/** A PATH with no gh at all (the real one's directory left out too). */
	hideAll(): void;
	/** PATH as it was. */
	restore(): void;
}

const SCRIPT = (plan: string, log: string, counts: string) => `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = args.includes("--body-file=-") ? fs.readFileSync(0, "utf8") : "";
const env = {};
for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") env[key] = value;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd(), env, stdin }) + "\\n");
const plan = JSON.parse(fs.readFileSync(${JSON.stringify(plan)}, "utf8"));
const key = args[0] === "--version" ? "--version" : args.slice(0, 2).join(" ");
let answer = plan[key];
if (Array.isArray(answer)) {
	let counts = {};
	try { counts = JSON.parse(fs.readFileSync(${JSON.stringify(counts)}, "utf8")); } catch {}
	const used = counts[key] ?? 0;
	counts[key] = used + 1;
	fs.writeFileSync(${JSON.stringify(counts)}, JSON.stringify(counts));
	answer = answer[Math.min(used, answer.length - 1)];
}
if (!answer) {
	process.stderr.write("fake gh: nothing planned for " + key + "\\n");
	process.exit(99);
}
const finish = () => {
	if (answer.stdout) process.stdout.write(answer.stdout);
	if (answer.stderr) process.stderr.write(answer.stderr);
	process.exitCode = answer.exit ?? 0;
};
if (answer.sleepMs) setTimeout(finish, answer.sleepMs);
else finish();
`;

export async function installFakeGh(root: string): Promise<FakeGh> {
	const dir = join(root, "fake-gh-bin");
	await mkdir(dir, { recursive: true });
	const plan = join(root, "fake-gh-plan.json");
	const log = join(root, "fake-gh-log.jsonl");
	const counts = join(root, "fake-gh-counts.json");
	const bin = join(dir, "gh");
	await writeFile(bin, SCRIPT(plan, log, counts));
	await chmod(bin, 0o755);
	await writeFile(plan, "{}");
	await writeFile(log, "");
	const original = process.env.PATH ?? "";
	const withoutGh = original
		.split(delimiter)
		.filter((entry) => entry && !existsSync(join(entry, "gh")))
		.join(delimiter);
	return {
		dir,
		async setPlan(next) {
			await writeFile(plan, JSON.stringify(next));
			await writeFile(counts, "{}");
		},
		async calls() {
			const text = await readFile(log, "utf8");
			return text
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as FakeGhCall);
		},
		async clearCalls() {
			await writeFile(log, "");
		},
		activate() {
			process.env.PATH = `${dir}${delimiter}${withoutGh}`;
		},
		hideAll() {
			process.env.PATH = withoutGh;
		},
		restore() {
			process.env.PATH = original;
		},
	};
}

/** `gh repo view --json …` for a repository gh may write to. */
export function repoViewJson(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		viewerPermission: "WRITE",
		mergeCommitAllowed: true,
		squashMergeAllowed: true,
		rebaseMergeAllowed: false,
		viewerDefaultMergeMethod: "SQUASH",
		isArchived: false,
		...overrides,
	});
}

/** `gh auth status --json hosts` logged in to `host`. */
export function authJson(host: string, state = "success"): string {
	return JSON.stringify({ hosts: { [host]: [{ state, active: true, host, login: "octo" }] } });
}

/** The answers of a usable gh for github.com/acme/app. */
export function usableGh(host = "github.com"): FakeGhPlan {
	return {
		"--version": { stdout: "gh version 2.89.0 (2026-03-26)\n" },
		"auth status": { stdout: authJson(host) },
		"repo view": { stdout: repoViewJson() },
	};
}
