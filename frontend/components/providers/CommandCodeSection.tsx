/**
 * Command Code 设置区块：凭据、额度、启用开关与模型配置。
 *
 * 骨架对齐其它 provider 卡片（CustomApiProviderSection）：描述行 → 标题/徽章/开关 → 表单 →
 * 分隔线 → 模型区，表单控件统一 `size="xs"`；额度展示对齐 CodexUsageDisplay（标题 / 已用 /
 * 进度 / 重置倒计时）。
 *
 * 凭据来自 Studio 生成的 API key（填进设置即可，无需安装 CLI）；若本机已有 CLI 登录的
 * `~/.commandcode/auth.json`，后端会作为回退自动使用。额度来自 /alpha/billing/credits
 * （月度余额与滚动窗口）与 /alpha/usage/summary（计费周期内的累计用量）。
 *
 * API key 与启用开关都是受控草稿，由页面底部的全局保存条统一提交 —— 停用必须落到
 * `settings.commandCode.disabled`，后端据此把该 provider 从可用候选里剔除。
 */

import { formatCompactNumber } from "@frontend/lib/compact-number";
import { formatCountdown, relativeTime } from "@frontend/lib/relative-time";
import {
	Alert,
	Anchor,
	Badge,
	Button,
	Divider,
	Group,
	Loader,
	Progress,
	Select,
	Stack,
	Switch,
	Text,
	TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { ToolResultImagesMode } from "@shared/tool-result-images";
import { IconRefresh } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { ProxyOverrideField } from "../common/ProxyOverrideField";
import { ClientFingerprintFields } from "./ClientFingerprintFields";
import { type CustomModelEntry, InlineCustomModels } from "./InlineCustomModels";
import { ModelList, type ModelListItem } from "./ModelList";
import { COMMAND_CODE_PROTOCOL_OPTIONS } from "./ModelProtocolSelect";
import type { CommandCodeState } from "./providers-reducer";
import type { CustomApiProtocol } from "./types";

const STUDIO_API_KEYS_URL = "https://commandcode.ai/studio/";

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
	/** settings.commandCode 的草稿镜像。 */
	value: CommandCodeState;
	onChange: (config: CommandCodeState) => void;
	/** 启用开关：平台 provider 的开关统一走草稿入口（见 PLATFORM_PROVIDER_PREFIXES）。 */
	onToggleDisabled: () => void;
	/** 已带 `commandcode:` 前缀的模型选项。 */
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
	value,
	onChange,
	onToggleDisabled,
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
	const { data, isLoading, dataUpdatedAt } = useQuery({
		queryKey: ["commandcode", "usage"],
		queryFn: () => api.commandCodeUsage(),
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
		<Stack>
			<Text size="sm" c="dimmed">
				{t("commandcode.sectionDesc")}
			</Text>

			<Stack gap="xs" style={value.disabled ? { opacity: 0.6 } : undefined}>
				<Group justify="space-between">
					<Group gap="xs">
						<Text fw={500} size="sm">
							Command Code
						</Text>
						{value.disabled && (
							<Badge size="xs" variant="light" color="gray">
								{t("providerDisabled")}
							</Badge>
						)}
						{!value.disabled && models.length > 0 && (
							<Badge size="xs" variant="light">
								{t("customApiModelsCount", { count: models.length })}
							</Badge>
						)}
					</Group>
					<Group gap="xs">
						{isLoading ? (
							<Loader size="xs" />
						) : (
							<Badge size="xs" variant="light" color={data?.loggedIn ? "green" : "gray"}>
								{data?.loggedIn ? t("commandcode.configured") : t("commandcode.notConfigured")}
							</Badge>
						)}
						<Switch
							size="xs"
							checked={!value.disabled}
							aria-label={t("commandcode.enabled")}
							onChange={onToggleDisabled}
						/>
					</Group>
				</Group>

				<TextInput
					size="xs"
					label={t("commandcode.apiKeyLabel")}
					description={t("commandcode.apiKeyDesc")}
					placeholder="user_..."
					type="password"
					value={value.apiKey}
					onChange={(event) => onChange({ ...value, apiKey: event.currentTarget.value })}
				/>
				<Anchor
					size="xs"
					href={STUDIO_API_KEYS_URL}
					target="_blank"
					rel="noreferrer"
					w="fit-content"
				>
					{t("commandcode.getKey")}
				</Anchor>

				<ProxyOverrideField
					value={value.proxy}
					onChange={(next) => onChange({ ...value, proxy: next })}
				/>

				<ClientFingerprintFields
					value={{
						userAgentMode: value.userAgentMode,
						customUserAgent: value.customUserAgent,
						extraHeaders: value.extraHeaders,
					}}
					onChange={(next) => onChange({ ...value, ...next })}
				/>

				<Select
					label={t("commandcode.toolResultImages")}
					description={t("commandcode.toolResultImagesDesc")}
					size="xs"
					data={[
						{ value: "off", label: t("commandcode.toolResultImagesOff") },
						{ value: "inline", label: t("commandcode.toolResultImagesInline") },
						{ value: "separate", label: t("commandcode.toolResultImagesSeparate") },
					]}
					value={value.toolResultImages ?? "off"}
					allowDeselect={false}
					onChange={(next) =>
						onChange({ ...value, toolResultImages: (next ?? "off") as ToolResultImagesMode })
					}
				/>

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
								<Group gap="lg">
									<Text size="xs" c="dimmed">
										{t("commandcode.requests")}: {summary.totalCount}
									</Text>
									<Text size="xs" c="dimmed">
										{t("commandcode.tokens")}: {formatCompactNumber(summary.totalTokens).compact}
									</Text>
									<Text size="xs" c="dimmed">
										{t("commandcode.successRate")}: {summary.successRate}%
									</Text>
								</Group>
							)}
							<Text size="xs" c="dimmed">
								{relativeTime(new Date(dataUpdatedAt).toISOString())}
							</Text>
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
							disabled={value.disabled || !onRefreshModels}
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
							prefix="CommandCode"
							customModels={customModels}
							onCustomModelsChange={onCustomModelsChange}
							hiddenModels={hiddenModels ?? new Set()}
							onToggleHidden={onToggleHidden ?? (() => {})}
							onTestModel={onTestModel}
						/>
					)}
				</Stack>
			</Stack>
		</Stack>
	);
}
