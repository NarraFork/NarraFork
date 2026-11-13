import { createContext, type ReactNode } from "react";
import type { NarratorDockContextValue } from "./dock/NarratorDockContext";
import type { WorkspaceDockStore } from "./workspace/workspace-dock";

/** Remote entry never mounts a dock, workspace, plugin surface, or resource receiver. */
export const NarratorDockContext = createContext<NarratorDockContextValue | null>(null);
export function useNarratorDockContext(): NarratorDockContextValue | null {
	return null;
}
export function useWorkspaceDock(): WorkspaceDockStore | null {
	return null;
}
export function useWorkspaceId(): string | null {
	return null;
}
export function useWorkspaceDirectorActive(): boolean {
	return false;
}
export function useWorkspaceNarratorDockValue(): NarratorDockContextValue | null {
	return null;
}
export function useWorkspaceOutlineOpener() {
	return null;
}
export function NarratorDockProvider({ children }: { children: ReactNode }) {
	return children;
}
export function WorkspaceDockProvider({ children }: { children: ReactNode }) {
	return children;
}
