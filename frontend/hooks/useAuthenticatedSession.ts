import { isSessionInvalidResponse } from "@shared/session-auth";
import { useSyncExternalStore } from "react";
import { type ApiError, getToken } from "../lib/api";
import { onTokenChange } from "../lib/api/client";
import { useCurrentUser } from "./useAuth";

/** Authentication policy shared by the full application and standalone windows. */
export function useAuthenticatedSession() {
	// Re-render when the token is cleared: the reset that follows drops the auth query
	// without notifying its observer, so a cached-identity page would never redirect.
	const token = useSyncExternalStore(onTokenChange, getToken, getToken);
	const query = useCurrentUser();
	const error = query.error as ApiError | null;
	const sessionLost =
		query.isError && error?.status === 401 && isSessionInvalidResponse(error.data ?? null);
	return { ...query, hasToken: !!token, sessionLost };
}
