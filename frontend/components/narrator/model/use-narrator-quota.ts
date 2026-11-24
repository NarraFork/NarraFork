import { REMOTE_BUILD } from "@frontend/lib/build-target";
import { useDisclosure } from "@mantine/hooks";
import type { PublicQuotaSnapshot } from "@shared/quota-snapshot";
import { useEffect } from "react";
import type { PaymentRequiredInfo } from "../useNarratorPanelWS";
import type { NugProviderInfo } from "./use-nug-quota";

function parsePersistedPaymentRequired(value: unknown): Partial<PaymentRequiredInfo> | null {
	if (typeof value !== "string" || !value.trim()) return null;
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		if (parsed.type !== "payment_required") return null;
		const resumeAction = parsed.resumeAction === "continue" ? "continue" : "retry";
		const balance = typeof parsed.balance === "number" ? parsed.balance : undefined;
		const required = typeof parsed.required === "number" ? parsed.required : undefined;
		return {
			providerId: typeof parsed.providerId === "string" ? parsed.providerId : undefined,
			providerPrefix: typeof parsed.providerPrefix === "string" ? parsed.providerPrefix : undefined,
			balance,
			required,
			resumeAction,
		};
	} catch {
		return null;
	}
}

export interface UseNarratorQuotaOptions {
	nugProviderInfo: NugProviderInfo | null;
	/** Public snapshot for this recharge provider, never a formatted display string. */
	snapshot: PublicQuotaSnapshot | null | undefined;
	paymentRequired: PaymentRequiredInfo | null;
	setPaymentRequired: (info: PaymentRequiredInfo | null) => void;
	narratorSubstatus: string[];
	narratorErrorMessage: string | null | undefined;
}

/** Recharge derivations and payment-required recovery; display reads shared snapshots. */
export function useNarratorQuota({
	nugProviderInfo,
	snapshot,
	paymentRequired,
	setPaymentRequired,
	narratorSubstatus,
	narratorErrorMessage,
}: UseNarratorQuotaOptions) {
	const nugBalance = snapshot?.balances[0];
	const nugBalanceNumber = nugBalance?.unlimited
		? Number.POSITIVE_INFINITY
		: (nugBalance?.remaining ?? Number.NaN);
	const balanceKnown = !Number.isNaN(nugBalanceNumber);
	const shouldShowNugRechargeButton = Boolean(
		!REMOTE_BUILD &&
			nugProviderInfo?.providerId &&
			(paymentRequired || !balanceKnown || nugBalanceNumber <= 0),
	);
	const shouldShowNugRechargeInQuotaDetails = Boolean(
		!REMOTE_BUILD && nugProviderInfo?.providerId && balanceKnown && nugBalanceNumber > 0,
	);

	useEffect(() => {
		if (paymentRequired) return;
		if (!narratorSubstatus.includes("payment_required")) return;
		const persisted = parsePersistedPaymentRequired(narratorErrorMessage);
		const providerId = nugProviderInfo?.providerId ?? persisted?.providerId;
		if (!providerId) return;
		setPaymentRequired({
			providerId,
			providerPrefix: nugProviderInfo?.providerPrefix ?? persisted?.providerPrefix,
			balance: persisted?.balance,
			required: persisted?.required,
			resumeAction: persisted?.resumeAction ?? "retry",
		});
	}, [
		narratorErrorMessage,
		narratorSubstatus,
		nugProviderInfo?.providerId,
		nugProviderInfo?.providerPrefix,
		paymentRequired,
		setPaymentRequired,
	]);

	const [nugRechargeOpened, { open: openNugRecharge, close: closeNugRecharge }] =
		useDisclosure(false);
	useEffect(() => {
		if (!REMOTE_BUILD && paymentRequired) openNugRecharge();
	}, [openNugRecharge, paymentRequired]);

	return {
		shouldShowNugRechargeButton,
		shouldShowNugRechargeInQuotaDetails,
		nugRechargeOpened,
		openNugRecharge,
		closeNugRecharge,
	};
}
