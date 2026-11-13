import type { LoginSession } from "@frontend/lib/api/auth";
import { authenticateRemoteSession } from "./runtime";

/** Storage and query hydration are deliberately downstream of RTC admin auth. */
export async function establishRemoteSession(
	session: LoginSession,
	persist: (token: string) => void,
): Promise<void> {
	if (session.user.role !== "admin") throw new Error("REMOTE_ADMIN_REQUIRED");
	await authenticateRemoteSession(session.token);
	persist(session.token);
}
