import {
	Alert,
	Badge,
	Button,
	Group,
	NumberInput,
	Paper,
	Stack,
	Switch,
	Text,
	TextInput,
} from "@mantine/core";
import { MIN_UNATTENDED_ARM_DELAY_SECONDS } from "@shared/unattended";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { api } from "../../lib/api";
import { unattendedStatusQueryKey } from "../../lib/api/unattended";
import { formatLocaleTime } from "../../lib/intl-format";
import { useConfirmDialog } from "../common/confirm-dialog-context";

/**
 * Administrator control for unattended mode (Issue #514).
 *
 * The card is a direct action surface, not part of the settings draft: arming takes effect
 * immediately and is intentionally NOT persisted (a remembered "armed" flag would re-arm
 * after the next boot and could power a machine off before anyone can log in).
 *
 * Turning it off is duplicated in the global banner, which every signed-in user can use.
 */
export function UnattendedModeCard() {
	const { data: user } = useCurrentUser();
	if (user?.role !== "admin") return null;
	return <AdminUnattendedModeCard />;
}

interface Draft {
	powerOff: boolean;
	quietSeconds: number;
	armDelaySeconds: number;
	powerOffCommand: string;
}

function toNumber(value: number | string, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function AdminUnattendedModeCard() {
	const { t } = useTranslation("settings");
	const confirm = useConfirmDialog();
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState<Draft | null>(null);
	const [confirming, setConfirming] = useState(false);
	// Polling belongs to the global banner, which shares this query key.
	const statusQuery = useQuery({
		queryKey: unattendedStatusQueryKey,
		queryFn: ({ signal }) => api.getUnattendedStatus(signal),
		staleTime: 0,
		retry: false,
	});
	const status = statusQuery.data;
	const server: Draft = {
		powerOff: status?.options.powerOff ?? true,
		quietSeconds: status?.options.quietSeconds ?? 120,
		armDelaySeconds: status?.options.armDelaySeconds ?? MIN_UNATTENDED_ARM_DELAY_SECONDS,
		powerOffCommand: status?.options.powerOffCommand ?? "",
	};
	const options = draft ?? server;
	const edit = (patch: Partial<Draft>) => setDraft({ ...options, ...patch });
	const action = useMutation({
		mutationFn: (enabled: boolean) =>
			api.setUnattendedMode({
				enabled,
				...(enabled
					? {
							powerOff: options.powerOff,
							quietSeconds: options.quietSeconds,
							armDelaySeconds: options.armDelaySeconds,
							powerOffCommand: options.powerOffCommand.trim()
								? options.powerOffCommand.trim()
								: null,
						}
					: {}),
			}),
		onSuccess: ({ status: next }) => {
			queryClient.setQueryData(unattendedStatusQueryKey, next);
			setDraft(null);
		},
	});
	const enabled = status?.enabled === true;
	const closing = status?.phase === "shutting_down";
	const busy = action.isPending || confirming || statusQuery.isLoading || closing;
	const errors = [
		...new Set([
			action.error?.message,
			status?.lastError,
			closing ? undefined : statusQuery.error?.message,
		]),
	].filter(Boolean) as string[];

	const start = async () => {
		setConfirming(true);
		try {
			const accepted = await confirm({
				title: t("unattendedConfirmTitle"),
				message: t(options.powerOff ? "unattendedConfirmBody" : "unattendedConfirmBodyServerOnly", {
					quiet: options.quietSeconds,
					delay: options.armDelaySeconds,
				}),
				confirmLabel: t("unattendedEnableAction"),
				confirmColor: "red",
			});
			if (accepted) action.mutate(true);
		} finally {
			setConfirming(false);
		}
	};

	return (
		<Paper p="sm" radius="sm" withBorder>
			<Stack gap="sm">
				<Group gap="xs">
					<Text fw={600} size="sm">
						{t("unattendedTitle")}
					</Text>
					{status && (
						<Badge variant="light" color={enabled ? (closing ? "gray" : "orange") : "gray"}>
							{t(`unattendedPhase_${status.phase}`)}
						</Badge>
					)}
				</Group>
				<Text size="xs" c="dimmed">
					{t("unattendedDescription")}
				</Text>
				<Text size="xs" c="dimmed">
					{t("unattendedRestartDisarms")}
				</Text>
				{statusQuery.isLoading && <Text size="sm">{t("systemLifecycleLoading")}</Text>}
				{errors.map((error) => (
					<Alert key={error} color="red">
						{error}
					</Alert>
				))}
				{enabled && status && (
					<Stack gap={2}>
						{status.shutdownAt && (
							<Text size="xs" c="dimmed">
								{t("unattendedCountdown", {
									time: formatLocaleTime(status.shutdownAt, { hour12: false }),
								})}
							</Text>
						)}
						<Text size="xs" c="dimmed">
							{t("unattendedStatusCounts", {
								narrators: status.blockers.narrators,
								compacting: status.blockers.compacting,
								queue: status.blockers.queuedDeliveries ? 1 : 0,
								background: status.blockers.backgroundTasks ? 1 : 0,
								scheduled: status.blockers.dueScheduledTasks ? 1 : 0,
							})}
						</Text>
						{status.powerOffPlan?.command && (
							<Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
								{t("unattendedPowerOffCommandHint", {
									command: status.powerOffPlan.command.join(" "),
								})}
							</Text>
						)}
					</Stack>
				)}
				<Switch
					label={t("unattendedPowerOff")}
					description={t("unattendedPowerOffHint")}
					checked={options.powerOff}
					disabled={busy}
					onChange={(event) => edit({ powerOff: event.currentTarget.checked })}
				/>
				<Group grow align="flex-start">
					<NumberInput
						label={t("unattendedQuietSeconds")}
						value={options.quietSeconds}
						min={10}
						max={86_400}
						step={10}
						disabled={busy}
						onChange={(value) => edit({ quietSeconds: toNumber(value, options.quietSeconds) })}
					/>
					<NumberInput
						label={t("unattendedArmDelay")}
						value={options.armDelaySeconds}
						min={MIN_UNATTENDED_ARM_DELAY_SECONDS}
						max={3_600}
						step={10}
						disabled={busy}
						onChange={(value) =>
							edit({ armDelaySeconds: toNumber(value, options.armDelaySeconds) })
						}
					/>
				</Group>
				<TextInput
					label={t("unattendedPowerOffCommand")}
					description={t("unattendedPowerOffCommandDescription")}
					placeholder={status?.powerOffPlan?.command?.join(" ") ?? ""}
					value={options.powerOffCommand}
					disabled={busy || !options.powerOff}
					onChange={(event) => edit({ powerOffCommand: event.currentTarget.value })}
				/>
				{status?.powerOffPlan && !status.powerOffPlan.supported && (
					<Alert color="yellow">{t("unattendedUnsupportedPlatform")}</Alert>
				)}
				{status?.lastError === "shutdown_unavailable" && (
					<Alert color="yellow">{t("unattendedShutdownUnavailable")}</Alert>
				)}
				<Group gap="xs">
					{enabled ? (
						<>
							<Button
								size="xs"
								variant="light"
								loading={action.isPending && action.variables === true}
								disabled={busy}
								onClick={() => action.mutate(true)}
							>
								{t("unattendedApply")}
							</Button>
							<Button
								size="xs"
								color="red"
								variant="light"
								loading={action.isPending && action.variables === false}
								disabled={busy}
								onClick={() => action.mutate(false)}
							>
								{t("unattendedDisable")}
							</Button>
						</>
					) : (
						<Button
							size="xs"
							color="orange"
							loading={action.isPending && action.variables === true}
							disabled={busy}
							onClick={() => void start()}
						>
							{t("unattendedEnableAction")}
						</Button>
					)}
				</Group>
			</Stack>
		</Paper>
	);
}
