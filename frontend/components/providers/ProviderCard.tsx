import { Badge, Box, Card, Group, Switch, Text, UnstyledButton } from "@mantine/core";
import { IconChevronRight } from "@tabler/icons-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { ModelOption } from "../../lib/constants";
import classes from "./ProviderCard.module.css";

interface ProviderCardProps {
	label: string;
	prefix: string;
	badgeLabel?: string;
	visibleCount: number;
	hiddenCount: number;
	previewModels: ModelOption[];
	disabled: boolean;
	autoExcluded?: boolean;
	onToggleDisabled: () => void;
	onOpenConfig?: () => void;
}

export function ProviderCard({
	label,
	prefix,
	badgeLabel,
	visibleCount,
	hiddenCount,
	previewModels,
	disabled,
	autoExcluded,
	onToggleDisabled,
	onOpenConfig,
}: ProviderCardProps) {
	const { t } = useTranslation("settings");
	const nameId = useId();
	const metadataId = `${nameId}-metadata`;
	const showPrefix = prefix && prefix !== label;
	const showMetadata = badgeLabel || showPrefix || (autoExcluded && !disabled);
	const moreModels = visibleCount - previewModels.length;

	const content = (
		<>
			<Box component="span" className={classes.heading}>
				<Text component="span" id={nameId} className={classes.name} fw={600} size="sm">
					{label}
				</Text>
				{onOpenConfig && <IconChevronRight className={classes.chevron} size={16} aria-hidden />}
			</Box>
			{showMetadata && (
				<Box component="span" id={metadataId} className={classes.metadata}>
					{badgeLabel && (
						<Text component="span" size="xs" c="dimmed">
							{badgeLabel}
						</Text>
					)}
					{showPrefix && (
						<Text component="span" size="xs" c="dimmed">
							{prefix}
						</Text>
					)}
					{autoExcluded && !disabled && (
						<Badge component="span" size="xs" variant="outline" color="gray">
							{t("autoParticipation.excludedBadge")}
						</Badge>
					)}
				</Box>
			)}
			{!disabled && (
				<Box component="span" className={classes.preview}>
					{previewModels.map((model) => (
						<Text key={model.value} component="span" size="xs" c="dimmed" truncate>
							{model.label}
						</Text>
					))}
					{moreModels > 0 && (
						<Text component="span" size="xs" c="dimmed">
							+{moreModels} {t("overviewMoreModels")}
						</Text>
					)}
					{visibleCount === 0 && (
						<Text component="span" size="xs" c="dimmed">
							{t("overviewNoModels")}
						</Text>
					)}
				</Box>
			)}
		</>
	);

	return (
		<Card withBorder padding={0} className={classes.card}>
			{onOpenConfig ? (
				<UnstyledButton
					type="button"
					className={`${classes.body} ${classes.open}`}
					aria-labelledby={nameId}
					aria-describedby={showMetadata ? metadataId : undefined}
					onClick={onOpenConfig}
				>
					{content}
				</UnstyledButton>
			) : (
				<Box className={classes.body}>{content}</Box>
			)}
			<Group className={classes.footer} justify="space-between" wrap="nowrap">
				<Group gap="xs">
					<Text size="xs" fw={500}>
						{t("overviewModelCount", { count: visibleCount })}
					</Text>
					{hiddenCount > 0 && (
						<Text size="xs" c="dimmed">
							{t("overviewHiddenCount", { count: hiddenCount })}
						</Text>
					)}
				</Group>
				<Switch
					size="sm"
					checked={!disabled}
					onChange={onToggleDisabled}
					aria-label={t("providerOverviewToggle", { name: label })}
					style={{ flexShrink: 0 }}
				/>
			</Group>
		</Card>
	);
}
