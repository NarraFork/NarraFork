import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { parseTokenDanceRecoveryAction, TOKENDANCE_ORIGIN } from "@shared/tokendance";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import {
	TOKENDANCE_RECOVERY_EVENT,
	type TokenDanceRecoveryDetail,
} from "../../lib/tokendance-recovery";

export function TokenDanceRecoveryHost() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { data: user } = useCurrentUser();
	const [detail, setDetail] = useState<TokenDanceRecoveryDetail | null>(null);
	useEffect(() => {
		const handle = (event: Event) => {
			const candidate = (event as CustomEvent<TokenDanceRecoveryDetail>).detail;
			const action = parseTokenDanceRecoveryAction(candidate?.action);
			if (action) {
				setDetail({ action });
				void queryClient.invalidateQueries({ queryKey: ["settings"] });
			}
		};
		window.addEventListener(TOKENDANCE_RECOVERY_EVENT, handle);
		return () => window.removeEventListener(TOKENDANCE_RECOVERY_EVENT, handle);
	}, [queryClient]);
	const close = useCallback(() => setDetail(null), []);
	if (!detail) return null;
	return (
		<TokenDanceRecoveryPrompt
			action={detail.action}
			admin={user?.role === "admin"}
			onClose={close}
			onManage={() => {
				close();
				void navigate({ to: "/settings/providers" });
			}}
		/>
	);
}

export function TokenDanceRecoveryPrompt({
	action,
	admin,
	onClose,
	onManage,
}: {
	action: TokenDanceRecoveryDetail["action"];
	admin: boolean;
	onClose: () => void;
	onManage: () => void;
}) {
	// errors is preloaded by the app shell; using narrator here would suspend other routes.
	const { t } = useTranslation("errors");
	const description =
		action === "top_up_balance"
			? "tokendanceRecoveryTopUp"
			: action === "reauthorize_api_key"
				? "tokendanceRecoveryReauthorize"
				: "tokendanceRecoveryQuota";
	return (
		<Modal opened onClose={onClose} title={t("tokendanceRecoveryTitle")} centered size="md">
			<Stack gap="md">
				<Text size="sm">{t(description)}</Text>
				{!admin && (
					<Text size="sm" c="dimmed">
						{t("tokendanceRecoveryAdminRequired")}
					</Text>
				)}
				<Group justify="flex-end" wrap="wrap">
					<Button variant="default" onClick={onClose}>
						{t("tokendanceRecoveryDismiss")}
					</Button>
					{admin && action === "top_up_balance" && (
						<Button
							component="a"
							href={`${TOKENDANCE_ORIGIN}/`}
							target="_blank"
							rel="noopener noreferrer"
						>
							{t("tokendanceRecoveryOpenWebsite")}
						</Button>
					)}
					{admin && <Button onClick={onManage}>{t("tokendanceRecoveryManage")}</Button>}
				</Group>
			</Stack>
		</Modal>
	);
}
