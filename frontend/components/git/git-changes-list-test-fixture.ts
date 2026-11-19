import { QueryClient, type QueryClientConfig } from "@tanstack/react-query";
import type { GitLineStats } from "../../../shared/git-line-stats";
import {
	GIT_STATUS_FILTER_CHARS,
	type GitStatusPage,
	type GitStatusPageQuery,
	gitStatusBadgeChar,
	gitStatusInSection,
	gitStatusMatchesSection,
} from "../../../shared/git-status-page";
import type { GitStatusSummary } from "../../hooks/useGit";
import { api } from "../../lib/api";
import { __setGitChangesWorkerFactory, type GitChangesWorkerPort } from "./git-changes-list-client";
import { GitChangesListModel } from "./git-changes-list-model";
import type {
	GitChangesWorkerRequest,
	GitChangesWorkerResponse,
} from "./git-changes-list-worker-protocol";

/** Deterministic transport for DOM tests; production always constructs a real Worker. */
export class TestGitChangesWorker implements GitChangesWorkerPort {
	onmessage: GitChangesWorkerPort["onmessage"] = null;
	onerror: GitChangesWorkerPort["onerror"] = null;
	terminated = false;
	requests: GitChangesWorkerRequest[] = [];
	private model: GitChangesListModel | undefined;
	private generation = "";
	postMessage(request: GitChangesWorkerRequest) {
		this.requests.push(request);
		queueMicrotask(() => {
			if (this.terminated) return;
			const base = { id: request.id, generation: request.generation };
			let response: GitChangesWorkerResponse;
			try {
				if (request.type === "reset") {
					this.model = new GitChangesListModel(request.config, request.generation);
					this.generation = request.generation;
				}
				const model = this.model;
				if (!model || request.generation !== this.generation) return;
				switch (request.type) {
					case "append":
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
				response = {
					...base,
					type: "error",
					message: error instanceof Error ? error.message : String(error),
				};
			}
			this.onmessage?.({ data: response } as MessageEvent<GitChangesWorkerResponse>);
		});
	}
	terminate() {
		this.terminated = true;
	}
}

/** Settle the query notification, React commit, Worker reply and follow-up commit. */
export async function flushGitChangesTestRender() {
	for (let turn = 0; turn < 8; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
}

let clients: QueryClient[] = [];
export function createGitChangesTestQueryClient(config?: QueryClientConfig) {
	const client = new QueryClient(config);
	client.setQueryData(["auth", "me"], { id: "fixture-alice" });
	clients.push(client);
	client.getQueryCache().subscribe((event) => {
		if (
			event.type === "updated" &&
			event.query.queryKey[0] === "gitStatus" &&
			event.action.type === "success"
		) {
			void client.invalidateQueries({ queryKey: ["gitStatusPages", event.query.queryKey[1]] });
		}
		if (
			event.type === "updated" &&
			event.query.queryKey[0] === "gitLineStats" &&
			event.action.type === "success"
		) {
			void client.invalidateQueries({ queryKey: ["gitStatusPageStats", event.query.queryKey[1]] });
		}
	});
	return client;
}

/** Existing behavior fixtures seed summaries; expose those files through the new page API. */
export function gitChangesFixturePage(
	status: GitStatusSummary,
	query: GitStatusPageQuery = {},
): GitStatusPage {
	const filter = query.filter ?? [];
	const matched = status.files.filter(
		(file) =>
			gitStatusMatchesSection(file.status, "staged", filter) ||
			gitStatusMatchesSection(file.status, "unstaged", filter),
	);
	const counts = {
		totalFiles: status.totalFiles ?? status.files.length,
		staged: status.staged,
		unstaged: status.unstaged,
		untracked: status.untracked,
		filteredFiles: matched.length,
		filteredStaged: status.files.filter((file) =>
			gitStatusMatchesSection(file.status, "staged", filter),
		).length,
		filteredUnstaged: status.files.filter((file) =>
			gitStatusMatchesSection(file.status, "unstaged", filter),
		).length,
		badgeCounts: Object.fromEntries(
			GIT_STATUS_FILTER_CHARS.map((char) => [char, 0]),
		) as GitStatusPage["counts"]["badgeCounts"],
		exact: status.totalFilesExact ?? !status.truncated,
	};
	if (filter.length === 0) {
		counts.filteredStaged = status.staged;
		counts.filteredUnstaged = status.unstaged + status.untracked;
	}
	for (const file of status.files)
		for (const section of ["staged", "unstaged"] as const) {
			if (gitStatusInSection(file.status, section))
				counts.badgeCounts[gitStatusBadgeChar(file.status, section)]++;
		}
	const offset = Number(query.cursor ?? 0);
	const limit = query.limit ?? 100;
	const files = matched
		.slice(offset, offset + limit)
		.map((file) => ({ path: file.path, status: file.status }));
	const legacyPrefix = filter.length === 0 && counts.totalFiles > status.files.length;
	const hasMore = offset + files.length < matched.length || legacyPrefix;
	return {
		snapshotId: `fixture:${status.headSha ?? "head"}:${filter.join("")}`,
		files,
		counts,
		complete: counts.exact,
		expiresAt: Date.now() + 120_000,
		hasMore,
		nextCursor: hasMore ? String(offset + files.length) : null,
		...(!counts.exact ? { limitReason: "records" as const } : {}),
	};
}

export function installGitChangesTestTransport() {
	clients = [];
	__setGitChangesWorkerFactory(() => new TestGitChangesWorker());
	const original = api.getGitStatusPage;
	const originalStats = api.getGitStatusPageStats;
	const originalStaging = api.getGitStagingLists;
	api.getGitStagingLists = async (target) => ({
		capability: { supported: true },
		workspaceKey: target.workspaceKey,
		initialized: false,
		generation: 0,
		observationId: null,
		activeListId: null,
		scannedAt: null,
		state: "uninitialized",
		lists: [],
		stats: {},
	});
	api.getGitStatusPageStats = async (target, query, signal) => {
		signal?.throwIfAborted();
		const client = [...clients]
			.reverse()
			.find((client) => client.getQueryData(["gitStatus", target.workspaceKey]));
		const status =
			client?.getQueryData<GitStatusSummary>(["gitStatus", target.workspaceKey]) ??
			(await api.getGitStatus(target));
		const lines = client
			? await client.fetchQuery<GitLineStats>({
					queryKey: ["gitLineStats", target.workspaceKey],
					queryFn: () => api.getGitLineStats(target, signal),
					staleTime: Infinity,
				})
			: await api.getGitLineStats(target, signal);
		signal?.throwIfAborted();
		const measurements = new Map(lines.files.map((file) => [file.path, file]));
		return {
			snapshotId: query.snapshotId,
			rows: query.rows.map((row) => {
				const members = status.files.filter(
					(file: GitStatusSummary["files"][number]) =>
						gitStatusMatchesSection(file.status, row.section, query.filter ?? []) &&
						(row.type === "file" ? file.path === row.path : file.path.startsWith(`${row.path}/`)),
				);
				let complete =
					members.length > 0 &&
					(row.type === "file" ||
						(!status.truncated &&
							(status.totalFiles ?? status.files.length) === status.files.length));
				let added = 0;
				let removed = 0;
				for (const file of members) {
					const measured = measurements.get(file.path);
					const a =
						measured?.[row.section === "staged" ? "stagedLinesAdded" : "unstagedLinesAdded"];
					const r =
						measured?.[row.section === "staged" ? "stagedLinesRemoved" : "unstagedLinesRemoved"];
					if (!measured?.complete || a == null || r == null) complete = false;
					else {
						added += a;
						removed += r;
					}
				}
				return { ...row, complete, ...(complete ? { added, removed } : {}) };
			}),
		};
	};
	api.getGitStatusPage = async (target, query) => {
		for (let index = clients.length - 1; index >= 0; index--) {
			const status = clients[index].getQueryData<GitStatusSummary>([
				"gitStatus",
				target.workspaceKey,
			]);
			if (status) return gitChangesFixturePage(status, query);
		}
		return gitChangesFixturePage(await api.getGitStatus(target), query);
	};
	return () => {
		api.getGitStatusPage = original;
		api.getGitStatusPageStats = originalStats;
		api.getGitStagingLists = originalStaging;
		__setGitChangesWorkerFactory();
		clients = [];
	};
}
