import { Alert, Button, Code, Group, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle } from "@tabler/icons-react";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../hooks/useAuth";
import { api, getToken } from "../lib/api";
import { useConfirmDialog } from "./common/confirm-dialog-context";

const notificationId = "data-directory-security";
const openEvent = "narrafork:check-data-directory-security";
// Session JWTs rotate during normal use; a renewal must not re-show a dismissed notice.
const sessions = new WeakMap<QueryClient, { userId: string; seen: Set<string> }>();

export function DataDirectorySecurityCheckButton() {
	const { t } = useTranslation("common");
	return (
		<Button variant="light" size="xs" onClick={() => window.dispatchEvent(new Event(openEvent))}>
			{t("dataDirectorySecurity.check")}
		</Button>
	);
}

/** Notifications and a portal only: never occupies space in the authenticated shell. */
export function DataDirectorySecurityAlert() {
	const { t } = useTranslation("common");
	const { data: user } = useCurrentUser();
	const confirm = useConfirmDialog();
	const queryClient = useQueryClient();
	const [busy, setBusy] = useState(false);
	const [opened, setOpened] = useState(false);
	const [repairFailed, setRepairFailed] = useState(false);
	const inFlight = useRef(false);
	const isAdmin = user?.role === "admin";
	const enabled = !!user && !!getToken();
	const queryKey = ["data-directory-security", user?.id, user?.role];
	const query = useQuery({
		queryKey,
		queryFn: ({ signal }) => api.getDataDirectorySecurity(signal),
		enabled: enabled && !busy,
		staleTime: 60_000,
		retry: false,
		refetchOnWindowFocus: true,
	});

	useEffect(() => {
		if (!enabled) return;
		const open = () => {
			setOpened(true);
			if (!inFlight.current) void query.refetch();
		};
		window.addEventListener(openEvent, open);
		return () => window.removeEventListener(openEvent, open);
	}, [enabled, query.refetch]);

	useEffect(() => {
		if (!enabled || (!query.isError && (!query.data || query.data.status === "ok"))) return;
		if (!user?.id) return;
		let session = sessions.get(queryClient);
		if (!session || session.userId !== user.id) {
			session = { userId: user.id, seen: new Set() };
			sessions.set(queryClient, session);
		}
		const issue = query.isError
			? "query-error"
			: `${query.data?.status}:${query.data?.details?.code ?? ""}`;
		if (session.seen.has(issue)) return;
		session.seen.add(issue);
		if (opened) return;
		notifications.show({
			id: notificationId,
			color: "yellow",
			autoClose: false,
			title: t("dataDirectorySecurity.title"),
			message: (
				<Stack gap="xs">
					<Text size="sm">
						{t(
							query.isError
								? "dataDirectorySecurity.queryFailed"
								: "dataDirectorySecurity.description",
						)}
					</Text>
					{!isAdmin && <Text size="sm">{t("dataDirectorySecurity.contactAdmin")}</Text>}
					<Button size="compact-xs" variant="light" onClick={() => setOpened(true)}>
						{t(isAdmin ? "dataDirectorySecurity.handle" : "dataDirectorySecurity.recheck")}
					</Button>
				</Stack>
			),
		});
	}, [enabled, isAdmin, opened, query.data, query.isError, queryClient, t, user?.id]);

	useEffect(() => {
		if (!enabled || (!query.isError && query.data?.status === "ok"))
			notifications.hide(notificationId);
	}, [enabled, query.data?.status, query.isError]);
	useEffect(
		() => () => {
			notifications.hide(notificationId);
		},
		[],
	);

	async function repair() {
		if (inFlight.current || !enabled || !isAdmin || !query.data?.canRepair) return;
		inFlight.current = true;
		setBusy(true);
		try {
			if (
				!(await confirm({
					title: t("dataDirectorySecurity.confirmTitle"),
					message: t("dataDirectorySecurity.confirmMessage"),
					confirmLabel: t("dataDirectorySecurity.repair"),
					confirmColor: "orange",
				}))
			)
				return;
			// Discard an older GET before publishing the authoritative repair result.
			await queryClient.cancelQueries({ queryKey });
			const result = await api.repairDataDirectorySecurity();
			queryClient.setQueryData(queryKey, result);
			setRepairFailed(result.status !== "ok");
			if (result.status === "ok") {
				setOpened(false);
				notifications.show({ color: "green", message: t("dataDirectorySecurity.success") });
			}
		} catch {
			setRepairFailed(true);
		} finally {
			inFlight.current = false;
			setBusy(false);
		}
	}

	if (!enabled || !opened) return null;
	const details = isAdmin ? query.data?.details : undefined;
	return (
		<Modal
			opened={opened}
			onClose={() => {
				if (!busy) setOpened(false);
			}}
			title={t("dataDirectorySecurity.title")}
			size="sm"
			closeOnClickOutside={!busy}
			closeOnEscape={!busy}
			withCloseButton={!busy}
		>
			<Alert
				color={query.data?.status === "ok" && !query.isError ? "green" : "yellow"}
				radius={0}
				icon={<IconAlertTriangle size={18} />}
				title={t("dataDirectorySecurity.title")}
			>
				<Stack gap="xs">
					<Text size="sm">
						{t(
							query.isError
								? "dataDirectorySecurity.queryFailed"
								: query.isFetching
									? "dataDirectorySecurity.checking"
									: query.data?.status === "ok"
										? "dataDirectorySecurity.healthy"
										: "dataDirectorySecurity.description",
						)}
					</Text>
					{!isAdmin && (query.isError || query.data?.status !== "ok") ? (
						<Text size="sm">{t("dataDirectorySecurity.contactAdmin")}</Text>
					) : query.data?.status !== "ok" && !query.data?.canRepair && !query.isError ? (
						<Text size="sm">{t("dataDirectorySecurity.manual")}</Text>
					) : null}
					{repairFailed && (
						<Text size="sm" c="red">
							{t("dataDirectorySecurity.repairFailed")}
						</Text>
					)}
					{details && (
						<details>
							<summary>{t("dataDirectorySecurity.details")}</summary>
							<Code block style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
								{[
									details.path,
									details.mode && `${t("dataDirectorySecurity.mode")}: ${details.mode}`,
									`${details.code}: ${details.message}`,
									details.ownerUid !== undefined && `ownerUid: ${details.ownerUid}`,
									details.serviceUid !== undefined && `serviceUid: ${details.serviceUid}`,
								]
									.filter((line) => line !== false && line !== undefined)
									.join("\n")}
							</Code>
						</details>
					)}
					<Group gap="xs">
						{isAdmin && query.data?.canRepair && (
							<Button
								size="compact-sm"
								color="orange"
								loading={busy}
								disabled={busy || query.isFetching}
								onClick={() => void repair()}
							>
								{t("dataDirectorySecurity.repair")}
							</Button>
						)}
						<Button
							size="compact-sm"
							variant="light"
							loading={query.isFetching}
							disabled={busy || query.isFetching}
							onClick={() => {
								setRepairFailed(false);
								void query.refetch();
							}}
						>
							{t("dataDirectorySecurity.recheck")}
						</Button>
					</Group>
				</Stack>
			</Alert>
		</Modal>
	);
}
