import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { analyzeShellCommand } from "../lib/agent/bash-analyze";
import { eventBus } from "../lib/event-bus";
import type { GitStatusSummary } from "./git-service";
import { markStatusDirty } from "./git-status-cache";
import { GitStatusPageService } from "./git-status-page";
import { getLocalGitStatusQueryKey } from "./git-status-query";
import { classifyGitToolRefresh, GitToolRefreshQueue } from "./git-tool-refresh-policy";

const path = "/git-tool-refresh-fixture";
const analyze = (command: string) => analyzeShellCommand(command, path, "bash");
const summary = (branch = "main"): GitStatusSummary => ({
	branch,
	headSha: "fixture-head",
	files: [],
	staged: 0,
	unstaged: 1,
	untracked: 0,
	hasChanges: true,
	totalFiles: 1,
});
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => mock.restore());

function fixture(options: { readers?: boolean; cached?: GitStatusSummary } = {}) {
	const timers = new Map<number, { callback: () => void; delay: number }>();
	let nextTimer = 0;
	spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
		const id = ++nextTimer;
		timers.set(id, { callback, delay });
		return id;
	}) as typeof setTimeout);
	spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => {
		timers.delete(id);
	}) as typeof clearTimeout);
	let readers = options.readers ?? true;
	const dirty = mock((_path: string) => {});
	const read = mock(async (_path: string) => summary());
	const publish = mock((_status: GitStatusSummary, _toolUseId: string) => {});
	const onError = mock((_error: unknown) => {});
	const queue = new GitToolRefreshQueue({
		state: {},
		markDirty: dirty,
		peek: () => options.cached ?? null,
		read,
		publish,
		onError,
		hasReaders: () => readers,
		isCurrent: () => true,
	});
	return {
		queue,
		timers,
		dirty,
		read,
		publish,
		onError,
		setReaders(value: boolean) {
			readers = value;
		},
		async runTimer() {
			const entry = timers.entries().next().value;
			expect(entry).toBeDefined();
			if (!entry) return;
			timers.delete(entry[0]);
			entry[1].callback();
			await turn();
		},
	};
}

describe("completed tool intent", () => {
	for (const command of [
		"git status --short",
		"git diff --stat",
		"git log -5 --oneline",
		"git show HEAD:README.md",
		"pwd && git status && git diff",
		"printf '%s' 'git commit -m example'",
		"ls -la | wc -l",
	]) {
		test(`confirmed read: ${command}`, async () => {
			expect(await classifyGitToolRefresh("Bash", { command }, analyze)).toBe("none");
		});
	}
	for (const command of [
		"git commit -m change",
		"git checkout other",
		"git status > status.txt",
		"git status && touch changed",
		"GIT_EXTERNAL_DIFF=helper git diff",
		"git -c alias.status='!touch changed' status",
		"unknown-command --read-only",
		"bash -c 'git status'",
		"printf '%s' 'content' > file",
		"touch changed; false",
		"git status $(touch changed)",
	]) {
		test(`potential write: ${command}`, async () => {
			for (const isError of [false, true]) {
				const event = { input: { command }, isError };
				expect(await classifyGitToolRefresh("Bash", event.input, analyze)).not.toBe("none");
			}
		});
	}
	test("failed reads stay read-only, parser failure stays uncertain, and dry runs do not write", async () => {
		const parse = mock(analyze);
		for (const isError of [false, true]) {
			const event = { input: { command: "git diff -- missing" }, isError };
			expect(await classifyGitToolRefresh("Bash", event.input, parse)).toBe("none");
		}
		expect(
			await classifyGitToolRefresh("Bash", { command: "uncertain" }, async () => {
				throw new Error("parser unavailable");
			}),
		).toBe("write");
		for (const action of ["show", "render", "kit_status"])
			expect(await classifyGitToolRefresh("GenUI", { action }, parse)).toBe("none");
		for (const action of ["create", "kit_build", "inspect", "future"])
			expect(await classifyGitToolRefresh("GenUI", { action }, parse)).toBe("write");
		expect(await classifyGitToolRefresh("StructSed", {}, parse)).toBe("none");
		expect(await classifyGitToolRefresh("StructSed", { dry_run: false }, parse)).toBe("write");
		expect(await classifyGitToolRefresh("Write", { file_path: "spec://tasks.json" }, parse)).toBe(
			"none",
		);
		expect(await classifyGitToolRefresh("Read", {}, parse)).toBe("none");
		expect(
			await classifyGitToolRefresh("Bash", { device: "remote", command: "touch x" }, parse),
		).toBe("none");
		expect(parse).toHaveBeenCalledTimes(2);
	});
});

describe("bounded header refresh", () => {
	test("100 confirmed reads issue zero invalidations, timers, reads or pushes", async () => {
		const f = fixture();
		const spawn = spyOn(Bun, "spawn");
		for (let index = 0; index < 100; index++) {
			const intent = await classifyGitToolRefresh(
				"Bash",
				{ command: "git status && git diff && git log -1" },
				analyze,
			);
			f.queue.track(intent, path, `read-${index}`);
		}
		expect(spawn).not.toHaveBeenCalled();
		expect(f.dirty).not.toHaveBeenCalled();
		expect(f.timers.size).toBe(0);
		expect(f.read).not.toHaveBeenCalled();
		expect(f.publish).not.toHaveBeenCalled();
	});

	test("100 writes share one delayed read, with no work when the header is unobserved", async () => {
		const f = fixture();
		for (let index = 0; index < 100; index++) f.queue.track("write", path, `write-${index}`);
		expect(f.timers.size).toBe(1);
		expect([...f.timers.values()][0].delay).toBe(800);
		expect(f.read).not.toHaveBeenCalled();
		await f.runTimer();
		expect(f.read).toHaveBeenCalledTimes(1);
		expect(f.publish).toHaveBeenCalledWith(summary(), "write-99");
		f.setReaders(false);
		for (let index = 0; index < 100; index++) f.queue.track("write", path, `hidden-${index}`);
		expect(f.dirty).toHaveBeenCalledTimes(200);
		expect(f.timers.size).toBe(0);
		expect(f.read).toHaveBeenCalledTimes(1);
	});

	test("writes during an active read produce one fresh successor and never overlap", async () => {
		const f = fixture();
		let finish!: (status: GitStatusSummary) => void;
		f.read.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		f.queue.track("write", path, "first");
		await f.runTimer();
		expect(f.read).toHaveBeenCalledTimes(1);
		for (let index = 0; index < 100; index++) f.queue.track("write", path, `during-${index}`);
		expect(f.timers.size).toBe(0);
		finish(summary("old"));
		await turn();
		expect(f.publish).not.toHaveBeenCalled();
		expect(f.timers.size).toBe(1);
		await f.runTimer();
		expect(f.read).toHaveBeenCalledTimes(2);
		expect(f.timers.size).toBe(0);
		expect(f.publish).toHaveBeenCalledTimes(1);
		expect(f.publish).toHaveBeenCalledWith(summary(), "during-99");
	});

	test("equal summaries stay quiet; real Git writes use a short nonzero shared delay", async () => {
		const f = fixture({ cached: summary() });
		f.queue.track("write", path, "same");
		await f.runTimer();
		expect(f.publish).not.toHaveBeenCalled();
		for (let index = 0; index < 100; index++) f.queue.track("git-write", path, `git-${index}`);
		expect(f.timers.size).toBe(1);
		expect([...f.timers.values()][0].delay).toBe(100);
		f.read.mockResolvedValue(summary("new-branch"));
		await f.runTimer();
		expect(f.read).toHaveBeenCalledTimes(2);
		expect(f.publish).toHaveBeenCalledWith(summary("new-branch"), "git-99");
	});

	test("an unsubscribed timer and a failed query do not create background retry loops", async () => {
		const f = fixture();
		f.queue.track("write", path, "unsubscribed");
		f.setReaders(false);
		await f.runTimer();
		expect(f.read).not.toHaveBeenCalled();
		f.setReaders(true);
		f.read.mockRejectedValueOnce(new Error("worker unavailable"));
		f.queue.track("write", path, "failed");
		await f.runTimer();
		expect(f.onError).toHaveBeenCalledTimes(1);
		expect(f.timers.size).toBe(0);
		expect(f.publish).not.toHaveBeenCalled();
	});
});

test("100 read events preserve a real worker's multi-page snapshot and its cached statistics", async () => {
	const pages = new GitStatusPageService();
	const scope = {
		actorId: "reader",
		workspaceKey: "fixture",
		queryKey: getLocalGitStatusQueryKey(path),
	};
	const source = {
		kind: "remote" as const,
		identity: scope.queryKey,
		read: mock(async () => ({
			stdout: Array.from(
				{ length: 350 },
				(_, index) => `?? file-${String(index).padStart(3, "0")}\0`,
			).join(""),
			complete: true,
		})),
	};
	const readStats = mock(async () => ({
		files: [{ path: "file-000", unstagedLinesAdded: 2, unstagedLinesRemoved: 0, complete: true }],
		linesAdded: 2,
		linesRemoved: 0,
		complete: true,
	}));
	const invalidated = mock(({ queryKey }: { queryKey: string }) => pages.invalidate(queryKey));
	eventBus.on("git:workspace_invalidated", invalidated);
	try {
		const first = await pages.readOnDemand({ scope, source, query: { limit: 100 } });
		const statsQuery = {
			snapshotId: first.snapshotId,
			rows: [{ type: "file" as const, section: "unstaged" as const, path: "file-000" }],
		};
		await pages.readStatsOnDemand({ scope, source, query: statsQuery, readStats });
		const read = mock(async () => summary());
		const queue = new GitToolRefreshQueue({
			state: {},
			markDirty: markStatusDirty,
			peek: () => null,
			read,
			hasReaders: () => true,
			isCurrent: () => true,
			publish: () => {},
			onError: () => {},
		});
		for (let index = 0; index < 100; index++)
			queue.track(
				await classifyGitToolRefresh(
					"Bash",
					{ command: "git status && git diff && git log -1" },
					analyze,
				),
				path,
				`read-${index}`,
			);
		const second = await pages.readOnDemand({
			scope,
			source,
			query: { limit: 100, cursor: first.nextCursor ?? undefined },
		});
		const third = await pages.readOnDemand({
			scope,
			source,
			query: { limit: 100, cursor: second.nextCursor ?? undefined },
		});
		expect(second.snapshotId).toBe(first.snapshotId);
		expect(third.snapshotId).toBe(first.snapshotId);
		expect(
			(await pages.readStatsOnDemand({ scope, source, query: statsQuery, readStats })).rows[0],
		).toMatchObject({ added: 2, complete: true });
		expect(source.read).toHaveBeenCalledTimes(1);
		expect(readStats).toHaveBeenCalledTimes(1);
		expect(read).not.toHaveBeenCalled();
		expect(invalidated).not.toHaveBeenCalled();
	} finally {
		eventBus.off("git:workspace_invalidated", invalidated);
		await pages.close();
	}
});
