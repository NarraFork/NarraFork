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
import { IconRefresh } from "@tabler/icons-react";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProviderStatus } from "./ProviderStatusBadge";

export interface ProviderCardProps {
	label: string;
	type: "platform" | "custom";
	badgeLabel?: string;
	status: ProviderStatus;
	statusError?: string;
	modelCount: number;
	hiddenCount: number;
	visibleModels: string[];
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
	badgeLabel,
	status,
	statusError,
	modelCount,
	hiddenCount,
	visibleModels,
	disabled,
	isRefreshing,
	onToggleDisabled,
	onRefresh,
	onOpenConfig,
	isSelected,
}: ProviderCardProps) {
	const { t } = useTranslation("settings");
	const [isHovered, setIsHovered] = useState(false);

	const visibleCount = modelCount - hiddenCount;
	const isHighlighted = Boolean(isSelected || isHovered);
	const previewModels = visibleModels.slice(0, 3);
	const hasMore = visibleModels.length > 3;

	return (
		<Card
			withBorder
			padding="sm"
			onClick={onOpenConfig}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onOpenConfig();
				}
			}}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
			onFocus={() => setIsHovered(true)}
			onBlur={() => setIsHovered(false)}
			role="button"
			tabIndex={0}
			style={{
				opacity: disabled ? 0.6 : 1,
				borderColor: isHighlighted ? "var(--mantine-color-indigo-5)" : undefined,
				borderWidth: isSelected ? 2 : 1,
				boxShadow: isHovered && !isSelected ? "0 0 0 1px var(--mantine-color-indigo-5)" : undefined,
				cursor: "pointer",
				transition: "border-color 150ms ease, box-shadow 150ms ease",
				height: "100%",
				display: "flex",
				flexDirection: "column",
			}}
		>
			<Stack gap="xs" style={{ flex: 1, minHeight: 0 }}>
				<Group justify="space-between" wrap="nowrap">
					<UnstyledButton
						onClick={(event) => {
							event.stopPropagation();
							onOpenConfig();
						}}
						style={{ flex: 1, minWidth: 0 }}
					>
						<Group gap="xs" wrap="nowrap">
							<Text fw={600} size="sm" truncate>
								{label}
							</Text>
							<Badge size="xs" variant="light" color={type === "platform" ? "violet" : "blue"}>
								{type === "platform"
									? t("providerTypePlatform")
									: (badgeLabel ?? t("providerTypeCustom"))}
							</Badge>
						</Group>
					</UnstyledButton>
					<Switch
						size="xs"
						checked={!disabled}
						onChange={(event) => {
							event.stopPropagation();
							onToggleDisabled();
						}}
						onClick={(event) => event.stopPropagation()}
						aria-label={disabled ? t("overviewEnable") : t("overviewDisable")}
					/>
				</Group>

				{/* Model preview or status */}
				{!disabled && previewModels.length > 0 ? (
					<Stack gap={4}>
						{previewModels.map((modelName) => (
							<Text key={modelName} size="xs" c="dimmed" truncate>
								{modelName}
							</Text>
						))}
						{hasMore && (
							<Text size="xs" c="dimmed" fs="italic">
								+{visibleModels.length - 3} {t("overviewMoreModels")}
							</Text>
						)}
					</Stack>
				) : !disabled && status === "unverified" ? (
					<Text size="xs" c="dimmed" fs="italic">
						{t("providerStatusUnverified")}
					</Text>
				) : status === "error" ? (
					<Tooltip label={statusError} multiline maw={300}>
						<Text size="xs" c="red" truncate>
							{t("providerStatusError")}: {statusError}
						</Text>
					</Tooltip>
				) : null}

				{/* Model count badges */}
				<Group justify="space-between" wrap="nowrap">
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
					{onRefresh && (
						<Tooltip label={t("providerRefreshModels")}>
							<ActionIcon
								variant="subtle"
								size="sm"
								onClick={(event) => {
									event.stopPropagation();
									onRefresh();
								}}
								loading={isRefreshing}
								disabled={disabled}
							>
								<IconRefresh size={16} />
							</ActionIcon>
						</Tooltip>
					)}
				</Group>
			</Stack>
		</Card>
	);
});
