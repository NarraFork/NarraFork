import { ActionIcon, Button, Menu, Tooltip } from "@mantine/core";
import { IconGitBranch, IconLock, IconLockOpen } from "@tabler/icons-react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { NarratorStatusToolbarAction } from "../header/NarratorStatusToolbar";

export interface BuildMobileToolbarActionsOptions {
	bottomActions: NarratorStatusToolbarAction[];
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
 * Fixed session controls followed by the registry-driven bottom tools.
 * The toolbar derives its measurement identity from action keys, not array identity.
 */
export function buildMobileToolbarActions({
	bottomActions,
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
		...bottomActions,
	];
}
