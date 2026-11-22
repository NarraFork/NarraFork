import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_STAGING_UNASSIGNED_LIST_ID } from "../../../shared/git-staging-lists";
import { isGitChangelistCli, parseGitChangelistCli } from "../git-changelist-cli";

const workspace = ["--workspace", "/fixture"];
const version = ["--generation", "2", "--observation", "observed"];
test("an empty workspace is rejected rather than resolving to the current directory", async () => {
	await expect(parseGitChangelistCli(["--workspace", "", "list"])).rejects.toThrow("workspace");
	expect(await parseGitChangelistCli(["--workspace", ".", "list"])).toMatchObject({
		cwd: process.cwd(),
		method: "summary",
	});
});

test("source and compiled argument layouts select the offline entry without matching option values", () => {
	expect(isGitChangelistCli(["bun", "server/index.ts", "changelists", ...workspace, "list"])).toBe(
		true,
	);
	expect(isGitChangelistCli(["narrafork", "narrafork", "changelists", ...workspace, "list"])).toBe(
		true,
	);
	expect(isGitChangelistCli(["bun", "server/index.ts", "--name", "changelists"])).toBe(false);
});
test("reads are independent Worker requests and never become sync actions", async () => {
	expect(await parseGitChangelistCli([...workspace, "list"])).toEqual({
		cwd: "/fixture",
		workspaceKey: "offline",
		method: "summary",
	});
	expect(
		await parseGitChangelistCli([
			"files",
			...workspace,
			"--list",
			"A",
			"--limit",
			"100",
			"--filter",
			"MA",
		]),
	).toMatchObject({ method: "files", listId: "A", options: { limit: 100, filter: ["M", "A"] } });
	expect(
		await parseGitChangelistCli([...workspace, "diff", "--list", "A", "--path", "a\nb"]),
	).toMatchObject({ method: "diff", options: { path: "a\nb" } });
});
test("source-group move selectors remain structured and versioned", async () => {
	const base = [...workspace, "move", ...version, "--from", "A", "--to", "B"];
	expect(
		await parseGitChangelistCli([...base, "--unit", "file:unit:one", "--unit", "file:unit:two"]),
	).toMatchObject({
		method: "action",
		request: {
			action: "move",
			expectedGeneration: 2,
			observationId: "observed",
			fromListId: "A",
			toListId: "B",
			unitIds: ["file:unit:one", "file:unit:two"],
		},
	});
	expect(await parseGitChangelistCli([...base, "--all"])).toMatchObject({ request: { all: true } });
	expect(
		await parseGitChangelistCli([...base, "--filter", "M", "--directory", "dir"]),
	).toMatchObject({ request: { scope: { filter: ["M"], directory: "dir" } } });
	for (const flags of [
		[],
		["--filter", ""],
		["--all", "--path", "file"],
		["--path", "../outside"],
		["--unit", "a", "--unit", "a"],
	])
		await expect(parseGitChangelistCli([...base, ...flags])).rejects.toThrow();
	expect(await parseGitChangelistCli([...base, "--path", "a:b.txt"])).toMatchObject({
		request: { paths: ["a:b.txt"] },
	});
	expect(
		await parseGitChangelistCli([...workspace, "diff", "--list", "A", "--path", "a:b.txt"]),
	).toMatchObject({
		options: { path: "a:b.txt" },
	});
});
test("automatic grouping uses sync and validated versioned same-list moves", async () => {
	expect(await parseGitChangelistCli([...workspace, "sync"])).toMatchObject({
		method: "action",
		request: { action: "sync" },
	});
	expect(
		await parseGitChangelistCli([
			...workspace,
			"move",
			...version,
			"--from",
			GIT_STAGING_UNASSIGNED_LIST_ID,
			"--to",
			GIT_STAGING_UNASSIGNED_LIST_ID,
			"--unit",
			"reviewed:file:unit",
		]),
	).toMatchObject({
		method: "action",
		request: {
			action: "move",
			fromListId: GIT_STAGING_UNASSIGNED_LIST_ID,
			toListId: GIT_STAGING_UNASSIGNED_LIST_ID,
			unitIds: ["reviewed:file:unit"],
			expectedGeneration: 2,
			observationId: "observed",
		},
	});
	await expect(
		parseGitChangelistCli([
			...workspace,
			"create",
			...version,
			"--name",
			"Unassigned",
			"--list",
			GIT_STAGING_UNASSIGNED_LIST_ID,
		]),
	).rejects.toThrow();
	await expect(parseGitChangelistCli([...workspace, "sync", "--all"])).rejects.toThrow();
});
test("JSON and NUL path manifests preserve whitespace, shell punctuation and newlines", async () => {
	const root = await mkdtemp(join(tmpdir(), "nf-cli-input-"));
	try {
		const paths = [" space file ", "line\nbreak", "-option", "$(literal);name"];
		const json = join(root, "paths.json");
		const nul = join(root, "paths.nul");
		await writeFile(json, JSON.stringify(paths));
		await writeFile(nul, `${paths.join("\0")}\0`);
		const base = [...workspace, "move", ...version, "--from", "A", "--to", "B"];
		for (const flags of [
			["--paths-file", json],
			["--paths0-file", nul],
		])
			expect(await parseGitChangelistCli([...base, ...flags])).toMatchObject({
				request: { paths },
			});
		await writeFile(nul, "unterminated");
		await expect(parseGitChangelistCli([...base, "--paths0-file", nul])).rejects.toThrow(
			"end with NUL",
		);
		await writeFile(
			json,
			JSON.stringify({
				action: "rename",
				listId: "A",
				name: "renamed",
				expectedGeneration: 2,
				observationId: "observed",
			}),
		);
		expect(
			await parseGitChangelistCli([...workspace, "rename", "--json-input", json]),
		).toMatchObject({ request: { action: "rename", name: "renamed" } });
		await expect(
			parseGitChangelistCli([...workspace, "create", "--json-input", json]),
		).rejects.toThrow("match");
		await expect(
			parseGitChangelistCli([...workspace, "rename", "--json-input", json, "--name", "ambiguous"]),
		).rejects.toThrow("do not apply");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test("unsupported, duplicate, irrelevant and unversioned arguments fail explicitly", async () => {
	for (const args of [
		[],
		["list"],
		[...workspace, "stage"],
		[...workspace, "list", "--unknown", "value"],
		[...workspace, "list", "--all"],
		[...workspace, "diff", "--list", "A", "--path", "first", "--path", "second"],
		[...workspace, "list", "--workspace", "/duplicate"],
		[...workspace, "create", "--name", "A"],
		[
			...workspace,
			"rename",
			"--generation",
			"1.2",
			"--observation",
			"id",
			"--list",
			"A",
			"--name",
			"B",
		],
	])
		await expect(parseGitChangelistCli(args)).rejects.toThrow();
});
