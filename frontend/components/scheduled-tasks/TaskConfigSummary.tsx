import type { ScheduledTask } from "@frontend/lib/api/scheduled-tasks";
import { Accordion, Group, Paper, Stack, Text, Title } from "@mantine/core";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

export function SummaryRow({ label, children }: { label: string; children: ReactNode }) {
	return (
		<Group align="flex-start" justify="space-between" gap="sm">
			<Text size="sm" c="dimmed">
				{label}
			</Text>
			<Text size="sm" style={{ maxWidth: "75%", overflowWrap: "anywhere" }}>
				{children}
			</Text>
		</Group>
	);
}

export function TaskConfigSummary({ task }: { task: ScheduledTask }) {
	const { t } = useTranslation("scheduledTasks");
	const permissions: Record<string, string> = {
		default: "permDefault",
		bypassPermissions: "permBypass",
		acceptEdits: "permAcceptEdits",
		readOnly: "permReadOnly",
		dontAsk: "permDontAsk",
	};
	const retention = task.cleanupPolicy;
	return (
		<Paper withBorder p="lg" radius="md">
			<Stack>
				<Title order={3}>{t("configuration")}</Title>
				<SummaryRow label={t("runContext")}>
					{t(task.runContext === "standalone" ? "ctxStandalone" : "ctxProject")}
				</SummaryRow>
				{task.projectId && <SummaryRow label={t("project")}>{task.projectId}</SummaryRow>}
				<SummaryRow label={t("cwd")}>{task.cwd || t("defaultDirectory")}</SummaryRow>
				<SummaryRow label={t("narratorMode")}>
					{t(task.narratorMode === "reuse" ? "modeReuse" : "modeNew")}
				</SummaryRow>
				<SummaryRow label={t("model")}>{task.model || t("modelFollowDefault")}</SummaryRow>
				{task.narratorMode === "reuse" && (
					<SummaryRow label={t("modelPolicy")}>{t(`policy.${task.modelPolicy}`)}</SummaryRow>
				)}
				<SummaryRow label={t("permissionMode")}>
					{permissions[task.permissionMode]
						? t(permissions[task.permissionMode])
						: task.permissionMode}
				</SummaryRow>
				<SummaryRow label={t("onBlocked")}>
					{t(`blockedPolicy.${task.onBlocked}`)}
					{task.onBlocked === "wait"
						? ` · ${t("minutesValue", { count: task.blockedWaitMinutes })}`
						: ""}
				</SummaryRow>
				<SummaryRow label={t("maxRunMinutes")}>
					{t("minutesValue", { count: task.maxRunMinutes })}
				</SummaryRow>
				<SummaryRow label={t("notifyOnSuccess")}>
					{t(task.notifyOnSuccess ? "yes" : "no")}
				</SummaryRow>
				<SummaryRow label={t("cleanupPolicy")}>
					{!retention || retention.mode === "none"
						? t("cleanupNone")
						: retention.mode === "keepLatestN"
							? t("retentionLatest", { count: retention.keepLatestN })
							: t("retentionDays", { count: retention.olderThanDays })}
				</SummaryRow>
				<SummaryRow label={t("locale")}>{task.locale}</SummaryRow>
				{task.capabilities.canSeePrompt && task.prompt !== undefined ? (
					<Accordion variant="contained">
						<Accordion.Item value="prompt">
							<Accordion.Control>{t("prompt")}</Accordion.Control>
							<Accordion.Panel>
								<Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
									{task.prompt}
								</Text>
							</Accordion.Panel>
						</Accordion.Item>
						{task.systemPrompt && (
							<Accordion.Item value="systemPrompt">
								<Accordion.Control>{t("systemPrompt")}</Accordion.Control>
								<Accordion.Panel>
									<Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
										{task.systemPrompt}
									</Text>
								</Accordion.Panel>
							</Accordion.Item>
						)}
					</Accordion>
				) : (
					<Text size="sm" c="dimmed">
						{t("promptRestricted")}
					</Text>
				)}
			</Stack>
		</Paper>
	);
}
