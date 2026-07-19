import { describe, expect, test } from "bun:test";
import {
	resolveCanonicalPluginUiSessionContext,
	resolvePluginUiOwnerNarratorId,
} from "./PluginUiSurfaceContext";
import type { PluginDockPanelParams } from "./protocol";

function params(binding: PluginDockPanelParams["binding"]): PluginDockPanelParams {
	return {
		panelType: "plugin",
		schemaVersion: 1,
		pluginId: "com.example.review",
		contributionId: "dashboard",
		panelInstanceId: "pui-review",
		binding,
	};
}

describe("canonical plugin surface context recovery", () => {
	test("restores workspace narrator/project ownership from persisted binding", () => {
		const panel = params({
			kind: "workspace-narrator",
			workspaceId: "workspace-1",
			ownerNarratorId: "narrator-1",
		});
		const host = { surface: "workspace" as const, workspaceId: "workspace-1" };
		expect(resolvePluginUiOwnerNarratorId(host, panel)).toBe("narrator-1");
		expect(
			resolveCanonicalPluginUiSessionContext(host, panel, {
				narratorId: "narrator-1",
				chapterId: "chapter-1",
				projectId: "project-1",
			}),
		).toEqual({
			surface: "workspace",
			workspaceId: "workspace-1",
			narratorId: "narrator-1",
			chapterId: "chapter-1",
			projectId: "project-1",
		});
	});

	test("uses director as the live surface while preserving canonical ownership", () => {
		const panel = params({
			kind: "workspace-narrator",
			workspaceId: "workspace-1",
			ownerNarratorId: "narrator-1",
		});
		expect(
			resolveCanonicalPluginUiSessionContext(
				{
					surface: "director",
					workspaceId: "workspace-1",
					presentation: "director",
				},
				panel,
				{
					narratorId: "narrator-1",
					chapterId: "chapter-1",
					projectId: "project-1",
				},
			),
		).toEqual({
			surface: "director",
			workspaceId: "workspace-1",
			presentation: "director",
			narratorId: "narrator-1",
			chapterId: "chapter-1",
			projectId: "project-1",
		});
	});

	test("fails closed rather than borrowing ownership from another workspace", () => {
		const panel = params({
			kind: "workspace-narrator",
			workspaceId: "workspace-1",
			ownerNarratorId: "narrator-1",
		});
		expect(
			resolveCanonicalPluginUiSessionContext(
				{ surface: "workspace", workspaceId: "workspace-2" },
				panel,
				{
					narratorId: "narrator-1",
					chapterId: "chapter-1",
					projectId: "project-1",
				},
			),
		).toBeUndefined();
	});

	test("restores focus panels against the current focus narrator", () => {
		const panel = params({ kind: "focus-current-narrator" });
		expect(
			resolveCanonicalPluginUiSessionContext(
				{ surface: "focus", narratorId: "narrator-1" },
				panel,
				{
					narratorId: "narrator-1",
					chapterId: "chapter-1",
					projectId: "project-1",
				},
			),
		).toMatchObject({
			surface: "focus",
			narratorId: "narrator-1",
			chapterId: "chapter-1",
			projectId: "project-1",
		});
	});
});
