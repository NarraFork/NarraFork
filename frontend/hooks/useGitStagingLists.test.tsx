import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type {
	GitStagingAction,
	GitStagingActionResult,
	GitStagingFilesPage,
	GitStagingSummary,
} from "@shared/git-staging-lists";
import type { GitStatusFilterChar } from "@shared/git-status-page";
import type { GitStagingObservationState } from "@shared/git-workspace-events";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../lib/api";
import { ApiError } from "../lib/api/client";
import type { GitTarget } from "../lib/api/git";
import type { MessageCallback } from "../lib/narrator-ws-manager";

mock.module("./useNarrator", () => ({ useNarrator: () => ({ data: undefined }) }));
const listeners = new Set<MessageCallback>();
const sent: Record<string, unknown>[] = [];
let connected = true;
let autoObservation = true;
let stateSequence = 0;
let stateEpoch = 1;
function observationState(
	overrides: Partial<GitStagingObservationState> = {},
): GitStagingObservationState {
	return {
		instanceId: "hook-observer",
		stateSequence: ++stateSequence,
		epoch: stateEpoch,
		completedEpoch: stateEpoch,
		round: stateEpoch,
		status: "settled",
		generation: summary.generation,
		observationId: summary.observationId,
		...overrides,
	};
}
mock.module("../lib/narrator-ws-manager", () => ({
	narratorWSManager: {
		get connected() {
			return connected;
		},
		send: (message: Record<string, unknown>) => {
			sent.push(message);
			return true;
		},
		addListener: (_options: unknown, callback: MessageCallback) => {
			listeners.add(callback);
			return callback;
		},
		removeListener: (callback: MessageCallback) => listeners.delete(callback),
		onConnectionChange: () => () => {},
	},
}));
const { useGitStagingLists, useGitStagingFiles, useGitStagingDiff } = await import(
	"./useGitStagingLists"
);
const target: GitTarget = { narratorId: "n", workspaceKey: "w", canWrite: true };
const version = { expectedGeneration: 1, observationId: "o1" };
const stats = { M: { files: 2, added: 3, removed: 2, binaryFiles: 0, gitlinkFiles: 0 } };
const file = {
	fileId: "file",
	path: "same.txt",
	status: "M",
	stats: { kind: "text" as const, added: 3, removed: 2 },
	unitCount: 2,
	needsReviewCount: 0,
};
function initialSummary(): GitStagingSummary {
	return {
		capability: { supported: true },
		workspaceKey: "w",
		initialized: true,
		generation: 1,
		observationId: "o1",
		activeListId: "A",
		scannedAt: 1,
		state: "ready",
		stats,
		lists: ["A", "B"].map((id) => ({
			id,
			name: id,
			active: id === "A",
			fileCount: 2,
			unitCount: 2,
			added: 3,
			removed: 2,
			needsReviewCount: 0,
			stats,
			snapshotVersion: "v1",
		})),
	};
}
const originalApi = { ...api };
const globals = new Map<string, PropertyDescriptor | undefined>();
let root: Root;
let client: QueryClient;
let latest: ReturnType<typeof useGitStagingLists>;
let latestFiles: ReturnType<typeof useGitStagingFiles>;
let summary: GitStagingSummary;
let fileReads: string[];
let summaryReads: number;
let diffReads: number;
let actions: GitStagingAction[];
let actionResult: GitStagingActionResult;
let actionError: Error | undefined;
let fileError: Error | undefined;
let readers: Record<string, ReturnType<typeof useGitStagingFiles>>;
type FilesProbeProps = {
	name?: string;
	enabled?: boolean;
	target?: GitTarget;
	filter?: GitStatusFilterChar[];
};
function FilesProbe({
	name = "first",
	enabled = true,
	target: current = target,
	filter,
}: FilesProbeProps) {
	const files = useGitStagingFiles(current, summary, summary.lists[0], enabled, filter);
	readers[name] = files;
	return (
		<div data-reader={name}>
			{files.pages
				.flatMap((page) => page.files)
				.map((entry) => entry.path)
				.join(",")}
		</div>
	);
}
async function renderFiles(probes: FilesProbeProps[] = [{}]) {
	root.render(
		<QueryClientProvider client={client}>
			{probes.map((props) => (
				<FilesProbe key={props.name ?? "first"} {...props} />
			))}
		</QueryClientProvider>,
	);
	await flush();
	if (connected && autoObservation) {
		emit("git_workspace_subscribed", { version: 0 });
		await flush();
	}
}
function stagingPage(cursor?: string, nextCursor: string | null = null): GitStagingFilesPage {
	return {
		workspaceKey: "w",
		listId: "A",
		snapshotVersion: "v1",
		generation: 1,
		observationId: "o1",
		stats: { complete: true, total: stats, directories: [] },
		files: [{ ...file, fileId: cursor ?? "first", path: `${cursor ?? "first"}.txt` }],
		nextCursor,
		complete: nextCursor === null,
	};
}
function deferredPage() {
	let resolve!: (page: GitStagingFilesPage) => void;
	const promise = new Promise<GitStagingFilesPage>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const messageVersions = new Map<unknown, number>();
function emit(type: string, extra: Record<string, unknown> = {}) {
	const subscription = sent.filter((m) => m.type === "git_workspace_subscribe").at(-1);
	const subscriptionId = extra.subscriptionId ?? subscription?.subscriptionId;
	const version = extra.version ?? (messageVersions.get(subscriptionId) ?? -1) + 1;
	if (typeof version === "number")
		messageVersions.set(
			subscriptionId,
			Math.max(messageVersions.get(subscriptionId) ?? -1, version),
		);
	for (const callback of listeners)
		callback({
			type,
			subscriptionId,
			version,
			workspaceKey: subscription?.workspaceKey,
			narratorId: subscription?.narratorId,
			...extra,
		});
}
function Probe({ expanded = true, preview = false }: { expanded?: boolean; preview?: boolean }) {
	latest = useGitStagingLists(target);
	latestFiles = useGitStagingFiles(target, latest.summary, latest.summary?.lists[0], expanded);
	useGitStagingFiles(target, latest.summary, latest.summary?.lists[1], expanded);
	useGitStagingDiff(target, latest.summary, latest.summary?.lists[0], preview ? file : null);
	return (
		<div>
			{latestFiles.pages
				.flatMap((page) => page.files)
				.map((entry) => entry.path)
				.join(",")}
		</div>
	);
}
async function flush() {
	for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
async function render(expanded = true, preview = false) {
	root.render(
		<QueryClientProvider client={client}>
			<Probe expanded={expanded} preview={preview} />
		</QueryClientProvider>,
	);
	await flush();
	if (autoObservation && connected) {
		emit("git_workspace_subscribed", { version: 0 });
		emit("git_workspace_staging_observation", { observation: observationState() });
		await flush();
	}
}
beforeEach(() => {
	const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		IS_REACT_ACT_ENVIRONMENT: false,
	})) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	listeners.clear();
	connected = true;
	autoObservation = true;
	stateSequence = 0;
	stateEpoch = 1;
	sent.length = 0;
	fileReads = [];
	readers = {};
	summaryReads = diffReads = 0;
	actions = [];
	summary = initialSummary();
	actionResult = {
		outcome: "applied",
		listId: "A",
		generation: 1,
		observationId: "o1",
		affectedListIds: ["A", "B"],
	};
	actionError = fileError = undefined;
	client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	client.setQueryData(["auth", "me"], { id: "alice" });
	root = createRoot(document.getElementById("root") as HTMLElement);
	api.getGitStagingLists = async () => {
		summaryReads++;
		return summary;
	};
	api.getGitStagingFiles = async (_target, listId) => {
		fileReads.push(listId);
		if (fileError) throw fileError;
		return {
			workspaceKey: "w",
			listId,
			snapshotVersion: summary.lists.find((entry) => entry.id === listId)?.snapshotVersion ?? "v1",
			generation: summary.generation,
			observationId: summary.observationId,
			stats: { complete: true, total: stats, directories: [] },
			files: [file],
			nextCursor: null,
			complete: true,
		};
	};
	api.getGitStagingDiff = async () => {
		diffReads++;
		return {
			path: "same.txt",
			diff: "ownership patch",
			truncated: false,
			snapshotVersion: summary.lists[0].snapshotVersion,
			generation: summary.generation,
			observationId: summary.observationId,
			units: [],
		};
	};
	api.gitStagingAction = async (_target, action) => {
		actions.push(action);
		if (actionError) throw actionError;
		if (action.action === "move") {
			summary = {
				...summary,
				generation: 2,
				observationId: "o2",
				lists: summary.lists.map((entry) => ({ ...entry, snapshotVersion: "v2" })),
			};
			return {
				...actionResult,
				generation: 2,
				observationId: "o2",
				observation: observationState(),
			};
		}
		return {
			...actionResult,
			observation: observationState({
				generation: actionResult.generation,
				observationId: actionResult.observationId,
			}),
		};
	};
	api.getGitStatus = async () => {
		throw new Error("Unexpected native status request");
	};
});
afterEach(async () => {
	root.unmount();
	client.clear();
	Object.assign(api, originalApi);
	await flush();
	for (const [key, value] of globals) {
		if (value) Object.defineProperty(globalThis, key, value);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});

test("summary is read-only; expansion and preview read only their own data", async () => {
	await render(false);
	expect(summaryReads).toBe(1);
	expect(fileReads).toEqual([]);
	expect(actions).toEqual([]);
	await render(true);
	expect(fileReads).toEqual(["A", "B"]);
	expect(diffReads).toBe(0);
	await render(true, true);
	expect(diffReads).toBe(1);
});
test("authorization waits before reading; an acknowledged unknown observation blocks ownership writes", async () => {
	autoObservation = false;
	await render(true, true);
	expect(summaryReads).toBe(0);
	expect(latest.summary).toBeUndefined();
	emit("git_workspace_subscribed", { version: 0 });
	await flush();
	expect(latest.summary?.state).toBe("ready");
	expect(latest.writable).toBe(false);
	expect(document.body.textContent).toBe("same.txt");
	await expect(
		latest.mutation.mutateAsync({
			action: "move",
			fromListId: "A",
			toListId: "B",
			unitIds: ["u"],
			...version,
		}),
	).rejects.toThrow("observation changed");
	expect(actions).toEqual([]);
});

test("pending epochs retire captured mutation closures even after an unchanged observation settles", async () => {
	await render(true, true);
	const captured = latest.mutation.mutateAsync;
	const previousKey = latest.selectionKey;
	const before = { summaryReads, files: [...fileReads], diffReads };
	stateEpoch = 2;
	emit("git_workspace_staging_observation", {
		observation: observationState({ status: "observing", completedEpoch: 1 }),
	});
	await flush();
	expect(latest.writable).toBe(false);
	expect(latest.selectionKey).not.toBe(previousKey);
	expect(document.body.textContent).toBe("same.txt");
	emit("git_workspace_staging_observation", { observation: observationState() });
	await flush();
	expect(latest.writable).toBe(true);
	await expect(
		captured({ action: "move", fromListId: "A", toListId: "B", unitIds: ["old"], ...version }),
	).rejects.toThrow("observation changed");
	expect(actions).toEqual([]);
	expect({ summaryReads, files: fileReads, diffReads }).toEqual(before);
});

test.each([
	503, 409,
])("staging HTTP %s suspends authorization only for transient or explicit identity errors", async (status) => {
	await render(true, true);
	const id = sent.find((message) => message.type === "git_workspace_subscribe")?.subscriptionId;
	const captured = latest.mutation.mutateAsync;
	const before = { files: fileReads.length, diff: diffReads };
	api.getGitStagingLists = async () => {
		summaryReads++;
		throw new ApiError("Temporary", status, {
			code: status === 503 ? "DB_READ_WORKER_UNAVAILABLE" : "GIT_WORKSPACE_CHANGED",
			messageCode: status === 503 ? "DATABASE_READ_UNAVAILABLE" : undefined,
		});
	};
	await latest.query.refetch();
	await flush();
	expect(latest.refused).toBe(false);
	expect(latest.summary).toBeUndefined();
	expect(latest.writable).toBe(false);
	const reads = summaryReads;
	await latest.query.refetch();
	await latest.refresh();
	await expect(captured({ action: "sync" })).rejects.toThrow("observation changed");
	expect(summaryReads).toBe(reads);
	expect({ files: fileReads.length, diff: diffReads }).toEqual(before);
	expect(actions).toEqual([]);
	if (status === 503)
		expect(sent.at(-1)).toEqual({ type: "git_workspace_refresh", subscriptionId: id });
});

test("one explicit unchanged refresh sends one HTTP sync and no WS refresh or content rereads", async () => {
	await render(true, true);
	const before = { summaryReads, files: [...fileReads], diffReads };
	await latest.refresh();
	await flush();
	expect(actions).toEqual([{ action: "sync" }]);
	expect(sent.filter((message) => message.type === "git_workspace_refresh")).toEqual([]);
	expect({ summaryReads, files: fileReads, diffReads }).toEqual(before);
	expect(latest.writable).toBe(true);
});

test("a failed observation can be retried without content invalidation; old HTTP success cannot unlock it", async () => {
	await render(true, true);
	const before = { summaryReads, files: [...fileReads], diffReads };
	stateEpoch = 2;
	emit("git_workspace_staging_observation", {
		observation: observationState({ status: "failed", completedEpoch: 1, errorCode: "BUSY" }),
	});
	await flush();
	expect(latest.writable).toBe(false);
	expect(latest.canRefresh).toBe(true);
	api.gitStagingAction = async (_target, action) => {
		actions.push(action);
		return actionResult;
	};
	await latest.refresh();
	await flush();
	expect(latest.writable).toBe(false);
	emit("git_workspace_staging_observation", { observation: observationState() });
	await flush();
	expect(latest.writable).toBe(true);
	expect({ summaryReads, files: fileReads, diffReads }).toEqual(before);
});

test("settled publication waits for matching summary and reloads only a changed group snapshot", async () => {
	await render(true, true);
	const oldSummary = summary;
	let release!: (value: GitStagingSummary) => void;
	api.getGitStagingLists = async () => {
		summaryReads++;
		return new Promise((resolve) => {
			release = resolve;
		});
	};
	const beforeDiff = diffReads;
	fileReads = [];
	stateEpoch = 2;
	emit("git_workspace_staging_observation", {
		observation: observationState({ generation: 2, observationId: "o2" }),
	});
	await flush();
	expect(latest.summary).toEqual(oldSummary);
	expect(latest.writable).toBe(false);
	summary = {
		...summary,
		generation: 2,
		observationId: "o2",
		lists: summary.lists.map((list) =>
			list.id === "B" ? { ...list, snapshotVersion: "v2" } : list,
		),
	};
	release(summary);
	await flush();
	expect(latest.writable).toBe(true);
	expect(fileReads).toEqual(["B"]);
	expect(diffReads).toBe(beforeDiff);
});

test("an uninitialized summary never implicitly writes or reads group files", async () => {
	summary = {
		...summary,
		initialized: false,
		generation: 0,
		observationId: null,
		activeListId: null,
		state: "uninitialized",
		lists: [],
	};
	await render();
	expect(latest.active).toBe(false);
	expect(actions).toEqual([]);
	expect(fileReads).toEqual([]);
	await latest.mutation.mutateAsync({ action: "init" });
	expect(actions).toEqual([{ action: "init" }]);
});
test.each([
	true,
])("move invalidates summary and both affected groups with push=%s", async (push) => {
	connected = push;
	await render(true, true);
	fileReads = [];
	const before = summaryReads;
	const beforeDiff = diffReads;
	await latest.mutation.mutateAsync({
		action: "move",
		fromListId: "A",
		toListId: "B",
		paths: ["same.txt"],
		...version,
	});
	await flush();
	expect(actions).toEqual([
		{ action: "move", fromListId: "A", toListId: "B", paths: ["same.txt"], ...version },
	]);
	expect(fileReads.sort()).toEqual(["A", "B"]);
	expect(summaryReads).toBe(before + 1);
	expect(diffReads).toBe(beforeDiff + 1);
});
test("HTTP, ownership WS and settled state publications deduplicate the same generation", async () => {
	await render(true, true);
	const before = summaryReads;
	const write = api.gitStagingAction;
	api.gitStagingAction = async (current, action) => {
		const result = await write(current, action);
		emit("git_workspace_staging_lists_changed", {
			version: 1,
			generation: result.generation,
			observationId: result.observationId,
			affectedListIds: result.affectedListIds,
		});
		emit("git_workspace_staging_observation", { observation: result.observation });
		return result;
	};
	await latest.mutation.mutateAsync({
		action: "move",
		fromListId: "A",
		toListId: "B",
		unitIds: ["u"],
		...version,
	});
	await flush();
	expect(summaryReads).toBe(before + 1);
	expect(latest.writable).toBe(true);
});

test("one WS observation invalidates summary and every affected group, once", async () => {
	await render();
	emit("git_workspace_subscribed", { version: 0 });
	await flush();
	fileReads = [];
	const before = summaryReads;
	summary = {
		...summary,
		generation: 2,
		observationId: "o2",
		lists: summary.lists.map((entry) => ({ ...entry, snapshotVersion: "v2" })),
	};
	emit("git_workspace_staging_lists_changed", {
		version: 2,
		affectedListIds: ["A", "B"],
		generation: 2,
		observationId: "o2",
	});
	await flush();
	expect(fileReads.sort()).toEqual(["A", "B"]);
	expect(summaryReads).toBe(before + 1);
	emit("git_workspace_staging_lists_changed", { version: 1, affectedListIds: ["A", "B"] });
	await flush();
	expect(fileReads).toHaveLength(2);
});
test("write errors preserve the selected contents and are never retried", async () => {
	await render();
	actionError = new Error("Database locked");
	const before = [...fileReads];
	await expect(
		latest.mutation.mutateAsync({
			action: "move",
			fromListId: "A",
			toListId: "B",
			unitIds: ["u1"],
			...version,
		}),
	).rejects.toThrow("Database locked");
	await flush();
	expect(actions).toHaveLength(1);
	expect(fileReads).toEqual(before);
	expect(document.body.textContent).toBe("same.txt");
});
test("a stale selected generation is rejected before issuing a write", async () => {
	await render();
	summary = { ...summary, generation: 2, observationId: "o2" };
	client.setQueryData(["gitStagingLists", "w", "n", "alice"], summary);
	await flush();
	await expect(
		latest.mutation.mutateAsync({
			action: "move",
			fromListId: "A",
			toListId: "B",
			paths: ["same.txt"],
			...version,
		}),
	).rejects.toThrow("observation changed");
	expect(actions).toEqual([]);
});
test.each([
	"GIT_STAGING_BUSY",
	"GIT_STAGING_INVALID",
])("ordinary %s conflicts retire old selection without requiring an absent state event", async (code) => {
	await render();
	const captured = latest.mutation.mutateAsync;
	const oldKey = latest.selectionKey;
	const before = summaryReads;
	actionError = new ApiError("Action unavailable", 409, { code });
	await expect(
		latest.mutation.mutateAsync({ action: "rename", listId: "B", name: "new", ...version }),
	).rejects.toThrow("Action unavailable");
	await flush();
	expect(latest.writable).toBe(true);
	expect(latest.selectionKey).not.toBe(oldKey);
	expect(summaryReads).toBe(before);
	actionError = undefined;
	await expect(
		captured({ action: "rename", listId: "B", name: "new", ...version }),
	).rejects.toThrow("observation changed");
	await latest.mutation.mutateAsync({
		action: "rename",
		listId: "B",
		name: "chosen again",
		...version,
	});
	expect(actions).toHaveLength(2);
});

test("a true stale rejection stays unwritable until an explicit verified refresh, not merely its old summary", async () => {
	await render();
	const captured = latest.mutation.mutateAsync;
	actionError = new ApiError("Observation changed", 409, { code: "GIT_STAGING_STALE" });
	await expect(
		latest.mutation.mutateAsync({
			action: "move",
			fromListId: "A",
			toListId: "B",
			unitIds: ["old"],
			...version,
		}),
	).rejects.toThrow("Observation changed");
	await flush();
	expect(latest.writable).toBe(false);
	actionError = undefined;
	await latest.refresh();
	await flush();
	expect(latest.writable).toBe(true);
	await expect(
		captured({ action: "move", fromListId: "A", toListId: "B", unitIds: ["old"], ...version }),
	).rejects.toThrow("observation changed");
	expect(actions.map((action) => action.action)).toEqual(["move", "sync"]);
});

test("server CAS refusal invalidates summary instead of replaying the old selection", async () => {
	await render();
	const before = summaryReads;
	actionError = new ApiError("Observation changed", 409, { code: "GIT_STAGING_STALE_GENERATION" });
	await expect(
		latest.mutation.mutateAsync({ action: "rename", listId: "B", name: "new", ...version }),
	).rejects.toThrow("Observation changed");
	await flush();
	expect(summaryReads).toBe(before + 1);
	expect(actions).toHaveLength(1);
});
test("committed partial cleanup exposes operationId and only recover finishes it", async () => {
	await render();
	actionResult = {
		...actionResult,
		outcome: "partial",
		commitOid: "committed",
		operationId: "op1",
		reason: "Database finalization failed",
	};
	await latest.mutation.mutateAsync({
		action: "commit",
		listId: "A",
		message: "changes",
		...version,
	});
	await flush();
	expect(latest.notice?.result.commitOid).toBe("committed");
	expect(latest.notice?.result.operationId).toBe("op1");
	actionResult = { ...actionResult, outcome: "applied" };
	await latest.mutation.mutateAsync({ action: "recover", operationId: "op1", ...version });
	await flush();
	expect(actions.map((action) => action.action)).toEqual(["commit", "recover"]);
	expect(latest.notice).toBeUndefined();
});
test("a global observation keeps unaffected content snapshots and only reloads changed groups", async () => {
	await render();
	fileReads = [];
	summary = {
		...summary,
		generation: 2,
		observationId: "o2",
		lists: summary.lists.map((entry) =>
			entry.id === "B" ? { ...entry, snapshotVersion: "v2" } : entry,
		),
	};
	client.setQueryData(["gitStagingLists", "w", "n", "alice"], summary);
	await flush();
	expect(fileReads).toEqual(["B"]);
	expect(latestFiles.pages[0].generation).toBe(1);
	expect(latest.version).toEqual({ expectedGeneration: 2, observationId: "o2" });
});
test("changed observation pages cannot be used as the requested version", async () => {
	api.getGitStagingFiles = async (_target, listId) => ({
		workspaceKey: "w",
		listId,
		snapshotVersion: "v2",
		generation: 2,
		observationId: "o2",
		stats: { complete: true, total: stats, directories: [] },
		files: [file],
		nextCursor: null,
		complete: true,
	});
	await render();
	expect(latestFiles.pages).toEqual([]);
	expect(latestFiles.error).toBeInstanceOf(ApiError);
});
test("read failures and cancellation retain the last complete page", async () => {
	await render();
	fileError = new Error("read unavailable");
	await latestFiles.refetch();
	await flush();
	expect(document.body.textContent).toBe("same.txt");
	expect(latestFiles.error?.message).toBe("read unavailable");
	await client.cancelQueries({ queryKey: ["gitStagingFiles", "w", "A"] });
	expect(document.body.textContent).toBe("same.txt");
});
test("expanded groups automatically read every bounded page, while collapsed readers cannot fetch", async () => {
	const calls: Array<string | undefined> = [];
	let inFlight = 0;
	let maximum = 0;
	api.getGitStagingFiles = async (_target, listId, query) => {
		expect(listId).toBe("A");
		expect(query?.limit).toBe(200);
		calls.push(query?.cursor);
		maximum = Math.max(maximum, ++inFlight);
		await Promise.resolve();
		inFlight--;
		const index = Number(query?.cursor ?? 0);
		return stagingPage(query?.cursor, index < 4 ? String(index + 1) : null);
	};
	await renderFiles([{ enabled: false }]);
	await readers.first.fetchNextPage();
	await readers.first.refetch();
	await readers.first.retry();
	expect(calls).toEqual([]);
	await renderFiles();
	await flush();
	expect(calls).toEqual([undefined, "1", "2", "3", "4"]);
	expect(maximum).toBe(1);
	expect(readers.first.pages).toHaveLength(5);
	expect(readers.first.hasNextPage).toBe(false);
	expect(readers.first.error).toBeNull();
});

test("a failed continuation keeps its pages and resumes automatic paging only after retry", async () => {
	const calls: Array<string | undefined> = [];
	let fail = true;
	api.getGitStagingFiles = async (_target, _listId, query) => {
		calls.push(query?.cursor);
		if (query?.cursor === "second" && fail) throw new Error("page unavailable");
		return stagingPage(
			query?.cursor,
			!query?.cursor ? "second" : query.cursor === "second" ? "last" : null,
		);
	};
	await renderFiles();
	await flush();
	expect(calls).toEqual([undefined, "second"]);
	expect(readers.first.pages).toHaveLength(1);
	expect(readers.first.error?.message).toBe("page unavailable");
	fail = false;
	await readers.first.retry();
	await flush();
	expect(calls).toEqual([undefined, "second", "second", "last"]);
	expect(readers.first.pages).toHaveLength(3);
	expect(readers.first.error).toBeNull();
});

test.each([
	["terminal page without completeness", { nextCursor: null, complete: false }],
	["complete page with a continuation", { nextCursor: "next", complete: true }],
	["empty continuation cursor", { nextCursor: "", complete: false }],
	["empty nonterminal page", { nextCursor: "next", complete: false, files: [] }],
] as const)("invalid page chain stops at %s", async (_label, invalid) => {
	let calls = 0;
	api.getGitStagingFiles = async () => {
		calls++;
		return { ...stagingPage(), ...invalid, files: "files" in invalid ? [] : [file] };
	};
	await renderFiles();
	await flush();
	expect(calls).toBe(1);
	expect(readers.first.pages).toEqual([]);
	expect(readers.first.error).toBeInstanceOf(ApiError);
	expect((readers.first.error as ApiError).data?.code).toBe("GIT_STAGING_INVALID_PAGE_CHAIN");
});

test.each([
	"second",
	"third",
])("repeated %s cursor retains the valid prefix and stops", async (repeatAt) => {
	const calls: Array<string | undefined> = [];
	api.getGitStagingFiles = async (_target, _listId, query) => {
		calls.push(query?.cursor);
		return stagingPage(
			query?.cursor,
			!query?.cursor ? "second" : query.cursor === repeatAt ? "second" : "third",
		);
	};
	await renderFiles();
	await flush();
	expect(calls).toEqual(
		repeatAt === "second" ? [undefined, "second"] : [undefined, "second", "third"],
	);
	expect(readers.first.pages).toHaveLength(repeatAt === "second" ? 1 : 2);
	expect((readers.first.error as ApiError).data?.code).toBe("GIT_STAGING_INVALID_PAGE_CHAIN");
});

test("a refetch validates its new cursors before replacing the complete cached chain", async () => {
	let phase: "initial" | "cycle" | "recovered" = "initial";
	const calls: Array<string | undefined> = [];
	api.getGitStagingFiles = async (_target, _listId, query) => {
		const cursor = query?.cursor;
		calls.push(cursor);
		if (phase === "initial")
			return stagingPage(cursor, !cursor ? "a" : cursor === "a" ? "b" : null);
		return stagingPage(
			cursor,
			!cursor
				? "x"
				: cursor === "x"
					? "y"
					: cursor === "y"
						? phase === "cycle"
							? "x"
							: "z"
						: null,
		);
	};
	await renderFiles();
	await flush();
	expect(readers.first.pages.map((page) => page.files[0].path)).toEqual([
		"first.txt",
		"a.txt",
		"b.txt",
	]);
	const accepted: unknown[][] = [];
	const unsubscribe = client.getQueryCache().subscribe((event) => {
		if (
			event.type === "updated" &&
			event.action.type === "success" &&
			event.query.queryKey[0] === "gitStagingFiles"
		)
			accepted.push((event.query.state.data as { pageParams: unknown[] }).pageParams);
	});
	phase = "cycle";
	await readers.first.refetch();
	await flush();
	expect(calls).toEqual([undefined, "a", "b", undefined, "x", "y"]);
	expect(accepted).toEqual([]);
	expect((readers.first.error as ApiError).data?.code).toBe("GIT_STAGING_INVALID_PAGE_CHAIN");
	expect(readers.first.pages.map((page) => page.files[0].path)).toEqual([
		"first.txt",
		"a.txt",
		"b.txt",
	]);
	phase = "recovered";
	await readers.first.retry();
	await flush();
	expect(calls).toEqual([undefined, "a", "b", undefined, "x", "y", undefined, "x", "y", "z"]);
	expect(readers.first.pages.map((page) => page.files[0].path)).toEqual([
		"first.txt",
		"x.txt",
		"y.txt",
		"z.txt",
	]);
	expect(readers.first.error).toBeNull();
	expect(readers.first.hasNextPage).toBe(false);
	unsubscribe();
});

test("an already cached cursor cycle blocks continuation and retry rebuilds from the first page", async () => {
	client.setQueryData(["gitStagingFiles", "w", "A", "n", "alice", "v1", []], {
		pages: [stagingPage(undefined, "x"), stagingPage("x", "y"), stagingPage("y", "x")],
		pageParams: [undefined, "x", "y"],
	});
	const calls: Array<string | undefined> = [];
	api.getGitStagingFiles = async (_target, _listId, query) => {
		const cursor = query?.cursor;
		calls.push(cursor);
		return stagingPage(cursor, !cursor ? "x" : cursor === "x" ? "y" : null);
	};
	await renderFiles();
	await readers.first.fetchNextPage();
	await flush();
	expect(calls).toEqual([]);
	expect((readers.first.error as ApiError).data?.code).toBe("GIT_STAGING_INVALID_PAGE_CHAIN");
	await readers.first.retry();
	await flush();
	expect(calls).toEqual([undefined, "x", "y"]);
	expect(readers.first.error).toBeNull();
	expect(readers.first.pages).toHaveLength(3);
	expect(readers.first.hasNextPage).toBe(false);
});

test("collapsing cancels only the unfinished page and reopening continues the cached chain", async () => {
	const pending = deferredPage();
	let signal: AbortSignal | undefined;
	const calls: Array<string | undefined> = [];
	api.getGitStagingFiles = async (_target, _listId, query, requestSignal) => {
		calls.push(query?.cursor);
		if (query?.cursor === "second" && calls.length === 2) {
			signal = requestSignal;
			return pending.promise;
		}
		return stagingPage(
			query?.cursor,
			!query?.cursor ? "second" : query.cursor === "second" ? "last" : null,
		);
	};
	await renderFiles();
	const oldFetch = readers.first.fetchNextPage;
	await renderFiles([{ enabled: false }]);
	expect(signal?.aborted).toBe(true);
	expect(readers.first.pages).toHaveLength(1);
	await oldFetch();
	pending.resolve(stagingPage("late", "last"));
	await flush();
	expect(calls).toEqual([undefined, "second"]);
	expect(readers.first.pages).toHaveLength(1);
	await renderFiles();
	await flush();
	expect(calls).toEqual([undefined, "second", "second", "last"]);
	expect(readers.first.pages.map((page) => page.files[0].path)).toEqual([
		"first.txt",
		"second.txt",
		"last.txt",
	]);
});

test("a hidden page chain pauses manual reads and resumes its cached prefix on return", async () => {
	const pending = deferredPage();
	let signal: AbortSignal | undefined;
	let calls = 0;
	api.getGitStagingFiles = async (_target, _listId, query, requestSignal) => {
		calls++;
		if (calls === 2) {
			signal = requestSignal;
			return pending.promise;
		}
		return stagingPage(query?.cursor, query?.cursor ? null : "second");
	};
	await renderFiles();
	const captured = readers.first;
	Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
	document.dispatchEvent(new window.Event("visibilitychange"));
	await flush();
	expect(signal?.aborted).toBe(true);
	await captured.fetchNextPage();
	await captured.retry();
	pending.resolve(stagingPage("late"));
	await flush();
	expect(calls).toBe(2);
	expect(readers.first.pages).toHaveLength(0);
	Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
	document.dispatchEvent(new window.Event("visibilitychange"));
	emit("git_workspace_subscribed", { version: 0 });
	await flush();
	expect(calls).toBe(3);
	expect(readers.first.pages.map((page) => page.files[0].path)).toEqual([
		"first.txt",
		"second.txt",
	]);
	expect(readers.first.hasNextPage).toBe(false);
});

test("an access rejection cancels the current page and blocks captured manual readers", async () => {
	const pending = deferredPage();
	let signal: AbortSignal | undefined;
	let calls = 0;
	api.getGitStagingFiles = async (_target, _listId, query, requestSignal) => {
		calls++;
		if (query?.cursor) {
			signal = requestSignal;
			return pending.promise;
		}
		return stagingPage(undefined, "second");
	};
	await renderFiles();
	const captured = readers.first;
	emit("git_workspace_error", { code: "GIT_WORKSPACE_ACCESS_DENIED" });
	await flush();
	expect(signal?.aborted).toBe(true);
	expect(readers.first.displayAllowed).toBe(false);
	await captured.fetchNextPage();
	await captured.refetch();
	await captured.retry();
	pending.resolve(stagingPage("private"));
	await flush();
	expect(calls).toBe(2);
	expect(readers.first.pages).toEqual([]);
});

test("a stale continuation stops after refreshing the summary and keeps its valid prefix", async () => {
	const calls: Array<string | undefined> = [];
	api.getGitStagingFiles = async (_target, listId, query) => {
		if (listId === "B") return { ...stagingPage(), listId };
		calls.push(query?.cursor);
		if (query?.cursor) throw new ApiError("snapshot expired", 409);
		return stagingPage(undefined, "second");
	};
	await render();
	await flush();
	expect(calls).toEqual([undefined, "second"]);
	expect(latestFiles.pages).toHaveLength(1);
	expect((latestFiles.error as ApiError).status).toBe(409);
	expect(summaryReads).toBe(2);
});

test("an unauthenticated reader cannot bypass enabled through a manual retry", async () => {
	client.removeQueries({ queryKey: ["auth", "me"] });
	await renderFiles();
	await readers.first.fetchNextPage();
	await readers.first.refetch();
	await readers.first.retry();
	expect(fileReads).toEqual([]);
	expect(readers.first.pages).toEqual([]);
});

test("a collapsed observer does not cancel or reject a shared reader started by it", async () => {
	const pending = deferredPage();
	let signal: AbortSignal | undefined;
	const calls: Array<string | undefined> = [];
	api.getGitStagingFiles = async (_target, _listId, query, requestSignal) => {
		calls.push(query?.cursor);
		if (query?.cursor === "second") {
			signal = requestSignal;
			return pending.promise;
		}
		return stagingPage(query?.cursor, query?.cursor ? null : "second");
	};
	await renderFiles();
	await renderFiles([{ name: "first" }, { name: "other" }]);
	await renderFiles([{ name: "first", enabled: false }, { name: "other" }]);
	expect(signal?.aborted).toBe(false);
	pending.resolve(stagingPage("second", "last"));
	await flush();
	expect(calls).toEqual([undefined, "second", "last"]);
	expect(readers.other.pages).toHaveLength(3);
	expect(readers.other.error).toBeNull();
});

test("unmounting the initiating observer leaves a shared authorized request valid", async () => {
	const pending = deferredPage();
	let signal: AbortSignal | undefined;
	api.getGitStagingFiles = async (_target, _listId, _query, requestSignal) => {
		signal = requestSignal;
		return pending.promise;
	};
	await renderFiles();
	await renderFiles([{ name: "first" }, { name: "other" }]);
	await renderFiles([{ name: "other" }]);
	expect(signal?.aborted).toBe(false);
	pending.resolve(stagingPage());
	await flush();
	expect(readers.other.pages).toHaveLength(1);
	expect(readers.other.error).toBeNull();
});

test.each([
	"workspace",
	"account",
	"filter",
	"snapshot",
])("switching %s cancels an old page and rejects its late result", async (kind) => {
	const pending = deferredPage();
	let oldSignal: AbortSignal | undefined;
	const calls: Array<{ workspace: string; cursor?: string; filter?: GitStatusFilterChar[] }> = [];
	api.getGitStagingFiles = async (currentTarget, _listId, query, signal) => {
		calls.push({
			workspace: currentTarget.workspaceKey,
			cursor: query?.cursor,
			filter: query?.filter,
		});
		if (calls.length === 2) {
			oldSignal = signal;
			return pending.promise;
		}
		return {
			...stagingPage(query?.cursor, calls.length === 1 ? "second" : null),
			workspaceKey: currentTarget.workspaceKey,
			snapshotVersion: summary.lists[0].snapshotVersion,
		};
	};
	await renderFiles();
	const captured = readers.first;
	const oldQuery = client
		.getQueryCache()
		.find({ queryKey: ["gitStagingFiles", "w", "A", "n", "alice", "v1", []], exact: true });
	const props: FilesProbeProps = {};
	if (kind === "workspace") props.target = { ...target, workspaceKey: "other" };
	if (kind === "account") client.setQueryData(["auth", "me"], { id: "bob" });
	if (kind === "filter") props.filter = ["M"];
	if (kind === "snapshot")
		summary = {
			...summary,
			lists: summary.lists.map((entry) => ({ ...entry, snapshotVersion: "v2" })),
		};
	await renderFiles([props]);
	expect(oldSignal?.aborted).toBe(true);
	await captured.fetchNextPage();
	pending.resolve(stagingPage("late", "never"));
	await flush();
	expect(calls).toHaveLength(kind === "account" ? 2 : 3);
	expect((oldQuery?.state.data as { pages: GitStagingFilesPage[] }).pages).toHaveLength(1);
	expect(readers.first.pages.flatMap((page) => page.files).map((entry) => entry.path)).toEqual(
		kind === "account" ? [] : ["first.txt"],
	);
	expect(readers.first.error).toBeNull();
});

test("authorization loss removes private group facts and blocks a captured action", async () => {
	await render();
	const mutate = latest.mutation.mutateAsync;
	client.setQueryData(["auth", "me"], undefined);
	client.removeQueries({ queryKey: ["auth", "me"] });
	await flush();
	expect(latest.summary).toBeUndefined();
	expect(document.body.textContent).toBe("");
	await expect(mutate({ action: "delete", listId: "B", ...version })).rejects.toThrow("access");
	expect(actions).toEqual([]);
});
