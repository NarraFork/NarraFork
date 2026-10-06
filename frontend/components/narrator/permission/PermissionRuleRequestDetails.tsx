import type { PendingPermission } from "@frontend/types/narrator";
import { Badge, Group, Paper, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { permissionRuleRequestView } from "./permission-rule-request-view";

export function PermissionRuleRequestDetails({ permission }: { permission: PendingPermission }) {
	const { t } = useTranslation("narrator");
	const view = permissionRuleRequestView(permission);
	if (!view) return null;
	return (
		<Paper withBorder p="xs" mb="xs" radius="sm">
			<Stack gap={4} style={{ overflowWrap: "anywhere" }}>
				<Text size="sm" fw={600}>
					{t("permissionRuleRequest.title")}
				</Text>
				<Group gap="xs">
					<Badge variant="light">{t(`permissionRuleRequest.${view.ruleType}`)}</Badge>
					{view.access && (
						<Badge variant="outline">{t(`permissionRuleRequest.${view.access}`)}</Badge>
					)}
				</Group>
				<Text size="xs">{t("permissionRuleRequest.scope", { narratorId: view.narratorId })}</Text>
				<Text size="xs">
					{t("permissionRuleRequest.device", {
						deviceId: view.deviceId ?? t("permissionRuleRequest.unknown"),
					})}
				</Text>
				{view.path && <Text size="xs">{t("permissionRuleRequest.path", { path: view.path })}</Text>}
				{view.pattern && (
					<Text size="xs">{t("permissionRuleRequest.pattern", { pattern: view.pattern })}</Text>
				)}
				{view.reason && (
					<Text size="xs" style={{ whiteSpace: "pre-wrap" }}>
						{t("permissionRuleRequest.reason", { reason: view.reason })}
					</Text>
				)}
			</Stack>
		</Paper>
	);
}
