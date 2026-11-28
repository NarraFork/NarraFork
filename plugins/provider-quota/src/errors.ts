import type { QuotaErrorCode } from "./protocol";

export type BalanceFailureKind =
	| "unsupported"
	| "transient"
	| "auth"
	| "invalid_response"
	| "invalid_configuration";
const failureCodes: Record<BalanceFailureKind, QuotaErrorCode> = {
	unsupported: "request_failed",
	transient: "request_failed",
	auth: "auth_failed",
	invalid_response: "invalid_response",
	invalid_configuration: "invalid_configuration",
};
export class BalanceProbeRequestError extends Error {
	readonly code: QuotaErrorCode;
	constructor(
		readonly kind: BalanceFailureKind,
		code?: QuotaErrorCode,
	) {
		super(kind === "unsupported" ? "Balance protocol unsupported" : "Balance request failed");
		this.code = code ?? failureCodes[kind];
		this.name = "BalanceProbeRequestError";
	}
	get isTransient(): boolean {
		return this.kind === "transient";
	}
}

export class QuotaQueryError extends Error {
	constructor(readonly code: QuotaErrorCode) {
		super(code);
		this.name = "QuotaQueryError";
	}
}
