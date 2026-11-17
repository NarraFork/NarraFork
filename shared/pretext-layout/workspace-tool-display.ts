import { readLeafText } from "./tool-io-projection";

export const WORKSPACE_LABELS = {
	workspaceCreate: "Create worktree",
	workspaceAttach: "Attach worktree",
	workspaceOperation: "Get worktree operation",
	workspaceList: "List worktrees",
	workspaceSwitch: "Switch directory",
	workspaceDevice: "Switch device",
	workspaceCreated: "Created",
	workspaceFailed: "Failed",
	workspaceUnknown: "Outcome unknown",
	workspaceChanged: "Switched",
	workspaceUnchanged: "Unchanged",
	workspaceEmpty: "No worktrees",
	workspaceTruncated: "List truncated",
	workspaceDetached: "Detached HEAD",
};

export function workspaceText(key: keyof typeof WORKSPACE_LABELS, labels?: Record<string, string>) {
	return labels?.[key] ?? WORKSPACE_LABELS[key];
}

export function workspaceObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function workspaceSummary(name: string, input: unknown, labels?: Record<string, string>) {
	const args = workspaceObject(input);
	if (name === "ListWorktrees" || (name === "Worktree" && readLeafText(args?.action) === "list")) {
		return workspaceText("workspaceList", labels);
	}
	if (name === "GetWorktreeOperation") return workspaceText("workspaceOperation", labels);
	if (["Worktree", "CreateWorktree", "AttachWorktree"].includes(name)) {
		const branch =
			readLeafText(args?.branchName) ?? readLeafText(workspaceObject(args?.branch)?.name);
		const path = readLeafText(args?.destinationPath)?.split(/[\\/]/).filter(Boolean).at(-1);
		const label = name === "AttachWorktree" ? "workspaceAttach" : "workspaceCreate";
		return `${workspaceText(label, labels)}${branch || path ? ` · ${branch || path}` : ""}`;
	}
	if (name === "SwitchDevice") {
		const device = readLeafText(args?.device);
		return `${workspaceText("workspaceDevice", labels)}${device ? ` · ${device}` : ""}`;
	}
	const path = readLeafText(workspaceObject(args?.target)?.cwd);
	return `${workspaceText("workspaceSwitch", labels)}${path ? ` · ${path}` : ""}`;
}
