import { Alert, Button, Group, Stack, Switch, Text } from "@mantine/core";
import {
	parseTokenDanceRecoveryAction,
	type TokenDancePublicConnection,
	type TokenDanceRecoveryAction,
} from "@shared/tokendance";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { formatTokenDanceMoney, useTokenDanceBalance } from "../../hooks/useTokenDanceBalance";
import { ApiError, api } from "../../lib/api";
import { useConfirmDialog } from "../common/confirm-dialog-context";
import { TokenDanceRechargeDialog } from "../settings/TokenDanceRechargeDialog";
import { ModelList, type ModelListProps } from "./ModelList";
export function TokenDanceSection({
	connection,
	onLogin,
	onChanged,
	onDeleted,
	...modelListProps
}: Omit<ModelListProps, "models" | "defaultContextWindows"> & {
	connection: TokenDancePublicConnection;
	onLogin: () => Promise<void>;
	onChanged: () => Promise<void>;
	onDeleted: () => void;
}) {
	const { t, i18n } = useTranslation("settings");
	const confirm = useConfirmDialog();
	const { data: user } = useCurrentUser();
	const isAdmin = user?.role === "admin";
	const qc = useQueryClient();
	const balance = useTokenDanceBalance(
		connection.generation,
		connection.connected && !connection.disabled,
	);
	const [rechargeOpened, setRechargeOpened] = useState(false);
	const [balanceRefreshFailed, setBalanceRefreshFailed] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Credential and actor changes close confirmation UI.
	useEffect(() => {
		setRechargeOpened(false);
		setBalanceRefreshFailed(false);
	}, [connection.generation, connection.disabled, user?.id, user?.role]);
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
			<Group wrap="wrap">
				<Text>
					{t("tokendance.balance")}:{" "}
					{formatTokenDanceMoney(balance.data?.balance, i18n.resolvedLanguage) ??
						t("tokendance.balanceUnknown")}
				</Text>
				<Text>
					{t("tokendance.credits")}:{" "}
					{formatTokenDanceMoney(balance.data?.credits, i18n.resolvedLanguage) ??
						t("tokendance.balanceUnknown")}
				</Text>
				<Text>
					{t("tokendance.creditsUsed")}:{" "}
					{formatTokenDanceMoney(balance.data?.creditsUsed, i18n.resolvedLanguage) ??
						t("tokendance.balanceUnknown")}
				</Text>
			</Group>
			{(balance.isError || balance.data?.hasError) && (
				<Alert color="red">{t("tokendance.operationFailed")}</Alert>
			)}
			{balanceRefreshFailed && <Alert color="red">{t("tokendance.balanceRefreshFailed")}</Alert>}
			{balance.data?.balance != null &&
				(balance.isError || balance.data.hasError || balanceRefreshFailed) && (
					<Text c="yellow" size="sm">
						{t("tokendance.balanceStale")}
					</Text>
				)}
			{balance.data?.balance != null && balance.data.balance <= 0 && (
				<Alert color="yellow">{t("tokendance.balanceInsufficient")}</Alert>
			)}
			{isAdmin && (
				<Group>
					<Button
						disabled={busy || connection.disabled}
						onClick={() =>
							void run(async () => {
								setBalanceRefreshFailed(false);
								try {
									const result = await api.tokenDanceRefreshBalance();
									if (result.generation !== connection.generation)
										throw new Error("Balance generation changed");
									qc.setQueryData(["tokendance", "balance", connection.generation], result);
									if (result.hasError) throw new Error("Balance refresh failed");
								} catch {
									setBalanceRefreshFailed(true);
									throw new Error("Balance refresh failed");
								}
							})
						}
					>
						{t("tokendance.refreshBalance")}
					</Button>
					<Button disabled={connection.disabled} onClick={() => setRechargeOpened(true)}>
						{t("tokendance.recharge")}
					</Button>
				</Group>
			)}
			<TokenDanceRechargeDialog
				opened={rechargeOpened}
				generation={connection.generation}
				disabled={connection.disabled}
				onClose={() => setRechargeOpened(false)}
			/>
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
				{recoveryAction && !isAdmin && <Text>{t("tokendance.contactAdmin")}</Text>}
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
			<ModelList
				{...modelListProps}
				models={connection.models.map((model) => ({
					value: `tokendance:${model.id}`,
					label: model.name || model.id,
				}))}
				defaultContextWindows={Object.fromEntries(
					connection.models.map((model) => [`tokendance:${model.id}`, model.context_length]),
				)}
			/>
		</Stack>
	);
}
