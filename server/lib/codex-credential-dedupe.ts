/** Pure Codex identity keys shared by the manager and service templates. */
import { createHash } from "node:crypto";

export interface CodexCredentialDedupeInput {
	refreshToken?: string;
	accessToken?: string;
	accountId?: string;
	email?: string;
	sub?: string;
	agentRuntimeId?: string;
}

const normalized = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() ? value.trim() : undefined;
const sha256Hex = (input: string): string => createHash("sha256").update(input).digest("hex");

/** Keep the manager's ordering and normalization, including untrimmed account claims. */
export function getCodexCredentialDedupeKeys(cred: CodexCredentialDedupeInput): string[] {
	const keys: string[] = [];
	const refreshToken = normalized(cred.refreshToken);
	const accessToken = normalized(cred.accessToken);
	const agentRuntimeId = normalized(cred.agentRuntimeId);
	if (agentRuntimeId) keys.push(`agent:${agentRuntimeId}`);
	if (refreshToken) keys.push(`rt:${sha256Hex(refreshToken)}`);
	if (cred.sub) keys.push(`sub:${cred.sub}`);
	if (cred.accountId && cred.email) keys.push(`account-email:${cred.accountId}:${cred.email}`);
	if (accessToken) keys.push(`at:${sha256Hex(accessToken)}`);
	return keys;
}
