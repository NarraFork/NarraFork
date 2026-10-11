import type { MiddlewareHandler } from "hono";
import {
	captureRemoteRecoveryAuthProvenance,
	withRemoteEditorHttpSessionOrigin,
	withRemoteRecoveryAuthProvenance,
} from "../services/remote-history-recovery-auth";

/** Capture only the discriminated authentication established by auth middleware.
 * A legacy bare user ID is not evidence of session rather than OAuth authority.
 * ACL and source authorization still run in the original handlers; this middleware
 * never grants permission, stores bearer tokens, or repairs old operation provenance. */
export const remoteRecoveryProvenance: MiddlewareHandler = async (c, next) => {
	const auth = c.get("auth");
	if (!auth || (auth.type !== "session" && auth.type !== "oauth")) return next();
	return withRemoteRecoveryAuthProvenance(captureRemoteRecoveryAuthProvenance(auth), next);
};
/** Only editor HTTP handlers receive this request-local session currency. Revert,
 * agent and attachment routes keep their existing provenance without an editor ref. */
export const remoteEditorSessionProvenance: MiddlewareHandler = (c, next) =>
	withRemoteEditorHttpSessionOrigin(c, async () => remoteRecoveryProvenance(c, next));
