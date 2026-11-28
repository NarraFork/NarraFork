import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GitStagingFilesPage } from "../../../shared/git-staging-lists";

export interface GitStagingListPagesInput {
	listId: string;
	pages: readonly GitStagingFilesPage[];
}

import { type GitStatusPage, normalizeGitStatusFilter } from "../../../shared/git-status-page";
import { GitChangesListClient } from "./git-changes-list-client";
import {
	GIT_CHANGES_ROW_HEIGHT,
	type GitChangesListConfig,
	type GitChangesListWindow,
	type GitChangesPageStatsResult,
	type GitChangesRow,
	type GitChangesStatsSettlement,
	type GitChangesStatsSource,
} from "./git-changes-list-model";

const EMPTY_WINDOW: GitChangesListWindow = {
	rows: [],
	start: 0,
	totalRows: 0,
	loadedFiles: 0,
	loadedStaged: 0,
	loadedUnstaged: 0,
	anchorDelta: 0,
};
type Counts = GitStatusPage["counts"];
interface DisplayFrame {
	generation: string;
	window: GitChangesListWindow;
	counts?: Counts;
}
interface ListState {
	generation: string;
	displayScope: string;
	access: number;
	token: number;
	configKey: string;
	configRevision: number;
	layoutKey: string;
	display?: DisplayFrame;
	candidateWindow: GitChangesListWindow;
	waitingForStats: boolean;
	error: Error | null;
}
const sameStatsSource = (
	left: GitChangesStatsSource | null | undefined,
	right: GitChangesStatsSource | null | undefined,
) =>
	!!left &&
	!!right &&
	left.epoch === right.epoch &&
	left.snapshotId === right.snapshotId &&
	left.pageGeneration === right.pageGeneration &&
	left.filterKey === right.filterKey &&
	left.workspaceIdentity === right.workspaceIdentity &&
	left.workerEpoch === right.workerEpoch &&
	left.memberVersion === right.memberVersion &&
	left.statsVersion === right.statsVersion &&
	left.updating === right.updating;
interface ConfigurationAnchor {
	top: number;
	index: number;
	row?: GitChangesRow;
}
function configuredAnchorDelta(
	window: GitChangesListWindow,
	anchor: ConfigurationAnchor,
	fallback = window.anchorDelta,
) {
	// Use the original row identity to cover the full offset across consecutive configurations.
	const row = anchor.row;
	if (!row) return fallback;
	let index = window.rows.findIndex((candidate) => candidate.key === row.key);
	if (index < 0 && "path" in row) {
		let path = row.path;
		while (index < 0 && path.includes("/")) {
			path = path.slice(0, path.lastIndexOf("/"));
			index = window.rows.findIndex(
				(candidate) =>
					candidate.key ===
					("listId" in row
						? `staging:${row.listId}:directory:${path}`
						: `${row.section}:directory:${path}`),
			);
		}
	}
	return index < 0 ? fallback : window.start + index - anchor.index;
}
const cancelled = () => new DOMException("Cancelled", "AbortError");

export function useGitChangesList({
	generation,
	pages,
	config,
	displayScope,
	displayAllowed,
	workspaceIdentity,
	rowHeight = GIT_CHANGES_ROW_HEIGHT,
	stagingPages = [],
}: {
	generation: string;
	pages: readonly GitStatusPage[];
	config: GitChangesListConfig;
	displayScope: string;
	displayAllowed: boolean;
	workspaceIdentity?: string;
	rowHeight?: number;
	stagingPages?: readonly GitStagingListPagesInput[];
}) {
	const rowHeightRef = useRef(rowHeight);
	const previousRowHeight = rowHeightRef.current;
	rowHeightRef.current = rowHeight;
	const sentStaging = useRef(new Map<string, readonly GitStagingFilesPage[]>());
	const viewportRef = useRef<HTMLDivElement>(null);
	const clientRef = useRef<GitChangesListClient | null>(null);
	const sentPages = useRef(0);
	const lifetime = useRef({
		generation,
		displayScope,
		displayAllowed,
		access: 0,
		token: 0,
		suspended: false,
	});
	const previousLifetime = lifetime.current;
	if (
		previousLifetime.generation !== generation ||
		previousLifetime.displayScope !== displayScope ||
		previousLifetime.displayAllowed !== displayAllowed
	) {
		lifetime.current = {
			generation,
			displayScope,
			displayAllowed,
			access:
				previousLifetime.access +
				Number(
					previousLifetime.displayScope !== displayScope ||
						previousLifetime.displayAllowed !== displayAllowed,
				),
			token: previousLifetime.token + 1,
			suspended: false,
		};
	}
	const token = lifetime.current.token;
	const configKey = JSON.stringify(config);
	const layoutKey = JSON.stringify([config.mode, normalizeGitStatusFilter(config.filter)]);
	const configRef = useRef({ config, key: configKey, layoutKey, revision: 0 });
	configRef.current = {
		config,
		key: configKey,
		layoutKey,
		revision: configRef.current.revision + Number(configRef.current.key !== configKey),
	};
	// A return to the same preferences still requires its own acknowledgement and scope callback.
	const configRevision = configRef.current.revision;
	const configured = useRef(configRef.current);
	const minimumWindow = useRef(0);
	const countsRef = useRef<{ snapshotId: string; counts: Counts } | null>(null);
	const statsSourceRef = useRef<GitChangesStatsSource | null>(null);
	const retiredStatsEpochs = useRef(new Set<string>());
	const [state, setState] = useState<ListState>(() => ({
		generation,
		displayScope,
		access: lifetime.current.access,
		token,
		configKey,
		configRevision,
		layoutKey,
		candidateWindow: EMPTY_WINDOW,
		waitingForStats: false,
		error: null,
	}));
	const stateRef = useRef(state);
	const updateState = useCallback((next: ListState) => {
		stateRef.current = next;
		setState(next);
	}, []);
	const [scrollVersion, setScrollVersion] = useState(0);
	const frame = useRef<number | null>(null);
	const pendingUserScroll = useRef(false);
	const anchoredScrollTop = useRef<number | null>(null);
	const lastScrollTop = useRef(0);
	const configurationAnchor = useRef<ConfigurationAnchor | null>(null);
	const configurationScrolled = useRef(false);
	const pendingViewport = useRef<{
		token: number;
		configRevision: number;
		window: GitChangesListWindow;
		top: number;
		adjust: boolean;
		clamp: boolean;
		requestWindow: boolean;
	} | null>(null);
	const requestWindow = useCallback(() => {
		const active = lifetime.current;
		if (
			!active.displayAllowed ||
			active.suspended ||
			stateRef.current.configRevision !== configRef.current.revision
		)
			return;
		const viewport = viewportRef.current;
		return clientRef.current?.send({
			type: "window",
			start: Math.floor((viewport?.scrollTop ?? 0) / rowHeightRef.current),
			count: Math.ceil((viewport?.clientHeight || 480) / rowHeightRef.current),
		});
	}, []);

	useEffect(() => {
		const owner = lifetime.current;
		const old = stateRef.current;
		const retain =
			owner.displayAllowed &&
			!owner.suspended &&
			old.access === owner.access &&
			old.displayScope === displayScope &&
			old.layoutKey === configRef.current.layoutKey &&
			!!old.display?.window.snapshotId;
		updateState({
			generation,
			displayScope,
			access: owner.access,
			token: owner.token,
			configKey: configRef.current.key,
			configRevision: configRef.current.revision,
			layoutKey: configRef.current.layoutKey,
			display: retain ? old.display : undefined,
			candidateWindow: EMPTY_WINDOW,
			waitingForStats: retain,
			error: null,
		});
		setScrollVersion(0);
		if (frame.current != null) cancelAnimationFrame(frame.current);
		frame.current = null;
		pendingUserScroll.current = false;
		sentStaging.current.clear();
		sentPages.current = 0;
		statsSourceRef.current = null;
		retiredStatsEpochs.current.clear();
		countsRef.current = null;
		minimumWindow.current = 0;
		pendingViewport.current = null;
		configurationAnchor.current = null;
		configurationScrolled.current = false;
		configured.current = configRef.current;
		if (!retain) {
			if (viewportRef.current) viewportRef.current.scrollTop = 0;
			lastScrollTop.current = 0;
		}
		anchoredScrollTop.current = null;
		if (!displayAllowed || !owner.displayAllowed || owner.suspended) return;
		const active = () =>
			lifetime.current.token === owner.token &&
			lifetime.current.displayAllowed &&
			!lifetime.current.suspended;
		let client: GitChangesListClient;
		try {
			client = new GitChangesListClient(
				generation,
				(window, requestId) => {
					if (
						!active() ||
						requestId < minimumWindow.current ||
						configured.current.revision !== configRef.current.revision
					)
						return;
					const previous = stateRef.current;
					const noMeasurements = window.rows.every(
						(row) => row.type !== "file" && row.type !== "directory",
					);
					const statsAccepted =
						window.statsReady === true &&
						sameStatsSource(window.statsSource, statsSourceRef.current) &&
						window.statsSource?.snapshotId === window.snapshotId;
					const show =
						!!window.snapshotId && (!previous.waitingForStats || noMeasurements || statsAccepted);
					const handoff = show && previous.waitingForStats;
					const configuring = previous.configRevision !== configured.current.revision;
					if (show) {
						const pending = pendingViewport.current;
						const anchor = configurationAnchor.current;
						const top = pending?.top ?? viewportRef.current?.scrollTop ?? 0;
						const target = handoff
							? top
							: anchor
								? anchor.top +
									configuredAnchorDelta(
										window,
										anchor,
										configurationScrolled.current ? 0 : window.anchorDelta,
									) *
										rowHeightRef.current
								: top + window.anchorDelta * rowHeightRef.current;
						pendingViewport.current = {
							token: owner.token,
							configRevision: configured.current.revision,
							window,
							top: target,
							adjust: target !== top || pending?.adjust === true,
							clamp: handoff || configuring || pending?.clamp === true,
							requestWindow: configurationScrolled.current || pending?.requestWindow === true,
						};
						configurationAnchor.current = null;
					}
					const metadata = countsRef.current;
					updateState({
						...previous,
						configKey: configured.current.key,
						configRevision: configured.current.revision,
						layoutKey: configured.current.layoutKey,
						candidateWindow: window,
						display: show
							? {
									generation,
									window,
									counts:
										metadata && metadata.snapshotId === window.snapshotId
											? metadata.counts
											: undefined,
								}
							: previous.display,
						waitingForStats: previous.waitingForStats && !show,
						error: window.snapshotId ? null : previous.error,
					});
				},
				(error) => {
					if (active()) updateState({ ...stateRef.current, error });
				},
			);
		} catch (error) {
			if (active())
				updateState({
					...stateRef.current,
					error: error instanceof Error ? error : new Error(String(error)),
				});
			return;
		}
		clientRef.current = client;
		client.send({ type: "reset", config: configRef.current.config });
		requestWindow();
		return () => {
			client.close();
			if (clientRef.current === client) clientRef.current = null;
		};
	}, [generation, displayScope, displayAllowed, requestWindow, updateState]);

	useEffect(() => {
		if (
			!displayAllowed ||
			lifetime.current.suspended ||
			lifetime.current.displayScope !== displayScope ||
			clientRef.current?.generation !== generation
		)
			return;
		if (pages.length > sentPages.current) {
			const first = pages[0];
			if (first)
				countsRef.current = {
					snapshotId: first.snapshotId,
					counts: { ...first.counts, badgeCounts: { ...first.counts.badgeCounts } },
				};
			clientRef.current.send({ type: "append", pages: pages.slice(sentPages.current) });
			sentPages.current = pages.length;
			// A new model must first read the retained viewport's actual position.
			// Ordinary pagination keeps the model's existing path-anchor adjustment.
			const current = stateRef.current;
			if (current.waitingForStats || current.display?.generation !== generation)
				minimumWindow.current = requestWindow() ?? minimumWindow.current;
		}
	}, [pages, generation, displayScope, displayAllowed, requestWindow]);
	useEffect(() => {
		const active = lifetime.current;
		if (
			!displayAllowed ||
			active.suspended ||
			active.displayScope !== displayScope ||
			clientRef.current?.generation !== generation
		)
			return;
		const client = clientRef.current;
		if (configured.current.revision !== configRevision) {
			const previous = stateRef.current;
			const retain =
				previous.token === active.token &&
				previous.access === active.access &&
				previous.displayScope === displayScope &&
				previous.layoutKey === layoutKey &&
				previous.display?.generation === generation &&
				!!previous.display.window.snapshotId &&
				!previous.waitingForStats;
			if (retain && !configurationAnchor.current) {
				const top = viewportRef.current?.scrollTop ?? 0;
				const index = Math.floor(top / rowHeightRef.current);
				configurationAnchor.current = {
					top,
					index,
					row: previous.display?.window.rows[index - previous.display.window.start],
				};
				clientRef.current.send({
					type: "window",
					start: index,
					count: Math.ceil((viewportRef.current?.clientHeight || 480) / rowHeightRef.current),
				});
			}
			if (!retain) {
				configurationAnchor.current = null;
				configurationScrolled.current = false;
			}
			pendingViewport.current = null;
			for (const [id] of sentStaging.current) {
				const nextList = config.staging?.lists.find((list) => list.id === id);
				const previousList = configured.current.config.staging?.lists.find(
					(list) => list.id === id,
				);
				if (!nextList || nextList.snapshotVersion !== previousList?.snapshotVersion)
					sentStaging.current.delete(id);
			}
			configured.current = configRef.current;
			updateState({
				...previous,
				display: retain ? previous.display : undefined,
				candidateWindow: retain ? previous.candidateWindow : EMPTY_WINDOW,
				waitingForStats: false,
			});
			minimumWindow.current = client.send({ type: "configure", config }) ?? minimumWindow.current;
		}
		// Send ready immutable pages in the same turn as configure. Only its final
		// response may replace the confirmed frame, not configure's empty model.
		for (const input of stagingPages) {
			const key = input.listId;
			const previous = sentStaging.current.get(key);
			if (previous === input.pages) continue;
			const offset =
				previous?.length &&
				previous.length <= input.pages.length &&
				previous.every((page, index) => input.pages[index] === page)
					? previous.length
					: 0;
			minimumWindow.current =
				client.send({
					type: "staging-pages",
					listId: input.listId,
					pages: input.pages.slice(offset),
					offset,
				}) ?? minimumWindow.current;
			sentStaging.current.set(key, input.pages);
		}
	}, [
		config,
		configRevision,
		layoutKey,
		generation,
		displayScope,
		displayAllowed,
		stagingPages,
		updateState,
	]);

	useLayoutEffect(() => {
		if (previousRowHeight === rowHeight) return;
		const viewport = viewportRef.current;
		if (viewport) {
			viewport.scrollTop = (viewport.scrollTop / previousRowHeight) * rowHeight;
			lastScrollTop.current = viewport.scrollTop;
			anchoredScrollTop.current = viewport.scrollTop;
		}
		requestWindow();
	}, [rowHeight, previousRowHeight, requestWindow]);

	const mergePageStats = useCallback(
		(
			source: GitChangesStatsSource,
			result?: GitChangesPageStatsResult,
			options?: GitChangesStatsSettlement,
		) => {
			const active = lifetime.current;
			const client = clientRef.current;
			if (
				active.token !== token ||
				!active.displayAllowed ||
				active.suspended ||
				!client ||
				client.generation !== generation ||
				(source.pageGeneration !== undefined && source.pageGeneration !== generation) ||
				(workspaceIdentity !== undefined && source.workspaceIdentity !== workspaceIdentity) ||
				source.filterKey !== normalizeGitStatusFilter(configRef.current.config.filter).join(",") ||
				!source.snapshotId ||
				source.snapshotId !== stateRef.current.candidateWindow.snapshotId ||
				retiredStatsEpochs.current.has(source.epoch)
			)
				return;
			const previous = statsSourceRef.current;
			if (!sameStatsSource(previous, source)) {
				if (previous && previous.epoch !== source.epoch)
					retiredStatsEpochs.current.add(previous.epoch);
				client.send({ type: "stats-source", source });
				statsSourceRef.current = source;
			}
			if (result || (options?.settled && options.failed))
				client.send({ type: "page-stats", source, result, options });
		},
		[generation, token, workspaceIdentity],
	);
	const clearDisplay = useCallback(() => {
		const active = lifetime.current;
		if (active.suspended) return;
		lifetime.current = {
			...active,
			token: active.token + 1,
			access: active.access + 1,
			suspended: true,
		};
		clientRef.current?.close();
		clientRef.current = null;
		if (frame.current != null) cancelAnimationFrame(frame.current);
		frame.current = null;
		pendingUserScroll.current = false;
		countsRef.current = null;
		statsSourceRef.current = null;
		pendingViewport.current = null;
		configurationAnchor.current = null;
		configurationScrolled.current = false;
		updateState({
			...stateRef.current,
			token: lifetime.current.token,
			access: lifetime.current.access,
			display: undefined,
			candidateWindow: EMPTY_WINDOW,
			waitingForStats: false,
			error: null,
		});
	}, [updateState]);
	useLayoutEffect(() => {
		const pending = pendingViewport.current;
		if (
			!pending ||
			pending.token !== lifetime.current.token ||
			pending.configRevision !== configRef.current.revision ||
			pending.window !== state.display?.window
		)
			return;
		pendingViewport.current = null;
		const viewport = viewportRef.current;
		if (!viewport) return;
		const maximum = Math.max(
			0,
			pending.window.totalRows * rowHeightRef.current - (viewport.clientHeight || 480),
		);
		const top = viewport.scrollTop ?? 0;
		const target =
			pending.clamp || pending.adjust ? Math.max(0, Math.min(pending.top, maximum)) : top;
		if (target !== top) viewport.scrollTop = target;
		if (pending.clamp || pending.adjust) {
			anchoredScrollTop.current = viewport.scrollTop;
			if (pending.clamp) lastScrollTop.current = viewport.scrollTop;
		}
		if (pending.requestWindow) {
			configurationScrolled.current = false;
			requestWindow();
		}
	}, [state, requestWindow]);
	useEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;
		const observer = new ResizeObserver(requestWindow);
		observer.observe(viewport);
		requestWindow();
		return () => observer.disconnect();
	}, [requestWindow]);
	useEffect(
		() => () => {
			if (frame.current != null) cancelAnimationFrame(frame.current);
		},
		[],
	);

	const onScroll = useCallback(() => {
		const top = viewportRef.current?.scrollTop ?? 0;
		if (Math.abs(top - lastScrollTop.current) < 1) return;
		lastScrollTop.current = top;
		const anchored = anchoredScrollTop.current;
		const userScroll = anchored == null || Math.abs(top - anchored) > 1;
		const current = stateRef.current;
		if (userScroll && configurationAnchor.current) {
			const index = Math.floor(top / rowHeightRef.current);
			configurationAnchor.current = {
				top,
				index,
				row: current.display?.window.rows[index - current.display.window.start],
			};
			configurationScrolled.current = true;
		}
		if (userScroll && current.waitingForStats) {
			const candidate = current.candidateWindow;
			const metadata = countsRef.current;
			updateState({
				...current,
				waitingForStats: false,
				display: candidate.snapshotId
					? {
							generation: current.generation,
							window: candidate,
							counts:
								metadata && metadata.snapshotId === candidate.snapshotId
									? metadata.counts
									: undefined,
						}
					: undefined,
			});
		}
		pendingUserScroll.current ||= userScroll;
		if (frame.current != null) return;
		frame.current = requestAnimationFrame(() => {
			frame.current = null;
			requestWindow();
			anchoredScrollTop.current = null;
			if (pendingUserScroll.current) setScrollVersion((version) => version + 1);
			pendingUserScroll.current = false;
		});
	}, [requestWindow, updateState]);
	const scope = useCallback(
		async (section: "staged" | "unstaged", directory?: string) => {
			const isCurrent = () => {
				const active = lifetime.current;
				const current = stateRef.current;
				return (
					active.token === token &&
					active.displayAllowed &&
					!active.suspended &&
					current.token === token &&
					current.configKey === configKey &&
					current.configRevision === configRevision &&
					configRef.current.revision === configRevision &&
					configRef.current.key === configKey &&
					current.display?.generation === generation &&
					!!current.display.window.snapshotId &&
					!current.waitingForStats
				);
			};
			const client = clientRef.current;
			if (!client || !isCurrent()) throw cancelled();
			const paths = await client.scope(section, directory);
			if (!isCurrent() || clientRef.current !== client) throw cancelled();
			return paths;
		},
		[generation, token, configKey, configRevision],
	);
	const sameScope =
		displayAllowed &&
		!lifetime.current.suspended &&
		state.access === lifetime.current.access &&
		state.displayScope === displayScope;
	const acknowledged = state.configRevision === configRevision;
	const isConfiguring =
		sameScope &&
		state.token === lifetime.current.token &&
		!acknowledged &&
		state.layoutKey === layoutKey &&
		state.display?.generation === generation &&
		!!state.display.window.snapshotId &&
		!state.waitingForStats;
	const canDisplay = sameScope && (acknowledged || isConfiguring);
	const display = canDisplay ? state.display : undefined;
	const current = canDisplay && state.token === lifetime.current.token;
	const isCurrent =
		!!display?.window.snapshotId && display.generation === generation && current && acknowledged;
	return {
		generation,
		window: display?.window ?? EMPTY_WINDOW,
		candidateWindow: current ? state.candidateWindow : EMPTY_WINDOW,
		displayGeneration: display?.generation ?? generation,
		displaySnapshotId: display?.window.snapshotId,
		displayCounts: display?.counts,
		isRetained: !!display && !isCurrent && !isConfiguring,
		isConfiguring,
		isCurrent,
		error: current ? state.error : null,
		viewportRef,
		onScroll,
		scope,
		mergePageStats,
		clearDisplay,
		scrollVersion,
	};
}
