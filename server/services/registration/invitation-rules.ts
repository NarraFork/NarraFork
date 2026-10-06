/**
 * When an invitation code may be redeemed — as a pure decision over plain data.
 *
 * These are the rules, not a query: which failure wins, in what order, and with which
 * error identity. They lived inline in the SQLite lookup, which made them look like a
 * property of the `registration_codes` table when in fact they are a property of the
 * feature. A second backend storing invitations differently must still reject a revoked
 * code with `CODE_REVOKED` and a wrong-username code with `CODE_USERNAME_MISMATCH`, so it
 * reuses this function and supplies its own row-to-`InvitationState` mapping.
 *
 * ORDER IS DELIBERATE. Revoked is reported before used, and both before expired, so the
 * message names the administrative decision (someone cancelled this) rather than a
 * consequence that happened to also become true while the code sat around. Codes have a
 * mandatory expiry, so *every* revoked code eventually expires too; checking expiry first
 * would silently rewrite the explanation after a week.
 *
 * This module must stay free of any storage import — it takes data and returns data.
 */
import { AppError } from "@server/lib/errors";
import type { AccountRole } from "./account-store";

/** An invitation's persisted state, mapped out of whatever table holds it. */
export interface InvitationState {
	id: string;
	/** Role this invitation grants to the account it creates. */
	role: AccountRole;
	/** When set, only this exact username may redeem it. */
	boundUsername: string | null;
	/** ISO timestamp; a code is unusable from this instant on. */
	expiresAt: string;
	usedAt: string | null;
	revokedAt: string | null;
}

/** What a redemption needs to know once the invitation is accepted. */
export interface RedeemableInvitation {
	id: string;
	role: AccountRole;
}

/**
 * Accept the invitation or throw the reason it cannot be used.
 *
 * `state` is null when the lookup found nothing, which is reported as `CODE_INVALID` —
 * the same answer as a malformed code, so a caller cannot distinguish "no such code" from
 * "code exists but is not yours" by probing.
 */
export function assertInvitationRedeemable(
	state: InvitationState | null,
	params: { username: string; nowIso: string },
): RedeemableInvitation {
	if (!state) {
		throw new AppError("Invalid registration code", 400, "CODE_INVALID");
	}
	if (state.revokedAt) {
		throw new AppError("This registration code was revoked", 400, "CODE_REVOKED");
	}
	if (state.usedAt) {
		throw new AppError("This registration code has already been used", 409, "CODE_ALREADY_USED");
	}
	if (Date.parse(state.expiresAt) <= Date.parse(params.nowIso)) {
		throw new AppError("This registration code has expired", 400, "CODE_EXPIRED");
	}
	if (state.boundUsername && state.boundUsername !== params.username) {
		throw new AppError(
			"This registration code was issued for a different username",
			400,
			"CODE_USERNAME_MISMATCH",
		);
	}
	return { id: state.id, role: state.role };
}
