import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { parseTokenDanceRecoveryAction, type TokenDancePublicConnection } from "@shared/tokendance";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { api } from "../../lib/api";
import {
	TOKENDANCE_RECHARGE_EVENT,
	TOKENDANCE_RECOVERY_EVENT,
	type TokenDanceRecoveryDetail,
} from "../../lib/tokendance-recovery";
import { TokenDanceRechargeDialog } from "./TokenDanceRechargeDialog";

export function TokenDanceRecoveryHost() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { data: user } = useCurrentUser();
	const [detail, setDetail] = useState<TokenDanceRecoveryDetail | null>(null);
	const [generation, setGeneration] = useState<number>();
	const [failed, setFailed] = useState(false);
	const pending = useRef<AbortController | null>(null);
	const actor = `${user?.id}:${user?.role}`;
	const connection = useQuery({
		queryKey: ["tokendance", "connection", user?.id],
		queryFn: ({ signal }) => api.tokenDanceConnection({ signal }),
		enabled: user?.role === "admin" && (!!detail || generation !== undefined),
		staleTime: 30_000,
		refetchInterval:
			user?.role === "admin" && (detail || generation !== undefined) ? 30_000 : false,
		refetchIntervalInBackground: false,
		retry: false,
	});
	const settings = useQuery<{ tokendance?: TokenDancePublicConnection }>({
		queryKey: ["settings"],
		queryFn: ({ signal }) => api.getSettings({ signal }),
		enabled: false,
	});
	const visibleConnection = settings.data?.tokendance ?? connection.data;
	const fingerprint = visibleConnection
		? `${visibleConnection.generation}:${visibleConnection.disabled}:${visibleConnection.connected}:${connection.data?.billingInstance ?? visibleConnection.billingInstance ?? ""}:${visibleConnection.billingInstance ?? ""}`
		: undefined;
	const previousConnection = useRef(fingerprint);
	const seenRecovery = useRef(new Set<string>());
	useEffect(() => {
		if (previousConnection.current !== undefined && previousConnection.current !== fingerprint) {
			pending.current?.abort();
			pending.current = null;
			setDetail(null);
			setGeneration(undefined);
			setFailed(false);
			seenRecovery.current.clear();
		}
		previousConnection.current = fingerprint;
	}, [fingerprint]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Actor changes invalidate all recovery state.
	useEffect(() => {
		setDetail(null);
		setGeneration(undefined);
		setFailed(false);
		seenRecovery.current.clear();
		return () => {
			pending.current?.abort();
			pending.current = null;
		};
	}, [actor]);
	const recharge = useCallback(async () => {
		if (user?.role !== "admin" || pending.current || generation !== undefined) return;
		const controller = new AbortController();
		pending.current = controller;
		setFailed(false);
		try {
			const connection = await api.tokenDanceConnection({ signal: controller.signal });
			if (!controller.signal.aborted && connection.connected && !connection.disabled) {
				setDetail(null);
				setGeneration(connection.generation);
			}
		} catch {
			if (!controller.signal.aborted) {
				setFailed(true);
				setDetail({ action: "top_up_balance" });
			}
		} finally {
			if (pending.current === controller) pending.current = null;
		}
	}, [user?.role, generation]);
	useEffect(() => {
		const handle = () => {
			if (user?.role !== "admin") setDetail({ action: "top_up_balance" });
			else void recharge();
		};
		window.addEventListener(TOKENDANCE_RECHARGE_EVENT, handle);
		return () => window.removeEventListener(TOKENDANCE_RECHARGE_EVENT, handle);
	}, [recharge, user?.role]);
	useEffect(() => {
		const handle = (event: Event) => {
			const candidate = (event as CustomEvent<TokenDanceRecoveryDetail>).detail;
			const action = parseTokenDanceRecoveryAction(candidate?.action);
			if (action) {
				const key = `${action}:${candidate?.narratorId ?? ""}`;
				if (seenRecovery.current.has(key) || generation !== undefined) return;
				// Bound diagnostic deduplication; reconnecting clears this set.
				if (seenRecovery.current.size >= 128) seenRecovery.current.clear();
				seenRecovery.current.add(key);
				setDetail({ action });
				void queryClient.invalidateQueries({ queryKey: ["settings"] });
			}
		};
		window.addEventListener(TOKENDANCE_RECOVERY_EVENT, handle);
		return () => window.removeEventListener(TOKENDANCE_RECOVERY_EVENT, handle);
	}, [queryClient, generation]);
	const close = useCallback(() => setDetail(null), []);
	return (
		<>
			{generation !== undefined && (
				<TokenDanceRechargeDialog
					opened
					generation={generation}
					onClose={() => setGeneration(undefined)}
				/>
			)}
			{detail && (
				<TokenDanceRecoveryPrompt
					action={detail.action}
					admin={user?.role === "admin"}
					onClose={close}
					onRecharge={() => void recharge()}
					failed={failed}
					onManage={() => {
						close();
						void navigate({ to: "/settings/providers", search: { provider: "tokendance" } });
					}}
				/>
			)}
		</>
	);
}

export function TokenDanceRecoveryPrompt({
	action,
	admin,
	onClose,
	onManage,
	onRecharge,
	failed,
}: {
	action: TokenDanceRecoveryDetail["action"];
	admin: boolean;
	onClose: () => void;
	onManage: () => void;
	onRecharge?: () => void;
	failed?: boolean;
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
				{failed && <Text c="red">{t("tokendanceRechargeFailed")}</Text>}
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
						<Button onClick={onRecharge}>{t("tokendanceRechargeTitle")}</Button>
					)}
					{admin && <Button onClick={onManage}>{t("tokendanceRecoveryManage")}</Button>}
				</Group>
			</Stack>
		</Modal>
	);
}
