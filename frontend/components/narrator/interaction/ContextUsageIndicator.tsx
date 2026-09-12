import { Anchor, Box, Group, Menu, Stack, Switch, Text, Tooltip } from "@mantine/core";
import { IconArrowsMinimize, IconEraser, IconSettings } from "@tabler/icons-react";
import { api } from "../../../lib/api";
import { formatLocaleNumber } from "../../../lib/intl-format";

export interface ContextUsageIndicatorProps {
	narratorId: string;
	/** Percentage of the context window used (0-100), or null before first data. */
	contextPercent: number | null;
	/** True when the shown figure is stale (model/window changed) — renders "?". */
	contextStale: boolean;
	/** Workspace-preview mounts render just the ring (no interactive menu). */
	isWorkspacePreview: boolean;
	/** Effective prune/compact thresholds (session override falls back to model defaults). */
	activePruneStart: number | null;
	activeCompactStart: number | null;
	modelThresholds: { pruneStart?: number; compactStart?: number } | undefined;
	forceCompactPruneThreshold: number;
	prunedPercent: number | null;
	promptTokens: number | null;
	contextWindow: number | null;
	isEstimated: boolean;
	pruneEnabledEffective: boolean;
	pruneEnabledGlobal: boolean;
	pruneDiffersFromDefault: boolean;
	onOpenThresholdSettings: () => void;
	onCompactError: (err: unknown) => void;
	// biome-ignore lint/suspicious/noExplicitAny: mutation object passthrough from useUpdatePruneEnabled.
	pruneEnabledMutation: any;
	// biome-ignore lint/suspicious/noExplicitAny: mutation object passthrough (settings update).
	updateSettingsMutation: any;
	/** narrator translation fn (namespace "narrator"). */
	t: (key: string, opts?: Record<string, unknown>) => string;
}

/**
 * The context-usage ring in the status bar plus its dropdown menu (thresholds,
 * prune toggle with reset/set-default, trigger-compact and clear-context
 * actions). Extracted verbatim from NarratorPanel; the ring's derived geometry
 * and colours are computed internally, everything stateful is injected so the
 * behaviour matches the previous inline node exactly.
 */
export function ContextUsageIndicator(props: ContextUsageIndicatorProps) {
	const {
		narratorId,
		contextPercent,
		contextStale,
		isWorkspacePreview,
		activePruneStart,
		activeCompactStart,
		modelThresholds,
		forceCompactPruneThreshold,
		prunedPercent,
		promptTokens,
		contextWindow,
		isEstimated,
		pruneEnabledEffective,
		pruneEnabledGlobal,
		pruneDiffersFromDefault,
		onOpenThresholdSettings,
		onCompactError,
		pruneEnabledMutation,
		updateSettingsMutation,
		t,
	} = props;

	const hasContextData = contextPercent != null;
	const contextIndicatorPercent = hasContextData ? Math.min(contextPercent, 100) : 0;
	const contextIndicatorRadius = 9;
	const contextIndicatorCirc = 2 * Math.PI * contextIndicatorRadius;
	const contextIndicatorOffset = contextIndicatorCirc * (1 - contextIndicatorPercent / 100);
	const contextStaleColor = "light-dark(var(--mantine-color-black), var(--mantine-color-dark-0))";
	const contextIndicatorColor = contextStale
		? contextStaleColor
		: contextIndicatorPercent >= 99
			? "var(--mantine-color-red-6)"
			: contextIndicatorPercent >= 95
				? "var(--mantine-color-yellow-6)"
				: "var(--mantine-color-blue-6)";
	const contextIndicatorLabel = contextStale
		? t("contextStaleHint")
		: hasContextData
			? `Context: ${contextPercent.toFixed(1)}%`
			: "Context";
	const contextRingNode = (
		<Box
			style={{
				position: "relative",
				width: 24,
				height: 24,
				flexShrink: 0,
				cursor: isWorkspacePreview ? "default" : "pointer",
			}}
			className="context-ring"
		>
			<svg width={24} height={24} viewBox="0 0 24 24" role="img" aria-label={contextIndicatorLabel}>
				<title>{contextIndicatorLabel}</title>
				<circle
					cx={12}
					cy={12}
					r={contextIndicatorRadius}
					fill="none"
					stroke="light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))"
					strokeWidth={2.5}
				/>
				{hasContextData && (
					<circle
						cx={12}
						cy={12}
						r={contextIndicatorRadius}
						fill="none"
						stroke={contextIndicatorColor}
						strokeWidth={2.5}
						strokeDasharray={contextIndicatorCirc}
						strokeDashoffset={contextIndicatorOffset}
						strokeLinecap="round"
						transform="rotate(-90 12 12)"
						style={{ transition: "stroke-dashoffset 0.3s ease" }}
					/>
				)}
				{contextStale && (
					<text
						x={12}
						y={12}
						textAnchor="middle"
						dominantBaseline="central"
						fontSize={12}
						fontWeight={700}
						fill={contextStaleColor}
					>
						?
					</text>
				)}
			</svg>
		</Box>
	);
	if (isWorkspacePreview) return contextRingNode;
	return (
		<Menu position="top-start">
			<Menu.Target>{contextRingNode}</Menu.Target>
			<Menu.Dropdown>
				{contextStale && (
					<Menu.Label c="orange" fz={10} style={{ maxWidth: 240, whiteSpace: "normal" }}>
						{t("contextStaleHint")}
					</Menu.Label>
				)}
				<Menu.Label c="dimmed" fz={10}>
					{t("activeThresholds", {
						prune: activePruneStart ?? modelThresholds?.pruneStart,
						compact: activeCompactStart ?? modelThresholds?.compactStart,
						force: forceCompactPruneThreshold,
					})}
				</Menu.Label>
				<Menu.Item
					leftSection={<IconSettings size={14} />}
					c="dimmed"
					fz="xs"
					onClick={onOpenThresholdSettings}
				>
					{t("thresholdSettings")}
				</Menu.Item>
				<Menu.Divider />
				{prunedPercent != null && (
					<Menu.Label>{t("prunedPercent", { percent: prunedPercent })}</Menu.Label>
				)}
				{hasContextData && (
					<Menu.Label>
						{t("contextUsagePercent", { percent: contextPercent.toFixed(1) })}
					</Menu.Label>
				)}
				{promptTokens != null && (
					<Menu.Label>
						{contextWindow != null
							? t("contextUsageTokensWithWindow", {
									tokens: formatLocaleNumber(promptTokens),
									window: formatLocaleNumber(contextWindow),
								})
							: t("contextUsageTokens", {
									tokens: formatLocaleNumber(promptTokens),
								})}
						{isEstimated && <span style={{ opacity: 0.6, marginLeft: 4 }}>({t("estimated")})</span>}
					</Menu.Label>
				)}
				<Menu.Divider />
				<Tooltip label={t("pruneEnabledTooltip")} multiline w={260} withArrow position="top">
					<Menu.Label>
						<Stack gap={4}>
							<Switch
								size="xs"
								label={t("pruneEnabled")}
								checked={pruneEnabledEffective}
								onChange={(e) => {
									pruneEnabledMutation.mutate({
										id: narratorId,
										pruneEnabled: e.currentTarget.checked,
									});
								}}
							/>
							{pruneEnabledEffective && (
								<Text size="xs" c="orange">
									{t("pruneEnabledWarning")}
								</Text>
							)}
							{pruneDiffersFromDefault && (
								<Group justify="space-between" wrap="nowrap" style={{ width: "100%" }}>
									<Anchor
										component="button"
										type="button"
										size="xs"
										c="dimmed"
										style={{ textDecoration: "underline" }}
										onClick={(event) => {
											event.stopPropagation();
											pruneEnabledMutation.mutate({
												id: narratorId,
												pruneEnabled: pruneEnabledGlobal,
											});
										}}
									>
										{t("pruneEnabledResetDefault")}
									</Anchor>
									<Anchor
										component="button"
										type="button"
										size="xs"
										c="dimmed"
										style={{ textDecoration: "underline" }}
										onClick={(event) => {
											event.stopPropagation();
											updateSettingsMutation.mutate({
												agent: { defaultPruneEnabled: pruneEnabledEffective },
											});
										}}
									>
										{t("pruneEnabledSetDefault")}
									</Anchor>
								</Group>
							)}
						</Stack>
					</Menu.Label>
				</Tooltip>
				<Menu.Divider />
				<Menu.Item
					leftSection={<IconArrowsMinimize size={14} />}
					onClick={() => {
						// Compacting state will arrive via substatus_change WS event
						api.triggerCompact(narratorId).catch((err) => {
							onCompactError(err);
						});
					}}
				>
					{t("triggerCompact")}
				</Menu.Item>
				<Menu.Item
					leftSection={<IconEraser size={14} />}
					onClick={() => {
						api.clearContext(narratorId).catch(() => {});
					}}
				>
					{t("clearContext")}
				</Menu.Item>
			</Menu.Dropdown>
		</Menu>
	);
}
