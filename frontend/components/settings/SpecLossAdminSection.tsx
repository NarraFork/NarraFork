/**
 * Content the old Spec panel may have swallowed, as an administrator sees it (outline P2 PR 12c):
 * every session's findings, how the background scan is doing, and "Scan now" (the server only
 * starts a pass and answers; the pass runs in the background). The list and what is done about a
 * finding are the Spec panel's ({@link SpecLossFindings}).
 */
import { Button, Group, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconSearch } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useOutlineEnabled } from "../../hooks/useOutlineEnabled";
import { specLossKey, useSpecLossPages } from "../../hooks/useSpecLoss";
import { api } from "../../lib/api";
import { describeApiError } from "../../lib/api-error";
import { formatLocaleDateTime } from "../../lib/intl-format";
import { SpecLossFindings } from "../narrator/spec/SpecLossFindings";

export function SpecLossAdminSection() {
	const { t, i18n } = useTranslation("narrator");
	const outline = useOutlineEnabled();
	const queryClient = useQueryClient();
	// The same query the list below reads (one request): its first page carries the scan's state.
	const page = useSpecLossPages(null, "open", { enabled: outline.enabled });
	const scan = page.data?.pages[0]?.scan;
	const start = useMutation({
		mutationFn: () => api.startSpecLossScan(),
		onSuccess: () => {
			notifications.show({ message: t("spec.loss.admin.scanStarted") });
			void queryClient.invalidateQueries({ queryKey: specLossKey(null) });
		},
		onError: (error) =>
			notifications.show({ color: "red", message: describeApiError(error, t).message }),
	});
	if (outline.loading || !outline.enabled) return null;
	return (
		<Stack gap="sm" data-testid="spec-loss-admin">
			<Stack gap={4}>
				<Title order={4}>{t("spec.loss.admin.title")}</Title>
				<Text size="sm" c="dimmed">
					{t("spec.loss.explain")}
				</Text>
				<Text size="sm" c="dimmed">
					{t("spec.loss.admin.description")}
				</Text>
			</Stack>
			<Group gap="xs" wrap="wrap" align="center">
				<Button
					size="xs"
					variant="light"
					leftSection={<IconSearch size={14} />}
					loading={start.isPending}
					disabled={scan?.running === true}
					onClick={() => start.mutate()}
					data-testid="spec-loss-scan-now"
				>
					{t("spec.loss.admin.scanNow")}
				</Button>
				<Text
					size="xs"
					c="dimmed"
					style={{ flex: "1 1 200px", minWidth: 0, overflowWrap: "anywhere" }}
					data-testid="spec-loss-scan-status"
				>
					{scan?.running
						? t("spec.loss.admin.scanRunning")
						: scan?.lastPass
							? [
									t("spec.loss.admin.scanLast", {
										date: formatLocaleDateTime(scan.lastPass.at, undefined, i18n.language),
										scanned: scan.lastPass.scanned,
										found: scan.lastPass.found,
										attached: scan.lastPass.attached,
									}),
									scan.lastPass.left > 0
										? t("spec.loss.admin.scanLeft", { left: scan.lastPass.left })
										: null,
								]
									.filter(Boolean)
									.join(" ")
							: t("spec.loss.admin.scanNever")}
				</Text>
			</Group>
			<SpecLossFindings />
		</Stack>
	);
}
