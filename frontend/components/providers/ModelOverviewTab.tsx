import {
	ActionIcon,
	Badge,
	Box,
	Divider,
	Group,
	Paper,
	Stack,
	Switch,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { IconArrowDown, IconArrowUp, IconSettings } from "@tabler/icons-react";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelOption } from "../../lib/constants";

/** A provider group in the overview. */
export interface ProviderGroup {
	prefix: string;
	label: string;
	models: ModelOption[];
	disabled: boolean;
	isPlatform: boolean;
}

export interface ModelOverviewTabProps {
	groups: ProviderGroup[];
	hiddenModels: Set<string>;
	providerOrder: string[];
	disabledProviders: Set<string>;
	onProviderOrderChange: (order: string[]) => void;
	onToggleProviderDisabled: (prefix: string) => void;
	onOpenProviderDetail: (prefix: string) => void;
	selectedProvider: string | null;
}

const MAX_HIDDEN_COLLAPSED = 3;

export const ModelOverviewTab = React.memo(function ModelOverviewTab({
	groups,
	hiddenModels,
	providerOrder,
	onProviderOrderChange,
	onToggleProviderDisabled,
	onOpenProviderDetail,
	selectedProvider,
}: ModelOverviewTabProps) {
	const { t } = useTranslation("settings");

	const sortedGroups = useMemo(() => {
		const orderMap = new Map(providerOrder.map((p, i) => [p, i]));
		return [...groups].sort((a, b) => {
			const ai = orderMap.get(a.prefix) ?? 9999;
			const bi = orderMap.get(b.prefix) ?? 9999;
			return ai !== bi ? ai - bi : 0;
		});
	}, [groups, providerOrder]);

	const enabledGroups = useMemo(() => sortedGroups.filter((g) => !g.disabled), [sortedGroups]);

	const moveProvider = useCallback(
		(prefix: string, direction: -1 | 1) => {
			const prefixes = sortedGroups.map((g) => g.prefix);
			const idx = prefixes.indexOf(prefix);
			if (idx < 0) return;
			const newIdx = idx + direction;
			if (newIdx < 0 || newIdx >= prefixes.length) return;
			const next = [...prefixes];
			[next[idx], next[newIdx]] = [next[newIdx], next[idx]];
			onProviderOrderChange(next);
		},
		[sortedGroups, onProviderOrderChange],
	);

	return (
		<Stack gap="md">
			{/* ── Provider control rows ── */}
			<Paper withBorder p="xs">
				<Stack gap={0}>
					{sortedGroups.map((group, idx) => (
						<ProviderRow
							key={group.prefix}
							group={group}
							hiddenModels={hiddenModels}
							isFirst={idx === 0}
							isLast={idx === sortedGroups.length - 1}
							onMoveUp={() => moveProvider(group.prefix, -1)}
							onMoveDown={() => moveProvider(group.prefix, 1)}
							onToggleDisabled={() => onToggleProviderDisabled(group.prefix)}
							onOpenDetail={() => onOpenProviderDetail(group.prefix)}
							isSelected={selectedProvider === group.prefix}
							showDivider={idx < sortedGroups.length - 1}
							t={t}
						/>
					))}
					{sortedGroups.length === 0 && (
						<Text c="dimmed" ta="center" py="md" size="sm">
							{t("overviewNoProviders")}
						</Text>
					)}
				</Stack>
			</Paper>

			{/* ── Final model list (grouped by provider) ── */}
			{enabledGroups.length > 0 && (
				<Box>
					<Text size="sm" fw={600} mb="xs">
						{t("overviewFinalList")}
					</Text>
					<Stack gap="sm">
						{enabledGroups.map((group) => (
							<ProviderModelGroup
								key={group.prefix}
								group={group}
								hiddenModels={hiddenModels}
								t={t}
							/>
						))}
					</Stack>
				</Box>
			)}
		</Stack>
	);
});

// ── Compact provider row (no model expansion) ──────────

interface ProviderRowProps {
	group: ProviderGroup;
	hiddenModels: Set<string>;
	isFirst: boolean;
	isLast: boolean;
	onMoveUp: () => void;
	onMoveDown: () => void;
	onToggleDisabled: () => void;
	onOpenDetail: () => void;
	isSelected: boolean;
	showDivider: boolean;
	t: (key: string, opts?: Record<string, unknown>) => string;
}

const ProviderRow = React.memo(function ProviderRow({
	group,
	hiddenModels,
	isFirst,
	isLast,
	onMoveUp,
	onMoveDown,
	onToggleDisabled,
	onOpenDetail,
	isSelected,
	showDivider,
	t,
}: ProviderRowProps) {
	const { visibleCount, hiddenCount } = useMemo(() => {
		let v = 0;
		let h = 0;
		for (const m of group.models) {
			if (hiddenModels.has(m.value)) h++;
			else v++;
		}
		return { visibleCount: v, hiddenCount: h };
	}, [group.models, hiddenModels]);

	return (
		<>
			<Group
				gap="xs"
				wrap="nowrap"
				py={6}
				px={4}
				style={{
					opacity: group.disabled ? 0.5 : 1,
					background: isSelected ? "var(--mantine-color-indigo-light)" : undefined,
					borderRadius: 4,
				}}
			>
				{/* Name + badges */}
				<UnstyledButton onClick={onOpenDetail} style={{ flex: 1, minWidth: 0 }}>
					<Group gap={6} wrap="nowrap">
						<Text fw={500} size="sm" truncate>
							{group.label}
						</Text>
						{!group.disabled && (
							<Badge size="xs" variant="light" color="blue">
								{visibleCount}
							</Badge>
						)}
						{!group.disabled && hiddenCount > 0 && (
							<Badge size="xs" variant="light" color="gray">
								+{hiddenCount}
							</Badge>
						)}
						{group.disabled && (
							<Badge size="xs" variant="light" color="gray">
								{t("overviewDisabled")}
							</Badge>
						)}
					</Group>
				</UnstyledButton>

				{/* Sort */}
				<Group gap={2} wrap="nowrap">
					<Tooltip label={t("overviewMoveUp")}>
						<ActionIcon variant="subtle" size="xs" disabled={isFirst} onClick={onMoveUp}>
							<IconArrowUp size={14} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("overviewMoveDown")}>
						<ActionIcon variant="subtle" size="xs" disabled={isLast} onClick={onMoveDown}>
							<IconArrowDown size={14} />
						</ActionIcon>
					</Tooltip>
				</Group>

				{/* Enable/disable */}
				<Tooltip label={group.disabled ? t("overviewEnable") : t("overviewDisable")}>
					<Switch size="xs" checked={!group.disabled} onChange={onToggleDisabled} />
				</Tooltip>

				{/* Settings */}
				<Tooltip label={t("overviewSettings")}>
					<ActionIcon variant="subtle" size="sm" onClick={onOpenDetail}>
						<IconSettings size={16} />
					</ActionIcon>
				</Tooltip>
			</Group>
			{showDivider && <Divider />}
		</>
	);
});

// ── Provider model group in the final list ─────────────

interface ProviderModelGroupProps {
	group: ProviderGroup;
	hiddenModels: Set<string>;
	t: (key: string, opts?: Record<string, unknown>) => string;
}

const ProviderModelGroup = React.memo(function ProviderModelGroup({
	group,
	hiddenModels,
	t,
}: ProviderModelGroupProps) {
	const [hiddenExpanded, setHiddenExpanded] = useState(false);

	const { visible, hidden } = useMemo(() => {
		const v: ModelOption[] = [];
		const h: ModelOption[] = [];
		for (const m of group.models) {
			if (hiddenModels.has(m.value)) h.push(m);
			else v.push(m);
		}
		return { visible: v, hidden: h };
	}, [group.models, hiddenModels]);

	if (visible.length === 0 && hidden.length === 0) return null;

	return (
		<Box>
			<Text size="xs" fw={600} c="dimmed" mb={4}>
				{group.label}
			</Text>
			<Stack gap={1} pl="xs">
				{visible.map((m) => (
					<ModelLine key={m.value} model={m} dimmed={false} />
				))}
				{hidden.length > 0 && (
					<>
						{(hiddenExpanded ? hidden : hidden.slice(0, MAX_HIDDEN_COLLAPSED)).map((m) => (
							<ModelLine key={m.value} model={m} dimmed />
						))}
						{hidden.length > MAX_HIDDEN_COLLAPSED && (
							<UnstyledButton onClick={() => setHiddenExpanded((v) => !v)}>
								<Text size="xs" c="dimmed" td="underline">
									{hiddenExpanded
										? t("overviewCollapseHidden")
										: t("overviewExpandHidden", {
												count: hidden.length - MAX_HIDDEN_COLLAPSED,
											})}
								</Text>
							</UnstyledButton>
						)}
					</>
				)}
			</Stack>
		</Box>
	);
});

// ── Single model line ──────────────────────────────────

const ModelLine = React.memo(function ModelLine({
	model,
	dimmed,
}: {
	model: ModelOption;
	dimmed: boolean;
}) {
	const id = model.value.includes(":") ? model.value.split(":").slice(1).join(":") : model.value;
	const suffix = model.rateMultiplier != null ? ` (×${model.rateMultiplier})` : "";
	const displayLabel = model.label !== id ? `${model.label}${suffix}` : suffix || undefined;

	return (
		<Group gap="xs" wrap="nowrap" style={dimmed ? { opacity: 0.4 } : undefined}>
			<Text size="xs" ff="monospace" truncate style={{ minWidth: 0, flex: 1 }}>
				{id}
			</Text>
			{displayLabel && (
				<Text size="xs" c="dimmed" truncate style={{ minWidth: 0, flexShrink: 0, maxWidth: "40%" }}>
					{displayLabel}
				</Text>
			)}
		</Group>
	);
});
