import { Alert, Button, Code, Group, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconLock } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../hooks/useAuth";
import { api, getToken } from "../lib/api";
import { useConfirmDialog } from "./common/confirm-dialog-context";

/**
 * Data directory permissions are checked only when an operator asks for it, from
 * Settings > Storage. The earlier design probed in the background on every login and
 * raised a notification for any non-ok result — including a probe that merely timed
 * out on a slow filesystem. That reported a permission fault where there was none,
 * and admins who followed the alert found a healthy directory. Real permission
 * problems still surface where they matter: the operation that needs the directory
 * fails with an error that points here.
 */
export function DataDirectorySecurityCheckButton() {
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
		// Never probes on mount: the operator's explicit request opens the modal.
		enabled: enabled && opened && !busy,
		staleTime: 60_000,
		retry: false,
		refetchOnWindowFocus: false,
	});

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

	const status = query.isError ? undefined : query.data?.status;
	// An inconclusive probe is neither healthy nor a fault; it says nothing at all.
	const inconclusive = query.isError || status === "unknown";
	const faulty = status !== undefined && status !== "ok" && status !== "unknown";
	const details = isAdmin ? query.data?.details : undefined;

	return (
		<>
			<Group>
				<Button variant="light" size="xs" onClick={() => setOpened(true)}>
					{t("dataDirectorySecurity.check")}
				</Button>
			</Group>
			<Modal
				opened={opened}
				onClose={() => {
					if (!busy) setOpened(false);
				}}
				// "needs attention" is only claimed once a check actually said so.
				title={t(faulty ? "dataDirectorySecurity.title" : "dataDirectorySecurity.statusTitle")}
				size="sm"
				closeOnClickOutside={!busy}
				closeOnEscape={!busy}
				withCloseButton={!busy}
			>
				<Alert
					color={faulty ? "yellow" : status === "ok" ? "green" : "gray"}
					radius={0}
					icon={faulty ? <IconAlertTriangle size={18} /> : <IconLock size={18} />}
					title={t(faulty ? "dataDirectorySecurity.title" : "dataDirectorySecurity.statusTitle")}
				>
					<Stack gap="xs">
						<Text size="sm">
							{t(
								query.isFetching
									? "dataDirectorySecurity.checking"
									: query.isError
										? "dataDirectorySecurity.queryFailed"
										: status === "unknown"
											? "dataDirectorySecurity.inconclusive"
											: status === "ok"
												? "dataDirectorySecurity.healthy"
												: faulty
													? "dataDirectorySecurity.description"
													: "dataDirectorySecurity.checking",
							)}
						</Text>
						{faulty && (
							<Alert color="blue" variant="light" icon={<IconLock size={18} />}>
								<Text size="sm">{t("dataDirectorySecurity.whyPermissions")}</Text>
							</Alert>
						)}
						{!isAdmin && (faulty || inconclusive) ? (
							<Text size="sm">{t("dataDirectorySecurity.contactAdmin")}</Text>
						) : faulty && !query.data?.canRepair ? (
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
						<Group gap="sm" mt="sm">
							{isAdmin && faulty && query.data?.canRepair && (
								<Button
									size="md"
									color="orange"
									leftSection={<IconLock size={18} />}
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
		</>
	);
}
