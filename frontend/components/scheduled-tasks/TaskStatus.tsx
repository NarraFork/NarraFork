import { statusRegistry } from "@frontend/lib/status-registry";
import { Badge, Group } from "@mantine/core";
import { type RunVerdict, runVerdict, type TaskLifecycle } from "@shared/scheduled-task-status";
import {
	IconAlertTriangle,
	IconCheck,
	IconClock,
	IconPlayerPause,
	IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

export function verdictAppearance(verdict: RunVerdict) {
	if (verdict === "succeeded")
		return { color: statusRegistry.narratorSubstatus("unread").color, Icon: IconCheck };
	if (verdict === "running")
		return { color: statusRegistry.narratorStatus("working").color, Icon: IconClock };
	if (verdict === "blocked" || verdict === "incomplete")
		return { color: statusRegistry.narratorStatus("waiting").color, Icon: IconAlertTriangle };
	if (verdict === "failed" || verdict === "timed_out")
		return { color: statusRegistry.narratorSubstatus("error").color, Icon: IconX };
	return { color: verdict === "interrupted" ? "orange" : "gray", Icon: IconClock };
}

export function RunVerdictBadge({
	status,
	outcome,
	verdict,
	requireReport = true,
}: {
	status?: string | null;
	outcome?: string | null;
	verdict?: RunVerdict;
	requireReport?: boolean;
}) {
	const { t } = useTranslation("scheduledTasks");
	const value = verdict ?? runVerdict(status, outcome, requireReport);
	const { color, Icon } = verdictAppearance(value);
	return (
		<Badge variant="light" color={color} leftSection={<Icon size={12} />}>
			{t(`verdict.${value}`)}
		</Badge>
	);
}

export function TaskLifecycleBadge({ lifecycle }: { lifecycle: TaskLifecycle }) {
	const { t } = useTranslation("scheduledTasks");
	return (
		<Badge
			variant="outline"
			color={lifecycle === "active" ? "blue" : "gray"}
			leftSection={lifecycle === "paused" ? <IconPlayerPause size={12} /> : undefined}
		>
			{t(`lifecycle.${lifecycle}`)}
		</Badge>
	);
}

export function RunAxes({ status, outcome }: { status: string; outcome: string | null }) {
	const { t } = useTranslation("scheduledTasks");
	return (
		<Group gap="xs">
			<Badge color="gray" variant="outline">
				{t("systemStatus")}: {t(`system.${status}`)}
			</Badge>
			<Badge color="gray" variant="outline">
				{t("modelOutcome")}: {outcome ? t(`outcome.${outcome}`) : t("outcome.none")}
			</Badge>
		</Group>
	);
}
