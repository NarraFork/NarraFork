/**
 * Command Code 平台的管理区块：连接状态、额度与模型配置。
 *
 * 凭据（apiKey / baseUrl / 代理 / 指纹）属于**实例**，统一在实例配置页里编辑；这里只放平台
 * 本身的状态与模型，实例页把它挂在实例配置下方。
 *
 * 额度来自 /alpha/billing/credits 与 /alpha/usage/summary，走的是内置连接（CLI 登录或
 * 默认前缀实例的 key），因此只对默认前缀展示。
 */

import { formatCompactNumber } from "@frontend/lib/compact-number";
import { formatCountdown } from "@frontend/lib/relative-time";
import { Alert, Badge, Button, Divider, Group, Loader, Progress, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconRefresh } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { type CustomModelEntry, InlineCustomModels } from "./InlineCustomModels";
import { ModelList, type ModelListItem } from "./ModelList";
import { COMMAND_CODE_PROTOCOL_OPTIONS } from "./ModelProtocolSelect";
import type { CustomApiProtocol } from "./types";

const COMMAND_CODE_REASONS = {
	not_configured: "commandcode.reasonNotConfigured",
	missing_api_key: "commandcode.reasonMissingApiKey",
	read_failed: "commandcode.reasonReadFailed",
	unauthorized: "commandcode.reasonUnauthorized",
} as const;

function commandCodeReasonText(
	t: (key: string) => string,
	reason: string | undefined,
): string | null {
	if (!reason) return null;
	const key = COMMAND_CODE_REASONS[reason as keyof typeof COMMAND_CODE_REASONS];
	return key ? t(key) : null;
}

export interface CommandCodeSectionProps {
	/** 模型值前缀（实例前缀，如 `CommandCode` 或 `CommandCode-2`）。 */
	prefix: string;
	/** 已带该前缀的模型选项。 */
	models?: ModelListItem[];
	hiddenModels?: Set<string>;
	onToggleHidden?: (modelVal: string) => void;
	onBatchToggleHidden?: (modelValues: string[], hidden: boolean) => void;
	customModels?: CustomModelEntry[];
	onCustomModelsChange?: (models: CustomModelEntry[]) => void;
	/** 逐模型协议覆盖的草稿（由设置页统一提交）。 */
	modelProtocols: Record<string, CustomApiProtocol>;
	onModelProtocolChange: (modelVal: string, protocol: CustomApiProtocol | null) => void;
	onTestModel?: (model: string) => void;
	/** 丢弃服务端模型缓存并重拉；由页面负责在草稿未保存时先落盘。 */
	onRefreshModels?: () => Promise<void>;
}

/** 剩余额度越少越红，与 CodexUsageDisplay 的进度着色一致。 */
function progressColor(usedPercent: number): string {
	const remaining = 100 - usedPercent;
	if (remaining < 10) return "red";
	if (remaining < 30) return "yellow";
	return "green";
}

/** 单个用量维度：标题 / 已用 / 进度 / 重置倒计时。 */
function UsageMeter({
	label,
	used,
	cap,
	resetAt,
}: {
	label: string;
	used: number;
	cap: number;
	resetAt?: number;
}) {
	const { t } = useTranslation("settings");
	if (!(cap > 0)) return null;
	const usedPercent = Math.min(100, Math.max(0, (used / cap) * 100));
	return (
		<Stack gap={2} maw="100%">
			<Text size="xs" fw={500}>
				{label}
			</Text>
			<Text size="xs">
				{t("commandcode.windowUsed", {
					used: used.toFixed(2),
					total: cap.toFixed(2),
					percent: usedPercent.toFixed(0),
				})}
			</Text>
			<Progress
				value={usedPercent}
				size="xs"
				color={progressColor(usedPercent)}
				style={{ width: "100%" }}
			/>
			{resetAt !== undefined && (
				<Text size="xs" c="dimmed">
					{t("commandcode.resetAt", {
						time: formatCountdown(resetAt) ?? t("commandcode.resetUnknown"),
					})}
				</Text>
			)}
		</Stack>
	);
}

export function CommandCodeSection({
	prefix,
	models: modelItems,
	hiddenModels,
	onToggleHidden,
	onBatchToggleHidden,
	customModels,
	onCustomModelsChange,
	modelProtocols,
	onModelProtocolChange,
	onTestModel,
	onRefreshModels,
}: CommandCodeSectionProps) {
	const { t } = useTranslation("settings");
	const { data, isLoading } = useQuery({
		queryKey: ["commandcode", "usage", prefix],
		queryFn: () => api.commandCodeUsage(prefix),
		refetchInterval: 60_000,
	});
	const [refreshing, setRefreshing] = useState(false);
	const handleRefreshModels = useCallback(async () => {
		if (!onRefreshModels || refreshing) return;
		setRefreshing(true);
		try {
			await onRefreshModels();
		} catch (error) {
			notifications.show({
				color: "red",
				title: t("customApiRefreshModelsError"),
				message: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setRefreshing(false);
		}
	}, [onRefreshModels, refreshing, t]);

	const models = modelItems ?? [];
	const credits = data?.credits;
	const summary = data?.summary;
	// 月度展示"已用 / 总共"：总配额 = 本周期已用 + 当前余额。
	const monthlyUsed = summary?.totalMonthlyCredits;
	const monthlyTotal =
		credits && monthlyUsed !== undefined ? credits.monthlyCredits + monthlyUsed : undefined;

	return (
		<Stack gap="xs">
			<Group justify="space-between">
				<Group gap="xs">
					<Text fw={500} size="sm">
						Command Code
					</Text>
					{models.length > 0 && (
						<Badge size="xs" variant="light">
							{t("customApiModelsCount", { count: models.length })}
						</Badge>
					)}
				</Group>
				{isLoading ? (
					<Loader size="xs" />
				) : (
					<Badge size="xs" variant="light" color={data?.loggedIn ? "green" : "gray"}>
						{data?.loggedIn ? t("commandcode.configured") : t("commandcode.notConfigured")}
					</Badge>
				)}
			</Group>

			{!isLoading && !data?.loggedIn && commandCodeReasonText(t, data?.reason) && (
				<Alert color="yellow" variant="light">
					{commandCodeReasonText(t, data?.reason)}
				</Alert>
			)}
			{data?.error === "usage_unavailable" && (
				<Alert color="red" variant="light">
					{t("commandcode.usageFailed")}
				</Alert>
			)}

			<Divider />
			<Stack gap="xs">
				<Text size="sm" fw={500}>
					{t("commandcode.usageTitle")}
				</Text>
				<Text size="xs" c="dimmed">
					{t("commandcode.usageDesc")}
				</Text>

				{credits ? (
					<Stack gap="sm" maw="100%">
						{monthlyUsed !== undefined && monthlyTotal !== undefined && (
							<UsageMeter
								label={t("commandcode.monthlyCredits")}
								used={monthlyUsed}
								cap={monthlyTotal}
							/>
						)}
						{data?.windowLimits?.fiveHour && (
							<UsageMeter
								label={t("commandcode.fiveHour")}
								used={data.windowLimits.fiveHour.used}
								cap={data.windowLimits.fiveHour.cap}
								resetAt={data.windowLimits.fiveHour.resetAt}
							/>
						)}
						{data?.windowLimits?.weekly && (
							<UsageMeter
								label={t("commandcode.weekly")}
								used={data.windowLimits.weekly.used}
								cap={data.windowLimits.weekly.cap}
								resetAt={data.windowLimits.weekly.resetAt}
							/>
						)}
						{summary && (
							<Text size="xs" c="dimmed">
								{t("commandcode.requests")}: {summary.totalCount} ·{" "}
								{formatCompactNumber(summary.totalTokens).compact} · {summary.successRate}%
							</Text>
						)}
					</Stack>
				) : (
					!isLoading && (
						<Text size="xs" c="dimmed">
							{t("commandcode.usageUnavailable")}
						</Text>
					)
				)}
			</Stack>

			<Divider />
			<Stack gap="xs">
				<Text size="sm" fw={500}>
					{t("commandcode.modelsTitle")}
				</Text>
				<Text size="xs" c="dimmed">
					{t("commandcode.modelsDesc")}
				</Text>
				<Group gap="xs">
					<Button
						size="xs"
						variant="light"
						leftSection={<IconRefresh size={14} />}
						loading={refreshing}
						disabled={!onRefreshModels}
						onClick={handleRefreshModels}
					>
						{refreshing ? t("customApiRefreshModelsLoading") : t("customApiRefreshModels")}
					</Button>
				</Group>
				{models.length > 0 && (
					<ModelList
						models={models}
						hiddenModels={hiddenModels ?? new Set()}
						onToggleHidden={onToggleHidden ?? (() => {})}
						onBatchToggleHidden={onBatchToggleHidden}
						modelProtocols={modelProtocols}
						onModelProtocolChange={onModelProtocolChange}
						protocols={COMMAND_CODE_PROTOCOL_OPTIONS}
						onTestModel={onTestModel}
					/>
				)}
				{customModels && onCustomModelsChange && (
					<InlineCustomModels
						prefix={prefix}
						customModels={customModels}
						onCustomModelsChange={onCustomModelsChange}
						hiddenModels={hiddenModels ?? new Set()}
						onToggleHidden={onToggleHidden ?? (() => {})}
						onTestModel={onTestModel}
					/>
				)}
			</Stack>
		</Stack>
	);
}
