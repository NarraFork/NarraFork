import { Alert, Anchor, Button, Group, Modal, NumberInput, Stack, Text } from "@mantine/core";
import {
	TOKENDANCE_ORIGIN,
	type TokenDancePaymentCreate,
	type TokenDancePaymentSession,
	type TokenDancePublicConnection,
} from "@shared/tokendance";
import { IconCircleCheck } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { formatTokenDanceMoney } from "../../hooks/useTokenDanceBalance";
import { api } from "../../lib/api";
import { createQrDataUrl } from "../../lib/qr";

export interface TokenDanceRechargeDialogProps {
	opened: boolean;
	generation: number;
	onClose: () => void;
	onPaid?: () => void;
	disabled?: boolean;
}

export function TokenDanceRechargeDialog(props: TokenDanceRechargeDialogProps) {
	return props.opened ? <OpenedTokenDanceRechargeDialog {...props} /> : null;
}

function OpenedTokenDanceRechargeDialog(props: TokenDanceRechargeDialogProps) {
	const { data: user } = useCurrentUser();
	const connection = useQuery({
		queryKey: ["tokendance", "connection", user?.id],
		queryFn: ({ signal }) => api.tokenDanceConnection({ signal }),
		enabled: props.opened && user?.role === "admin",
		staleTime: 0,
		refetchInterval: props.opened && user?.role === "admin" ? 30_000 : false,
		refetchIntervalInBackground: false,
		retry: false,
	});
	const settings = useQuery<{ tokendance?: TokenDancePublicConnection }>({
		queryKey: ["settings"],
		queryFn: ({ signal }) => api.getSettings({ signal }),
		enabled: false,
	});
	const cachedConnection = settings.data?.tokendance;
	const settingsMatch =
		!cachedConnection ||
		(cachedConnection.connected &&
			!cachedConnection.disabled &&
			cachedConnection.generation === props.generation);
	const allowed =
		props.opened &&
		!props.disabled &&
		settingsMatch &&
		user?.role === "admin" &&
		connection.data?.connected &&
		!connection.data.disabled &&
		connection.data.generation === props.generation &&
		!connection.isError;
	const actorIdentity = `${user?.id}:${props.generation}`;
	const billingInstance = connection.data?.billingInstance;
	const billingReady =
		typeof billingInstance === "string" && /^[a-f0-9]{32}$/.test(billingInstance);
	const settingsInstanceMismatch =
		cachedConnection?.billingInstance && cachedConnection.billingInstance !== billingInstance
			? cachedConnection.billingInstance
			: "";
	const identity = `${actorIdentity}:${billingInstance ?? "not-ready"}:${settingsInstanceMismatch}`;
	const previous = useRef<{ actorIdentity: string; billingInstance?: string }>({ actorIdentity });
	const previousSettingsInstance = useRef(cachedConnection?.billingInstance);
	const { t } = useTranslation("errors");
	useEffect(() => {
		if (
			props.opened &&
			(previous.current.actorIdentity !== actorIdentity ||
				(previous.current.billingInstance !== undefined &&
					previous.current.billingInstance !== billingInstance) ||
				(previousSettingsInstance.current !== undefined &&
					previousSettingsInstance.current !== cachedConnection?.billingInstance) ||
				(connection.isFetchedAfterMount && ((connection.data && !allowed) || connection.isError)))
		)
			props.onClose();
		previous.current = {
			actorIdentity,
			billingInstance: connection.isFetchedAfterMount ? billingInstance : undefined,
		};
		previousSettingsInstance.current = cachedConnection?.billingInstance;
	}, [
		actorIdentity,
		billingInstance,
		cachedConnection?.billingInstance,
		props.opened,
		props.onClose,
		allowed,
		connection.data,
		connection.isError,
		connection.isFetchedAfterMount,
	]);
	// A new opening waits for an actual connection read, never a cached process marker.
	if (!allowed || !connection.isFetchedAfterMount) return null;
	if (!billingReady)
		return (
			<Modal opened onClose={props.onClose} title={t("tokendanceRechargeTitle")} centered>
				<Stack>
					<Alert color="yellow">{t("tokendanceRechargeBackendNotReady")}</Alert>
					<Button variant="default" onClick={props.onClose}>
						{t("tokendanceRecoveryDismiss")}
					</Button>
				</Stack>
			</Modal>
		);
	return <RechargeContent key={identity} {...props} billingInstance={billingInstance} />;
}

function RechargeContent({
	generation,
	billingInstance,
	onClose,
	onPaid,
}: TokenDanceRechargeDialogProps & { billingInstance: string }) {
	const { t, i18n } = useTranslation("errors");
	const qc = useQueryClient();
	const [amount, setAmount] = useState<string | number>(10);
	const [session, setSession] = useState<TokenDancePaymentSession>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(false);
	const [balanceRefreshFailed, setBalanceRefreshFailed] = useState(false);
	const [finalCheckPending, setFinalCheckPending] = useState(false);
	const [paymentUnconfirmed, setPaymentUnconfirmed] = useState(false);
	const finalCheckStarted = useRef(false);
	const controller = useRef(new AbortController());
	const lock = useRef(false);
	const request = useRef<TokenDancePaymentCreate | undefined>(undefined);
	const paid = useRef(false);
	const paidCallback = useRef(onPaid);
	paidCallback.current = onPaid;
	useEffect(() => {
		// StrictMode replays mount effects; the replay must receive a live controller.
		if (controller.current.signal.aborted) controller.current = new AbortController();
		const active = controller.current;
		return () => active.abort();
	}, []);
	const close = () => {
		controller.current.abort();
		onClose();
	};
	const valid =
		typeof amount === "number" && Number.isInteger(amount) && amount >= 1 && amount <= 100_000;
	const accept = useCallback(
		(next: TokenDancePaymentSession) => {
			if (controller.current.signal.aborted || next.generation !== generation) return;
			setSession(next);
		},
		[generation],
	);
	const confirm = async () => {
		if (!valid || lock.current || session || controller.current.signal.aborted) return;
		lock.current = true;
		setBusy(true);
		setError(false);
		try {
			if (!request.current) {
				// getRandomValues also works on non-secure LAN HTTP; randomUUID does not.
				const bytes = crypto.getRandomValues(new Uint8Array(16));
				const requestId = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
				request.current = { amount: Number(amount), generation, billingInstance, requestId };
			}
			const result = await api.tokenDanceCreatePayment(request.current, {
				signal: controller.current.signal,
			});
			accept(result.session);
		} catch {
			if (!controller.current.signal.aborted) setError(true);
		} finally {
			lock.current = false;
			if (!controller.current.signal.aborted) setBusy(false);
		}
	};
	const sessionId = session?.id;
	const sessionStatus = session?.status;
	const sessionRef = useRef(session);
	sessionRef.current = session;
	useEffect(() => {
		const currentSession = sessionRef.current;
		if (!currentSession || !sessionId || sessionStatus !== "pending" || finalCheckStarted.current)
			return;
		// Pending snapshots cannot restart this effect or cancel the one final check.
		const sessionExpiresAt = currentSession.expiresAt;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let expiry: ReturnType<typeof setTimeout> | undefined;
		let finalTimeout: ReturnType<typeof setTimeout> | undefined;
		let disposed = false;
		const pollController = new AbortController();
		const finalController = new AbortController();
		const signal = AbortSignal.any([controller.current.signal, pollController.signal]);
		const finishExpired = (unconfirmed: boolean) => {
			if (disposed || controller.current.signal.aborted) return;
			setFinalCheckPending(false);
			setPaymentUnconfirmed(unconfirmed);
			setSession({ ...currentSession, status: "expired" });
		};
		const finalCheck = () => {
			if (disposed || controller.current.signal.aborted || finalCheckStarted.current) return;
			finalCheckStarted.current = true;
			clearTimeout(timer);
			clearTimeout(expiry);
			pollController.abort();
			setFinalCheckPending(true);
			const finalSignal = AbortSignal.any([controller.current.signal, finalController.signal]);
			// Abort AND complete the local UI even if a transport ignores cancellation.
			finalTimeout = setTimeout(() => {
				finalController.abort();
				finishExpired(true);
			}, 30_000);
			void (async () => {
				try {
					const result = await api.tokenDancePaymentSession(sessionId, { signal: finalSignal });
					if (disposed || finalSignal.aborted) return;
					clearTimeout(finalTimeout);
					if (result.session.id !== sessionId || result.session.generation !== generation) {
						finishExpired(true);
						return;
					}
					setFinalCheckPending(false);
					setError(false);
					accept(
						result.session.status === "pending"
							? { ...result.session, status: "expired" }
							: result.session,
					);
				} catch {
					if (!disposed && !finalSignal.aborted) finishExpired(true);
				} finally {
					clearTimeout(finalTimeout);
				}
			})();
		};
		const poll = async () => {
			if (signal.aborted) return;
			if (Date.now() >= sessionExpiresAt) {
				finalCheck();
				return;
			}
			try {
				const result = await api.tokenDancePaymentSession(sessionId, { signal });
				if (!signal.aborted && result.session.generation !== generation) {
					pollController.abort();
					setError(true);
					return;
				}
				if (
					!signal.aborted &&
					result.session.id === sessionId &&
					result.session.generation === generation
				) {
					setError(false);
					accept(result.session);
					if (result.session.status !== "pending") return;
				}
			} catch {
				if (!signal.aborted) setError(true);
			}
			if (!signal.aborted) timer = setTimeout(poll, 3000);
		};
		const remaining = sessionExpiresAt - Date.now();
		if (remaining <= 0) finalCheck();
		else {
			expiry = setTimeout(finalCheck, remaining);
			timer = setTimeout(poll, 3000);
		}
		return () => {
			disposed = true;
			clearTimeout(timer);
			clearTimeout(expiry);
			clearTimeout(finalTimeout);
			pollController.abort();
			finalController.abort();
		};
	}, [sessionId, sessionStatus, generation, accept]);
	useEffect(() => {
		if (session?.status !== "paid" || paid.current || controller.current.signal.aborted) return;
		paid.current = true;
		void api
			.tokenDanceRefreshBalance({ signal: controller.current.signal })
			.then((balance) => {
				if (!controller.current.signal.aborted && balance.generation === generation) {
					qc.setQueryData(["tokendance", "balance", generation], balance);
					if (balance.hasError) setBalanceRefreshFailed(true);
				}
			})
			.catch(() => {
				if (!controller.current.signal.aborted) setBalanceRefreshFailed(true);
			});
		paidCallback.current?.();
	}, [session, generation, qc]);
	const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
	const qr = useMemo(() => {
		if (mobile || !session || session.status !== "pending") return null;
		if (session.paymentUrl.length > 2048) return null;
		try {
			return createQrDataUrl(session.paymentUrl);
		} catch {
			return null;
		}
	}, [session, mobile]);
	return (
		<Modal opened onClose={close} title={t("tokendanceRechargeTitle")} centered>
			<Stack>
				{session?.status !== "paid" && <Text size="sm">{t("tokendanceRechargeNotice")}</Text>}
				{error && session?.status !== "paid" && (
					<Alert color="red">{t("tokendanceRechargeFailed")}</Alert>
				)}
				{!session ? (
					<>
						<NumberInput
							label={t("tokendanceRechargeAmount")}
							value={amount}
							min={1}
							max={100000}
							disabled={busy || !!request.current}
							onChange={setAmount}
						/>
						{!valid && <Text c="red">{t("tokendanceRechargeInvalid")}</Text>}
						<Button disabled={!valid || busy} loading={busy} onClick={() => void confirm()}>
							{t("tokendanceRechargeConfirm")}
						</Button>
					</>
				) : (
					<>
						{session.status === "paid" ? (
							<Alert
								color="green"
								icon={<IconCircleCheck size={24} />}
								title={t("tokendancePayment_paid")}
							>
								<Text>
									{t("tokendanceRechargeSuccess", {
										amount: formatTokenDanceMoney(session.amount * 1_000_000, i18n.language),
									})}
								</Text>
							</Alert>
						) : paymentUnconfirmed ? (
							<Alert color="yellow">
								<Text>{t("tokendancePaymentUnconfirmed")}</Text>
								<Anchor href={`${TOKENDANCE_ORIGIN}/`} target="_blank" rel="noopener noreferrer">
									{t("tokendanceRecoveryOpenWebsite")}
								</Anchor>
							</Alert>
						) : (
							<Text>
								{finalCheckPending
									? t("tokendancePaymentFinalCheck")
									: t(`tokendancePayment_${session.status}`)}
							</Text>
						)}
						{session.status === "pending" &&
							!finalCheckPending &&
							(mobile ? (
								session.alipayUrl ? (
									<Anchor href={session.alipayUrl} target="_blank" rel="noopener noreferrer">
										{t("tokendanceRechargeAlipay")}
									</Anchor>
								) : (
									<Text>{t("tokendanceRechargeDesktop")}</Text>
								)
							) : qr ? (
								<img src={qr} alt={t("tokendanceRechargeScan")} width={240} height={240} />
							) : (
								<Stack gap="xs">
									<Text>{t("tokendanceRechargeQrUnavailable")}</Text>
									<Anchor href={`${TOKENDANCE_ORIGIN}/`} target="_blank" rel="noopener noreferrer">
										{t("tokendanceRecoveryOpenWebsite")}
									</Anchor>
								</Stack>
							))}
					</>
				)}
				{session?.status === "paid" && balanceRefreshFailed && (
					<Alert color="yellow">{t("tokendanceRechargeBalanceDelayed")}</Alert>
				)}
				<Group justify="flex-end">
					<Button variant={session?.status === "paid" ? "filled" : "default"} onClick={close}>
						{t(session?.status === "paid" ? "tokendanceRechargeDone" : "tokendanceRecoveryDismiss")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
