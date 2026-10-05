import { isSessionInvalidResponse } from "@shared/session-auth";
import { type ApiError, getToken } from "../lib/api";
import { useCurrentUser } from "./useAuth";

/** Authentication policy shared by the full application and standalone windows. */
export function useAuthenticatedSession() {
	const query = useCurrentUser();
	const error = query.error as ApiError | null;
	const sessionLost =
		query.isError && error?.status === 401 && isSessionInvalidResponse(error.data ?? null);
	return { ...query, hasToken: !!getToken(), sessionLost };
}
