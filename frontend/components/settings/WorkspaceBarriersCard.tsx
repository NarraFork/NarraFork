import {
	Alert,
	Badge,
	Button,
	Checkbox,
	Divider,
	Group,
	Paper,
	Stack,
	Text,
	Textarea,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconEyeSearch, IconShieldCheck } from "@tabler/icons-react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
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
	const { data: user } = useCurrentUser();
	if (user?.role !== "admin") return null;
	return <AdminWorkspaceBarriersCard />;
}
function AdminWorkspaceBarriersCard() {
	const { t } = useTranslation("settings");
	const queryClient = useQueryClient();
	const { data, isLoading, error, hasNextPage, fetchNextPage, isFetchingNextPage } =
		useInfiniteQuery({
			queryKey: ["workspace-barriers"],
			initialPageParam: undefined as string | undefined,
			queryFn: ({ pageParam }) => api.getWorkspaceBarriers(pageParam),
			getNextPageParam: (page) => page.nextCursor ?? undefined,
			refetchInterval: 30_000,
		});
	const invalidate = () => queryClient.invalidateQueries({ queryKey: ["workspace-barriers"] });
	const items = data?.pages.flatMap((page) => page.items) ?? [];
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
				{error && <Alert color="red">{error.message}</Alert>}
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
							<BarrierRow
								key={barrier.leaseId ?? barrier.scope.id}
								barrier={barrier}
								onRecovered={invalidate}
							/>
						))}
					</Stack>
				)}
				{hasNextPage && (
					<Button
						size="xs"
						variant="subtle"
						loading={isFetchingNextPage}
						onClick={() => fetchNextPage()}
					>
						{t("workspaceBarriersLoadMore")}
					</Button>
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
	const [maintenance, setMaintenance] = useState<{
		maintenanceToken: string;
		expiresAt: string;
	} | null>(null);
	const [writersStopped, setWritersStopped] = useState(false);
	const [operatorReason, setOperatorReason] = useState("");
	const maintenanceRef = useRef(maintenance);
	maintenanceRef.current = maintenance;
	useEffect(
		() => () => {
			const session = maintenanceRef.current;
			if (session)
				void api
					.cancelWorkspaceMaintenance(barrier.scope.id, session.maintenanceToken)
					.catch(() => {});
		},
		[barrier.scope.id],
	);
	useEffect(() => {
		if (!maintenance) return;
		const timer = setTimeout(
			() => {
				setMaintenance(null);
				setObservation(null);
			},
			Math.max(0, Date.parse(maintenance.expiresAt) - Date.now()),
		);
		return () => clearTimeout(timer);
	}, [maintenance]);
	const maintenanceError = (error: unknown) =>
		notifications.show({
			color: "red",
			message: error instanceof Error ? error.message : String(error),
		});
	const retryPersistence = useMutation({
		mutationFn: () => api.retryWorkspaceRecoveryPersistence(barrier.scope.id),
		onSuccess: () => {
			onRecovered();
			notifications.show({ color: "green", message: t("workspaceBarriersRetryPersistenceDone") });
		},
		onError: maintenanceError,
	});
	const beginMaintenance = useMutation({
		mutationFn: () =>
			api.beginWorkspaceMaintenance(barrier.scope.id, {
				leaseId: barrier.leaseId ?? undefined,
				acknowledgeWritersStopped: true,
				operatorReason,
			}),
		onSuccess: (result) => {
			setMaintenance(result);
			setObservation(null);
		},
		onError: maintenanceError,
	});
	const cancelMaintenance = useMutation({
		mutationFn: () =>
			api.cancelWorkspaceMaintenance(barrier.scope.id, maintenance?.maintenanceToken ?? ""),
		onSuccess: () => {
			setMaintenance(null);
			setObservation(null);
			onRecovered();
		},
		onError: maintenanceError,
	});
	const observeController = useRef<AbortController | null>(null);
	useEffect(() => () => observeController.current?.abort(), []);

	const observeMutation = useMutation({
		mutationFn: () => {
			observeController.current?.abort();
			observeController.current = new AbortController();
			setObservation(null);
			if (maintenance)
				return api.observeWorkspaceMaintenance(
					barrier.scope.id,
					maintenance.maintenanceToken,
					observeController.current.signal,
				);
			return api.observeWorkspaceBarrier(
				barrier.scope.id,
				barrier.leaseId,
				observeController.current.signal,
			);
		},
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
		mutationFn: () => {
			const request = {
				confirmationToken: observation?.confirmationToken ?? "",
				acknowledgements: (observation?.observations ?? [])
					.filter((entry) => checked.has(entry.effectId))
					.map((entry) => ({ effectId: entry.effectId, verdict: entry.verdict })),
				acknowledgeInspected: inspected,
			};
			return maintenance
				? api.commitWorkspaceMaintenance(barrier.scope.id, {
						...request,
						maintenanceToken: maintenance.maintenanceToken,
					})
				: api.recoverWorkspaceBarrier(barrier.scope.id, {
						...request,
						leaseId: barrier.leaseId ?? undefined,
					});
		},
		onSuccess: (result) => {
			setMaintenance(null);
			notifications.show({
				color: "green",
				message:
					result.remaining && Object.values(result.remaining).some(Boolean)
						? t("workspaceBarriersRemaining")
						: result.recovered === "root_verified"
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
	const needsInspection =
		!isRootVerification && (noEffects || (observation?.rangeObservations.length ?? 0) > 0);
	const recoverReady =
		observation !== null &&
		(!barrier.blockedReason || !!maintenance || !!barrier.ownerProbeRetryAllowed) &&
		!cancelMaintenance.isPending &&
		(isRootVerification || noEffects || allChecked) &&
		(!needsInspection || inspected);

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
						<Text size="xs" c={barrier.executionEnded ? "dimmed" : "orange"}>
							{t(
								barrier.executionEnded
									? "workspaceBarriersExecutionEnded"
									: "workspaceBarriersExecutionUnknown",
							)}
						</Text>
						{barrier.ranges.map((range) => (
							<Text
								key={`${range.kind}:${range.canonicalPath}`}
								size="xs"
								style={{ wordBreak: "break-all" }}
							>
								{t("workspaceBarriersRange", {
									kind: t(`workspaceBarriersRange_${range.kind}`),
									path: range.canonicalPath,
								})}
							</Text>
						))}
						{barrier.blockedReason && (
							<Alert color="orange" mt="xs">
								{t("workspaceBarriersBlocked", { reason: barrier.blockedReason })}
							</Alert>
						)}
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
						<Button
							size="xs"
							variant="subtle"
							disabled={
								!barrier.local ||
								!!maintenance ||
								recoverMutation.isPending ||
								observeMutation.isPending
							}
							loading={retryPersistence.isPending}
							onClick={() => retryPersistence.mutate()}
						>
							{t("workspaceBarriersRetryPersistence")}
						</Button>
						<Button
							size="xs"
							variant="light"
							leftSection={<IconEyeSearch size={14} />}
							onClick={() => observeMutation.mutate()}
							loading={observeMutation.isPending}
							disabled={
								!barrier.local ||
								(!!barrier.blockedReason && !maintenance && !barrier.ownerProbeRetryAllowed) ||
								recoverMutation.isPending ||
								cancelMaintenance.isPending
							}
							title={!barrier.local ? t("workspaceBarriersRemoteUnsupported") : undefined}
						>
							{t("workspaceBarriersObserve")}
						</Button>
						{observeMutation.isPending && (
							<Button size="xs" variant="subtle" onClick={() => observeController.current?.abort()}>
								{t("workspaceBarriersCancel")}
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

				{barrier.maintenanceRequired && barrier.local && !maintenance && (
					<Alert color="orange">
						<Stack gap="xs">
							<Text size="xs">{t("workspaceMaintenanceExplanation")}</Text>
							<Checkbox
								checked={writersStopped}
								onChange={(event) => setWritersStopped(event.currentTarget.checked)}
								label={t("workspaceMaintenanceWritersStopped")}
							/>
							<Textarea
								label={t("workspaceMaintenanceReason")}
								value={operatorReason}
								maxLength={1000}
								onChange={(event) => setOperatorReason(event.currentTarget.value)}
							/>
							<Button
								size="xs"
								disabled={!writersStopped || !operatorReason.trim()}
								loading={beginMaintenance.isPending}
								onClick={() => beginMaintenance.mutate()}
							>
								{t("workspaceMaintenanceBegin")}
							</Button>
						</Stack>
					</Alert>
				)}
				{maintenance && (
					<Alert color="orange">
						<Text size="xs">
							{t("workspaceMaintenanceActive", {
								expiresAt: formatLocaleDateTime(maintenance.expiresAt),
							})}
						</Text>
						<Button
							size="xs"
							variant="subtle"
							loading={cancelMaintenance.isPending}
							onClick={() => cancelMaintenance.mutate()}
						>
							{t("workspaceMaintenanceCancel")}
						</Button>
					</Alert>
				)}
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
										{entry.alreadySettled && (
											<Text size="xs" c="dimmed">
												{t("workspaceBarriersAlreadySettled")}
											</Text>
										)}
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

				{observation && (
					<Text size="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
						{t("workspaceBarriersToken", { token: observation.confirmationToken })}
					</Text>
				)}
				{observation?.rangeObservations.map((range) => (
					<Text key={range.canonicalPath} size="xs">
						{t("workspaceBarriersRangeObservation", {
							path: range.canonicalPath,
							state: range.actualKind,
						})}
					</Text>
				))}
				{needsInspection && (
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
