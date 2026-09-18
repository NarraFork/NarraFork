import { Alert, Badge, Button, Checkbox, Divider, Group, Paper, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconEyeSearch, IconShieldCheck } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	api,
	type WorkspaceBarrier,
	type WorkspaceBarrierObservationResult,
	type WorkspaceBarrierVerdict,
} from "../../lib/api";
import { formatLocaleDateTime } from "../../lib/intl-format";
import { useConfirmDialog } from "../common/confirm-dialog-context";

/**
 * Durable workspace write barriers awaiting human-driven external recovery.
 * The write coordinator fails closed around these scopes (an uncertain write or
 * a crashed lease), so they must be re-observed and explicitly acknowledged
 * here before any overlapping write is admitted again.
 */
export function WorkspaceBarriersCard() {
	const { t } = useTranslation("settings");
	const queryClient = useQueryClient();
	const { data, isLoading } = useQuery({
		queryKey: ["workspace-barriers"],
		queryFn: api.getWorkspaceBarriers,
		refetchInterval: 30_000,
	});
	const invalidate = () => queryClient.invalidateQueries({ queryKey: ["workspace-barriers"] });
	const items = data?.items ?? [];
	return (
		<Paper p="sm" radius="sm" withBorder>
			<Stack gap="sm">
				<Group gap="xs">
					<IconShieldCheck size={18} />
					<Text fw={600} size="sm">
						{t("workspaceBarriersTitle")}
					</Text>
					{items.length > 0 && (
						<Badge color="red" variant="light">
							{t("workspaceBarriersPending", { count: items.length })}
						</Badge>
					)}
				</Group>
				<Text size="xs" c="dimmed">
					{t("workspaceBarriersDescription")}
				</Text>
				{isLoading ? (
					<Text size="sm" c="dimmed">
						{t("workspaceBarriersLoading")}
					</Text>
				) : items.length === 0 ? (
					<Text size="sm" c="dimmed">
						{t("workspaceBarriersEmpty")}
					</Text>
				) : (
					<Stack gap="sm">
						{items.map((barrier) => (
							<BarrierRow key={barrier.scope.id} barrier={barrier} onRecovered={invalidate} />
						))}
					</Stack>
				)}
			</Stack>
		</Paper>
	);
}

const VERDICT_COLORS: Record<WorkspaceBarrierVerdict, string> = {
	applied: "green",
	not_applied: "blue",
	not_dispatched: "gray",
	foreign: "red",
	unobservable: "orange",
};

function BarrierRow({
	barrier,
	onRecovered,
}: {
	barrier: WorkspaceBarrier;
	onRecovered: () => void;
}) {
	const { t } = useTranslation("settings");
	const confirm = useConfirmDialog();
	const [observation, setObservation] = useState<WorkspaceBarrierObservationResult | null>(null);
	const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
	const [inspected, setInspected] = useState(false);

	const observeMutation = useMutation({
		mutationFn: () => api.observeWorkspaceBarrier(barrier.scope.id),
		onSuccess: (result) => {
			setObservation(result);
			setChecked(new Set());
			setInspected(false);
		},
		onError: (error) => {
			notifications.show({
				color: "red",
				message: error instanceof Error ? error.message : String(error),
			});
		},
	});

	const recoverMutation = useMutation({
		mutationFn: () =>
			api.recoverWorkspaceBarrier(barrier.scope.id, {
				acknowledgements: (observation?.observations ?? [])
					.filter((entry) => checked.has(entry.effectId))
					.map((entry) => ({ effectId: entry.effectId, verdict: entry.verdict })),
				acknowledgeInspected: inspected,
			}),
		onSuccess: (result) => {
			notifications.show({
				color: "green",
				message:
					result.recovered === "root_verified"
						? t("workspaceBarriersRootVerified")
						: t("workspaceBarriersRecovered", { count: result.settledEffectCount }),
			});
			setObservation(null);
			onRecovered();
		},
		onError: (error) => {
			notifications.show({
				color: "red",
				message: error instanceof Error ? error.message : String(error),
			});
		},
	});

	const observations = observation?.observations ?? [];
	const allChecked =
		observations.length > 0 && observations.every((entry) => checked.has(entry.effectId));
	const hasForeign = observations.some((entry) => entry.verdict === "foreign");
	const noEffects = barrier.effects.length === 0;
	const isRootVerification = barrier.kind === "unverified_root";
	const recoverReady = isRootVerification
		? true
		: noEffects
			? inspected
			: observation !== null && allChecked;

	const handleRecover = async () => {
		const ok = await confirm({
			title: t("workspaceBarriersRecoverConfirmTitle"),
			message: isRootVerification
				? t("workspaceBarriersRecoverConfirmRoot", { root: barrier.scope.canonicalRoot })
				: t("workspaceBarriersRecoverConfirm", { root: barrier.scope.canonicalRoot }),
			confirmLabel: t("workspaceBarriersRecoverAction"),
			confirmColor: "red",
		});
		if (ok) recoverMutation.mutate();
	};

	return (
		<Paper p="xs" withBorder>
			<Stack gap="xs">
				<Group justify="space-between" align="flex-start" wrap="nowrap">
					<div style={{ flex: 1, minWidth: 0 }}>
						<Text size="sm" fw={500} style={{ wordBreak: "break-all" }}>
							{barrier.scope.canonicalRoot}
						</Text>
						<Group gap="xs" wrap="wrap" mt={4}>
							<Badge variant="light" color={barrier.kind === "quarantined" ? "red" : "yellow"}>
								{t(`workspaceBarriersKind_${barrier.kind}`)}
							</Badge>
							{!barrier.local && (
								<Badge variant="light" color="gray">
									{t("workspaceBarriersRemote")}
								</Badge>
							)}
							<Text size="xs" c="dimmed">
								{formatLocaleDateTime(barrier.scope.updatedAt)}
							</Text>
							{barrier.effects.length > 0 && (
								<Text size="xs" c="dimmed">
									{t("workspaceBarriersEffectCount", { count: barrier.effects.length })}
								</Text>
							)}
						</Group>
						{barrier.operations.map((operation) => (
							<Text key={operation.operationId} size="xs" c="dimmed" mt={2}>
								{t("workspaceBarriersOperation", {
									kind: operation.sourceKind,
									time: formatLocaleDateTime(operation.startedAt),
								})}
							</Text>
						))}
					</div>
					<Group gap="xs" wrap="nowrap">
						{!isRootVerification && !noEffects && (
							<Button
								size="xs"
								variant="light"
								leftSection={<IconEyeSearch size={14} />}
								onClick={() => observeMutation.mutate()}
								loading={observeMutation.isPending}
								disabled={!barrier.local || recoverMutation.isPending}
								title={!barrier.local ? t("workspaceBarriersRemoteUnsupported") : undefined}
							>
								{t("workspaceBarriersObserve")}
							</Button>
						)}
						<Button
							size="xs"
							color="red"
							variant="light"
							onClick={handleRecover}
							loading={recoverMutation.isPending}
							disabled={!barrier.local || !recoverReady || observeMutation.isPending}
							title={
								!barrier.local
									? t("workspaceBarriersRemoteUnsupported")
									: !recoverReady
										? t("workspaceBarriersRecoverDisabled")
										: undefined
							}
						>
							{t("workspaceBarriersRecoverAction")}
						</Button>
					</Group>
				</Group>

				{hasForeign && (
					<Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} py="xs">
						<Text size="xs">{t("workspaceBarriersForeignWarning")}</Text>
					</Alert>
				)}

				{observations.length > 0 && (
					<>
						<Divider />
						<Stack gap={4}>
							{observations.map((entry) => (
								<Group key={entry.effectId} wrap="nowrap" align="flex-start" gap="xs">
									<Checkbox
										size="xs"
										mt={2}
										checked={checked.has(entry.effectId)}
										onChange={(event) => {
											const next = new Set(checked);
											if (event.currentTarget.checked) next.add(entry.effectId);
											else next.delete(entry.effectId);
											setChecked(next);
										}}
									/>
									<div style={{ flex: 1, minWidth: 0 }}>
										<Text size="xs" style={{ wordBreak: "break-all" }}>
											{entry.displayPath}
										</Text>
										<Text size="xs" c="dimmed">
											{t("workspaceBarriersVerdictExplanation", {
												verdict: t(`workspaceBarriersVerdict_${entry.verdict}`),
											})}
										</Text>
									</div>
									<Badge variant="light" color={VERDICT_COLORS[entry.verdict]}>
										{t(`workspaceBarriersVerdict_${entry.verdict}`)}
									</Badge>
								</Group>
							))}
						</Stack>
					</>
				)}

				{!isRootVerification && noEffects && (
					<Checkbox
						size="xs"
						checked={inspected}
						onChange={(event) => setInspected(event.currentTarget.checked)}
						label={t("workspaceBarriersInspectedLabel")}
					/>
				)}
			</Stack>
		</Paper>
	);
}
