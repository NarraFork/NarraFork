/**
 * Runtime state of model credentials, keyed by credential id: the last quota snapshot,
 * recent usage history, a system block (failures or exhausted quota) and request counts.
 *
 * None of it is secret, and all of it changes far more often than the credential
 * itself, so it lives in `credential-state.json` instead of the encrypted credential
 * files: a request or a quota refresh never rewrites a refresh token. Writes are
 * debounced; owners flush on dispose and process exit. An unreadable file starts empty —
 * quotas are probed again and blocks re-derived — and never stops credentials loading.
 */
import { existsSync, readFileSync } from "node:fs";
import type { CodexUsageResult } from "./codex-usage";
import type { CodexUsageHistoryEntry } from "./codex-usage-summary";
import { logger } from "./logger";
import { writePrivate } from "./secret-store";

export const CREDENTIAL_STATE_FILE = "credential-state.json";
const WRITE_DEBOUNCE_MS = 2_000;

export type CredentialBlockReason = "too_many_failures" | "quota_exhausted";

export interface CredentialState {
	usage?: CodexUsageResult;
	usageHistory?: CodexUsageHistoryEntry[];
	/** Temporarily unusable by system decision; recovery clears it. User stops live on the credential. */
	blocked?: { reason: CredentialBlockReason; resetsAt?: number };
	stats?: { successCount: number; failureCount: number; lastUsedAt?: string };
}

export class CredentialStateStore {
	private readonly states = new Map<string, CredentialState>();
	/** Set while a write is pending. */
	private timer?: ReturnType<typeof setTimeout>;

	constructor(
		private readonly path: string,
		private readonly debounceMs = WRITE_DEBOUNCE_MS,
	) {
		try {
			if (!existsSync(path)) return;
			const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!raw || typeof raw !== "object") throw new Error("not a JSON object");
			for (const [id, state] of Object.entries(raw)) {
				if (state && typeof state === "object") this.states.set(id, state as CredentialState);
			}
		} catch (err) {
			logger.warn("Credential runtime state is unreadable; starting empty", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	get(id: string): CredentialState | undefined {
		return this.states.get(id);
	}

	/** Replace one credential's state (empty or undefined removes it) and schedule a write. */
	set(id: string, state: CredentialState | undefined): void {
		if (state && Object.values(state).some((value) => value !== undefined)) {
			this.states.set(id, state);
		} else if (!this.states.delete(id)) {
			return;
		}
		if (this.timer) return;
		this.timer = setTimeout(() => this.dispose(), this.debounceMs);
		(this.timer as { unref?: () => void }).unref?.();
	}

	/** Write a pending change now. Throws when the write fails. */
	flush(): void {
		if (!this.timer) return;
		clearTimeout(this.timer);
		this.timer = undefined;
		writePrivate(this.path, JSON.stringify(Object.fromEntries(this.states)));
	}

	/** Flush a pending change, logging instead of throwing; used by the timer and on shutdown. */
	dispose(): void {
		try {
			this.flush();
		} catch (err) {
			logger.warn("Failed to save credential runtime state", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}
