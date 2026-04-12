import {
	ActionIcon,
	Badge,
	Card,
	Group,
	Stack,
	Switch,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { IconRefresh, IconSettings } from "@tabler/icons-react";
import React from "react";
import { useTranslation } from "react-i18next";
import type { ProviderStatus } from "./ProviderStatusBadge";
import { ProviderStatusBadge } from "./ProviderStatusBadge";

export interface ProviderCardProps {
	label: string;
	type: "platform" | "custom";
	status: ProviderStatus;
	statusError?: string;
	modelCount: number;
	hiddenCount: number;
	disabled: boolean;
	isRefreshing?: boolean;
	onToggleDisabled: () => void;
	onRefresh?: () => void;
	onOpenConfig: () => void;
	isSelected?: boolean;
}

export const ProviderCard = React.memo(function ProviderCard({
	label,
	type,
	status,
	statusError,
	modelCount,
	hiddenCount,
	disabled,
	isRefreshing,
	onToggleDisabled,
	onRefresh,
	onOpenConfig,
	isSelected,
}: ProviderCardProps) {
	const { t } = useTranslation("settings");

	const visibleCount = modelCount - hiddenCount;

	return (
		<Card
			withBorder
			padding="sm"
			style={{
				opacity: disabled ? 0.6 : 1,
				borderColor: isSelected ? "var(--mantine-color-indigo-5)" : undefined,
				borderWidth: isSelected ? 2 : 1,
				cursor: "pointer",
			}}
		>
			<Stack gap="xs">
				<Group justify="space-between" wrap="nowrap">
					<UnstyledButton onClick={onOpenConfig} style={{ flex: 1, minWidth: 0 }}>
						<Group gap="xs" wrap="nowrap">
							<Text fw={600} size="sm" truncate>
								{label}
							</Text>
							<Badge size="xs" variant="light" color={type === "platform" ? "violet" : "blue"}>
								{type === "platform" ? t("providerTypePlatform") : t("providerTypeCustom")}
							</Badge>
						</Group>
					</UnstyledButton>
					<Switch
						size="xs"
						checked={!disabled}
						onChange={onToggleDisabled}
						aria-label={disabled ? t("overviewEnable") : t("overviewDisable")}
					/>
				</Group>

				<Group justify="space-between" wrap="nowrap">
					<ProviderStatusBadge status={status} errorMessage={statusError} size="xs" />
					{!disabled && (
						<Group gap={4}>
							<Badge size="xs" variant="light" color="blue">
								{t("overviewModelCount", { count: visibleCount })}
							</Badge>
							{hiddenCount > 0 && (
								<Tooltip label={t("overviewHiddenCount", { count: hiddenCount })}>
									<Badge size="xs" variant="light" color="gray">
										+{hiddenCount}
									</Badge>
								</Tooltip>
							)}
						</Group>
					)}
				</Group>

				<Group justify="flex-end" gap="xs">
					{onRefresh && (
						<Tooltip label={t("providerRefreshModels")}>
							<ActionIcon
								variant="subtle"
								size="sm"
								onClick={onRefresh}
								loading={isRefreshing}
								disabled={disabled}
							>
								<IconRefresh size={16} />
							</ActionIcon>
						</Tooltip>
					)}
					<Tooltip label={t("overviewSettings")}>
						<ActionIcon variant="subtle" size="sm" onClick={onOpenConfig}>
							<IconSettings size={16} />
						</ActionIcon>
					</Tooltip>
				</Group>
			</Stack>
		</Card>
	);
});
