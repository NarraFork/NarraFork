import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import i18next from "i18next";
import { Profiler, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { GitStatusPage } from "../../../shared/git-status-page";
import { setTypography } from "../../../shared/pretext-layout/typography";
import { useGitWorkspaceSubscription } from "../../hooks/useGit";
import { useGitStagingLists } from "../../hooks/useGitStagingLists";
import type { GitTarget } from "../../lib/api/git";
import { type MessageCallback, narratorWSManager } from "../../lib/narrator-ws-manager";
import commonEnglish from "../../locales/en/common.json";
import gitEnglish from "../../locales/en/git.json";
import { ConfirmDialogProvider } from "../common/ConfirmDialogProvider";
import { GitChangesTab } from "./GitChangesTab";
import { GitPatchView } from "./GitPatchView";
import {
	createGitBrowserNetwork,
	type GitBrowserBlockScenario,
} from "./git-changes.browser-network";
import { GIT_CHANGES_OVERSCAN, GIT_CHANGES_ROW_HEIGHT } from "./git-changes-list-model";
import { GIT_VIEW_PREFS_KEY } from "./git-view-prefs";

const params = new URLSearchParams(location.search);
const total = Number(params.get("total") ?? 10_000);
if (params.get("staging") === "1")
	localStorage.setItem("narrafork_token", params.get("fixtureId") ?? "git-browser-default");
else localStorage.removeItem("narrafork_token");
const network = createGitBrowserNetwork(total, {
	directorySize: Number(params.get("directorySize")) || undefined,
	branchingDirectories: params.get("branchingDirectories") === "1",
	staging: params.get("staging") === "1",
	stagingPaths: params.get("stagingPaths") === "1",
	blockMove: (params.get("blockMove") as GitBrowserBlockScenario | null) ?? undefined,
});
// Native-list fixtures use a deterministic push transport; ChangeLists retain
// the browser suite's real observation WebSocket server.
if (params.get("staging") !== "1") {
	const callbacks = new Map<number, MessageCallback>();
	const subscriptions = new Map<unknown, Record<string, unknown>>();
	let id = 0;
	let version = 0;
	Object.defineProperty(narratorWSManager, "connected", { configurable: true, value: true });
	narratorWSManager.getCredentialIdentity = () => 1;
	narratorWSManager.getConnectionCredentialIdentity = () => 1;
	narratorWSManager.addListener = (_options, callback) => {
		const handle = { _id: ++id };
		callbacks.set(handle._id, callback);
		return handle;
	};
	narratorWSManager.removeListener = (handle) => {
		callbacks.delete(handle._id);
	};
	narratorWSManager.send = (message) => {
		if (message.type === "git_workspace_subscribe") {
			subscriptions.set(message.subscriptionId, message);
			queueMicrotask(() => {
				for (const callback of callbacks.values())
					callback({ ...message, type: "git_workspace_subscribed", version: ++version });
				for (const callback of callbacks.values())
					callback({
						...message,
						type: "git_workspace_snapshot",
						version: ++version,
						view: "details",
						snapshot: { revision: version, updating: false, statusPages: network.publishCache() },
					});
			});
		} else if (message.type === "git_workspace_refresh") {
			const subscription = subscriptions.get(message.subscriptionId);
			const cache = network.publishCache();
			queueMicrotask(() => {
				for (const callback of callbacks.values())
					callback({
						...subscription,
						type: "git_workspace_snapshot",
						version: ++version,
						view: "details",
						snapshot: { revision: version, updating: false, statusPages: cache },
					});
			});
		} else if (message.type === "git_workspace_unsubscribe")
			subscriptions.delete(message.subscriptionId);
		return true;
	};
}
if (params.get("holdNextPage") === "1") network.holdNextPage();
const queryClient = new QueryClient({
	defaultOptions: {
		queries: { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false },
		mutations: { retry: false },
	},
});
if (params.get("staging") === "1")
	queryClient.setQueryData(["auth", "me"], { id: "browser-fixture-user" });
let currentTarget: GitTarget = {
	narratorId: "git-browser-fixture",
	workspaceKey: "workspace-a",
	canWrite: params.get("canWrite") === "1",
};
let setWorkspace: (target: GitTarget) => void;
let setExtraReader: (enabled: boolean) => void;
let setOrdinaryWidth: (width: number) => void;
function ExtraStagingReader({ target }: { target: GitTarget }) {
	useGitStagingLists(target);
	return null;
}
function WorkspaceAuthorization({ target }: { target: GitTarget }) {
	const subscriptions = useGitWorkspaceSubscription(target);
	const workspace = useQuery({
		queryKey: ["gitWorkspace", target.narratorId, target.workspaceKey],
		queryFn: async () => target,
	});
	useEffect(() => {
		if (workspace.data && workspace.dataUpdatedAt) subscriptions.confirmWorkspace(workspace.data);
	}, [subscriptions, workspace.data, workspace.dataUpdatedAt]);
	return null;
}
network.warm(currentTarget.workspaceKey);
localStorage.setItem(
	GIT_VIEW_PREFS_KEY,
	JSON.stringify({
		"workspace-a": params.get("mode") ?? "flat",
		"workspace-b": params.get("mode") ?? "flat",
	}),
);

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
	lng: "en",
	fallbackLng: "en",
	defaultNS: "git",
	ns: ["common", "git"],
	resources: { en: { common: commonEnglish, git: gitEnglish } },
	interpolation: { escapeValue: false },
});

const reactCommits = { count: 0, actualDurationMs: 0, maxActualDurationMs: 0, baseDurationMs: 0 };

function App() {
	const [target, setTarget] = useState(currentTarget);
	const [extraReader, setExtra] = useState(false);
	const [ordinaryWidth, showOrdinary] = useState(0);
	setWorkspace = setTarget;
	setExtraReader = setExtra;
	setOrdinaryWidth = showOrdinary;
	return (
		<I18nextProvider i18n={i18n}>
			<QueryClientProvider client={queryClient}>
				{params.get("staging") === "1" && <WorkspaceAuthorization target={target} />}
				<MantineProvider forceColorScheme="dark">
					<ConfirmDialogProvider>
						<div
							data-git-browser-fixture
							style={{ height: 620, width: "min(760px, 100%)", minWidth: 0, display: "flex" }}
						>
							<Profiler
								id="git-changes"
								onRender={(_id, _phase, actualDuration, baseDuration) => {
									reactCommits.count++;
									reactCommits.actualDurationMs += actualDuration;
									reactCommits.maxActualDurationMs = Math.max(
										reactCommits.maxActualDurationMs,
										actualDuration,
									);
									reactCommits.baseDurationMs = baseDuration;
								}}
							>
								<GitChangesTab target={target} />
								{extraReader && <ExtraStagingReader target={target} />}
							</Profiler>
						</div>
						{ordinaryWidth > 0 && (
							<div data-git-ordinary-comparison style={{ width: ordinaryWidth }}>
								<GitPatchView
									diff={network.ordinaryBlockDiff()}
									file="src/blocks.ts"
									resetKey="ordinary-comparison"
								/>
							</div>
						)}
					</ConfirmDialogProvider>
				</MantineProvider>
			</QueryClientProvider>
		</I18nextProvider>
	);
}

function viewport() {
	const list = document.querySelector<HTMLElement>("[data-git-changes-list]");
	return list?.matches("[data-radix-scroll-area-viewport], [data-mantine-scrollarea-viewport]")
		? list
		: (list?.querySelector<HTMLElement>(
				"[data-radix-scroll-area-viewport], [data-mantine-scrollarea-viewport]",
			) ?? list);
}

function activePages() {
	for (const query of queryClient.getQueryCache().getAll()) {
		if (query.getObserversCount() === 0) continue;
		const data = query.state.data as { pages?: GitStatusPage[] } | undefined;
		if (data?.pages?.[0]?.snapshotId) return data.pages;
	}
	return [];
}

function rows() {
	return [...document.querySelectorAll<HTMLElement>("[data-git-change-row]")];
}

function measurements(row: HTMLElement) {
	return [...row.querySelectorAll<HTMLElement>("*")]
		.filter(
			(element) => element.childElementCount === 0 && /^[+-]\d+$/.test(element.textContent ?? ""),
		)
		.map((element) => element.textContent ?? "");
}

function listActions() {
	return [...document.querySelectorAll<HTMLButtonElement>("[data-git-change-row] button")].filter(
		(button) => {
			const label = button.getAttribute("aria-label") ?? button.textContent ?? "";
			return /stage|discard/i.test(label);
		},
	);
}

const sectionNodeIds = new WeakMap<Element, number>();
let nextSectionNodeId = 0;

function displaySnapshot() {
	const mounted = rows();
	const scroll = viewport();
	return {
		at: performance.now(),
		busy: !!document.querySelector('[data-git-browser-fixture] [aria-busy="true"]'),
		refreshing:
			document
				.querySelector('[data-testid="git-changes-refresh"]')
				?.getAttribute("data-refreshing") === "true",
		rows: mounted
			.filter((row) => row.dataset.gitRowType === "file" || row.dataset.gitRowType === "directory")
			.map((row) => ({
				key: row.dataset.gitChangeRow ?? "",
				type: row.dataset.gitRowType ?? "",
				path: row.dataset.gitRowPath ?? "",
				measurements: measurements(row),
			})),
		directoryCounts: mounted
			.filter((row) => row.dataset.gitRowType === "directory")
			.map((row) => {
				const badge = row.querySelector(".mantine-Badge-root");
				return {
					path: row.dataset.gitRowPath ?? "",
					count: badge?.textContent ?? "",
					title: badge?.getAttribute("title") ?? null,
					expanded: row.querySelector("[aria-expanded]")?.getAttribute("aria-expanded"),
					actionDisabled:
						row.querySelector<HTMLButtonElement>(
							'button[aria-label="Stage"], button[aria-label="Unstage"]',
						)?.disabled ?? null,
				};
			}),
		sectionCounts: [...document.querySelectorAll<HTMLElement>("[data-git-section-count]")].map(
			(element) => element.textContent ?? "",
		),
		sectionNodeIds: [...document.querySelectorAll("[data-git-section-count]")].map((element) => {
			if (!sectionNodeIds.has(element)) sectionNodeIds.set(element, ++nextSectionNodeId);
			return sectionNodeIds.get(element);
		}),
		actions: listActions().map((button) => ({
			label: button.getAttribute("aria-label") ?? button.textContent ?? "",
			disabled: button.disabled,
		})),
		empty: !!document.querySelector('[data-git-row-type="empty"]'),
		mounted: mounted.length,
		visibleCapacity: Math.ceil((scroll?.clientHeight ?? 0) / GIT_CHANGES_ROW_HEIGHT),
		scrollTop: scroll?.scrollTop ?? 0,
		scrollHeight: scroll?.scrollHeight ?? 0,
	};
}

function snapshot() {
	const pages = activePages();
	const last = pages.at(-1);
	const scroll = viewport();
	const mounted = rows();
	return {
		runtime: {
			production: import.meta.env.PROD as unknown as boolean,
			development: import.meta.env.DEV as unknown as boolean,
			mode: import.meta.env.MODE,
		},
		workspace: currentTarget.workspaceKey,
		loaded: pages.reduce((count, page) => count + page.files.length, 0),
		pageCount: pages.length,
		hasMore: last?.hasMore ?? true,
		filteredTotal: last?.counts.filteredFiles ?? 0,
		snapshotIds: [...new Set(pages.map((page) => page.snapshotId))],
		mounted: mounted.length,
		rowKeys: mounted.map((row) => row.getAttribute("data-git-change-row")),
		filePaths: mounted
			.filter((row) => row.dataset.gitRowType === "file")
			.map((row) => row.dataset.gitRowPath ?? ""),
		directories: mounted
			.filter((row) => row.dataset.gitRowType === "directory")
			.map((row) => row.dataset.gitRowPath ?? ""),
		viewportHeight: scroll?.clientHeight ?? 0,
		scrollTop: scroll?.scrollTop ?? 0,
		scrollHeight: scroll?.scrollHeight ?? 0,
		rowHeight: GIT_CHANGES_ROW_HEIGHT,
		overscan: GIT_CHANGES_OVERSCAN,
		visibleCapacity: Math.ceil((scroll?.clientHeight ?? 0) / GIT_CHANGES_ROW_HEIGHT),
		visibility: document.visibilityState,
		react: { ...reactCommits },
		sampling: samplingSnapshot(),
		network: network.snapshot(),
		display: displaySnapshot(),
	};
}

type DisplaySample = ReturnType<typeof displaySnapshot> & {
	kind: "frame" | "mutation" | "boundary";
	pageRequests: number;
	snapshotIds: string[];
};
let continuity: DisplaySample[] | undefined;
let continuityObserver: MutationObserver | undefined;
let continuityAnimation: number | undefined;
function recordDisplay(kind: DisplaySample["kind"]) {
	if (!continuity) return;
	if (continuity.length >= 2_000)
		throw new Error("Git continuity sample exceeded its bounded budget");
	continuity.push({
		...displaySnapshot(),
		kind,
		pageRequests: network.snapshot().requests.length,
		snapshotIds: [...new Set(activePages().map((page) => page.snapshotId))],
	});
}
function startContinuity() {
	continuityObserver?.disconnect();
	if (continuityAnimation !== undefined) cancelAnimationFrame(continuityAnimation);
	continuity = [];
	recordDisplay("boundary");
	continuityObserver = new MutationObserver(() => recordDisplay("mutation"));
	const element = document.querySelector("[data-git-browser-fixture]");
	if (!element) throw new Error("Git fixture DOM is unavailable");
	continuityObserver.observe(element, {
		childList: true,
		subtree: true,
		characterData: true,
		attributes: true,
		attributeFilter: ["aria-busy", "disabled", "data-git-row-path", "data-refreshing"],
	});
	const tick = () => {
		recordDisplay("frame");
		continuityAnimation = requestAnimationFrame(tick);
	};
	continuityAnimation = requestAnimationFrame(tick);
}
function stopContinuity() {
	continuityObserver?.disconnect();
	if (continuityAnimation !== undefined) cancelAnimationFrame(continuityAnimation);
	continuityAnimation = undefined;
	recordDisplay("boundary");
	const result = continuity ?? [];
	continuity = undefined;
	return result;
}

function frame() {
	return new Promise<void>((done) => requestAnimationFrame(() => done()));
}

interface LongTaskSample {
	start: number;
	duration: number;
	name: string;
}
interface PerformanceSample {
	supported: boolean;
	startedAt: number;
	endedAt: number;
	frames: number[];
	maxFrameGapMs: number;
	longTasks: LongTaskSample[];
	maxMounted: number;
	operations: Array<{ name: string; start: number; end: number; frames: number }>;
}
let sample: PerformanceSample | undefined;
let observer: PerformanceObserver | undefined;
let animationFrame: number | undefined;
function recordLongTasks(entries: PerformanceEntry[]) {
	if (!sample) return;
	for (const entry of entries) {
		if (entry.startTime >= sample.startedAt) {
			sample.longTasks.push({ start: entry.startTime, duration: entry.duration, name: entry.name });
		}
	}
}
function startSampling() {
	observer?.disconnect();
	if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
	sample = {
		supported: PerformanceObserver.supportedEntryTypes.includes("longtask"),
		startedAt: performance.now(),
		endedAt: 0,
		frames: [],
		maxFrameGapMs: 0,
		longTasks: [],
		maxMounted: rows().length,
		operations: [],
	};
	observer = new PerformanceObserver((list) => recordLongTasks(list.getEntries()));
	if (sample.supported) observer.observe({ type: "longtask", buffered: false });
	const tick = (now: number) => {
		if (!sample || sample.endedAt) return;
		const previous = sample.frames.at(-1);
		if (previous !== undefined)
			sample.maxFrameGapMs = Math.max(sample.maxFrameGapMs, now - previous);
		sample.frames.push(now);
		sample.maxMounted = Math.max(sample.maxMounted, rows().length);
		animationFrame = requestAnimationFrame(tick);
	};
	animationFrame = requestAnimationFrame(tick);
}

function samplingSnapshot() {
	if (!sample) return null;
	return {
		frames: sample.frames.length,
		maxFrameGapMs: sample.maxFrameGapMs,
		longTaskCount: sample.longTasks.length,
		longTasks: sample.longTasks.slice(-8),
		maxMounted: sample.maxMounted,
		elapsedMs: (sample.endedAt || performance.now()) - sample.startedAt,
	};
}

async function scrollTo(fraction: number) {
	const scroll = viewport();
	if (!scroll) throw new Error("Git changes scroll viewport is unavailable");
	const start = performance.now();
	const framesBefore = sample?.frames.length ?? 0;
	scroll.scrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight) * fraction;
	scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
	await frame();
	await frame();
	sample?.operations.push({
		name: `scroll-${fraction}`,
		start,
		end: performance.now(),
		frames: sample.frames.length - framesBefore,
	});
}

export const fixture = {
	ready: () => snapshot().mounted > 0 && snapshot().loaded > 0,
	snapshot,
	rowStats(path: string, type: "file" | "directory") {
		const row = rows().find(
			(item) => item.dataset.gitRowPath === path && item.dataset.gitRowType === type,
		);
		if (!row) return null;
		return {
			path,
			text: row.innerText,
			measurements: measurements(row),
			stageDisabled:
				row.querySelector<HTMLButtonElement>('button[aria-label="Stage"]')?.disabled ?? null,
		};
	},
	diagnostics() {
		const state = snapshot();
		return {
			preview: [
				...document.querySelectorAll<HTMLElement>(
					"[data-git-staging-preview] [data-content-scrollport]",
				),
			].map((viewport) => ({
				top: viewport.scrollTop,
				height: viewport.clientHeight,
				scrollHeight: viewport.scrollHeight,
				projection: document
					.querySelector("[data-diff-content]")
					?.getAttribute("data-diff-projection-count"),
				indices: [...viewport.querySelectorAll<HTMLElement>("[data-diff-line-index]")]
					.map((row) => row.dataset.diffLineIndex)
					.filter(Boolean),
			})),
			state: {
				...state,
				rowKeys: state.rowKeys.slice(0, 8),
				filePaths: state.filePaths.slice(0, 8),
				directories: state.directories.slice(0, 8),
				snapshotIds: state.snapshotIds.slice(0, 4),
				display: {
					...state.display,
					rows: state.display.rows.slice(0, 3),
					actions: state.display.actions.slice(0, 6),
				},
				network: {
					...state.network,
					requests: state.network.requests.slice(-12),
					stagingDiffReads: state.network.stagingDiffReads.slice(-3).map((read) => ({
						...read,
						unitCount: read.units.length,
						units: read.units.slice(0, 3),
						unitMappings: read.unitMappings?.slice(0, 3),
					})),
					statsRequests: state.network.statsRequests.slice(-4).map((request) => ({
						...request,
						rowCount: request.rows.length,
						rows: request.rows.slice(0, 3),
					})),
					pending: state.network.pending.slice(0, 12),
					unexpected: state.network.unexpected.slice(0, 12),
				},
			},
			queries: queryClient
				.getQueryCache()
				.getAll()
				.slice(0, 8)
				.map((query) => ({
					key: JSON.stringify(query.queryKey).slice(0, 600),
					observers: query.getObserversCount(),
					status: query.state.status,
					fetchStatus: query.state.fetchStatus,
					error:
						query.state.error instanceof Error ? query.state.error.message.slice(0, 500) : null,
				})),
		};
	},
	async frames(count = 3) {
		for (let index = 0; index < count; index++) await frame();
	},
	scrollTo,
	async advance() {
		await frame();
		await frame();
		const deadline = performance.now() + 5_000;
		// A query page can precede its Worker window. Scrolling the previous bottom again
		// would be a no-op to Mantine and must not stand in for the next user interaction.
		for (;;) {
			const flat = [
				...document.querySelectorAll<HTMLButtonElement>('button[aria-pressed="true"]'),
			].some((button) => button.textContent === "List");
			const loaded = activePages().reduce((count, page) => count + page.files.length, 0);
			const renderedRows = Number(
				document.querySelector<HTMLElement>("[data-git-total-rows]")?.dataset.gitTotalRows ?? 0,
			);
			if (!flat || renderedRows >= loaded) break;
			if (performance.now() >= deadline)
				throw new Error("Git Worker viewport did not catch up to query pages");
			await frame();
		}
		const scroll = viewport();
		if (!scroll) throw new Error("Git changes scroll viewport is unavailable");
		const button = document.querySelector<HTMLButtonElement>(
			'[data-testid="git-changes-load-more"]',
		);
		if (button && !button.disabled) button.click();
		else {
			scroll.scrollTop = scroll.scrollHeight;
			scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
		}
	},
	integrity() {
		const pages = activePages();
		const files = pages.flatMap((page) => page.files);
		return {
			loaded: files.length,
			unique: new Set(files.map((file) => file.path)).size,
			first: files[0]?.path,
			last: files.at(-1)?.path,
			workspaces: [...new Set(files.map((file) => file.path.split("/")[0]))],
			revisions: [...new Set(files.map((file) => file.path.split("/")[1]))],
			statuses: [...new Set(files.map((file) => file.status))],
		};
	},
	holdNextPage: network.holdNextPage,
	expireNextCursor: network.expireNextCursor,
	failNextStagingMove: network.failNextStagingMove,
	observationControl: network.observationControl,
	holdStagingSync: network.holdStagingSync,
	releaseStagingSync: network.releaseStagingSync,
	holdStagingSummary: network.holdStagingSummary,
	releaseStagingSummary: network.releaseStagingSummary,
	startStagingSummaryRead() {
		void queryClient.invalidateQueries(
			{ queryKey: ["gitStagingLists", currentTarget.workspaceKey] },
			{ cancelRefetch: false },
		);
	},
	editStagingGroup: network.editStagingGroup,
	setTypography,
	showOrdinaryPatch: (width: number) => setOrdinaryWidth(width),
	setExtraStagingReader: (enabled: boolean) => setExtraReader(enabled),
	connectObservationTransport: () => narratorWSManager.connect(),
	holdStagingMove: network.holdStagingMove,
	releaseStagingMove: network.releaseStagingMove,
	async advanceStagingObservation() {
		network.advanceStagingObservation();
		await queryClient.invalidateQueries({ queryKey: ["gitStagingLists"] });
	},
	setCanWrite(canWrite: boolean) {
		currentTarget = { ...currentTarget, canWrite };
		setWorkspace(currentTarget);
	},
	holdFirstPage: network.holdFirstPage,
	holdStatistics: network.holdStatistics,
	releaseStatistics: network.releaseStatistics,
	denyNext: network.denyNext,
	releaseHeld: network.releaseHeld,
	startContinuity,
	stopContinuity,
	attemptListActions() {
		const buttons = listActions();
		for (const button of buttons) button.click();
		return { attempted: buttons.length, allDisabled: buttons.every((button) => button.disabled) };
	},
	revise(nextTotal?: number) {
		const version = network.revise(nextTotal);
		network.warm(currentTarget.workspaceKey);
		return version;
	},
	expireSnapshot() {
		// Exhaust automatic lease renewal so the retained range needs an explicit refresh.
		network.expireNextPage();
		for (const query of queryClient.getQueryCache().getAll()) {
			if (query.getObserversCount() === 0) continue;
			const data = query.state.data as { pages?: GitStatusPage[] } | undefined;
			if (!data?.pages?.[0]?.snapshotId) continue;
			query.setData({
				...data,
				pages: data.pages.map((page) => ({ ...page, expiresAt: Date.now() - 1 })),
			});
		}
	},
	switchWorkspace(workspaceKey: string) {
		currentTarget = { ...currentTarget, workspaceKey };
		network.warm(workspaceKey);
		setWorkspace(currentTarget);
	},
	startSampling,
	async stopSampling() {
		await frame();
		await frame();
		recordLongTasks(observer?.takeRecords() ?? []);
		observer?.disconnect();
		if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
		if (!sample) throw new Error("Performance sampling was not started");
		sample.endedAt = performance.now();
		return sample;
	},
};

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing Git browser fixture root");
Object.assign(window, { gitChangesFixture: fixture });
if (params.get("staging") === "1") narratorWSManager.connect();
createRoot(rootElement).render(<App />);
