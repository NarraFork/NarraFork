import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { currentChangelistHead, observeChangelists } from "../git-changelist-observer";
import {
	CHANGELIST_SNAPSHOT_LIMITS,
	type ChangelistRepository,
	ChangelistStore,
} from "../git-changelist-store";

const exec = promisify(execFile);
let root: string;
let repo: ChangelistRepository;
let store: ChangelistStore;
const restores: (() => void)[] = [];
async function git(...args: string[]) {
	return (
		await exec(
			"git",
			["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args],
			{
				cwd: root,
				timeout: 15_000,
				maxBuffer: 1024 * 1024,
			},
		)
	).stdout.trim();
}
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "nf-observer-regression-"));
	await git("init", "--quiet", "--initial-branch=main");
	const gitDir = join(root, ".git");
	repo = {
		root,
		gitDir,
		directory: join(gitDir, "narrafork", "changelists"),
		index: join(gitDir, "index"),
		key: root,
	};
	const opened = await ChangelistStore.open(repo, true);
	if (!opened) throw new Error("Missing fixture store");
	store = opened;
});
afterEach(async () => {
	for (const restore of restores.splice(0).reverse()) restore();
	store?.close();
	await rm(root, { recursive: true, force: true });
});

test("publication rejects a draft whose ownership exceeds the next observation's read budget", async () => {
	for (let index = 0; index < 5; index++) await writeFile(join(root, `file-${index}`), "changed\n");
	const fileIds = store.fileIds.bind(store);
	const ids = spyOn(store, "fileIds").mockImplementation((observationId) => {
		const files = fileIds(observationId);
		return observationId && observationId !== store.state().observation_id
			? files.map((file) => ({
					...file,
					ownership_size: CHANGELIST_SNAPSHOT_LIMITS.maxOwnershipFileBytes,
				}))
			: files;
	});
	restores.push(() => ids.mockRestore());
	await expect(observeChangelists(repo, store)).rejects.toMatchObject({
		code: "GIT_STAGING_LIMIT",
	});
	expect(store.state().observation_id).toBeNull();
	ids.mockRestore();
	for (let index = 0; index < 5; index++) await rm(join(root, `file-${index}`));
	expect((await observeChangelists(repo, store)).state).toBe("ready");
	expect(store.fileIds()).toEqual([]);
});

for (const directoryFirst of [false, true]) {
	test(`observation publishes ${directoryFirst ? "directory-to-file" : "file-to-directory"} replacements`, async () => {
		const original = directoryFirst ? "entry/child" : "entry";
		const replacement = directoryFirst ? "entry" : "entry/child";
		if (directoryFirst) await mkdir(join(root, "entry"));
		await writeFile(join(root, original), "original\n");
		await git("add", "--", original);
		await git("commit", "--quiet", "-m", "Base");
		await writeFile(join(root, original), "local edit\n");
		await observeChangelists(repo, store);
		await rm(join(root, "entry"), { recursive: true });
		if (!directoryFirst) await mkdir(join(root, "entry"));
		await writeFile(join(root, replacement), "replacement\n");
		expect((await observeChangelists(repo, store)).state).toBe("ready");
		const files = store.fileIds().map((row) => store.loadFile(row.file_id));
		expect(files.find((file) => file?.path === original)).toMatchObject({
			baseMode: "100644",
			workMode: "000000",
			workBytes: Buffer.alloc(0),
		});
		expect(files.find((file) => file?.path === replacement)).toMatchObject({
			baseMode: "000000",
			workMode: "100644",
			workBytes: Buffer.from("replacement\n"),
		});
		expect((await observeChangelists(repo, store)).state).toBe("ready");
	});
}

test("reftable HEAD identity names the actual symbolic branch rather than its compatibility stub", async () => {
	const refRoot = join(root, "reftable");
	await exec(
		"git",
		["init", "--quiet", "--ref-format=reftable", "--initial-branch=main", refRoot],
		{
			timeout: 10_000,
			maxBuffer: 4096,
		},
	);
	const head = await currentChangelistHead({
		...repo,
		root: refRoot,
		gitDir: join(refRoot, ".git"),
	});
	expect(head.head).toBeNull();
	expect(head.headTarget).toBe("ref: refs/heads/main");
});
