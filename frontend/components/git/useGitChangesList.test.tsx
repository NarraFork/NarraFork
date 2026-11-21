import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GitStatusPage, GitStatusPageStatsResult } from "../../../shared/git-status-page";
import { __setGitChangesWorkerFactory, type GitChangesWorkerPort } from "./git-changes-list-client";
import {
	GIT_CHANGES_ROW_HEIGHT,
	type GitChangesListConfig,
	GitChangesListModel,
	type GitChangesStatsSettlement,
	type GitChangesStatsSource,
} from "./git-changes-list-model";
import type {
	GitChangesWorkerRequest,
	GitChangesWorkerResponse,
} from "./git-changes-list-worker-protocol";
import { useGitChangesList } from "./useGitChangesList";

class ControlledWorker implements GitChangesWorkerPort {
	onmessage: GitChangesWorkerPort["onmessage"] = null;
	onerror: GitChangesWorkerPort["onerror"] = null;
	requests: GitChangesWorkerRequest[] = [];
	pending: GitChangesWorkerRequest[] = [];
	terminated = false;
	failAppend = false;
	holdWindows = false;
	heldWindows: GitChangesWorkerResponse[] = [];
	private model?: GitChangesListModel;
	postMessage(request: GitChangesWorkerRequest) {
		this.requests.push(request);
		this.pending.push(request);
	}
	terminate() {
		this.terminated = true;
	}
	flush() {
		while (this.pending.length && !this.terminated) {
			const request = this.pending.shift();
			if (!request) return;
			const base = { id: request.id, generation: request.generation };
			let response: GitChangesWorkerResponse;
			try {
				if (request.type === "reset")
					this.model = new GitChangesListModel(request.config, request.generation);
				const model = this.model;
				if (!model) throw new Error("Missing Worker model");
				switch (request.type) {
					case "append":
						if (this.failAppend) throw new Error("List unavailable");
						model.append(request.pages);
						break;
					case "staging-pages":
						model.appendStaging(request.listId, request.pages, request.offset);
						break;
					case "configure":
						model.configure(request.config);
						break;
					case "stats-source":
						model.setStatsSource(request.source);
						break;
					case "page-stats":
						model.mergePageStats(request.source, request.result, request.options);
						break;
				}
				response =
					request.type === "scope"
						? { ...base, type: "scope", paths: model.scope(request.section, request.directory) }
						: {
								...base,
								type: "window",
								window:
									request.type === "window"
										? model.window(request.start, request.count)
										: model.window(),
							};
			} catch (error) {
				response = { ...base, type: "error", message: String(error) };
			}
			if (this.holdWindows && response.type === "window") this.heldWindows.push(response);
			else this.onmessage?.({ data: response } as MessageEvent<GitChangesWorkerResponse>);
		}
	}
	releaseWindows() {
		for (const response of this.heldWindows.splice(0))
			this.onmessage?.({ data: response } as MessageEvent<GitChangesWorkerResponse>);
	}
}
const flat: GitChangesListConfig = {
	mode: "flat",
	filter: [],
	expanded: { staged: [], unstaged: [] },
};
function page(
	snapshotId: string,
	names: string[],
	options: Partial<GitStatusPage> = {},
): GitStatusPage {
	return {
		snapshotId,
		expiresAt: Date.now() + 120_000,
		files: names.map((path) => ({ path, status: " M" })),
		counts: {
			totalFiles: names.length,
			staged: 0,
			unstaged: names.length,
			untracked: 0,
			filteredFiles: names.length,
			filteredStaged: 0,
			filteredUnstaged: names.length,
			badgeCounts: { A: 0, M: names.length, D: 0, R: 0, C: 0, U: 0 },
			exact: true,
		},
		hasMore: false,
		nextCursor: null,
		complete: true,
		...options,
	};
}
const source = (generation: string, snapshotId: string, epoch = "1"): GitChangesStatsSource => ({
	pageGeneration: generation,
	snapshotId,
	filterKey: "",
	epoch,
});
function result(snapshotId: string, names: string[], added?: number): GitStatusPageStatsResult {
	return {
		snapshotId,
		rows: names.map((path) => ({
			type: "file",
			section: "unstaged",
			path,
			...(added === undefined ? {} : { added, removed: 1 }),
			complete: added !== undefined,
		})),
	};
}
type Input = Parameters<typeof useGitChangesList>[0];
type List = ReturnType<typeof useGitChangesList>;
let root: Root;
let latest: List;
let ports: ControlledWorker[];
let renders: {
	names: string[];
	staging: string[];
	current: boolean;
	counts?: number;
	height: number;
	snapshot?: string;
	candidateSnapshot?: string;
}[];
let simulatedViewports: WeakMap<HTMLDivElement, { top: number; writes: number[] }>;
let beforeConfigurationEffect: (() => void) | undefined;
let frames: Map<number, FrameRequestCallback>;
let clientHeightDescriptor: PropertyDescriptor | undefined;
let prototype: object;
const names = (list = latest) =>
	list.window.rows.flatMap((row) => (row.type === "file" ? [row.path] : []));
const added = () =>
	latest.window.rows.flatMap((row) => (row.type === "file" ? [row.file.displayLinesAdded] : []));
function Probe(input: Input) {
	latest = useGitChangesList(input);
	renders.push({
		names: names(latest),
		staging: latest.window.rows.flatMap((row) => (row.type === "staging-file" ? [row.path] : [])),
		current: latest.isCurrent,
		counts: latest.displayCounts?.totalFiles,
		height: latest.window.totalRows * (input.rowHeight ?? GIT_CHANGES_ROW_HEIGHT),
		snapshot: latest.displaySnapshotId,
		candidateSnapshot: latest.candidateWindow.snapshotId,
	});
	useLayoutEffect(() => {
		const viewport = latest.viewportRef.current;
		const simulation = viewport && simulatedViewports.get(viewport);
		if (simulation) simulation.top = Math.min(simulation.top, maximumScrollTop(viewport));
		const callback = beforeConfigurationEffect;
		beforeConfigurationEffect = undefined;
		callback?.();
	});
	return (
		<div ref={latest.viewportRef}>
			<div data-height={latest.window.totalRows * (input.rowHeight ?? GIT_CHANGES_ROW_HEIGHT)}>
				{names(latest).join(",")}
			</div>
		</div>
	);
}
function maximumScrollTop(viewport: HTMLDivElement) {
	return Math.max(
		0,
		Number(viewport.firstElementChild?.getAttribute("data-height")) - viewport.clientHeight,
	);
}
function simulateViewport(top: number) {
	const viewport = latest.viewportRef.current;
	if (!viewport) throw new Error("Missing viewport");
	const simulation = { top, writes: [] as number[] };
	simulatedViewports.set(viewport, simulation);
	Object.defineProperty(viewport, "scrollTop", {
		configurable: true,
		get: () => simulation.top,
		set: (value: number) => {
			simulation.writes.push(value);
			simulation.top = Math.max(0, Math.min(value, maximumScrollTop(viewport)));
		},
	});
	return { viewport, simulation };
}
async function scrollFrame() {
	await act(async () => {
		latest.onScroll();
		for (const callback of frames.values()) callback(0);
		frames.clear();
	});
	await flush();
}
async function render(input: Partial<Input> = {}) {
	await act(async () => {
		root.render(
			<Probe
				generation="g1"
				pages={[]}
				config={flat}
				displayScope="workspace-1"
				displayAllowed
				{...input}
			/>,
		);
	});
}
async function flush() {
	await act(async () => {
		ports.at(-1)?.flush();
	});
}
async function merge(
	statsSource: GitChangesStatsSource,
	stats?: GitStatusPageStatsResult,
	options?: GitChangesStatsSettlement,
) {
	await act(async () => latest.mergePageStats(statsSource, stats, options));
}
async function initial(names = ["old-file"]) {
	await render({ pages: [page("old-snapshot", names)] });
	await flush();
	await merge(source("g1", "old-snapshot"), result("old-snapshot", names, 7));
	await flush();
}
async function treeAtBottom() {
	const config: GitChangesListConfig = { ...flat, mode: "tree" };
	const snapshot = page("tree-snapshot", [
		...Array.from({ length: 12 }, (_, index) => `a/file-${index}`),
		...Array.from({ length: 30 }, (_, index) => `b${String(index).padStart(2, "0")}/file`),
	]);
	await render({ config, pages: [snapshot] });
	await flush();
	const scroll = simulateViewport((latest.window.totalRows - 3) * GIT_CHANGES_ROW_HEIGHT);
	await scrollFrame();
	await merge(source("g1", snapshot.snapshotId), {
		snapshotId: snapshot.snapshotId,
		rows: latest.candidateWindow.rows.flatMap((row) =>
			row.type === "file" || row.type === "directory"
				? [
						{
							type: row.type,
							section: row.section,
							path: row.path,
							added: 7,
							removed: 1,
							complete: true,
						},
					]
				: [],
		),
	});
	await flush();
	return { config, snapshot, ...scroll };
}
beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body><main></main></body></html>");
	frames = new Map();
	let nextFrame = 0;
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		IS_REACT_ACT_ENVIRONMENT: true,
		ResizeObserver: class {
			observe() {}
			disconnect() {}
		},
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			frames.set(++nextFrame, callback);
			return nextFrame;
		},
		cancelAnimationFrame: (id: number) => frames.delete(id),
	});
	prototype = window.HTMLElement.prototype;
	clientHeightDescriptor = Object.getOwnPropertyDescriptor(prototype, "clientHeight");
	Object.defineProperty(prototype, "clientHeight", { configurable: true, get: () => 90 });
	ports = [];
	renders = [];
	simulatedViewports = new WeakMap();
	beforeConfigurationEffect = undefined;
	__setGitChangesWorkerFactory(() => {
		const port = new ControlledWorker();
		ports.push(port);
		return port;
	});
	const container = window.document.querySelector("main");
	if (!container) throw new Error("Missing test container");
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	__setGitChangesWorkerFactory();
	if (clientHeightDescriptor)
		Object.defineProperty(prototype, "clientHeight", clientHeightDescriptor);
	else Reflect.deleteProperty(prototype, "clientHeight");
});

test("list Worker accepts only the active workspace and exact published statistics version", async () => {
	const cache = {
		status: "ready" as const,
		workerEpoch: "worker",
		memberVersion: 1,
		statsVersion: 1,
		updating: false,
	};
	const ownedPage = { ...page("snapshot", ["a"]), cache };
	await render({ pages: [ownedPage], workspaceIdentity: "workspace" });
	await flush();
	const base = {
		...source("g1", "snapshot"),
		workspaceIdentity: "workspace",
		workerEpoch: "worker",
		memberVersion: 1,
		statsVersion: 1,
	};
	const observed = {
		...result("snapshot", ["a"], 7),
		cache,
		workspaceIdentity: "workspace",
		filterKey: "",
	};
	await merge({ ...base, workspaceIdentity: "other" }, observed);
	await flush();
	expect(added()).toEqual([undefined]);
	await merge(base, observed);
	await flush();
	expect(added()).toEqual([7]);
	const next = { ...base, epoch: "two", statsVersion: 2 };
	await merge(next);
	await flush();
	expect(added()).toEqual([7]);
	const stale = { ...observed, rows: observed.rows.map((row) => ({ ...row, added: 999 })) };
	await merge(next, stale);
	await flush();
	expect(added()).toEqual([7]);
	const current = { ...stale, cache: { ...cache, statsVersion: 2 } };
	await merge(next, current);
	await flush();
	expect(added()).toEqual([999]);
});

describe("Git changes display handoff", () => {
	test("responsive 44px rows keep the same visible row, viewport window and scroll anchor", async () => {
		const snapshot = page(
			"mobile",
			Array.from({ length: 100 }, (_, index) => `file-${index}`),
		);
		await render({ pages: [snapshot] });
		await flush();
		const { viewport } = simulateViewport(300);
		await scrollFrame();
		await render({ pages: [snapshot], rowHeight: 44 });
		await flush();
		expect(viewport.scrollTop).toBe(440);
		expect(renders.at(-1)?.height).toBe(latest.window.totalRows * 44);
		expect(ports).toHaveLength(1);
		const request = ports[0].requests.filter((request) => request.type === "window").at(-1);
		expect(request).toMatchObject({ start: 10, count: 3 });
		await render({ pages: [snapshot], rowHeight: 30 });
		await flush();
		expect(viewport.scrollTop).toBe(300);
	});

	test("independent index pages use the one Worker, append only new pages and never replace workspace snapshots", async () => {
		const config: GitChangesListConfig = {
			...flat,
			staging: {
				lists: [
					{
						id: "A",
						name: "A",
						active: true,
						fileCount: 2,
						unitCount: 2,
						added: 6,
						removed: 4,
						needsReviewCount: 0,
						stats: { M: { files: 2, added: 6, removed: 4, binaryFiles: 0, gitlinkFiles: 0 } },
						snapshotVersion: "v1",
					},
				],
				expanded: ["A"],
				folders: {},
			},
		};
		const snapshot = page("native", ["work.txt"]);
		const first = {
			workspaceKey: "workspace-1",
			listId: "A",
			generation: 1,
			observationId: "o1",
			snapshotVersion: "v1",
			complete: false,
			nextCursor: btoa(JSON.stringify(["v1", 1])),
			stats: {
				complete: true as const,
				total: { M: { files: 2, added: 6, removed: 4, binaryFiles: 0, gitlinkFiles: 0 } },
				directories: [],
			},
			files: [
				{
					path: "one.txt",
					fileId: "f1",
					unitCount: 1,
					needsReviewCount: 0,
					status: "M",
					stats: { kind: "text" as const, added: 3, removed: 2 },
				},
			],
		};
		await render({
			config,
			pages: [snapshot],
			stagingPages: [{ listId: "A", pages: [first] }],
		});
		await flush();
		expect(ports).toHaveLength(1);
		expect(latest.window.snapshotId).toBe("native");
		expect(latest.window.rows.some((row) => row.key === "staging:A:file:one.txt")).toBe(true);
		const second = {
			...first,
			nextCursor: null,
			complete: true,
			files: [
				{
					path: "two.txt",
					fileId: "f1",
					unitCount: 1,
					needsReviewCount: 0,
					status: "M",
					stats: { kind: "text" as const, added: 3, removed: 2 },
				},
			],
		};
		await render({
			config,
			pages: [snapshot],
			stagingPages: [{ listId: "A", pages: [first, second] }],
		});
		await flush();
		const append = ports[0].requests.filter((request) => request.type === "staging-pages").at(-1);
		expect(append).toMatchObject({ listId: "A", pages: [second], offset: 1 });
		const paths = latest.scope("unstaged");
		await flush();
		expect(await paths).toEqual(["work.txt"]);
	});
	test("staging configure and ready pages hand off without an intermediate empty frame", async () => {
		const snapshot = page("native", []);
		const config: GitChangesListConfig = {
			...flat,
			staging: {
				lists: [
					{
						id: "A",
						name: "A",
						active: true,
						fileCount: 2,
						unitCount: 2,
						added: 6,
						removed: 4,
						needsReviewCount: 0,
						stats: { M: { files: 2, added: 6, removed: 4, binaryFiles: 0, gitlinkFiles: 0 } },
						snapshotVersion: "v1",
					},
				],
				expanded: ["A"],
				folders: {},
			},
		};
		const first = {
			workspaceKey: "workspace-1",
			listId: "A",
			generation: 1,
			observationId: "o1",
			snapshotVersion: "v1",
			complete: true,
			nextCursor: null,
			stats: {
				complete: true as const,
				total: { M: { files: 1, added: 3, removed: 2, binaryFiles: 0, gitlinkFiles: 0 } },
				directories: [],
			},
			files: [
				{
					path: "old.txt",
					fileId: "f1",
					unitCount: 1,
					needsReviewCount: 0,
					status: "M",
					stats: { kind: "text" as const, added: 3, removed: 2 },
				},
			],
		};
		await render({
			config,
			pages: [snapshot],
			stagingPages: [{ listId: "A", pages: [first] }],
		});
		await flush();
		expect(renders.at(-1)?.staging).toEqual(["old.txt"]);
		renders.length = 0;
		if (!config.staging) throw new Error("Missing staging fixture");
		const next = {
			...first,
			snapshotVersion: "v2",
			files: [
				{
					path: "new.txt",
					fileId: "f1",
					unitCount: 1,
					needsReviewCount: 0,
					status: "M",
					stats: { kind: "text" as const, added: 3, removed: 2 },
				},
			],
		};
		await render({
			config: {
				...config,
				staging: {
					...config.staging,
					lists: config.staging.lists.map((list) => ({
						...list,
						name: "Renamed",
						snapshotVersion: "v2",
					})),
				},
			},
			pages: [snapshot],
			stagingPages: [{ listId: "A", pages: [next] }],
		});
		const port = ports[0];
		port.holdWindows = true;
		await flush();
		expect(port.requests.at(-1)?.type).toBe("staging-pages");
		const intermediate = port.heldWindows.splice(0, port.heldWindows.length - 1);
		for (const response of intermediate) {
			await act(async () =>
				port.onmessage?.({ data: response } as MessageEvent<GitChangesWorkerResponse>),
			);
			expect(renders.at(-1)?.staging).toEqual(["old.txt"]);
		}
		await act(async () => port.releaseWindows());
		expect(renders.at(-1)?.staging).toEqual(["new.txt"]);
		expect(renders.every((frame) => frame.staging.length === 1)).toBe(true);
		expect(ports).toHaveLength(1);
	});
	test("the initial snapshot displays progressively without waiting for statistics", async () => {
		await render({ pages: [page("first", ["first-file"])] });
		expect(latest.isCurrent).toBe(false);
		await flush();
		expect(names()).toEqual(["first-file"]);
		expect(latest.candidateWindow.snapshotId).toBe("first");
		expect(latest.isCurrent).toBe(true);
		expect(latest.window.statsReady).toBe(false);
	});

	test("same-scope refresh keeps one frame and counts until the candidate statistics ACK", async () => {
		await initial();
		const oldScope = latest.scope;
		const oldClient = ports[0];
		await render({ generation: "g2" });
		expect(oldClient.terminated).toBe(true);
		expect(names()).toEqual(["old-file"]);
		expect(added()).toEqual([7]);
		expect(latest.displayGeneration).toBe("g1");
		expect(latest.isRetained).toBe(true);
		expect(latest.displayCounts?.totalFiles).toBe(1);
		expect("files" in (latest.displayCounts ?? {})).toBe(false);
		expect("nextCursor" in (latest.displayCounts ?? {})).toBe(false);
		await expect(oldScope("unstaged")).rejects.toMatchObject({ name: "AbortError" });
		await flush();
		expect(latest.candidateWindow.snapshotId).toBeUndefined();
		expect(names()).toEqual(["old-file"]);
		const freshPage = page("new-snapshot", ["new-a", "new-b"]);
		await render({ generation: "g2", pages: [freshPage] });
		expect(latest.isCurrent).toBe(false);
		await flush();
		expect(latest.candidateWindow.snapshotId).toBe("new-snapshot");
		expect(latest.candidateWindow.loadedFiles).toBe(2);
		expect(latest.window.loadedFiles).toBe(1);
		expect(latest.displaySnapshotId).toBe("old-snapshot");
		expect(latest.isConfiguring).toBe(false);
		expect(latest.isRetained).toBe(true);
		expect(names()).toEqual(["old-file"]);
		await expect(latest.scope("unstaged")).rejects.toMatchObject({ name: "AbortError" });
		await merge(source("g2", "new-snapshot"), result("new-snapshot", ["new-a", "new-b"]), {
			settled: true,
		});
		expect(names()).toEqual(["old-file"]);
		await flush();
		expect(names()).toEqual(["new-a", "new-b"]);
		expect(added()).toEqual([undefined, undefined]);
		expect(latest.displayCounts?.totalFiles).toBe(2);
		expect(latest.isRetained).toBe(false);
		expect(latest.isCurrent).toBe(true);
		const promise = latest.scope("unstaged");
		await flush();
		expect(await promise).toEqual(["new-a", "new-b"]);
	});

	test("an accepted empty snapshot replaces old rows without any statistics request", async () => {
		await initial();
		await render({ generation: "empty", pages: [page("empty-snapshot", [])] });
		expect(names()).toEqual(["old-file"]);
		await flush();
		expect(names()).toEqual([]);
		expect(latest.displaySnapshotId).toBe("empty-snapshot");
		expect(latest.displayCounts?.totalFiles).toBe(0);
		expect(latest.isCurrent).toBe(true);
	});

	test("automatic append cannot release a retained frame measured for a different candidate", async () => {
		await initial();
		const first = page("new", ["new-a"], { hasMore: true, nextCursor: "next" });
		await render({ generation: "g2", pages: [first] });
		await flush();
		await merge(source("g2", "new"), result("new", ["new-a"], 2), { settled: true });
		const second = page("new", ["new-b"]);
		await render({ generation: "g2", pages: [first, second] });
		await flush();
		expect(latest.candidateWindow.loadedFiles).toBe(2);
		expect(latest.candidateWindow.statsReady).toBe(false);
		expect(names()).toEqual(["old-file"]);
		expect(latest.isCurrent).toBe(false);
		await merge(source("g2", "new"), result("new", ["new-a", "new-b"], 2), { settled: true });
		await flush();
		expect(names()).toEqual(["new-a", "new-b"]);
		expect(latest.isCurrent).toBe(true);
	});

	test("statistics failure settles the new rows as unknown and leaves current-list operations available", async () => {
		await initial();
		await render({ generation: "g2", pages: [page("new", ["new-file"])] });
		await flush();
		await merge(source("g2", "new"), undefined, {
			settled: true,
			failed: true,
			rows: [{ type: "file", section: "unstaged", path: "new-file" }],
		});
		expect(names()).toEqual(["old-file"]);
		await flush();
		expect(names()).toEqual(["new-file"]);
		expect(added()).toEqual([undefined]);
		expect(latest.window.statsFailed).toBe(true);
		expect(latest.isCurrent).toBe(true);
	});

	test("a candidate-A failure arriving after Worker append-B cannot settle B before its own query", async () => {
		await initial();
		const first = page("new", ["new-a"], { hasMore: true, nextCursor: "next" });
		await render({ generation: "g2", pages: [first] });
		await flush();
		await merge(source("g2", "new"));
		await flush();
		const worker = ports.at(-1);
		if (!worker) throw new Error("Missing Worker");
		worker.holdWindows = true;
		await render({ generation: "g2", pages: [first, page("new", ["new-b"])] });
		await flush();
		expect(
			worker.heldWindows.some(
				(response) => response.type === "window" && response.window.loadedFiles === 2,
			),
		).toBe(true);
		expect(latest.candidateWindow.loadedFiles).toBe(1);
		await merge(source("g2", "new"), undefined, {
			settled: true,
			failed: true,
			rows: [{ type: "file", section: "unstaged", path: "new-a" }],
		});
		worker.holdWindows = false;
		await flush();
		expect(latest.candidateWindow.loadedFiles).toBe(2);
		expect(latest.candidateWindow.statsReady).toBe(false);
		expect(
			latest.candidateWindow.rows.find((row) => row.type === "file" && row.path === "new-b"),
		).toMatchObject({
			file: { statsEpoch: undefined, statsRefreshing: true },
		});
		expect(names()).toEqual(["old-file"]);
		expect(latest.isCurrent).toBe(false);
		await act(async () => worker.releaseWindows());
		expect(names()).toEqual(["old-file"]);
		await merge(source("g2", "new"), result("new", ["new-b"]), { settled: true });
		await flush();
		expect(names()).toEqual(["new-a", "new-b"]);
		expect(latest.isCurrent).toBe(true);
	});

	test("ordinary Worker failure keeps the old frame stale and a later retry can hand off", async () => {
		await initial();
		await render({ generation: "failed", pages: [page("failed", ["failed-file"])] });
		const failingWorker = ports.at(-1);
		if (!failingWorker) throw new Error("Missing Worker");
		failingWorker.failAppend = true;
		await flush();
		expect(names()).toEqual(["old-file"]);
		expect(latest.isRetained).toBe(true);
		expect(latest.isCurrent).toBe(false);
		expect(latest.error?.message).toContain("List unavailable");
		await render({ generation: "retry", pages: [page("retry", ["retry-file"])] });
		await flush();
		await merge(source("retry", "retry"), result("retry", ["retry-file"], 3));
		await flush();
		expect(names()).toEqual(["retry-file"]);
		expect(latest.error).toBeNull();
	});

	test("same-snapshot epoch refresh preserves numbers, rejects old results, then shows new unknowns", async () => {
		await initial();
		await merge(source("g1", "old-snapshot", "2"));
		await flush();
		expect(added()).toEqual([7]);
		expect(latest.window.statsRefreshing).toBe(true);
		const requests = ports[0].requests.length;
		await merge(source("g1", "old-snapshot", "1"), result("old-snapshot", ["old-file"], 88));
		expect(ports[0].requests).toHaveLength(requests);
		await merge(source("g1", "old-snapshot", "2"), result("old-snapshot", ["old-file"]));
		await flush();
		expect(added()).toEqual([undefined]);
		expect(latest.window.statsRefreshing).toBe(false);
	});

	test("permission loss and scope changes clear facts in the input render and revoke old callbacks", async () => {
		await initial();
		const revokedMerge = latest.mergePageStats;
		const revokedScope = latest.scope;
		renders = [];
		await render({ pages: [page("old-snapshot", ["old-file"])], displayAllowed: false });
		expect(
			renders.every((render) => render.names.length === 0 && render.counts === undefined),
		).toBe(true);
		expect(latest.candidateWindow.snapshotId).toBeUndefined();
		await expect(revokedScope("unstaged")).rejects.toMatchObject({ name: "AbortError" });
		await render({ pages: [page("old-snapshot", ["old-file"])] });
		await flush();
		const requests = ports.at(-1)?.requests.length;
		revokedMerge(source("g1", "old-snapshot"), result("old-snapshot", ["old-file"], 99));
		expect(ports.at(-1)?.requests.length).toBe(requests);
		expect(added()).toEqual([undefined]);
		renders = [];
		await render({ generation: "g2", displayScope: "workspace-2" });
		expect(
			renders.every((render) => render.names.length === 0 && render.counts === undefined),
		).toBe(true);
	});

	test("explicit clear invalidates the display and late responses until an explicit new generation", async () => {
		await initial();
		const mergeLate = latest.mergePageStats;
		const worker = ports[0];
		const lateMessage = worker.onmessage;
		await act(async () => latest.clearDisplay());
		expect(names()).toEqual([]);
		expect(latest.displayCounts).toBeUndefined();
		expect(worker.terminated).toBe(true);
		await act(async () => {
			mergeLate(source("g1", "old-snapshot"), result("old-snapshot", ["old-file"], 99));
			lateMessage?.({
				data: {
					id: 999,
					generation: "g1",
					type: "window",
					window: { ...latest.window, snapshotId: "old-snapshot" },
				},
			} as MessageEvent<GitChangesWorkerResponse>);
		});
		expect(names()).toEqual([]);
		await render({ generation: "g2", pages: [page("new", ["new-file"])] });
		await flush();
		expect(names()).toEqual(["new-file"]);
		expect(latest.isCurrent).toBe(true);
	});

	test("a retained refresh preserves scrollTop and the accepted shorter range clamps exactly once", async () => {
		await initial(Array.from({ length: 40 }, (_, index) => `old-${index}`));
		const viewport = latest.viewportRef.current;
		if (!viewport) throw new Error("Missing viewport");
		let top = 600;
		const writes: number[] = [];
		Object.defineProperty(viewport, "scrollTop", {
			configurable: true,
			get: () => top,
			set: (value: number) => {
				top = value;
				writes.push(value);
			},
		});
		await render({ generation: "g2", pages: [page("new", ["new-a", "new-b"])] });
		await flush();
		expect(top).toBe(600);
		expect(writes).toEqual([]);
		await merge(source("g2", "new"), result("new", ["new-a", "new-b"], 2));
		await flush();
		expect(top).toBe(0);
		expect(writes).toEqual([0]);
		expect(names()).toEqual(["new-a", "new-b"]);
	});

	test("user scrolling and view configuration changes exit a retained frame", async () => {
		await initial();
		await render({ generation: "g2", pages: [page("new", ["new-file"])] });
		await flush();
		const viewport = latest.viewportRef.current;
		if (!viewport) throw new Error("Missing viewport");
		viewport.scrollTop = 30;
		await act(async () => latest.onScroll());
		expect(names()).toEqual(["new-file"]);
		expect(latest.isRetained).toBe(false);
		await act(async () => {
			for (const callback of frames.values()) callback(0);
			frames.clear();
		});
		await flush();
		expect(latest.scrollVersion).toBe(1);
		await render({ generation: "g3" });
		expect(latest.isRetained).toBe(true);
		await render({ generation: "g3", config: { ...flat, mode: "tree" } });
		expect(names()).toEqual([]);
		expect(latest.isRetained).toBe(false);
		await flush();
		await render({
			generation: "g3",
			config: { ...flat, mode: "tree" },
			pages: [page("third", ["third-file"])],
		});
		await flush();
		expect(names()).toEqual(["third-file"]);
		expect(latest.isCurrent).toBe(true);
	});

	test.each([
		"configuration",
		"refresh",
	] as const)("%s keeps finite scroll geometry while viewport height is unavailable", async (transition) => {
		await initial();
		const viewport = latest.viewportRef.current;
		if (!viewport) throw new Error("Missing viewport");
		Object.defineProperty(viewport, "clientHeight", { configurable: true, value: undefined });
		if (transition === "configuration") {
			await render({
				config: { ...flat, expanded: { staged: [], unstaged: ["src"] } },
				pages: [page("old-snapshot", ["old-file"])],
			});
			await flush();
		} else {
			await render({ generation: "g2", pages: [page("new", ["new-file"])] });
			await flush();
			await merge(source("g2", "new"), result("new", ["new-file"], 3));
			await flush();
		}
		expect(viewport.scrollTop).toBe(0);
		expect(Number.isFinite(latest.window.start)).toBe(true);
		expect(Number.isFinite(latest.window.totalRows)).toBe(true);
		expect(names()).toEqual([transition === "configuration" ? "old-file" : "new-file"]);
		expect(latest.isCurrent).toBe(true);
	});

	test("directory configuration keeps its frame and statistics until the layout ACK commits", async () => {
		const { config, snapshot, viewport, simulation } = await treeAtBottom();
		const oldHeight = latest.window.totalRows * GIT_CHANGES_ROW_HEIGHT;
		const oldTop = viewport.scrollTop;
		const oldSource = latest.candidateWindow.statsSource;
		const oldScope = latest.scope;
		const worker = ports[0];
		worker.holdWindows = true;
		renders = [];
		await render({
			config: { ...config, expanded: { staged: [], unstaged: ["a"] } },
			pages: [snapshot],
		});
		expect(renders.every((frame) => frame.height === oldHeight)).toBe(true);
		expect(renders.every((frame) => frame.snapshot === snapshot.snapshotId)).toBe(true);
		expect(renders.every((frame) => frame.candidateSnapshot === snapshot.snapshotId)).toBe(true);
		expect(latest.candidateWindow.statsSource).toEqual(oldSource);
		expect(latest.displayCounts?.totalFiles).toBe(snapshot.counts.totalFiles);
		expect(latest.isConfiguring).toBe(true);
		expect(latest.isRetained).toBe(false);
		expect(latest.isCurrent).toBe(false);
		expect(latest.displayGeneration).toBe("g1");
		expect(latest.displaySnapshotId).toBe(snapshot.snapshotId);
		expect(latest.window.loadedFiles).toBe(snapshot.counts.filteredFiles);
		expect(latest.candidateWindow.loadedFiles).toBe(snapshot.counts.filteredFiles);
		expect(viewport.scrollTop).toBe(oldTop);
		expect(simulation.writes).toEqual([]);
		await expect(oldScope("unstaged")).rejects.toMatchObject({ name: "AbortError" });
		await expect(latest.scope("unstaged")).rejects.toMatchObject({ name: "AbortError" });
		await flush();
		expect(viewport.scrollTop).toBe(oldTop);
		await act(async () => worker.releaseWindows());
		expect(latest.isConfiguring).toBe(false);
		expect(latest.isCurrent).toBe(true);
		expect(latest.window.totalRows * GIT_CHANGES_ROW_HEIGHT).toBe(oldHeight + 360);
		expect(viewport.scrollTop).toBe(oldTop + 360);
		expect(simulation.writes).toEqual([oldTop + 360]);
		expect(latest.candidateWindow.statsSource).toEqual(oldSource);
		const scrollVersion = latest.scrollVersion;
		await scrollFrame();
		expect(latest.scrollVersion).toBe(scrollVersion);
		const expandedScope = latest.scope;
		await render({ config, pages: [snapshot] });
		await flush();
		expect(latest.isConfiguring).toBe(true);
		expect(latest.isCurrent).toBe(false);
		expect(latest.isRetained).toBe(false);
		expect(latest.displayGeneration).toBe("g1");
		expect(latest.displaySnapshotId).toBe(snapshot.snapshotId);
		expect(latest.window.loadedFiles).toBe(snapshot.counts.filteredFiles);
		expect(latest.candidateWindow.loadedFiles).toBe(snapshot.counts.filteredFiles);
		await expect(expandedScope("unstaged", "a")).rejects.toMatchObject({ name: "AbortError" });
		await expect(latest.scope("unstaged", "a")).rejects.toMatchObject({ name: "AbortError" });
		await act(async () => worker.releaseWindows());
		expect(latest.isCurrent).toBe(true);
		expect(latest.isConfiguring).toBe(false);
		expect(latest.window.totalRows * GIT_CHANGES_ROW_HEIGHT).toBe(oldHeight);
		expect(latest.window.loadedFiles).toBe(snapshot.counts.filteredFiles);
	});

	test("rapid directory configurations keep the original frame and only accept the final layout", async () => {
		const { config, snapshot, viewport } = await treeAtBottom();
		const oldTop = viewport.scrollTop;
		const oldHeight = latest.window.totalRows;
		const worker = ports[0];
		worker.holdWindows = true;
		const initialScope = latest.scope;
		const inFlightScope = initialScope("unstaged").then(
			() => undefined,
			(error: unknown) => error,
		);
		const expanded = { ...config, expanded: { staged: [], unstaged: ["a"] } };
		await render({ config: expanded, pages: [snapshot] });
		const firstScope = latest.scope;
		await flush();
		const firstAck = worker.heldWindows.find(
			(response) => response.type === "window" && response.window.totalRows > oldHeight,
		);
		if (!firstAck) throw new Error("Missing first configuration ACK");
		await render({ config, pages: [snapshot] });
		expect(latest.isCurrent).toBe(false);
		expect(latest.isConfiguring).toBe(true);
		await expect(latest.scope("unstaged")).rejects.toMatchObject({ name: "AbortError" });
		await act(async () => worker.releaseWindows());
		await flush();
		expect(latest.window.totalRows).toBe(oldHeight);
		expect(viewport.scrollTop).toBe(oldTop);
		await act(async () => worker.releaseWindows());
		expect(latest.window.totalRows).toBe(oldHeight);
		expect(viewport.scrollTop).toBe(oldTop);
		expect(latest.isCurrent).toBe(true);
		expect(await inFlightScope).toMatchObject({ name: "AbortError" });
		await expect(initialScope("unstaged")).rejects.toMatchObject({ name: "AbortError" });
		await expect(firstScope("unstaged")).rejects.toMatchObject({ name: "AbortError" });
		await act(async () =>
			worker.onmessage?.({ data: firstAck } as MessageEvent<GitChangesWorkerResponse>),
		);
		expect(latest.window.totalRows).toBe(oldHeight);
		expect(viewport.scrollTop).toBe(oldTop);
	});

	test("the latest configuration ACK restores the full path anchor before older ACKs arrive", async () => {
		const { config, snapshot, viewport, simulation } = await treeAtBottom();
		const oldTop = viewport.scrollTop;
		const oldRows = latest.window.totalRows;
		const worker = ports[0];
		worker.holdWindows = true;
		await render({
			config: { ...config, expanded: { staged: [], unstaged: ["a"] } },
			pages: [snapshot],
		});
		await flush();
		await render({
			config: { ...config, expanded: { staged: [], unstaged: ["a", "b00"] } },
			pages: [snapshot],
		});
		await flush();
		expect(latest.window.totalRows).toBe(oldRows);
		const final = worker.heldWindows.at(-1);
		expect(final).toMatchObject({ type: "window", window: { anchorDelta: 1 } });
		await act(async () => {
			worker.heldWindows.reverse();
			worker.releaseWindows();
		});
		expect(latest.window.totalRows).toBe(oldRows + 13);
		expect(viewport.scrollTop).toBe(oldTop + 390);
		expect(simulation.writes).toEqual([oldTop + 390]);
		expect(latest.isCurrent).toBe(true);
	});

	test("an old layout ACK between the input render and configure effect cannot publish old rows", async () => {
		const { config, snapshot, viewport } = await treeAtBottom();
		const oldRows = latest.window.totalRows;
		const oldTop = viewport.scrollTop;
		const worker = ports[0];
		worker.holdWindows = true;
		await render({
			config: { ...config, expanded: { staged: [], unstaged: ["a"] } },
			pages: [snapshot],
		});
		await flush();
		const oldAck = worker.heldWindows.find(
			(response) => response.type === "window" && response.window.totalRows > oldRows,
		);
		if (!oldAck) throw new Error("Missing held configuration ACK");
		beforeConfigurationEffect = () =>
			worker.onmessage?.({ data: oldAck } as MessageEvent<GitChangesWorkerResponse>);
		renders = [];
		await render({ config, pages: [snapshot] });
		expect(renders.every((frame) => frame.height === oldRows * GIT_CHANGES_ROW_HEIGHT)).toBe(true);
		expect(viewport.scrollTop).toBe(oldTop);
		expect(latest.isCurrent).toBe(false);
		await flush();
		await act(async () => worker.releaseWindows());
		expect(latest.window.totalRows).toBe(oldRows);
		expect(viewport.scrollTop).toBe(oldTop);
		expect(latest.isCurrent).toBe(true);
	});

	test("configuration synchronizes a viewport scroll whose animation frame has not run yet", async () => {
		const { config, snapshot, viewport } = await treeAtBottom();
		viewport.scrollTop = 0;
		await act(async () => latest.onScroll());
		expect(frames.size).toBe(1);
		await render({
			config: { ...config, expanded: { staged: [], unstaged: ["a"] } },
			pages: [snapshot],
		});
		await flush();
		expect(viewport.scrollTop).toBe(0);
		expect(latest.window.anchorDelta).toBe(0);
		expect(latest.window.start).toBe(0);
		expect(latest.isCurrent).toBe(true);
	});

	test.each([
		{ top: 840, expected: 1200 },
		{ top: 60, expected: 60 },
	])("scrolling to $top while configuration is pending respects the latest viewport", async ({
		top,
		expected,
	}) => {
		const { config, snapshot, viewport } = await treeAtBottom();
		const worker = ports[0];
		worker.holdWindows = true;
		await render({
			config: { ...config, expanded: { staged: [], unstaged: ["a"] } },
			pages: [snapshot],
		});
		await flush();
		viewport.scrollTop = top;
		await scrollFrame();
		await act(async () => worker.releaseWindows());
		expect(viewport.scrollTop).toBe(expected);
		worker.holdWindows = false;
		await flush();
		expect(viewport.scrollTop).toBe(expected);
		const firstVisible = Math.floor(expected / GIT_CHANGES_ROW_HEIGHT);
		expect(latest.window.start).toBeLessThanOrEqual(firstVisible);
		expect(latest.window.start + latest.window.rows.length).toBeGreaterThan(firstVisible);
		expect(latest.isCurrent).toBe(true);
	});

	test("collapsing a directory restores its hidden file anchor to the visible parent", async () => {
		const { config, snapshot, viewport, simulation } = await treeAtBottom();
		await render({
			config: { ...config, expanded: { staged: [], unstaged: ["a"] } },
			pages: [snapshot],
		});
		await flush();
		viewport.scrollTop = 300;
		await scrollFrame();
		simulation.writes = [];
		const oldRows = latest.window.totalRows;
		await render({ config, pages: [snapshot] });
		expect(latest.window.totalRows).toBe(oldRows);
		expect(viewport.scrollTop).toBe(300);
		await flush();
		expect(latest.window.totalRows).toBe(oldRows - 12);
		expect(viewport.scrollTop).toBe(30);
		expect(simulation.writes).toEqual([30]);
		expect(latest.isCurrent).toBe(true);
	});

	test("a new generation during configuration clears its candidate and invalidates old ACKs", async () => {
		const { config, snapshot } = await treeAtBottom();
		const expanded = { ...config, expanded: { staged: [], unstaged: ["a"] } };
		await render({ config: expanded, pages: [snapshot] });
		const scope = latest.scope;
		const worker = ports[0];
		worker.holdWindows = true;
		await flush();
		await render({ generation: "g2", config: expanded });
		expect(latest.candidateWindow.snapshotId).toBeUndefined();
		expect(latest.isCurrent).toBe(false);
		expect(latest.isConfiguring).toBe(false);
		await act(async () => worker.releaseWindows());
		expect(latest.candidateWindow.snapshotId).toBeUndefined();
		await expect(scope("unstaged")).rejects.toMatchObject({ name: "AbortError" });
		await render({ generation: "g2", config: expanded, pages: [page("next", ["new/file"])] });
		await flush();
		expect(latest.candidateWindow.snapshotId).toBe("next");
		await act(async () =>
			latest.mergePageStats(
				source("g2", "next"),
				{
					snapshotId: "next",
					rows: [{ type: "directory", section: "unstaged", path: "new", complete: false }],
				},
				{ settled: true },
			),
		);
		await flush();
		expect(latest.displaySnapshotId).toBe("next");
		expect(latest.isCurrent).toBe(true);
	});

	test("non-layout scope and permission changes revoke a pending directory frame immediately", async () => {
		const { config, snapshot } = await treeAtBottom();
		const expanded = { ...config, expanded: { staged: [], unstaged: ["a"] } };
		await render({ config: expanded, pages: [snapshot] });
		const worker = ports[0];
		worker.holdWindows = true;
		await flush();
		renders = [];
		await render({ config: { ...expanded, filter: ["M"] }, pages: [snapshot] });
		expect(renders.every((frame) => frame.height === 0 && frame.snapshot === undefined)).toBe(true);
		expect(latest.candidateWindow.snapshotId).toBeUndefined();
		expect(latest.isConfiguring).toBe(false);
		await render({ config: expanded, pages: [snapshot], displayAllowed: false });
		await act(async () => worker.releaseWindows());
		expect(latest.displaySnapshotId).toBeUndefined();
		expect(latest.candidateWindow.snapshotId).toBeUndefined();
		expect(latest.isCurrent).toBe(false);
		await render({
			config: expanded,
			pages: [snapshot],
			displayScope: "workspace-2",
			generation: "g2",
		});
		expect(latest.displaySnapshotId).toBeUndefined();
		expect(latest.candidateWindow.snapshotId).toBeUndefined();
		await expect(latest.scope("unstaged")).rejects.toMatchObject({ name: "AbortError" });
	});

	test("ordinary pagination preserves the visible path anchor when tree sorting inserts earlier rows", async () => {
		const tree: GitChangesListConfig = { ...flat, mode: "tree" };
		const first = page("snapshot", ["b", "c", "d", "e", "f", "g"], {
			hasMore: true,
			nextCursor: "next",
		});
		await render({ pages: [first], config: tree });
		await flush();
		const viewport = latest.viewportRef.current;
		if (!viewport) throw new Error("Missing viewport");
		viewport.scrollTop = 60;
		await act(async () => {
			latest.onScroll();
			for (const callback of frames.values()) callback(0);
			frames.clear();
		});
		await flush();
		await render({ pages: [first, page("snapshot", ["a"])], config: tree });
		await flush();
		expect(viewport.scrollTop).toBe(90);
		expect(latest.window.anchorDelta).toBe(1);
		expect(latest.isCurrent).toBe(true);
	});

	test("a user scroll following an anchor event in the same RAF advances pagination once", async () => {
		const tree: GitChangesListConfig = { ...flat, mode: "tree" };
		const first = page("snapshot", ["b", "c", "d", "e", "f", "g"], {
			hasMore: true,
			nextCursor: "next",
		});
		const second = page("snapshot", ["a"], { hasMore: true, nextCursor: "third" });
		await render({ pages: [first], config: tree });
		await flush();
		const viewport = latest.viewportRef.current;
		if (!viewport) throw new Error("Missing viewport");
		viewport.scrollTop = 60;
		await act(async () => {
			latest.onScroll();
			for (const callback of frames.values()) callback(0);
			frames.clear();
		});
		await flush();
		expect(latest.scrollVersion).toBe(1);
		await render({ pages: [first, second], config: tree });
		await flush();
		expect(viewport.scrollTop).toBe(90);
		await act(async () => {
			latest.onScroll();
			for (const callback of frames.values()) callback(0);
			frames.clear();
		});
		await flush();
		expect(latest.scrollVersion).toBe(1);
		await render({ pages: [first, second, page("snapshot", ["0"])], config: tree });
		await flush();
		expect(viewport.scrollTop).toBe(120);
		await act(async () => {
			latest.onScroll();
			viewport.scrollTop = 150;
			latest.onScroll();
			viewport.scrollTop = 180;
			latest.onScroll();
		});
		expect(frames.size).toBe(1);
		const previousRequests = ports[0].requests.filter(
			(request) => request.type === "window",
		).length;
		await act(async () => {
			for (const callback of frames.values()) callback(0);
			frames.clear();
		});
		await flush();
		expect(latest.scrollVersion).toBe(2);
		expect(ports[0].requests.filter((request) => request.type === "window")).toHaveLength(
			previousRequests + 1,
		);
	});

	test("configuration changes retire captured scope callbacks and their in-flight paths", async () => {
		await initial();
		const oldScope = latest.scope;
		const rejection = oldScope("unstaged").then(
			() => undefined,
			(error: unknown) => error,
		);
		await render({
			config: { ...flat, mode: "tree" },
			pages: [page("old-snapshot", ["old-file"])],
		});
		await flush();
		expect(await rejection).toMatchObject({ name: "AbortError" });
		await expect(oldScope("unstaged")).rejects.toMatchObject({ name: "AbortError" });
		expect(latest.isCurrent).toBe(true);
		const currentScope = latest.scope("unstaged");
		await flush();
		expect(await currentScope).toEqual(["old-file"]);
	});

	test("foreign generation statistics and an old asynchronous scope cannot cross a refresh", async () => {
		await initial();
		const rejection = latest.scope("unstaged").then(
			() => undefined,
			(error: unknown) => error,
		);
		await render({ generation: "g2", pages: [page("new", ["new-file"])] });
		expect(await rejection).toMatchObject({ name: "AbortError" });
		await flush();
		const requests = ports.at(-1)?.requests.length;
		await merge(source("g1", "new"), result("new", ["new-file"], 99));
		await merge({ ...source("g2", "new"), filterKey: "M" }, result("new", ["new-file"], 99));
		expect(ports.at(-1)?.requests.length).toBe(requests);
		expect(names()).toEqual(["old-file"]);
	});
});
