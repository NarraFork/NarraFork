import type { GitStagingFilesPage } from "../../../shared/git-staging-lists";
import type { GitStatusPage, GitStatusPageSection } from "../../../shared/git-status-page";
import type {
	GitChangesListConfig,
	GitChangesListWindow,
	GitChangesPageStatsResult,
	GitChangesStatsSettlement,
	GitChangesStatsSource,
} from "./git-changes-list-model";

export type GitChangesWorkerCommand =
	| { type: "reset"; config: GitChangesListConfig }
	| { type: "append"; pages: readonly GitStatusPage[] }
	| { type: "configure"; config: GitChangesListConfig }
	| {
			type: "staging-pages";
			listId: string;
			pages: readonly GitStagingFilesPage[];
			offset?: number;
	  }
	| { type: "stats-source"; source: GitChangesStatsSource }
	| {
			type: "page-stats";
			source: GitChangesStatsSource;
			result?: GitChangesPageStatsResult;
			options?: GitChangesStatsSettlement;
	  }
	| { type: "window"; start: number; count: number }
	| { type: "scope"; section: GitStatusPageSection; directory?: string };
export type GitChangesWorkerRequest = GitChangesWorkerCommand & { id: number; generation: string };
export type GitChangesWorkerResponse = { id: number; generation: string } & (
	| { type: "window"; window: GitChangesListWindow }
	| { type: "scope"; paths: string[] }
	| { type: "error"; message: string }
);
