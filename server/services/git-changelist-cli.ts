import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { GIT_STAGING_LIMITS, type GitStagingAction } from "../../shared/git-staging-lists";
import {
	gitStagingActionSchema,
	gitStagingDiffQuerySchema,
	gitStagingFilesQuerySchema,
	gitStagingListIdSchema,
} from "../lib/validators/git";
import { executeGitStagingWork } from "./git-staging-lists-service";
import type { GitStagingWork } from "./git-staging-worker";

const COMMANDS = new Set([
	"init",
	"sync",
	"list",
	"files",
	"diff",
	"create",
	"rename",
	"activate",
	"move",
	"delete",
	"commit",
	"recover",
]);
const VALUE_FLAGS = new Set([
	"workspace",
	"list",
	"cursor",
	"limit",
	"path",
	"old-path",
	"name",
	"from",
	"to",
	"unit",
	"message",
	"operation",
	"generation",
	"observation",
	"paths-file",
	"paths0-file",
	"json-input",
	"filter",
	"directory",
]);

export function isGitChangelistCli(argv: readonly string[]): boolean {
	return argv[2] === "changelists";
}

class CliError extends Error {
	readonly code = "GIT_CHANGELISTS_ARGUMENT";
}

async function boundedInput(path: string): Promise<Uint8Array> {
	if (path !== "-") {
		const info = await stat(path);
		if (!info.isFile() || info.size > GIT_STAGING_LIMITS.maxRequestBytes)
			throw new CliError("Input must be a file within the request byte limit");
		const bytes = await readFile(path);
		if (bytes.length > GIT_STAGING_LIMITS.maxRequestBytes)
			throw new CliError("Input exceeds request byte limit");
		return bytes;
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = Bun.stdin.stream().getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > GIT_STAGING_LIMITS.maxRequestBytes) {
				await reader.cancel();
				throw new CliError("Input exceeds request byte limit");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks);
}

export async function parseGitChangelistCli(args: readonly string[]): Promise<GitStagingWork> {
	if (Buffer.byteLength(JSON.stringify(args)) > GIT_STAGING_LIMITS.maxRequestBytes)
		throw new CliError("Arguments exceed request byte limit");
	const flags = new Map<string, string[]>();
	let command: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg) continue;
		if (!arg.startsWith("--")) {
			if (command || !COMMANDS.has(arg))
				throw new CliError(`Unknown command or positional argument: ${arg}`);
			command = arg;
			continue;
		}
		const key = arg.slice(2);
		if (key === "all") {
			if (flags.has(key)) throw new CliError("Duplicate --all");
			flags.set(key, ["true"]);
			continue;
		}
		if (!VALUE_FLAGS.has(key)) throw new CliError(`Unknown option: ${arg}`);
		const value = args[++i];
		if (value === undefined) throw new CliError(`Missing value for ${arg}`);
		const values = flags.get(key) ?? [];
		if (values.length && key !== "path" && key !== "unit") throw new CliError(`Duplicate ${arg}`);
		values.push(value);
		flags.set(key, values);
	}
	if (!command) throw new CliError("A changelists command is required");
	const take = (key: string, required = false) => {
		if ((flags.get(key)?.length ?? 0) > 1) throw new CliError(`Duplicate --${key}`);
		const value = flags.get(key)?.[0];
		flags.delete(key);
		if (required && value === undefined) throw new CliError(`--${key} is required`);
		return value;
	};
	const workspace = take("workspace", true) as string;
	if (!workspace) throw new CliError("--workspace must not be empty");
	const base = { cwd: resolve(workspace), workspaceKey: "offline" };
	const done = <T extends GitStagingWork>(work: T): T => {
		if (flags.size)
			throw new CliError(`Options do not apply to ${command}: ${[...flags.keys()].join(", ")}`);
		return work;
	};
	if (command === "list") return done({ ...base, method: "summary" });
	if (command === "files") {
		const listId = gitStagingListIdSchema.parse(take("list", true));
		const parsed = gitStagingFilesQuerySchema.parse({
			workspaceKey: base.workspaceKey,
			cursor: take("cursor"),
			limit: take("limit"),
			filter: take("filter"),
		});
		return done({
			...base,
			method: "files",
			listId,
			options: { cursor: parsed.cursor, limit: parsed.limit, filter: parsed.filter },
		});
	}
	if (command === "diff") {
		const listId = gitStagingListIdSchema.parse(take("list", true));
		const options = gitStagingDiffQuerySchema.parse({
			workspaceKey: base.workspaceKey,
			path: take("path", true),
			oldPath: take("old-path"),
		});
		return done({ ...base, method: "diff", listId, options });
	}
	let action: Record<string, unknown> = { action: command, workspaceKey: base.workspaceKey };
	const jsonInput = take("json-input");
	if (jsonInput !== undefined) {
		const input: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(await boundedInput(jsonInput)),
		);
		if (!input || typeof input !== "object" || Array.isArray(input))
			throw new CliError("JSON input must be an action object");
		action = { ...input, workspaceKey: base.workspaceKey };
		if (action.action !== command) throw new CliError("JSON action must match the command");
	} else {
		if (command !== "init" && command !== "sync") {
			const generation = take("generation", true) as string;
			if (!/^(0|[1-9]\d*)$/.test(generation))
				throw new CliError("--generation must be a nonnegative integer");
			action.expectedGeneration = Number(generation);
			action.observationId = take("observation", true);
		}
		if (["files", "rename", "activate", "delete", "commit"].includes(command))
			action.listId = take("list", true);
		if (command === "create" || command === "rename") action.name = take("name", true);
		if (command === "commit") action.message = take("message", true);
		if (command === "recover") action.operationId = take("operation", true);
		if (command === "move") {
			action.fromListId = take("from", true);
			action.toListId = take("to", true);
			const unitIds = flags.get("unit");
			flags.delete("unit");
			const paths = flags.get("path");
			flags.delete("path");
			if (unitIds) action.unitIds = unitIds;
			if (paths) action.paths = paths;
			const pathsFile = take("paths-file");
			const paths0 = take("paths0-file");
			if (pathsFile !== undefined || paths0 !== undefined) {
				if (paths || (pathsFile !== undefined && paths0 !== undefined))
					throw new CliError("Choose one paths input");
				const text = new TextDecoder("utf-8", { fatal: true }).decode(
					await boundedInput(pathsFile ?? (paths0 as string)),
				);
				if (paths0 !== undefined && !text.endsWith("\0"))
					throw new CliError("NUL paths input must end with NUL");
				action.paths = pathsFile !== undefined ? JSON.parse(text) : text.slice(0, -1).split("\0");
			}
			if (take("all") !== undefined) action.all = true;
			const filter = take("filter");
			const directory = take("directory");
			if (filter !== undefined || directory !== undefined)
				action.scope = {
					...(filter !== undefined ? { filter: [...filter] } : {}),
					...(directory !== undefined ? { directory } : {}),
				};
		}
	}
	const { workspaceKey: _workspaceKey, ...request } = gitStagingActionSchema.parse(action);
	return done({
		...base,
		method: "action",
		request:
			request.action === "create"
				? { ...request, listId: randomUUID() }
				: (request as GitStagingAction),
	});
}

export async function runGitChangelistCli(argv: readonly string[] = process.argv): Promise<number> {
	try {
		const request = await parseGitChangelistCli(argv.slice(3));
		const result = await executeGitStagingWork(request);
		process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
		return 0;
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error
				? String(error.code)
				: error instanceof Error && error.name === "ZodError"
					? "GIT_CHANGELISTS_ARGUMENT"
					: "GIT_CHANGELISTS_FAILED";
		process.stderr.write(
			`${JSON.stringify({ ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } })}\n`,
		);
		return 1;
	}
}
