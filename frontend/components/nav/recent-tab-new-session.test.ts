import { describe, expect, test } from "bun:test";
import type { RecentTab } from "../../hooks/recent-tabs-utils";
import { newSessionTargetFor } from "./recent-tab-new-session";

function tab(id: string, overrides: Partial<RecentTab> = {}): RecentTab {
	return { type: "narrator", id, title: id, lastVisitedAt: 1, ...overrides };
}

describe("侧栏新建会话的目标", () => {
	test("会话与子代理沿用自己作为目录来源", () => {
		expect(newSessionTargetFor(tab("n1"))).toEqual({ narratorId: "n1" });
		expect(newSessionTargetFor(tab("s1", { type: "subagent" }))).toEqual({ narratorId: "s1" });
	});

	test("文件夹是分组目标：没有目录可继承，建完归入该文件夹", () => {
		expect(newSessionTargetFor(tab("f1", { type: "folder" }))).toEqual({ folderId: "f1" });
	});

	test("项目标签不是新建目标", () => {
		expect(newSessionTargetFor(tab("p1", { type: "project" }))).toBeNull();
	});
});
