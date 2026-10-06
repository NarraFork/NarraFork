export const FORK_WORKTREE_SOURCES = ["workspace", "commit"] as const;

export type ForkWorktreeSource = (typeof FORK_WORKTREE_SOURCES)[number];
