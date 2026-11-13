/**
 * 侧栏右键「新建会话」的目标。
 *
 * 会话与子代理有自己的工作目录，新建时沿用它预填；文件夹只是一个分组，没有目录，
 * 目标就是「建完把新会话放进去」。
 */
import type { RecentTab } from "../../hooks/useRecentTabs";

export type NewSessionTarget = { narratorId: string } | { folderId: string };

export function newSessionTargetFor(tab: RecentTab): NewSessionTarget | null {
	if (tab.type === "narrator" || tab.type === "subagent") return { narratorId: tab.id };
	if (tab.type === "folder") return { folderId: tab.id };
	return null;
}
