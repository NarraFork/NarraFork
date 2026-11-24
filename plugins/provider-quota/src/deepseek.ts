import { boundedJson, type QuotaData, record } from "./protocol";

export interface DeepSeekBalancePayload {
	isAvailable: boolean;
	balanceInfos: Array<{
		currency: string;
		totalBalance: string;
		grantedBalance: string;
		toppedUpBalance: string;
	}>;
}
export const DEEPSEEK_BALANCE_PATH = "/user/balance";
export function isDeepSeekCustomApiProvider(config: {
	baseUrl?: string;
	disabled?: boolean;
}): boolean {
	if (config.disabled || !config.baseUrl) return false;
	try {
		const url = new URL(config.baseUrl);
		return (
			url.protocol === "https:" &&
			url.hostname === "api.deepseek.com" &&
			!url.port &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			["/", "/v1", "/anthropic"].includes(url.pathname.replace(/\/$/, "") || "/")
		);
	} catch {
		return false;
	}
}
export function parseDeepSeekBalanceResponse(body: unknown): DeepSeekBalancePayload {
	if (
		!record(body) ||
		!boundedJson(body) ||
		typeof body.is_available !== "boolean" ||
		!Array.isArray(body.balance_infos) ||
		body.balance_infos.length > 10
	)
		throw new Error("Invalid balance response");
	const balanceInfos = body.balance_infos.map((item: unknown) => {
		if (
			!record(item) ||
			(item.currency !== "CNY" && item.currency !== "USD") ||
			![item.total_balance, item.granted_balance, item.topped_up_balance].every(
				(amount) =>
					typeof amount === "string" && amount.length <= 256 && /^-?\d+(?:\.\d+)?$/.test(amount),
			)
		)
			throw new Error("Invalid balance response");
		return {
			currency: item.currency as string,
			totalBalance: item.total_balance as string,
			grantedBalance: item.granted_balance as string,
			toppedUpBalance: item.topped_up_balance as string,
		};
	});
	return { isAvailable: body.is_available, balanceInfos };
}

export function deepSeekQuotaData(payload: DeepSeekBalancePayload): QuotaData | null {
	const amounts: QuotaData["amounts"] = [];
	const currencies = new Set<string>();
	for (const info of payload.balanceInfos) {
		if ((info.currency !== "CNY" && info.currency !== "USD") || currencies.has(info.currency)) {
			return null;
		}
		currencies.add(info.currency);
		for (const [id, label, raw] of [
			["balance", "Total balance", info.totalBalance],
			["granted", "Granted balance", info.grantedBalance],
			["topped-up", "Topped-up balance", info.toppedUpBalance],
		]) {
			const remaining = Number(raw);
			if (
				raw.length > 64 ||
				!/^-?\d+(?:\.\d+)?$/.test(raw) ||
				!Number.isFinite(remaining) ||
				Math.abs(remaining) > Number.MAX_SAFE_INTEGER
			)
				return null;
			amounts.push({
				id: `${id}:${info.currency}`,
				label,
				display: id === "balance" ? "summary" : "detail",
				quota: id === "balance" ? "alternative" : "none",
				unit: info.currency,
				remaining,
				remainingText: raw,
			});
		}
	}
	return { amounts, windows: [], available: payload.isAvailable };
}
