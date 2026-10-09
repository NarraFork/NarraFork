import { Alert, Button, Loader, Stack, Text } from "@mantine/core";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	captureTokenDanceCallback,
	completeTokenDanceCallback,
	readTokenDanceFlowMarker,
} from "../../components/providers/tokendance-flow";
import { api } from "../../lib/api";

export const Route = createFileRoute("/settings/providers/tokendance/callback")({
	beforeLoad: () => {
		captureTokenDanceCallback();
	},
	component: TokenDanceCallbackPage,
});
function TokenDanceCallbackPage() {
	const { t } = useTranslation("settings");
	const navigate = useNavigate();
	const [failed, setFailed] = useState(false);
	const [cancelling, setCancelling] = useState(false);
	const cancelRef = useRef(false);
	const cancel = async () => {
		if (cancelRef.current) return;
		cancelRef.current = true;
		setCancelling(true);
		const { flowId } = captureTokenDanceCallback();
		if (flowId && flowId === readTokenDanceFlowMarker())
			await api.tokenDanceOAuthCancel(flowId).catch(() => {});
		void navigate({ to: "/settings/providers", replace: true });
	};
	useEffect(() => {
		let active = true;
		void completeTokenDanceCallback().then((ok) => {
			if (!active || cancelRef.current) return;
			if (ok) void navigate({ to: "/settings/providers", replace: true });
			else setFailed(true);
		});
		return () => {
			active = false;
		};
	}, [navigate]);
	return (
		<Stack p="md" align="center">
			{failed ? (
				<>
					<Alert color="yellow">{t("tokendance.loginFailed")}</Alert>
					<Button onClick={() => void navigate({ to: "/settings/providers", replace: true })}>
						{t("tokendance.returnSettings")}
					</Button>
				</>
			) : (
				<>
					<Loader />
					<Text>{t("tokendance.completing")}</Text>
					<Button
						variant="subtle"
						loading={cancelling}
						disabled={cancelling}
						onClick={() => void cancel()}
					>
						{t("addProviderCancel")}
					</Button>
				</>
			)}
		</Stack>
	);
}
