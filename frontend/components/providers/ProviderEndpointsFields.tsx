import {
	ActionIcon,
	Badge,
	Button,
	Checkbox,
	Collapse,
	Group,
	NumberInput,
	Paper,
	SegmentedControl,
	Stack,
	Table,
	Text,
	TextInput,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	ENDPOINT_POLICY_LIMITS,
	type EndpointFailoverConditions,
	type EndpointSelectionStrategy,
	isHttpEndpointUrl,
	type ProviderEndpointPolicy,
	type ProviderEndpointsStatus,
	resolveEndpointPolicy,
} from "@shared/provider-endpoints";
import {
	IconActivity,
	IconChevronDown,
	IconChevronRight,
	IconPlus,
	IconTrash,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

interface ProviderEndpointsFieldsProps {
	/** Saved provider whose live status to show; omit while the provider does not exist yet. */
	providerId?: string;
	baseUrls: string[] | undefined;
	endpointPolicy: ProviderEndpointPolicy | undefined;
	disabled?: boolean;
	onBaseUrlsChange: (next: string[]) => void;
	onPolicyChange: (next: ProviderEndpointPolicy) => void;
	isDirty?: boolean;
	onSaveBeforeProbe?: () => Promise<boolean>;
}

const STRATEGIES: EndpointSelectionStrategy[] = ["sticky", "lowest-latency", "ordered"];

const STRATEGY_KEYS: Record<EndpointSelectionStrategy, { label: string; desc: string }> = {
	sticky: { label: "endpointStrategySticky", desc: "endpointStrategyStickyDesc" },
	"lowest-latency": {
		label: "endpointStrategyLowestLatency",
		desc: "endpointStrategyLowestLatencyDesc",
	},
	ordered: { label: "endpointStrategyOrdered", desc: "endpointStrategyOrderedDesc" },
};

const FAILOVER_KEYS: Array<{ key: keyof EndpointFailoverConditions; label: string }> = [
	{ key: "network", label: "endpointFailoverNetwork" },
	{ key: "timeout", label: "endpointFailoverTimeout" },
	{ key: "serverError", label: "endpointFailoverServerError" },
	{ key: "rateLimit", label: "endpointFailoverRateLimit" },
	{ key: "clientError", label: "endpointFailoverClientError" },
];

function formatMs(value: number | null): string {
	return value === null ? "—" : `${value} ms`;
}

export function ProviderEndpointsFields({
	providerId,
	baseUrls,
	endpointPolicy,
	disabled,
	onBaseUrlsChange,
	onPolicyChange,
	isDirty,
	onSaveBeforeProbe,
}: ProviderEndpointsFieldsProps) {
	const { t } = useTranslation("settings");
	// Collapsed by default: most providers keep the defaults, and the summary line says what they are.
	const [policyOpen, setPolicyOpen] = useState(false);
	const mirrors = baseUrls ?? [];
	const hasMirrors = mirrors.some((url) => url.trim().length > 0);
	const policy = resolveEndpointPolicy(endpointPolicy);
	const customized = !!endpointPolicy && Object.keys(endpointPolicy).length > 0;

	const strategyData = useMemo(
		() => STRATEGIES.map((value) => ({ value, label: t(STRATEGY_KEYS[value].label) })),
		[t],
	);

	const policySummary = useMemo(() => {
		const conditions = FAILOVER_KEYS.filter(({ key }) => policy.failoverOn[key]).map(({ label }) =>
			t(label),
		);
		const failover =
			conditions.length > 0
				? t("endpointSummaryFailover", { conditions: conditions.join(", ") })
				: t("endpointSummaryNoFailover");
		return `${t(STRATEGY_KEYS[policy.strategy].label)} · ${failover}`;
	}, [policy, t]);

	const updatePolicy = useCallback(
		(patch: Partial<ProviderEndpointPolicy>) => onPolicyChange({ ...endpointPolicy, ...patch }),
		[endpointPolicy, onPolicyChange],
	);

	const updateMirror = (index: number, value: string) =>
		onBaseUrlsChange(mirrors.map((url, i) => (i === index ? value : url)));
	const removeMirror = (index: number) => onBaseUrlsChange(mirrors.filter((_, i) => i !== index));
	const addMirror = () => onBaseUrlsChange([...mirrors, ""]);

	return (
		<Stack gap={6}>
			<Group justify="space-between" align="flex-end">
				<Stack gap={0}>
					<Text size="sm" fw={500}>
						{t("endpointMirrors")}
					</Text>
					<Text size="xs" c="dimmed">
						{t("endpointMirrorsDesc")}
					</Text>
				</Stack>
				<Button
					size="xs"
					variant="subtle"
					leftSection={<IconPlus size={14} />}
					disabled={mirrors.length >= ENDPOINT_POLICY_LIMITS.maxBaseUrls}
					onClick={addMirror}
				>
					{t("endpointAddMirror")}
				</Button>
			</Group>

			{mirrors.map((url, index) => (
				<Group
					// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and may be blank or duplicated while typing
					key={index}
					gap="xs"
					wrap="nowrap"
					align="flex-start"
				>
					<TextInput
						size="xs"
						style={{ flex: 1 }}
						placeholder={t("endpointMirrorPlaceholder")}
						value={url}
						error={url.trim() && !isHttpEndpointUrl(url) ? t("endpointMirrorInvalid") : undefined}
						onChange={(e) => updateMirror(index, e.currentTarget.value)}
						type="url"
						autoCapitalize="none"
						spellCheck={false}
					/>
					<ActionIcon
						color="red"
						variant="subtle"
						size="sm"
						mt={4}
						aria-label={t("endpointRemoveMirror")}
						onClick={() => removeMirror(index)}
					>
						<IconTrash size={14} />
					</ActionIcon>
				</Group>
			))}

			{hasMirrors && (
				<Paper withBorder p="xs" radius="sm">
					<Stack gap="xs">
						<UnstyledButton
							onClick={() => setPolicyOpen((open) => !open)}
							aria-expanded={policyOpen}
						>
							<Group gap={6} wrap="nowrap">
								{policyOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
								<Text size="xs" fw={600} style={{ flexShrink: 0 }}>
									{t("endpointPolicyTitle")}
								</Text>
								{customized && (
									<Badge size="xs" variant="light">
										{t("endpointPolicyCustomized")}
									</Badge>
								)}
								{!policyOpen && (
									<Text size="xs" c="dimmed" truncate>
										{policySummary}
									</Text>
								)}
							</Group>
						</UnstyledButton>

						<Collapse expanded={policyOpen}>
							<Stack gap="xs" pt={4}>
								<Stack gap={4}>
									<Text size="xs" fw={600}>
										{t("endpointStrategy")}
									</Text>
									<SegmentedControl
										size="xs"
										value={policy.strategy}
										onChange={(value) =>
											updatePolicy({ strategy: value as EndpointSelectionStrategy })
										}
										data={strategyData}
									/>
									<Text size="xs" c="dimmed">
										{t(STRATEGY_KEYS[policy.strategy].desc)}
									</Text>
								</Stack>

								{policy.strategy === "sticky" && (
									<NumberInput
										size="xs"
										label={t("endpointStickySwitchRatio")}
										description={t("endpointStickySwitchRatioDesc")}
										value={Math.round(policy.stickySwitchRatio * 100)}
										min={0}
										max={Math.round(ENDPOINT_POLICY_LIMITS.stickySwitchRatio.max * 100)}
										suffix="%"
										onChange={(v) => updatePolicy({ stickySwitchRatio: Number(v) / 100 })}
									/>
								)}

								<Stack gap={4}>
									<Text size="xs" fw={600}>
										{t("endpointFailoverOn")}
									</Text>
									<Group gap="md">
										{FAILOVER_KEYS.map(({ key, label }) => (
											<Checkbox
												key={key}
												size="xs"
												label={t(label)}
												checked={policy.failoverOn[key]}
												onChange={(e) =>
													updatePolicy({
														failoverOn: { ...policy.failoverOn, [key]: e.currentTarget.checked },
													})
												}
											/>
										))}
									</Group>
								</Stack>

								<Group grow gap="xs" align="flex-start">
									<NumberInput
										size="xs"
										label={t("endpointHeaderTimeout")}
										description={t("endpointHeaderTimeoutDesc")}
										value={policy.headerTimeoutMs / 1000}
										disabled={!policy.failoverOn.timeout}
										min={0}
										max={ENDPOINT_POLICY_LIMITS.headerTimeoutMs.max / 1000}
										suffix=" s"
										onChange={(v) =>
											updatePolicy({ headerTimeoutMs: Math.round(Number(v) * 1000) })
										}
									/>
									<NumberInput
										size="xs"
										label={t("endpointCooldown")}
										description={t("endpointCooldownDesc")}
										value={policy.cooldownSec}
										min={0}
										max={ENDPOINT_POLICY_LIMITS.cooldownSec.max}
										suffix=" s"
										onChange={(v) => updatePolicy({ cooldownSec: Math.round(Number(v)) })}
									/>
									<NumberInput
										size="xs"
										label={t("endpointProbeInterval")}
										description={t("endpointProbeIntervalDesc")}
										value={policy.probeIntervalSec}
										min={0}
										max={ENDPOINT_POLICY_LIMITS.probeIntervalSec.max}
										suffix=" s"
										onChange={(v) => updatePolicy({ probeIntervalSec: Math.round(Number(v)) })}
									/>
								</Group>

								{customized && (
									<Group justify="flex-end">
										<Button size="compact-xs" variant="subtle" onClick={() => onPolicyChange({})}>
											{t("endpointResetPolicy")}
										</Button>
									</Group>
								)}
							</Stack>
						</Collapse>

						{providerId && (
							<EndpointStatusSection
								providerId={providerId}
								disabled={disabled}
								isDirty={isDirty}
								onSaveBeforeProbe={onSaveBeforeProbe}
							/>
						)}
					</Stack>
				</Paper>
			)}
		</Stack>
	);
}

/**
 * Live status and on-demand probing for a saved provider. Kept separate so the
 * add-provider form, which has no saved provider yet, renders without React Query.
 */
function EndpointStatusSection({
	providerId,
	disabled,
	isDirty,
	onSaveBeforeProbe,
}: {
	providerId: string;
	disabled?: boolean;
	isDirty?: boolean;
	onSaveBeforeProbe?: () => Promise<boolean>;
}) {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const [probing, setProbing] = useState(false);
	const statusKey = useMemo(() => ["provider-endpoints", providerId], [providerId]);
	const { data: status } = useQuery({
		queryKey: statusKey,
		queryFn: () => api.getProviderEndpoints(providerId),
		// Status reflects the saved config; skip while the form has unsaved edits.
		enabled: !isDirty,
		refetchInterval: 30_000,
	});

	const handleProbe = useCallback(async () => {
		if (isDirty) {
			const saved = await onSaveBeforeProbe?.();
			if (!saved) return;
		}
		setProbing(true);
		try {
			const result = await api.probeProviderEndpoints(providerId);
			qc.setQueryData<ProviderEndpointsStatus>(statusKey, result);
		} catch (err) {
			notifications.show({
				color: "red",
				title: t("endpointProbeError"),
				message: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setProbing(false);
		}
	}, [isDirty, onSaveBeforeProbe, providerId, qc, statusKey, t]);

	return (
		<>
			<Group justify="space-between">
				<Text size="xs" fw={600}>
					{t("endpointStatus")}
				</Text>
				<Button
					size="xs"
					variant="light"
					leftSection={<IconActivity size={14} />}
					loading={probing}
					disabled={disabled}
					onClick={handleProbe}
				>
					{t("endpointProbeNow")}
				</Button>
			</Group>
			{isDirty ? (
				<Text size="xs" c="dimmed">
					{t("endpointStatusUnsaved")}
				</Text>
			) : (
				status && <EndpointStatusTable status={status} />
			)}
		</>
	);
}

function EndpointStatusTable({ status }: { status: ProviderEndpointsStatus }) {
	const { t } = useTranslation("settings");
	return (
		<Table.ScrollContainer minWidth={520}>
			<Table fz="xs" verticalSpacing={4}>
				<Table.Thead>
					<Table.Tr>
						<Table.Th>{t("endpointColUrl")}</Table.Th>
						<Table.Th>{t("endpointColProbe")}</Table.Th>
						<Table.Th>{t("endpointColRequest")}</Table.Th>
						<Table.Th>{t("endpointColState")}</Table.Th>
					</Table.Tr>
				</Table.Thead>
				<Table.Tbody>
					{status.endpoints.map((endpoint) => (
						<Table.Tr key={endpoint.url}>
							<Table.Td style={{ wordBreak: "break-all" }}>
								<Group gap={4} wrap="nowrap">
									<Text size="xs">{endpoint.url}</Text>
									{endpoint.preferred && (
										<Badge size="xs" variant="light" color="indigo">
											{t("endpointPreferred")}
										</Badge>
									)}
								</Group>
							</Table.Td>
							<Table.Td>{formatMs(endpoint.probeLatencyMs)}</Table.Td>
							<Table.Td>{formatMs(endpoint.requestLatencyMs)}</Table.Td>
							<Table.Td>
								<Tooltip
									label={endpoint.lastError ?? ""}
									disabled={!endpoint.lastError}
									multiline
									maw={360}
								>
									<Badge
										size="xs"
										variant="light"
										color={endpoint.healthy ? (endpoint.lastError ? "yellow" : "green") : "red"}
									>
										{endpoint.healthy
											? t("endpointHealthy")
											: t("endpointCoolingDown", {
													seconds: Math.max(
														1,
														Math.ceil(((endpoint.cooldownUntil ?? 0) - Date.now()) / 1000),
													),
												})}
									</Badge>
								</Tooltip>
							</Table.Td>
						</Table.Tr>
					))}
				</Table.Tbody>
			</Table>
		</Table.ScrollContainer>
	);
}
