export type GitWorkspaceCategory = "worktree" | "index" | "refs" | "head" | "stash";
export interface GitWorkspaceSubscribe {
	type: "git_workspace_subscribe";
	subscriptionId: string;
	narratorId?: string;
	chapterId?: string;
	workspaceKey?: string;
}
export type GitWorkspaceClientMessage =
	| GitWorkspaceSubscribe
	| {
			type: "git_workspace_unsubscribe";
			subscriptionId: string;
	  };
export interface GitWorkspaceEventIdentity {
	subscriptionId: string;
	version: number;
	workspaceKey: string;
	repositoryKey: string;
	narratorId?: string;
	chapterId?: string;
}
export type GitWorkspaceServerMessage =
	| ({ type: "git_workspace_subscribed" } & GitWorkspaceEventIdentity)
	| ({
			type: "git_workspace_changed";
			categories: GitWorkspaceCategory[];
	  } & GitWorkspaceEventIdentity)
	| { type: "git_workspace_error"; subscriptionId: string; code: string; message: string };
