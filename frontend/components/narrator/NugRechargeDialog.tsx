import {
	Alert,
	Anchor,
	Badge,
	Box,
	Button,
	Group,
	Loader,
	Modal,
	NativeSelect,
	NumberInput,
	Paper,
	Stack,
	Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconExternalLink } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { createQrDataUrl } from "../../lib/qr";
import type { PaymentRequiredInfo } from "./useNarratorPanelWS";

interface NugBillingOrder {
	id: string;
	amount: string;
	quota_amount: string;
	provider: string;
	channel?: string;
	status: string;
	pay_url?: string;
	paid_at?: string;
	created_at: string;
}

interface NugRechargeDialogProps {
	opened: boolean;
	narratorId: string;
	providerId: string | null;
	providerName?: string | null;
	paymentRequired: PaymentRequiredInfo | null;
	onClose: () => void;
	onPaymentRequiredChange: (value: PaymentRequiredInfo | null) => void;
	onQuotaUpdated?: (
		balance: string | null,
		totalGranted?: number | null,
		detailedQuotaBalance?: string | null,
	) => void;
}

function parseAmount(value: string | number | undefined): number {
	const n = typeof value === "number" ? value : Number(value ?? 0);
	return Number.isFinite(n) ? n : 0;
}

function isEmbeddableImageUrl(url: string): boolean {
	const lower = url.toLowerCase();
	if (lower.startsWith("data:image/")) return true;
	try {
		const parsed = new URL(url, "http://localhost");
		return /\.(png|jpe?g|gif|webp|svg)$/i.test(parsed.pathname);
	} catch {
		return /\.(png|jpe?g|gif|webp|svg)$/i.test(url.split(/[?#]/, 1)[0] ?? "");
	}
}

function estimateQuota(
	amount: number,
	channel: string,
	cfg?: Awaited<ReturnType<typeof api.nugGetBillingConfig>>,
): number {
	const channelRate =
		channel === "alipay"
			? cfg?.channelQuotaRates?.alipay
			: channel === "wechat"
				? cfg?.channelQuotaRates?.wechat
				: undefined;
	const rate = channelRate && channelRate > 0 ? channelRate : cfg?.quotaRate;
	return rate && rate > 0 ? amount / rate : amount;
}

export function NugRechargeDialog({
	opened,
	narratorId,
	providerId,
	providerName,
	paymentRequired,
	onClose,
	onPaymentRequiredChange,
	onQuotaUpdated,
}: NugRechargeDialogProps) {
	const { t } = useTranslation("narrator");
	const qc = useQueryClient();
	const [amount, setAmount] = useState<number | string>(10);
	const [paymentProvider, setPaymentProvider] = useState("");
	const [channel, setChannel] = useState("alipay");
	const [order, setOrder] = useState<NugBillingOrder | null>(null);
	const resumedRef = useRef(false);

	const configQuery = useQuery({
		queryKey: ["nug", "billing", "config", providerId],
		queryFn: () => api.nugGetBillingConfig(providerId ?? ""),
		enabled: opened && !!providerId,
	});
	const config = configQuery.data;

	useEffect(() => {
		if (!opened) return;
		resumedRef.current = false;
		setOrder(null);
	}, [opened]);

	useEffect(() => {
		if (!config) return;
		if (!paymentProvider && config.providers[0]?.name) {
			setPaymentProvider(config.providers[0].name);
		}
		if (config.orderMinAmount > 0 && parseAmount(amount) < config.orderMinAmount) {
			setAmount(config.orderMinAmount);
		}
	}, [config, paymentProvider, amount]);

	const createOrder = useMutation({
		mutationFn: async () => {
			if (!providerId || !paymentProvider) throw new Error(t("recharge.providerNotReady"));
			const currentAmount = parseAmount(amount);
			return api.nugCreateBillingOrder(providerId, {
				amount: currentAmount,
				provider: paymentProvider,
				channel,
			});
		},
		onSuccess: (data) => {
			setOrder(data.order);
		},
		onError: (err) => {
			notifications.show({
				color: "red",
				title: t("recharge.createOrderFailed"),
				message: err instanceof Error ? err.message : "",
			});
		},
	});

	const orderQuery = useQuery({
		queryKey: ["nug", "billing", "order", providerId, order?.id],
		queryFn: () => api.nugGetBillingOrder(providerId ?? "", order?.id ?? ""),
		enabled: opened && !!providerId && !!order?.id && order.status === "pending",
		refetchInterval: (query) => {
			const status = query.state.data?.order.status ?? order?.status;
			return status === "pending" ? (config?.pollIntervalMs ?? 3000) : false;
		},
	});

	useEffect(() => {
		if (orderQuery.data?.order) setOrder(orderQuery.data.order);
	}, [orderQuery.data]);

	useEffect(() => {
		if (!providerId || !order || order.status !== "paid" || resumedRef.current) return;
		resumedRef.current = true;
		void (async () => {
			try {
				const quota = await api.nugGetQuota(providerId);
				onQuotaUpdated?.(
					String(quota.balance),
					quota.totalGranted,
					quota.detailedQuotaBalance ?? null,
				);
				qc.setQueryData(["nug", "quotas"], (old: unknown) => {
					const quotas = old && typeof old === "object" ? (old as Record<string, unknown>) : {};
					const existing =
						quotas[providerId] && typeof quotas[providerId] === "object"
							? (quotas[providerId] as Record<string, unknown>)
							: {};
					return {
						...quotas,
						[providerId]: {
							...existing,
							balance: quota.balance,
							totalGranted: quota.totalGranted,
							detailedQuotaBalance: quota.detailedQuotaBalance ?? null,
							...(quota.extra !== undefined ? { extra: quota.extra } : {}),
						},
					};
				});
				qc.invalidateQueries({ queryKey: ["settings"] });
				qc.invalidateQueries({ queryKey: ["admin", "settings"] });
				notifications.show({
					color: "green",
					title: t("recharge.success"),
					message: t("recharge.currentBalance", { balance: quota.balance }),
					icon: <IconCheck size={16} />,
				});
				if (paymentRequired) {
					if (paymentRequired.resumeAction === "continue") {
						await api.continueNarrator(narratorId);
					} else {
						await api.retryLastMessage(narratorId);
					}
					onPaymentRequiredChange(null);
				}
				onClose();
			} catch (err) {
				notifications.show({
					color: "red",
					title: t("recharge.resumeFailed"),
					message: err instanceof Error ? err.message : "",
				});
			}
		})();
	}, [
		narratorId,
		onClose,
		onPaymentRequiredChange,
		onQuotaUpdated,
		order,
		paymentRequired,
		providerId,
		qc,
		t,
	]);

	const providerOptions = useMemo(
		() =>
			(config?.providers ?? []).map((p) => ({
				value: p.name,
				label: p.displayName || p.name,
			})),
		[config?.providers],
	);
	const amountNumber = parseAmount(amount);
	const expectedQuota = estimateQuota(amountNumber, channel, config);
	const amountInvalid =
		amountNumber <= 0 ||
		(config?.orderMinAmount != null &&
			config.orderMinAmount > 0 &&
			amountNumber < config.orderMinAmount) ||
		(config?.orderMaxAmount != null &&
			config.orderMaxAmount > 0 &&
			amountNumber > config.orderMaxAmount);
	const payUrl = order?.pay_url ?? "";
	const qrDataUrl = useMemo(() => {
		if (!payUrl || isEmbeddableImageUrl(payUrl)) return "";
		try {
			return createQrDataUrl(payUrl, { scale: 5 });
		} catch {
			return "";
		}
	}, [payUrl]);

	return (
		<Modal opened={opened} onClose={onClose} title={t("recharge.title")} centered size="lg">
			<Stack>
				{paymentRequired && (
					<Alert color="yellow" variant="light">
						{t("recharge.paymentRequired")}
					</Alert>
				)}
				{providerName && (
					<Group gap="xs">
						<Text size="sm" c="dimmed">
							{t("recharge.account")}
						</Text>
						<Badge variant="light">{providerName}</Badge>
					</Group>
				)}

				{configQuery.isLoading && (
					<Group gap="xs">
						<Loader size="sm" />
						<Text size="sm">{t("recharge.loadingConfig")}</Text>
					</Group>
				)}
				{configQuery.error && (
					<Alert color="red">
						{configQuery.error instanceof Error
							? configQuery.error.message
							: t("recharge.configLoadFailed")}
					</Alert>
				)}
				{config && !config.enabled && <Alert color="yellow">{t("recharge.disabled")}</Alert>}

				{config?.enabled && !order && (
					<Stack>
						<NumberInput
							label={t("recharge.amount")}
							value={amount}
							onChange={setAmount}
							min={config.orderMinAmount || 0.01}
							max={config.orderMaxAmount || undefined}
							step={1}
							decimalScale={2}
							error={amountInvalid ? t("recharge.amountOutOfRange") : undefined}
						/>
						<Group grow>
							<NativeSelect
								label={t("recharge.channel")}
								value={channel}
								onChange={(e) => setChannel(e.currentTarget.value)}
								data={[
									{ value: "alipay", label: t("recharge.channelAlipay") },
									{ value: "wechat", label: t("recharge.channelWechat") },
								]}
							/>
							<NativeSelect
								label={t("recharge.paymentService")}
								value={paymentProvider}
								onChange={(e) => setPaymentProvider(e.currentTarget.value)}
								data={providerOptions}
							/>
						</Group>
						<Paper withBorder p="sm">
							<Group justify="space-between">
								<Text size="sm" c="dimmed">
									{t("recharge.expectedQuota")}
								</Text>
								<Text fw={600}>
									{expectedQuota.toFixed(4)} {config.unitName}
								</Text>
							</Group>
						</Paper>
						<Button
							onClick={() => createOrder.mutate()}
							loading={createOrder.isPending}
							disabled={amountInvalid || !paymentProvider}
						>
							{t("recharge.createOrder")}
						</Button>
					</Stack>
				)}

				{order && (
					<Stack align="center">
						<Group gap="xs">
							<Text size="sm" c="dimmed">
								{t("recharge.status")}
							</Text>
							<Badge
								color={
									order.status === "paid" ? "green" : order.status === "pending" ? "yellow" : "red"
								}
							>
								{t(`recharge.status_${order.status}`, { defaultValue: order.status })}
							</Badge>
						</Group>
						{order.status === "pending" && payUrl && (
							<>
								{isEmbeddableImageUrl(payUrl) ? (
									<Box component="img" src={payUrl} alt="payment" maw={260} mah={260} />
								) : qrDataUrl ? (
									<Box component="img" src={qrDataUrl} alt="payment qr" maw={260} mah={260} />
								) : (
									<Box
										component="iframe"
										src={payUrl}
										title="payment"
										w="100%"
										h={360}
										style={{ border: "1px solid var(--mantine-color-gray-3)", borderRadius: 8 }}
									/>
								)}
								<Anchor href={payUrl} target="_blank" size="sm" inline>
									<Group gap={4}>
										<IconExternalLink size={14} />
										<Text size="sm">{t("recharge.openPaymentPage")}</Text>
									</Group>
								</Anchor>
								<Group gap="xs">
									<Loader size="xs" />
									<Text size="xs" c="dimmed">
										{t("recharge.waitingPayment")}
									</Text>
								</Group>
							</>
						)}
						<Group gap="lg">
							<Text size="sm">
								{t("recharge.orderAmount", { amount: parseAmount(order.amount).toFixed(2) })}
							</Text>
							<Text size="sm">
								{t("recharge.quotaAmount", {
									amount: parseAmount(order.quota_amount).toFixed(4),
									unit: config?.unitName ?? t("recharge.balanceUnit"),
								})}
							</Text>
						</Group>
						{order.status !== "pending" && order.status !== "paid" && (
							<Button
								variant="light"
								onClick={async () => {
									if (!providerId) return;
									const data = await api.nugRepayBillingOrder(providerId, order.id);
									setOrder(data.order);
								}}
							>
								{t("recharge.repay")}
							</Button>
						)}
					</Stack>
				)}
			</Stack>
		</Modal>
	);
}
