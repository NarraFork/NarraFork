import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { UNATTENDED_CHANGED_WS_TYPE, UNATTENDED_IDLE_POLL_INTERVAL_MS } from "@shared/unattended";
import { IconPower } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../hooks/useAuth";
import { ApiError, api } from "../lib/api";
import { type UnattendedStatus, unattendedStatusQueryKey } from "../lib/api/unattended";
import { formatLocaleTime } from "../lib/intl-format";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import { TOP_BANNER_SECOND_ROW_STYLE } from "../lib/safe-area";
import { Z } from "../lib/z-index";

/**
 * Global, always-visible indicator that unattended mode is armed — and its kill switch.
 *
 * This is the safety valve for a mode whose end state is "the machine switches off": whoever
 * is sitting in front of NarraFork can stop it at any point, from any page, without hunting
 * for a settings page they may not even be allowed to open. That is why cancellation is open
 * to every signed-in user (see `routes/unattended.ts`) and why the banner is mounted by the
 * authenticated shell rather than by one route.
 *
 * It is also the single owner of the 5 s status poll: the settings card reads the same query
 * key without an interval, so two surfaces never poll independently.
 */

const POLL_INTERVAL_MS = 5_000;
/**
 * A slow poll while the mode is off is what lets a *different* browser notice that
 * somebody armed it — the banner is the only surface that user may be able to reach before
 * the machine goes down, so it must appear without a page reload.
 */
const URGENT_WINDOW_MS = 60_000;

const BLOCKER_KEYS = [
	["narrators", "unattendedBlockedNarrators"],
	["compacting", "unattendedBlockedCompacting"],
	["queuedDeliveries", "unattendedBlockedQueue"],
	["backgroundTasks", "unattendedBlockedBackground"],
	["dueScheduledTasks", "unattendedBlockedScheduled"],
	["maintenance", "unattendedBlockedMaintenance"],
	["unknown", "unattendedBlockedUnknown"],
] as const;

function blockerKey(status: UnattendedStatus): string | null {
	for (const [field, key] of BLOCKER_KEYS) {
		const value = status.blockers[field];
		if (typeof value === "number" ? value > 0 : value) return key;
	}
	return null;
}

function formatClock(iso: string): string {
	return formatLocaleTime(iso, { hour12: false });
}

function formatRemaining(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function UnattendedModeBanner() {
	const { t } = useTranslation("settings");
	const { data: user } = useCurrentUser();
	const client = useQueryClient();
	const statusQuery = useQuery({
		queryKey: unattendedStatusQueryKey,
		queryFn: ({ signal }) => api.getUnattendedStatus(signal),
		enabled: !!user,
		refetchInterval: (query) =>
			query.state.data?.enabled ? POLL_INTERVAL_MS : UNATTENDED_IDLE_POLL_INTERVAL_MS,
		refetchIntervalInBackground: true,
		retry: false,
	});
	const signedIn = !!user;
	useEffect(() => {
		if (!signedIn) return;
		let disposed = false;
		const refresh = async () => {
			await client.cancelQueries({ queryKey: unattendedStatusQueryKey });
			if (!disposed) await client.invalidateQueries({ queryKey: unattendedStatusQueryKey });
		};
		const listener = narratorWSManager.addListener(
			{ types: [UNATTENDED_CHANGED_WS_TYPE] },
			refresh,
		);
		const disconnect = narratorWSManager.onConnectionChange((connected) => {
			if (connected) void refresh();
		});
		return () => {
			disposed = true;
			disconnect();
			narratorWSManager.removeListener(listener);
		};
	}, [client, signedIn]);
	const cancel = useMutation({
		mutationFn: () => api.cancelUnattendedMode(),
		onSuccess: ({ status }) => {
			client.setQueryData(unattendedStatusQueryKey, status);
		},
	});
	const status = statusQuery.data;
	const enabled = status?.enabled === true;
	// One local ticker for the countdown text; status itself still comes from the 5 s poll.
	const [, tick] = useReducer((ticks: number) => ticks + 1, 0);
	useEffect(() => {
		if (!enabled) return;
		const timer = setInterval(tick, 1_000);
		return () => clearInterval(timer);
	}, [enabled]);

	if (!user || !status || !enabled) return null;

	const closing = status.phase === "shutting_down";
	const shutdownAt = status.shutdownAt ? new Date(status.shutdownAt).getTime() : null;
	const remainingMs = shutdownAt === null ? 0 : shutdownAt - Date.now();
	const urgent = !closing && shutdownAt !== null && remainingMs <= URGENT_WINDOW_MS;
	const key = blockerKey(status);
	const detail = closing
		? t("unattendedBannerClosing")
		: key
			? t(key, { count: status.blockers.narrators })
			: shutdownAt === null
				? t("unattendedBannerWaiting")
				: t("unattendedBannerCountdown", {
						time: formatClock(status.shutdownAt as string),
						remaining: formatRemaining(remainingMs),
					});
	const error = cancel.error;
	const errorText = error
		? error instanceof ApiError && error.status === 409
			? t("unattendedBannerTooLate")
			: error.message
		: null;

	return (
		<Alert
			className="nf-top-banner"
			color={closing ? "gray" : urgent ? "red" : "orange"}
			variant="filled"
			icon={<IconPower size={18} />}
			aria-live="polite"
			style={{
				position: "fixed",
				// Second row: the WS-reconnect and version banners own the first one.
				...TOP_BANNER_SECOND_ROW_STYLE,
				// Centred with auto margins, not a transform — the WCO no-drag rect is derived
				// from the layout box (see VersionUpdateBanner).
				left: 0,
				right: 0,
				marginInline: "auto",
				zIndex: Z.toast,
				maxWidth: 560,
				width: "calc(100% - 32px)",
			}}
		>
			<Group justify="space-between" wrap="nowrap" gap="sm">
				<Stack gap={0} style={{ minWidth: 0 }}>
					<Text size="sm" fw={600}>
						{t("unattendedBannerOn")}
					</Text>
					<Text size="xs" style={{ overflowWrap: "anywhere" }}>
						{detail}
					</Text>
					{errorText && (
						<Text size="xs" style={{ overflowWrap: "anywhere" }}>
							{errorText}
						</Text>
					)}
				</Stack>
				{!closing && (
					<Button
						size="compact-sm"
						variant="white"
						color={urgent ? "red" : "orange"}
						loading={cancel.isPending}
						onClick={() => cancel.mutate()}
						style={{ flexShrink: 0 }}
					>
						{t("unattendedBannerDisable")}
					</Button>
				)}
			</Group>
		</Alert>
	);
}
