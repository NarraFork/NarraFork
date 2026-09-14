import { ActionIcon, Button, Menu, Tooltip } from "@mantine/core";
import { IconGitBranch, IconLock, IconLockOpen } from "@tabler/icons-react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { NarratorStatusToolbarAction } from "../header/NarratorStatusToolbar";
import { PathRulesPopover } from "./PathRulesPopover";

export interface BuildMobileToolbarActionsOptions {
	narratorId: string;
	t: (key: string) => string;
	hasPlanTrait: boolean;
	relaxedPlanEnabled: boolean;
	relaxedPlanForced: boolean;
	// biome-ignore lint/suspicious/noExplicitAny: mutation shape is incidental here
	relaxedPlanMutation: UseMutationResult<any, any, { id: string; relaxedPlan: boolean }, any>;
	isAskInPassing: boolean | null | undefined;
	chapterId: string | null | undefined;
	// biome-ignore lint/suspicious/noExplicitAny: mutation shape is incidental here
	promoteMutation: UseMutationResult<any, any, any, any>;
	handlePromote: () => void;
}

/**
 * The mobile status-row action set: path rules, relaxed-plan toggle, and promote.
 * These are session CONFIGURATION controls (they modify the state shown beside
 * them) rather than panel-opening tool entries — tool entries live in the header
 * registry (narrator-toolbar-items). Extracted from NarratorPanel to keep the
 * ~110-line array out of the panel body; still built per render (the toolbar
 * derives its measurement identity from the action keys, not array identity).
 */
export function buildMobileToolbarActions({
	narratorId,
	t,
	hasPlanTrait,
	relaxedPlanEnabled,
	relaxedPlanForced,
	relaxedPlanMutation,
	isAskInPassing,
	chapterId,
	promoteMutation,
	handlePromote,
}: BuildMobileToolbarActionsOptions): NarratorStatusToolbarAction[] {
	return [
		{
			key: "path-rules",
			collapsePriority: 10,
			// Inline reserve only. A vertical reserve cannot protect this badge: it is
			// painted inside the ActionIcon, which clips its own overflow, so padding
			// on the wrapper would only push the button off the row's centre line.
			visualOverflow: { inlineEnd: 4 },
			render: (mode) => (
				<PathRulesPopover
					narratorId={narratorId}
					t={t}
					triggerMode={mode === "menu" ? "menu" : "icon"}
				/>
			),
		},
		...(hasPlanTrait
			? ([
					{
						key: "relaxed-plan",
						collapsePriority: 20,
						render: (mode: "inline" | "menu") =>
							mode === "menu" ? (
								<Menu.Item
									key="relaxed-plan"
									leftSection={
										relaxedPlanEnabled ? <IconLockOpen size={16} /> : <IconLock size={16} />
									}
									disabled={relaxedPlanForced || relaxedPlanMutation.isPending}
									onClick={() =>
										relaxedPlanMutation.mutate({
											id: narratorId,
											relaxedPlan: !relaxedPlanEnabled,
										})
									}
								>
									{t("relaxed_plan")}
								</Menu.Item>
							) : (
								<Tooltip
									label={
										relaxedPlanForced ? t("relaxed_plan_forced_tooltip") : t("relaxed_plan_tooltip")
									}
								>
									<ActionIcon
										variant="subtle"
										color={relaxedPlanEnabled ? "teal" : "gray"}
										size="sm"
										aria-label={t("relaxed_plan")}
										disabled={relaxedPlanForced || relaxedPlanMutation.isPending}
										onClick={() =>
											relaxedPlanMutation.mutate({
												id: narratorId,
												relaxedPlan: !relaxedPlanEnabled,
											})
										}
									>
										{relaxedPlanEnabled ? <IconLockOpen size={16} /> : <IconLock size={16} />}
									</ActionIcon>
								</Tooltip>
							),
					},
				] satisfies NarratorStatusToolbarAction[])
			: []),
		...(isAskInPassing
			? ([
					{
						key: "promote",
						collapsePriority: 30,
						render: (mode: "inline" | "menu") =>
							mode === "menu" ? (
								<Menu.Item
									key="promote"
									leftSection={<IconGitBranch size={16} />}
									disabled={promoteMutation.isPending}
									onClick={handlePromote}
								>
									{t("promote")}
								</Menu.Item>
							) : (
								<Tooltip
									label={chapterId ? t("promote_chapter_hint") : t("promote_standalone_hint")}
								>
									<Button
										size="compact-xs"
										variant="light"
										color="teal"
										loading={promoteMutation.isPending}
										onClick={handlePromote}
									>
										{t("promote")}
									</Button>
								</Tooltip>
							),
					},
				] satisfies NarratorStatusToolbarAction[])
			: []),
		/*
		 * The terminal entry deliberately does NOT appear here any more.
		 *
		 * It is a tool entry, so it belongs to the registry-driven header row
		 * (`narrator-toolbar-items.tsx`) together with git / search / browser / the
		 * rest. Keeping a copy here would put the same control in two places at once
		 * on mobile — the header AND this status row — which is precisely the split
		 * that made the old mobile layout confusing to navigate.
		 *
		 * What stays in this row is session CONFIGURATION (path rules, relaxed plan,
		 * promote), which modifies the state shown beside it rather than opening a
		 * panel.
		 */
	];
}
