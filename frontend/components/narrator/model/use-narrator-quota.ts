import { REMOTE_BUILD } from "@frontend/lib/build-target";
import { useDisclosure } from "@mantine/hooks";
import { isNugPaymentContext } from "@shared/nug-payment";
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
			...(isNugPaymentContext(parsed.paymentContext)
				? { paymentContext: parsed.paymentContext }
				: {}),
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
	/** Bar-text quota balance from the WS layer (may be a NUG numeric string). */
	quotaBalance: string | null;
	/** Details-popover quota text from the WS layer. */
	detailedQuotaBalance: string | null;
	paymentRequired: PaymentRequiredInfo | null;
	setPaymentRequired: (info: PaymentRequiredInfo | null) => void;
	narratorSubstatus: string[];
	narratorErrorMessage: string | null | undefined;
}

/**
 * Quota display + NUG recharge derivations, lifted out of NarratorPanel. Consumes
 * the WS-layer quota outputs (quotaBalance/detailedQuotaBalance/paymentRequired)
 * plus the resolved NUG provider, and produces the status bar's recharge/detail
 * flags, the recharge dialog disclosure, and the effects that (a) reconstruct a
 * persisted `payment_required` marker and (b) auto-open the dialog when payment is
 * required.
 */
export function useNarratorQuota({
	nugProviderInfo,
	quotaBalance,
	detailedQuotaBalance,
	paymentRequired,
	setPaymentRequired,
	narratorSubstatus,
	narratorErrorMessage,
}: UseNarratorQuotaOptions) {
	const nugBalanceNumber =
		nugProviderInfo?.providerId && quotaBalance != null ? Number(quotaBalance) : Number.NaN;
	const shouldShowNugRechargeButton = Boolean(
		!REMOTE_BUILD &&
			nugProviderInfo?.providerId &&
			(paymentRequired || !Number.isFinite(nugBalanceNumber) || nugBalanceNumber <= 0),
	);
	const shouldShowNugRechargeInQuotaDetails = Boolean(
		nugProviderInfo?.providerId && Number.isFinite(nugBalanceNumber) && nugBalanceNumber > 0,
	);
	const quotaDetailsText = detailedQuotaBalance?.trim() ? detailedQuotaBalance : null;
	const hasQuotaDetailsPopover = Boolean(quotaDetailsText || shouldShowNugRechargeInQuotaDetails);

	useEffect(() => {
		if (paymentRequired) return;
		if (!narratorSubstatus.includes("payment_required")) return;
		const persisted = parsePersistedPaymentRequired(narratorErrorMessage);
		const providerId = persisted?.providerId ?? nugProviderInfo?.providerId;
		if (!providerId) return;
		setPaymentRequired({
			providerId,
			providerPrefix: persisted?.providerPrefix ?? nugProviderInfo?.providerPrefix,
			...(persisted?.paymentContext ? { paymentContext: persisted.paymentContext } : {}),
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
		quotaDetailsText,
		hasQuotaDetailsPopover,
		shouldShowNugRechargeButton,
		shouldShowNugRechargeInQuotaDetails,
		nugRechargeOpened,
		openNugRecharge,
		closeNugRecharge,
	};
}
