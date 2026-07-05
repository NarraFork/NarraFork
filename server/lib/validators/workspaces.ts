import { z } from "zod";

// Dockview's SerializedDockview envelope (grid + panels + floating/popout groups)
// is considerably larger than the legacy split-tree JSON, so allow more headroom.
const WORKSPACE_TREE_MAX = 500_000;

export const createWorkspaceSchema = z.object({
	title: z.string().max(200).optional(),
	tree: z.string().min(2).max(WORKSPACE_TREE_MAX), // JSON string: Dockview envelope or legacy SplitNode
});

export const updateWorkspaceSchema = z.object({
	title: z.string().max(200).optional(),
	tree: z.string().min(2).max(WORKSPACE_TREE_MAX).optional(),
});

// === Project DB (backup/import) ===

export const importProjectSchema = z.object({
	gitPath: z.string().min(1),
});
