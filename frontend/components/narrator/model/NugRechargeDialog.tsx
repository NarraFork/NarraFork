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
import { isNugPaymentContext, type NugPaymentIntent } from "@shared/nug-payment";
import { IconCheck, IconExternalLink } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, api } from "../../../lib/api";
import { getAuthSnapshot, subscribeAuth } from "../../../lib/api/client";
import { createQrDataUrl } from "../../../lib/qr";
import type { PaymentRequiredInfo } from "../useNarratorPanelWS";

interface NugBillingOrder {
	id: string;
	binding: string;
	amount: string;
	quota_amount: string;
	provider: string;
	channel?: string;
	status: string;
	pay_url?: string;
	paid_at?: string;
	created_at: string;
}

interface ScopedNugOrder {
	scope: string;
	order: NugBillingOrder;
}
interface NugCreateSubmission {
	scope: string;
	authGeneration: number;
	providerId: string;
	intent: NugPaymentIntent;
	body: Parameters<typeof api.nugCreateBillingOrder>[1];
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

const MAX_NUG_FAILED_POLLS = 6;
const MIN_NUG_POLL_MS = 3000;
const MAX_NUG_POLL_MS = 30_000;

function terminalNugPaymentError(error: unknown): boolean {
	return (
		error instanceof ApiError &&
		(error.data?.code === "NUG_PAYMENT_CONTEXT" ||
			error.data?.code === "NUG_PAYMENT_RESPONSE" ||
			[401, 403, 404, 409, 410].includes(error.status))
	);
}

function nugPollDelay(value: number | undefined): number {
	return Number.isFinite(value)
		? Math.max(MIN_NUG_POLL_MS, Math.min(value ?? MIN_NUG_POLL_MS, MAX_NUG_POLL_MS))
		: MIN_NUG_POLL_MS;
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
	const auth = useSyncExternalStore(subscribeAuth, getAuthSnapshot, getAuthSnapshot);
	const authGeneration = auth.generation;
	const [amount, setAmount] = useState<number | string>(10);
	const [paymentProvider, setPaymentProvider] = useState("");
	const [channel, setChannel] = useState("alipay");
	const [scopedOrder, setScopedOrder] = useState<ScopedNugOrder | null>(null);
	const resumedRef = useRef<string | null>(null);
	const paymentIntent: NugPaymentIntent = paymentRequired
		? { mode: "request", narratorId, paymentContext: paymentRequired.paymentContext ?? "" }
		: { mode: "standalone" };
	const paymentScope = JSON.stringify([
		authGeneration,
		narratorId,
		providerId,
		paymentIntent.mode,
		paymentRequired?.paymentContext ?? null,
	]);
	const scopeRef = useRef<string | null>(null);
	// 在 render 层立即隔离旧订单，不能等 effect 才隐藏另一个钱包的二维码。
	scopeRef.current = opened ? paymentScope : null;
	const order = opened && scopedOrder?.scope === paymentScope ? scopedOrder.order : null;
	const isCurrentScope = useCallback((scope: string, generation: number) => {
		const current = getAuthSnapshot();
		return scopeRef.current === scope && current.generation === generation && current.hasToken;
	}, []);
	useEffect(() => {
		scopeRef.current = opened ? paymentScope : null;
		return () => {
			if (scopeRef.current === paymentScope) scopeRef.current = null;
		};
	}, [opened, paymentScope]);
	const missingRequestContext =
		!!paymentRequired && !isNugPaymentContext(paymentRequired.paymentContext);
	const requireRequestContext = () => {
		if (missingRequestContext)
			throw new ApiError("失败请求缺少有效的充值上下文，请重新发起该请求", 409, {
				code: "NUG_PAYMENT_CONTEXT",
			});
	};

	const configQuery = useQuery({
		queryKey: ["nug", "billing", "config", paymentScope],
		queryFn: () => {
			requireRequestContext();
			return api.nugGetBillingConfig(providerId ?? "", paymentIntent);
		},
		retry: (attempt, error) => !terminalNugPaymentError(error) && attempt < 2,
		enabled: opened && !!providerId && auth.hasToken,
	});
	const config = configQuery.data;
	const selectedPaymentProvider = config?.providers.some(
		(provider) => provider.name === paymentProvider,
	)
		? paymentProvider
		: (config?.providers[0]?.name ?? "");

	useEffect(() => {
		if (!opened) return;
		resumedRef.current = null;
		setScopedOrder(null);
	}, [opened]);

	useEffect(() => {
		if (!config) return;
		if (
			!config.providers.some((provider) => provider.name === paymentProvider) &&
			config.providers[0]?.name
		) {
			setPaymentProvider(config.providers[0].name);
		}
		if (config.orderMinAmount > 0 && parseAmount(amount) < config.orderMinAmount) {
			setAmount(config.orderMinAmount);
		}
	}, [config, paymentProvider, amount]);

	const createOrder = useMutation({
		mutationFn: async (input: NugCreateSubmission) => {
			if (!isCurrentScope(input.scope, input.authGeneration))
				throw new ApiError("充值范围已变化", 409, { code: "NUG_PAYMENT_CONTEXT" });
			if (!input.providerId || !input.body.provider)
				throw new Error(t("recharge.providerNotReady"));
			if (input.intent.mode === "request" && !isNugPaymentContext(input.intent.paymentContext))
				throw new ApiError("失败请求缺少有效的充值上下文，请重新发起该请求", 409, {
					code: "NUG_PAYMENT_CONTEXT",
				});
			return api.nugCreateBillingOrder(input.providerId, input.body, input.intent);
		},
		onSuccess: (data, input) => {
			if (isCurrentScope(input.scope, input.authGeneration))
				setScopedOrder({ scope: input.scope, order: data.order });
		},
		onError: (err, input) => {
			if (!isCurrentScope(input.scope, input.authGeneration)) return;
			notifications.show({
				color: "red",
				title: t("recharge.createOrderFailed"),
				message: err instanceof Error ? err.message : "",
			});
		},
	});

	const orderQuery = useQuery({
		queryKey: ["nug", "billing", "order", paymentScope, order?.id, order?.binding],
		queryFn: () => api.nugGetBillingOrder(providerId ?? "", order?.id ?? "", order?.binding ?? ""),
		retry: (attempt, error) => !terminalNugPaymentError(error) && attempt < 2,
		retryDelay: (attempt) => nugPollDelay(MIN_NUG_POLL_MS * 2 ** attempt),
		retryOnMount: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		enabled: (query) =>
			opened &&
			!!providerId &&
			!!order?.id &&
			order.status === "pending" &&
			!terminalNugPaymentError(query.state.error),
		refetchInterval: (query) => {
			const error = query.state.error;
			if (
				terminalNugPaymentError(error) ||
				(error && query.state.errorUpdateCount >= MAX_NUG_FAILED_POLLS)
			)
				return false;
			const status = query.state.data?.order.status ?? order?.status;
			if (status !== "pending") return false;
			return error
				? nugPollDelay(MIN_NUG_POLL_MS * 2 ** query.state.errorUpdateCount)
				: nugPollDelay(config?.pollIntervalMs);
		},
	});
	const orderContextInvalid = terminalNugPaymentError(orderQuery.error);

	useEffect(() => {
		const received = orderQuery.data?.order;
		if (!received || !isCurrentScope(paymentScope, authGeneration)) return;
		setScopedOrder((current) =>
			current?.scope === paymentScope &&
			current.order.id === received.id &&
			current.order.binding === received.binding &&
			current.order !== received
				? { scope: paymentScope, order: received }
				: current,
		);
	}, [orderQuery.data, paymentScope, authGeneration, isCurrentScope]);

	useEffect(() => {
		if (
			!providerId ||
			!order ||
			order.status !== "paid" ||
			!isCurrentScope(paymentScope, authGeneration)
		)
			return;
		const resumeScope = JSON.stringify([paymentScope, order.binding]);
		if (resumedRef.current === resumeScope) return;
		resumedRef.current = resumeScope;
		void (async () => {
			try {
				const quota = await api.nugGetQuota(providerId, undefined, {
					orderId: order.id,
					binding: order.binding,
				});
				if (!isCurrentScope(paymentScope, authGeneration)) return;
				if (quota.paymentCredentialIsPrimary !== false) {
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
				}
				qc.invalidateQueries({ queryKey: ["nug", "quotas"] });
				qc.invalidateQueries({ queryKey: ["nug", "quota", providerId] });
				qc.invalidateQueries({ queryKey: ["settings"] });
				qc.invalidateQueries({ queryKey: ["admin", "settings"] });
				notifications.show({
					color: "green",
					title: t("recharge.success"),
					message: t("recharge.currentBalance", { balance: quota.balance }),
					icon: <IconCheck size={16} />,
				});
				if (!isCurrentScope(paymentScope, authGeneration)) return;
				if (paymentRequired) {
					if (paymentRequired.resumeAction === "continue") {
						await api.continueNarrator(narratorId);
					} else {
						await api.retryLastMessage(narratorId);
					}
					if (!isCurrentScope(paymentScope, authGeneration)) return;
					onPaymentRequiredChange(null);
				}
				if (isCurrentScope(paymentScope, authGeneration)) onClose();
			} catch (err) {
				if (!isCurrentScope(paymentScope, authGeneration)) return;
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
		paymentScope,
		authGeneration,
		isCurrentScope,
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
								value={selectedPaymentProvider}
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
							onClick={() =>
								createOrder.mutate({
									scope: paymentScope,
									authGeneration,
									providerId: providerId ?? "",
									intent: paymentIntent,
									body: { amount: amountNumber, provider: selectedPaymentProvider, channel },
								})
							}
							loading={createOrder.isPending && createOrder.variables?.scope === paymentScope}
							disabled={amountInvalid || !selectedPaymentProvider}
						>
							{t("recharge.createOrder")}
						</Button>
					</Stack>
				)}

				{orderQuery.error && (
					<Alert color="red">
						{orderQuery.error.message}
						{!orderContextInvalid && (
							<Button
								variant="subtle"
								loading={orderQuery.isFetching}
								onClick={() => void orderQuery.refetch()}
							>
								{t("retry")}
							</Button>
						)}
					</Alert>
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
						{order.status === "pending" && payUrl && !orderContextInvalid && (
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
									if (!providerId || !isCurrentScope(paymentScope, authGeneration)) return;
									try {
										const data = await api.nugRepayBillingOrder(
											providerId,
											order.id,
											order.binding,
										);
										if (isCurrentScope(paymentScope, authGeneration))
											setScopedOrder({ scope: paymentScope, order: data.order });
									} catch (err) {
										if (!isCurrentScope(paymentScope, authGeneration)) return;
										notifications.show({
											color: "red",
											title: t("recharge.createOrderFailed"),
											message: err instanceof Error ? err.message : "",
										});
									}
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
