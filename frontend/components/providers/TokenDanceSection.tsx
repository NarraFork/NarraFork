import { Alert, Button, Group, Stack, Switch, Text } from "@mantine/core";
import {
	parseTokenDanceRecoveryAction,
	type TokenDancePublicConnection,
	type TokenDanceRecoveryAction,
} from "@shared/tokendance";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { ApiError, api } from "../../lib/api";
import { formatLocaleNumber } from "../../lib/intl-format";
import { useConfirmDialog } from "../common/confirm-dialog-context";
export function TokenDanceSection({
	connection,
	onLogin,
	onChanged,
	onDeleted,
}: {
	connection: TokenDancePublicConnection;
	onLogin: () => Promise<void>;
	onChanged: () => Promise<void>;
	onDeleted: () => void;
}) {
	const { t } = useTranslation("settings");
	const confirm = useConfirmDialog();
	const { data: user } = useCurrentUser();
	const isAdmin = user?.role === "admin";
	const [recovery, setRecovery] = useState<{
		generation: number;
		action: TokenDanceRecoveryAction;
	}>();
	const recoveryAction =
		recovery?.generation === connection.generation ? recovery.action : connection.recoveryAction;
	const busyRef = useRef(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(false);
	const run = async (action: () => Promise<unknown>) => {
		if (busyRef.current || !isAdmin) return;
		busyRef.current = true;
		setBusy(true);
		setError(false);
		try {
			await action();
			await onChanged();
			setRecovery(undefined);
		} catch (cause) {
			const action = parseTokenDanceRecoveryAction(
				cause instanceof ApiError ? cause.data?.recoveryAction : undefined,
			);
			if (action) setRecovery({ generation: connection.generation, action });
			setError(true);
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};
	return (
		<Stack>
			<Text>{connection.name || "TokenDance"}</Text>
			{error && <Alert color="red">{t("tokendance.operationFailed")}</Alert>}
			{recoveryAction && <Alert color="yellow">{t(`tokendance.${recoveryAction}`)}</Alert>}
			<Switch
				label={t("tokendance.enabled")}
				checked={!connection.disabled}
				disabled={busy || !isAdmin}
				onChange={() => void run(() => api.tokenDanceUpdateConnection(!connection.disabled))}
			/>
			<Group wrap="wrap">
				<Button
					loading={busy}
					disabled={busy || !isAdmin}
					onClick={() => void run(() => api.tokenDanceRefreshModels())}
				>
					{t("tokendance.refresh")}
				</Button>
				<Button disabled={busy || !isAdmin} onClick={() => void run(onLogin)}>
					{t("tokendance.reauthorize")}
				</Button>
				{recoveryAction === "top_up_balance" && (
					<Button
						component="a"
						href="https://tokendance.space"
						target="_blank"
						rel="noopener noreferrer"
					>
						{t("tokendance.top_up_balance")}
					</Button>
				)}
				<Button
					color="red"
					disabled={busy || !isAdmin}
					onClick={() =>
						void run(async () => {
							const accepted = await confirm({
								title: t("tokendance.delete"),
								message: t("tokendance.deleteDescription"),
								confirmLabel: t("tokendance.delete"),
								confirmColor: "red",
							});
							if (!accepted) return;
							await api.tokenDanceDeleteConnection();
							onDeleted();
						})
					}
				>
					{t("tokendance.delete")}
				</Button>
			</Group>
			{connection.models.map((model) => (
				<Text key={model.id} size="sm">
					{model.name || model.id} · {formatLocaleNumber(model.context_length)}
				</Text>
			))}
		</Stack>
	);
}
