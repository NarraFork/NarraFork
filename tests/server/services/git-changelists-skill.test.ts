import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { safeSpawn } from "../../../server/lib/spawn";
import { gitStagingActionSchema } from "../../../server/lib/validators/git";
import { loadProjectSkillByName, loadProjectSkills } from "../../../server/services/skill-service";
import {
	GIT_STAGING_UNASSIGNED_LIST_ID,
	GIT_STAGING_UNASSIGNED_LIST_NAME,
	type GitStagingActionResult,
	type GitStagingDiff,
	type GitStagingFilesPage,
	type GitStagingSummary,
	type GitStagingVersion,
} from "../../../shared/git-staging-lists";

const repository = resolve(import.meta.dir, "../../..");
const skillRelative = ".agents/skills/git-changelists/SKILL.md";
let fixture: string;
let raw: string;
let protocol: string;

function codeBlocks(text: string, language: string): string[] {
	return [
		...text.matchAll(
			new RegExp(`\u0060\u0060\u0060${language}\\n([\\s\\S]*?)\u0060\u0060\u0060`, "g"),
		),
	].map((match) => match[1] ?? "");
}

function versionArgs(version: GitStagingVersion): string[] {
	expect(version.observationId).toBeString();
	return ["--generation", String(version.generation), "--observation", version.observationId ?? ""];
}

function commandEnv(home: string): Record<string, string | undefined> {
	return {
		...Object.fromEntries(
			Object.entries(process.env).filter(
				([key]) =>
					!key.startsWith("GIT_") &&
					!key.startsWith("NF_") &&
					!key.startsWith("NARRAFORK_") &&
					key !== "DATABASE_URL" &&
					key !== "BUN_OPTIONS" &&
					key !== "NODE_OPTIONS",
			),
		),
		HOME: home,
		NARRAFORK_HOME: join(home, "application"),
		NARRAFORK_ALLOW_MULTIPLE: "1",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_OPTIONAL_LOCKS: "0",
	};
}

async function runCommand(root: string, home: string, cmd: string[]) {
	return safeSpawn({
		cmd,
		cwd: root,
		env: commandEnv(home),
		timeout: 15_000,
		maxOutputBytes: 512 * 1024,
	});
}

async function git(root: string, home: string, ...args: string[]): Promise<string> {
	const result = await runCommand(root, home, ["git", "--literal-pathspecs", ...args]);
	expect(result.exitCode, result.stderr).toBe(0);
	return result.stdout.trim();
}

async function cliRaw(root: string, home: string, args: string[]) {
	return runCommand(repository, home, [
		process.execPath,
		join(repository, "server/index.ts"),
		"changelists",
		"--workspace",
		root,
		...args,
	]);
}

async function cli<T>(root: string, home: string, args: string[]): Promise<T> {
	const result = await cliRaw(root, home, args);
	expect(result.exitCode, result.stderr).toBe(0);
	const output = JSON.parse(result.stdout) as { ok: boolean; result: T };
	expect(output.ok).toBe(true);
	return output.result;
}

interface ReadonlyObservation {
	workspace: Array<{
		generation: number;
		observation_id: string | null;
		active_list_id: string;
		head_oid: string | null;
		state: string;
	}>;
	lists: Array<{ id: string; name: string; active: number; unit_count: number }>;
	changes: Array<{
		file_id: string;
		path: string;
		unit_id: string;
		list_id: string;
		added: number;
		removed: number;
		needs_review: number;
		review_reason: string | null;
	}>;
}

async function readDocumentedObservation(
	root: string,
	home: string,
	gitDir: string,
): Promise<ReadonlyObservation> {
	const query = codeBlocks(raw, "sh").find((block) =>
		block.includes("new Database(process.argv[1]"),
	);
	expect(query).toBeDefined();
	const result = await safeSpawn({
		cmd: ["bash", "-euc", query ?? ""],
		cwd: repository,
		env: { ...commandEnv(home), ROOT: root, ACTUAL_GIT_DIR: gitDir },
		timeout: 15_000,
		maxOutputBytes: 512 * 1024,
	});
	expect(result.exitCode, result.stderr).toBe(0);
	return JSON.parse(result.stdout) as ReadonlyObservation;
}

beforeAll(async () => {
	fixture = await mkdtemp(join(tmpdir(), "nf-git-changelists-skill-"));
	for (const relative of [skillRelative, "docs/GIT_STAGING_LISTS.md", "AGENTS.md"]) {
		const target = join(fixture, relative);
		await mkdir(dirname(target), { recursive: true });
		await copyFile(join(repository, relative), target);
	}
	raw = await readFile(join(fixture, skillRelative), "utf8");
	protocol = await readFile(join(fixture, "docs/GIT_STAGING_LISTS.md"), "utf8");
});

afterAll(async () => {
	if (fixture) await rm(fixture, { recursive: true, force: true });
});

test("project scanner discovers the dynamic changelist skill without installation", async () => {
	const skills = await loadProjectSkills(fixture);
	expect(skills.map((skill) => skill.name)).toEqual(["git-changelists"]);
	const skill = await loadProjectSkillByName(fixture, "git-changelists");
	expect(skill?.location).toBe(join(fixture, skillRelative));
	expect(skill?.description).toContain("动态变更分组");
	expect(skill?.description).toContain("普通 Git 操作不自动改用分组");
	expect(skill?.content.startsWith("# 动态变更分组")).toBe(true);
	expect(skill?.content).not.toContain("\nname:");
	expect(skill?.files).toEqual([]);
});

test("skill protocol links, anchors and AGENTS entry resolve inside the fixture", async () => {
	const links = [...raw.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1] ?? "");
	expect(links.length).toBeGreaterThan(8);
	for (const link of links) {
		const [relative, fragment] = link.split("#");
		const target = resolve(dirname(join(fixture, skillRelative)), relative ?? "");
		expect(target).toBe(join(fixture, "docs/GIT_STAGING_LISTS.md"));
		expect((await stat(target)).isFile()).toBe(true);
		if (fragment) {
			const anchors = [...protocol.matchAll(/^#{1,6} (.+)$/gm)].map((heading) =>
				(heading[1] ?? "")
					.toLowerCase()
					.replace(/[^\p{L}\p{N}_ -]/gu, "")
					.replaceAll(" ", "-"),
			);
			expect(anchors).toContain(fragment);
		}
	}
	const agents = await readFile(join(fixture, "AGENTS.md"), "utf8");
	expect(agents).toContain(`](${skillRelative})`);
	expect(agents).toContain("changelists.sqlite");
	expect(agents).toContain("不直接 SQL 写归属");
});

test("protocol defines offline freshness, unique ownership, authorization and recovery", () => {
	for (const term of [
		"v_workspace_state",
		"v_changelists",
		"v_changes",
		"generation",
		"observationId",
		"readonly: true",
		"immutable=1",
		"operationId",
		"commitOid",
		"明确授权",
		"ITA",
		"fence_token",
		"SHA256",
		"lease",
	]) {
		expect(raw).toContain(term);
		expect(protocol).toContain(term);
	}
	expect(protocol).toContain("sqlite3 -readonly");
	expect(protocol).toContain("--paths0-file");
	expect(protocol).toContain("--json-input");
	expect(protocol).toContain("GIT_STAGING_INITIALIZATION_INCOMPLETE");
	expect(protocol).toContain("PERSIST_WAL");
	expect(protocol).toContain("commit-<fenceToken>.receipt.json");
	expect(protocol).toContain("读命令默认查询最后一次完成的观察");
	expect(raw).toContain("当前活动组不可删除");
	expect(raw).toContain("不复制版本");
	expect(raw).not.toContain("write-tree");
	expect(raw).not.toContain("retrySave");
	expect(raw).not.toContain("lists/<id>.json");
});

test("protocol documents automatic ownership and compatible sync upgrades", () => {
	for (const text of [raw, protocol]) {
		expect(text).toContain(GIT_STAGING_UNASSIGNED_LIST_ID);
		expect(text).toContain("MERGE_HEAD");
		expect(text).toContain("未分组");
		expect(text).toContain("同组");
		expect(text).toContain("v1");
	}
});

test("documented commands match validated actions and literal path examples parse", () => {
	const commands = [...protocol.matchAll(/^\| `([a-z]+)`(?: \/ `([a-z]+)`)? \|/gm)].flatMap(
		(match) => [match[1], match[2]].filter((command): command is string => !!command),
	);
	const actions = gitStagingActionSchema.options.map((option) => option.shape.action.value);
	expect(commands.sort()).toEqual([...actions, "list", "files", "diff"].sort());
	const [paths] = codeBlocks(protocol, "json").map((block) => JSON.parse(block));
	expect(paths).toEqual(["src/login.ts", "中文 空格\t换行\n文件.txt", ":(glob)*.txt"]);
	const query = (text: string) =>
		codeBlocks(text, "sh").find((block) => block.includes("new Database(process.argv[1]"));
	expect(query(protocol)).toBe(query(raw));
});

test("documented CLI and readonly SQL preserve partial staging, paths and worktree offline", async () => {
	const root = join(fixture, "cli repository");
	const home = join(fixture, "offline home");
	await mkdir(root);
	const appHome = join(home, "application");
	await mkdir(appHome, { recursive: true });
	const mainDatabase = Buffer.from("This is deliberately not a NarraFork main SQLite database.\n");
	await writeFile(join(appHome, "narrafork.db"), mainDatabase);
	await git(root, home, "init", "--quiet", root);
	const paths = [
		"note.txt",
		"native.txt",
		"空格 tab\t换行\nquote'\".txt",
		"--option.txt",
		":(glob)*.txt",
	];
	const baseLines = Array.from({ length: 24 }, (_, index) => `line ${index + 1}\n`);
	for (const path of paths) {
		await writeFile(join(root, path), path === "note.txt" ? baseLines.join("") : "base\n");
	}
	await git(root, home, "add", "--", ...paths);
	await git(
		root,
		home,
		"-c",
		"user.name=Skill Fixture",
		"-c",
		"user.email=skill@example.test",
		"commit",
		"--quiet",
		"-m",
		"Fixture base",
	);
	const headBefore = await git(root, home, "rev-parse", "HEAD");
	const gitDir = await git(root, home, "rev-parse", "--absolute-git-dir");
	await writeFile(join(root, "native.txt"), "native staged\n");
	await git(root, home, "add", "--", "native.txt");
	await writeFile(join(root, "native.txt"), "native working\n");
	const changedLines = [...baseLines];
	changedLines[1] = "first task\n";
	changedLines[20] = "second task\n";
	await writeFile(join(root, "note.txt"), changedLines.join(""));
	for (const path of paths.slice(2)) await writeFile(join(root, path), "changed\n");
	const nativeBefore = await readFile(join(gitDir, "index"));
	const workBefore = new Map(
		await Promise.all(paths.map(async (path) => [path, await readFile(join(root, path))] as const)),
	);

	// Unreadable old metadata would fail if init tried to interpret it.
	const storage = join(gitDir, "narrafork/changelists");
	await mkdir(join(storage, "lists"), { recursive: true });
	await mkdir(join(storage, "indexes"));
	const oldMetadata = "not JSON; preserve this existing file\n";
	const oldIndex = Buffer.from("existing private index bytes\n");
	await writeFile(join(storage, "lists/old-group.json"), oldMetadata);
	await writeFile(join(storage, "indexes/old-group.index"), oldIndex);
	const oldRef = "refs/narrafork/changelists/fixture/old-group/base";
	await git(root, home, "update-ref", oldRef, headBefore);

	const initCommands = codeBlocks(raw, "sh").find((block) => block.includes('"$ROOT" init'));
	expect(initCommands).toBeDefined();
	const initialized = await safeSpawn({
		cmd: ["bash", "-euc", initCommands ?? ""],
		cwd: repository,
		env: { ...commandEnv(home), ROOT: root, ACTUAL_GIT_DIR: gitDir },
		timeout: 30_000,
		maxOutputBytes: 512 * 1024,
	});
	expect(initialized.exitCode, initialized.stderr).toBe(0);
	const summary = await cli<GitStagingSummary>(root, home, ["list"]);
	expect(summary.initialized).toBe(true);
	expect(summary.state).toBe("ready");
	expect(summary.observationId).toBeString();
	expect(summary.scannedAt).toBeNumber();
	expect(summary.lists).toHaveLength(1);
	const original = summary.lists[0];
	expect(original?.name).toBe("Changes");
	expect(original?.active).toBe(true);
	expect(original?.snapshotVersion).toBeString();
	expect(original?.fileCount).toBe(paths.length);
	const from = original?.id ?? "";
	expect(summary.activeListId).toBe(from);

	const observed = await readDocumentedObservation(root, home, gitDir);
	expect(observed.workspace[0]?.generation).toBe(summary.generation);
	expect(observed.workspace[0]?.observation_id).toBe(summary.observationId);
	expect(observed.lists.map((list) => list.name)).toEqual(["Changes"]);
	expect(new Set(observed.changes.map((change) => change.path))).toEqual(new Set(paths));
	expect(observed.changes.every((change) => change.list_id === from)).toBe(true);
	const unitsBefore = observed.changes.length;
	const totalsBefore = observed.changes.reduce(
		(total, change) => [total[0] + change.added, total[1] + change.removed],
		[0, 0],
	);
	const db = new Database(join(storage, "changelists.sqlite"), { readonly: true });
	try {
		expect(db.query("PRAGMA application_id").get()).toEqual({ application_id: 0x4e46434c });
		expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
		expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
		for (const view of ["v_workspace_state", "v_changelists", "v_changes"]) {
			const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${view})`).all();
			for (const column of columns) expect(protocol).toContain(`\u0060${column.name}\u0060`);
		}
	} finally {
		db.close();
	}

	const storageBefore = await Promise.all(
		["changelists.sqlite", "changelists.sqlite-wal"].map(async (name) => {
			const path = join(storage, name);
			return { path, bytes: await readFile(path), identity: await stat(path, { bigint: true }) };
		}),
	);
	const unchanged = await cli<GitStagingActionResult>(root, home, ["sync"]);
	expect(unchanged.generation).toBe(summary.generation);
	expect(unchanged.observationId).toBe(summary.observationId);
	await cli<GitStagingSummary>(root, home, ["list"]);
	await cli<GitStagingFilesPage>(root, home, ["files", "--list", from, "--limit", "1"]);
	for (const previous of storageBefore) {
		expect(await readFile(previous.path)).toEqual(previous.bytes);
		const identity = await stat(previous.path, { bigint: true });
		expect([identity.ino, identity.size, identity.mtimeNs]).toEqual([
			previous.identity.ino,
			previous.identity.size,
			previous.identity.mtimeNs,
		]);
	}

	const created = await cli<GitStagingActionResult>(root, home, [
		"create",
		"--name",
		"修复 登录",
		...versionArgs(summary),
	]);
	expect(created.outcome).toBe("applied");
	expect(created.listId).toBeString();
	const to = created.listId ?? "";
	const note = await cli<GitStagingDiff>(root, home, [
		"diff",
		"--list",
		from,
		"--path",
		"note.txt",
	]);
	expect(note.units.length).toBeGreaterThanOrEqual(2);
	expect(note.snapshotVersion).toBe(original?.snapshotVersion);
	const selected = note.units[0]?.id ?? "";
	let current = await cli<GitStagingActionResult>(root, home, [
		"move",
		"--from",
		from,
		"--to",
		to,
		"--unit",
		selected,
		...versionArgs(created),
	]);
	const split = await readDocumentedObservation(root, home, gitDir);
	expect(split.changes.find((change) => change.unit_id === selected)?.list_id).toBe(to);
	expect(
		split.changes.some((change) => change.path === "note.txt" && change.list_id === from),
	).toBe(true);
	const toPage = await cli<GitStagingFilesPage>(root, home, [
		"files",
		"--list",
		to,
		"--limit",
		"1",
	]);
	expect(toPage.files.map((file) => file.path)).toEqual(["note.txt"]);
	expect(toPage.generation).toBe(current.generation);
	expect(toPage.snapshotVersion).toBeString();

	const moveCommands = codeBlocks(raw, "sh").find((block) => block.includes('--path "$FILE_PATH"'));
	expect(moveCommands).toBeDefined();
	const documentedMove = await safeSpawn({
		cmd: ["bash", "-euc", moveCommands ?? ""],
		cwd: repository,
		env: {
			...commandEnv(home),
			ROOT: root,
			FROM: from,
			TO: to,
			FILE_PATH: "native.txt",
			GENERATION: String(current.generation),
			OBSERVATION: current.observationId ?? "",
		},
		timeout: 30_000,
		maxOutputBytes: 512 * 1024,
	});
	expect(documentedMove.exitCode, documentedMove.stderr).toBe(0);
	const movedOutputs = documentedMove.stdout
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(movedOutputs.every((output) => output.ok === true)).toBe(true);
	current = movedOutputs.at(-1)?.result as GitStagingActionResult;
	expect(current.outcome).toBe("applied");

	const nulPaths = join(fixture, "literal paths.nul");
	await writeFile(nulPaths, `${paths[2]}\0${paths[3]}\0`);
	current = await cli<GitStagingActionResult>(root, home, [
		"move",
		"--from",
		from,
		"--to",
		to,
		"--paths0-file",
		nulPaths,
		...versionArgs(current),
	]);
	const jsonPaths = join(fixture, "literal paths.json");
	await writeFile(jsonPaths, JSON.stringify([paths[4]]));
	current = await cli<GitStagingActionResult>(root, home, [
		"move",
		"--from",
		from,
		"--to",
		to,
		"--paths-file",
		jsonPaths,
		...versionArgs(current),
	]);
	const beforeRename = await cli<GitStagingSummary>(root, home, ["list"]);
	const renameInput = join(fixture, "rename action.json");
	await writeFile(
		renameInput,
		JSON.stringify({
			action: "rename",
			listId: to,
			name: "修复 登录与路径",
			expectedGeneration: current.generation,
			observationId: current.observationId,
		}),
	);
	current = await cli<GitStagingActionResult>(root, home, ["rename", "--json-input", renameInput]);
	const afterRename = await cli<GitStagingSummary>(root, home, ["list"]);
	expect(afterRename.generation).toBeGreaterThan(beforeRename.generation);
	for (const list of beforeRename.lists) {
		expect(afterRename.lists.find((item) => item.id === list.id)?.snapshotVersion).toBe(
			list.snapshotVersion,
		);
	}
	const moved = await readDocumentedObservation(root, home, gitDir);
	expect(moved.lists.find((list) => list.id === to)?.name).toBe("修复 登录与路径");
	expect(moved.changes).toHaveLength(unitsBefore);
	for (const path of paths.slice(2)) {
		expect(
			moved.changes.filter((change) => change.path === path).map((change) => change.list_id),
		).toEqual([to]);
	}
	expect(
		moved.changes.reduce(
			(total, change) => [total[0] + change.added, total[1] + change.removed],
			[0, 0],
		),
	).toEqual(totalsBefore);
	expect(new Set(moved.changes.map((change) => change.unit_id)).size).toBe(unitsBefore);
	const stale = await cliRaw(root, home, [
		"move",
		"--from",
		from,
		"--to",
		to,
		"--path",
		"native.txt",
		...versionArgs(summary),
	]);
	expect(stale.exitCode).toBe(1);
	expect(JSON.parse(stale.stderr).error.code).toBe("GIT_STAGING_STALE_VERSION");
	expect((await cli<GitStagingSummary>(root, home, ["list"])).generation).toBe(current.generation);

	// Switching changes the receiver for subsequently observed edits, not old units.
	current = await cli<GitStagingActionResult>(root, home, ["sync"]);
	current = await cli<GitStagingActionResult>(root, home, [
		"activate",
		"--list",
		to,
		...versionArgs(current),
	]);
	const newPath = "new 独立块.txt";
	await writeFile(join(root, newPath), "new active change\n");
	workBefore.set(newPath, await readFile(join(root, newPath)));
	const cached = await cli<GitStagingSummary>(root, home, ["list"]);
	expect(cached.generation).toBe(current.generation);
	expect(
		(await readDocumentedObservation(root, home, gitDir)).changes.some((c) => c.path === newPath),
	).toBe(false);
	current = await cli<GitStagingActionResult>(root, home, ["sync"]);
	const refreshed = await readDocumentedObservation(root, home, gitDir);
	expect(refreshed.changes.find((change) => change.path === newPath)?.list_id).toBe(to);
	expect(
		refreshed.changes.some((change) => change.path === "note.txt" && change.list_id === from),
	).toBe(true);

	const refusedCommit = await cliRaw(root, home, [
		"commit",
		"--list",
		to,
		"--message",
		"Fixture commit protection",
		...versionArgs(current),
	]);
	expect(refusedCommit.exitCode).toBe(1);
	expect(JSON.parse(refusedCommit.stderr).error.code).toMatch(/INDEX|STAGED|NATIVE/);
	expect(await git(root, home, "rev-parse", "HEAD")).toBe(headBefore);
	const activeDelete = await cliRaw(root, home, ["delete", "--list", to, ...versionArgs(current)]);
	expect(activeDelete.exitCode).toBe(1);
	expect(JSON.parse(activeDelete.stderr).error.code).toMatch(/ACTIVE/);

	current = await cli<GitStagingActionResult>(root, home, [
		"delete",
		"--list",
		from,
		...versionArgs(current),
	]);
	const deleted = await readDocumentedObservation(root, home, gitDir);
	expect(deleted.lists.map((list) => list.id)).toEqual([to]);
	expect(deleted.changes.length).toBe(refreshed.changes.length);
	expect(deleted.changes.every((change) => change.list_id === to)).toBe(true);
	await cli<GitStagingActionResult>(root, home, ["init"]);
	const repeated = await cli<GitStagingSummary>(root, home, ["list"]);
	expect(repeated.lists.map((list) => list.id)).toEqual([to]);
	expect(repeated.activeListId).toBe(to);

	expect(await readFile(join(gitDir, "index"))).toEqual(nativeBefore);
	for (const [path, content] of workBefore)
		expect(await readFile(join(root, path))).toEqual(content);
	expect(await readFile(join(storage, "lists/old-group.json"), "utf8")).toBe(oldMetadata);
	expect(await readFile(join(storage, "indexes/old-group.index"))).toEqual(oldIndex);
	expect(await git(root, home, "rev-parse", oldRef)).toBe(headBefore);
	expect(await git(root, home, "rev-parse", "HEAD")).toBe(headBefore);
	expect(await readFile(join(appHome, "narrafork.db"))).toEqual(mainDatabase);
	expect(await readdir(appHome)).toEqual(["narrafork.db"]);
	expect(await readdir(root)).not.toContain(".narrafork");
}, 90_000);

test("source CLI groups HEAD differences offline and commits ordinary and unassigned lists", async () => {
	const root = join(fixture, "head grouping repository");
	const home = join(fixture, "head grouping home");
	const appHome = join(home, "application");
	await mkdir(root);
	await mkdir(appHome, { recursive: true });
	const mainDatabase = Buffer.from("Offline grouping must not open the main database.\n");
	await writeFile(join(appHome, "narrafork.db"), mainDatabase);
	await git(root, home, "init", "--quiet", "--initial-branch=main");
	await git(root, home, "config", "user.name", "Skill Fixture");
	await git(root, home, "config", "user.email", "skill@example.test");
	await git(root, home, "config", "commit.gpgSign", "false");
	const baseIgnore = "*.log\n# exceptions\n";
	await writeFile(join(root, ".gitignore"), baseIgnore);
	await writeFile(join(root, "healthy.txt"), "healthy base\n");
	await writeFile(join(root, "absorbed.txt"), "absorbed base\n");
	await git(root, home, "add", "--", ".gitignore", "healthy.txt", "absorbed.txt");
	await git(root, home, "commit", "--quiet", "-m", "Grouping base");
	const gitDir = await git(root, home, "rev-parse", "--absolute-git-dir");
	await writeFile(join(root, ".gitignore"), `${baseIgnore}!local.log\n`);
	await writeFile(join(root, "healthy.txt"), "healthy local\n");
	await writeFile(join(root, "absorbed.txt"), "absorbed local\n");
	let current = await cli<GitStagingActionResult>(root, home, ["init"]);
	const initial = await cli<GitStagingSummary>(root, home, ["list"]);
	const healthy = initial.activeListId ?? "";
	current = await cli<GitStagingActionResult>(root, home, [
		"create",
		"--name",
		GIT_STAGING_UNASSIGNED_LIST_NAME,
		...versionArgs(current),
	]);
	const sameName = current.listId ?? "";
	const before = await cli<GitStagingSummary>(root, home, ["list"]);
	await writeFile(join(root, ".gitignore"), `${baseIgnore}!external.log\n`);
	await git(root, home, "add", "--", ".gitignore", "absorbed.txt");
	await git(root, home, "commit", "--quiet", "-m", "External same-position ignore exception");
	const externalHead = await git(root, home, "rev-parse", "HEAD");
	await writeFile(join(root, ".gitignore"), `${baseIgnore}!local.log\n`);
	const native = await readFile(join(gitDir, "index"));
	const paths = [".gitignore", "healthy.txt", "absorbed.txt"];
	const work = await Promise.all(paths.map((path) => readFile(join(root, path))));
	current = await cli<GitStagingActionResult>(root, home, ["sync"]);
	const published = await cli<GitStagingSummary>(root, home, ["list"]);
	expect(published).toMatchObject({
		state: "ready",
		activeListId: healthy,
		generation: before.generation + 1,
		observationId: current.observationId,
	});
	expect(published.lists.map((list) => list.id).sort()).toEqual(
		[healthy, sameName, GIT_STAGING_UNASSIGNED_LIST_ID].sort(),
	);
	expect(published.lists.find((list) => list.id === sameName)).toMatchObject({
		name: GIT_STAGING_UNASSIGNED_LIST_NAME,
		unitCount: 0,
	});
	const observed = await readDocumentedObservation(root, home, gitDir);
	expect(observed.workspace[0]).toMatchObject({
		head_oid: externalHead,
		state: "ready",
		generation: published.generation,
		observation_id: published.observationId,
	});
	expect(new Set(observed.changes.map((change) => change.path))).toEqual(
		new Set([".gitignore", "healthy.txt"]),
	);
	expect(observed.changes.filter((change) => change.path === ".gitignore")).toEqual([
		expect.objectContaining({
			list_id: GIT_STAGING_UNASSIGNED_LIST_ID,
			needs_review: 0,
			review_reason: null,
		}),
	]);
	expect(observed.changes.find((change) => change.path === "healthy.txt")).toMatchObject({
		list_id: healthy,
		needs_review: 0,
	});
	expect(await cli<GitStagingActionResult>(root, home, ["sync"])).toMatchObject({
		generation: current.generation,
		observationId: current.observationId,
	});
	const stale = await cliRaw(root, home, [
		"move",
		"--from",
		GIT_STAGING_UNASSIGNED_LIST_ID,
		"--to",
		healthy,
		"--path",
		".gitignore",
		...versionArgs(before),
	]);
	expect(stale.exitCode).toBe(1);
	expect(JSON.parse(stale.stderr).error.code).toBe("GIT_STAGING_STALE_VERSION");
	expect(await readFile(join(gitDir, "index"))).toEqual(native);
	expect(await Promise.all(paths.map((path) => readFile(join(root, path))))).toEqual(work);
	expect(await git(root, home, "rev-parse", "HEAD")).toBe(externalHead);
	const committed = await cli<GitStagingActionResult>(root, home, [
		"commit",
		"--list",
		healthy,
		"--message",
		"Healthy group fixture",
		...versionArgs(current),
	]);
	expect(committed).toMatchObject({ outcome: "applied" });
	expect(committed.commitOid).toBeString();
	expect(await git(root, home, "rev-parse", "HEAD^1")).toBe(externalHead);
	expect(await git(root, home, "show", "HEAD:healthy.txt")).toBe("healthy local");
	expect(await git(root, home, "show", "HEAD:.gitignore")).toBe(`${baseIgnore}!external.log`);
	expect(await git(root, home, "diff", "--cached", "--name-only")).toBe("");
	const unassigned = await cli<GitStagingDiff>(root, home, [
		"diff",
		"--list",
		GIT_STAGING_UNASSIGNED_LIST_ID,
		"--path",
		".gitignore",
	]);
	expect(unassigned.units).toHaveLength(1);
	expect(unassigned.units[0]).toMatchObject({ needsReview: false });
	expect(unassigned.units[0].reviewReason).toBeUndefined();
	current = await cli<GitStagingActionResult>(root, home, [
		"move",
		"--from",
		GIT_STAGING_UNASSIGNED_LIST_ID,
		"--to",
		GIT_STAGING_UNASSIGNED_LIST_ID,
		"--unit",
		unassigned.units[0]?.id ?? "",
		...versionArgs(committed),
	]);
	expect(current).toMatchObject({
		generation: committed.generation,
		observationId: committed.observationId,
	});
	const afterMove = await readDocumentedObservation(root, home, gitDir);
	expect(afterMove.workspace[0]?.generation).toBe(current.generation);
	expect(afterMove.changes).toEqual([
		expect.objectContaining({
			path: ".gitignore",
			list_id: GIT_STAGING_UNASSIGNED_LIST_ID,
			needs_review: 0,
			review_reason: null,
		}),
	]);
	const unassignedCommit = await cli<GitStagingActionResult>(root, home, [
		"commit",
		"--list",
		GIT_STAGING_UNASSIGNED_LIST_ID,
		"--message",
		"Unassigned group fixture",
		...versionArgs(current),
	]);
	expect(unassignedCommit.outcome).toBe("applied");
	expect(await git(root, home, "show", "HEAD:.gitignore")).toBe(`${baseIgnore}!local.log`);
	expect((await readDocumentedObservation(root, home, gitDir)).changes).toEqual([]);
	const final = await cli<GitStagingSummary>(root, home, ["list"]);
	expect(final.lists.map((list) => list.id).sort()).toEqual(
		[healthy, sameName, GIT_STAGING_UNASSIGNED_LIST_ID].sort(),
	);
	expect(final.activeListId).toBe(healthy);
	expect(await git(root, home, "diff", "--cached", "--name-only")).toBe("");
	expect(await Promise.all(paths.map((path) => readFile(join(root, path))))).toEqual(work);
	expect(await readFile(join(appHome, "narrafork.db"))).toEqual(mainDatabase);
	expect(await readdir(appHome)).toEqual(["narrafork.db"]);
	expect(await readdir(root)).not.toContain(".narrafork");
}, 90_000);
