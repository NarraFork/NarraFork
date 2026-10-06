/**
 * Codex Personal Access Token (PAT) support.
 *
 * A Codex PAT is a static `at-` prefixed bearer token issued by the Codex CLI.
 * Unlike OAuth credentials it cannot be refreshed; it is validated against the
 * first-class whoami endpoint used by the Codex client to discover the account
 * identity (chatgpt_account_id / chatgpt_user_id / email / plan_type).
 *
 * Reference: sub2api openai_codex_pat_service.go
 */

import { getHttpCodexUserAgent } from "./user-agent";

const WHOAMI_URL = "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami";
const PAT_PREFIX = "at-";
const VALIDATE_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Test seam: allow overriding the whoami endpoint. */
let whoamiUrl = WHOAMI_URL;
export function __setCodexPatWhoamiUrlForTests(url?: string): void {
	whoamiUrl = url ?? WHOAMI_URL;
}

export interface CodexPatIdentity {
	accountId: string;
	userId: string;
	email: string;
	planType: string;
	fedramp: boolean;
}

interface WhoamiResponse {
	email?: string;
	chatgpt_user_id?: string;
	chatgpt_account_id?: string;
	chatgpt_plan_type?: string;
	chatgpt_account_is_fedramp?: boolean;
}

export class CodexPatValidationError extends Error {
	readonly status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.name = "CodexPatValidationError";
		this.status = status;
	}
}

/** Whether a raw token looks like a Codex personal access token. */
export function isCodexPersonalAccessToken(token: string | undefined): boolean {
	return typeof token === "string" && token.trim().startsWith(PAT_PREFIX);
}

function pfetch(url: string, init: RequestInit, proxy?: string): Promise<Response> {
	if (proxy) {
		// biome-ignore lint/suspicious/noExplicitAny: Bun-specific `proxy` extension on RequestInit
		return fetch(url, { ...init, proxy } as any);
	}
	return fetch(url, init);
}

async function readLimitedText(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				break;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(Math.min(total, MAX_RESPONSE_BYTES));
	let offset = 0;
	for (const chunk of chunks) {
		if (offset + chunk.byteLength > bytes.length) {
			bytes.set(chunk.subarray(0, bytes.length - offset), offset);
			break;
		}
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

/**
 * Validate a Codex personal access token via the whoami endpoint and return
 * the resolved account identity. Throws CodexPatValidationError on failure.
 */
export async function validateCodexPersonalAccessToken(
	accessToken: string,
	proxy?: string,
): Promise<CodexPatIdentity> {
	const token = accessToken.trim();
	if (!token) {
		throw new CodexPatValidationError("Codex personal access token is required", 400);
	}
	if (!token.startsWith(PAT_PREFIX)) {
		throw new CodexPatValidationError("Codex personal access token must start with at-", 400);
	}

	const abortController = new AbortController();
	const timeout = setTimeout(() => {
		abortController.abort(
			new Error(`Codex PAT validation timed out after ${VALIDATE_TIMEOUT_MS}ms`),
		);
	}, VALIDATE_TIMEOUT_MS);

	try {
		const response = await pfetch(
			whoamiUrl,
			{
				method: "GET",
				headers: {
					authorization: `Bearer ${token}`,
					accept: "application/json",
					originator: "codex_cli_rs",
					"user-agent": getHttpCodexUserAgent(),
				},
				signal: abortController.signal,
			},
			proxy,
		);

		if (response.status === 401 || response.status === 403) {
			throw new CodexPatValidationError(
				"Codex personal access token is invalid or expired",
				response.status,
			);
		}
		if (!response.ok) {
			const body = (await readLimitedText(response).catch(() => "")).trim();
			throw new CodexPatValidationError(
				`Codex personal access token validation failed: ${body || response.statusText}`,
				response.status,
			);
		}

		const raw = await readLimitedText(response);
		let whoami: WhoamiResponse;
		try {
			whoami = JSON.parse(raw) as WhoamiResponse;
		} catch {
			throw new CodexPatValidationError(
				"Codex personal access token validation response is not valid JSON",
				response.status,
			);
		}
		return normalizeWhoami(whoami);
	} finally {
		clearTimeout(timeout);
	}
}

function normalizeWhoami(whoami: WhoamiResponse): CodexPatIdentity {
	const accountId = (whoami.chatgpt_account_id ?? "").trim();
	const userId = (whoami.chatgpt_user_id ?? "").trim();
	const email = (whoami.email ?? "").trim();
	const planType = (whoami.chatgpt_plan_type ?? "").trim();
	const missing: string[] = [];
	if (!email) missing.push("email");
	if (!userId) missing.push("chatgpt_user_id");
	if (!accountId) missing.push("chatgpt_account_id");
	if (!planType) missing.push("chatgpt_plan_type");
	if (missing.length > 0) {
		throw new CodexPatValidationError(
			`Codex personal access token validation response is missing ${missing.join(", ")}`,
		);
	}
	return {
		accountId,
		userId,
		email,
		planType,
		fedramp: whoami.chatgpt_account_is_fedramp === true,
	};
}
