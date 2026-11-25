import { sha256 } from "@noble/hashes/sha2.js";
import type { NarratorSubmissionReceipt } from "./api/narrators";

export const SUBMISSION_DEDUPE_WINDOW_MS = 604_800_000;
/** Text plus its bounded document sidecar; attachment bytes are never fingerprinted here. */
export const MAX_SUBMISSION_FINGERPRINT_BYTES = 4 * 1024 * 1024;
let submissionSequence = 0;
/** Correlation only, never an authorization token. getRandomValues also works on LAN HTTP. */
function createSubmissionId(): string {
	if (globalThis.crypto?.getRandomValues) {
		const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
		return `submission-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
	}
	// Match ordinary composer draft IDs on older runtimes with no Crypto object at all.
	return `submission-${Date.now().toString(36)}-${++submissionSequence}-${Math.random().toString(36).slice(2)}`;
}
interface PendingSubmission {
	id: string;
	startedAt: number;
	fingerprint: string;
}
export class SubmissionOutcomeUnknown extends Error {
	constructor(public readonly reason: "unknown" | "expired" | "changed" = "unknown") {
		super(`submissionReceipt_${reason}`);
		this.name = "SubmissionOutcomeUnknown";
	}
}
interface ReceiptError {
	status?: number;
	data?: { status?: string; dedupeWindowMs?: number; code?: string };
}
interface SubmissionStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

/** Only unresolved IDs survive reloads. No body, title, credential, or file bytes are stored. */
export class NarratorSubmissionReconciler {
	private pending = new Map<string, PendingSubmission>();
	private expired = new Map<string, string>();
	/** Called only by an explicit user action after expiry was established; never a retry. */
	startNewAfterExpiry(scope: string): boolean {
		const pending = this.read(scope);
		if (!pending || this.expired.get(scope) !== pending.id) return false;
		this.expired.delete(scope);
		this.write(scope);
		return true;
	}
	constructor(
		private storage?: SubmissionStorage,
		private now = Date.now,
	) {}
	private key(scope: string) {
		return `nf:pending-submission:${scope}`;
	}
	private read(scope: string): PendingSubmission | undefined {
		try {
			const raw = this.storage?.getItem(this.key(scope));
			if (raw) {
				const value = JSON.parse(raw) as PendingSubmission;
				if (
					typeof value.id === "string" &&
					typeof value.fingerprint === "string" &&
					Number.isFinite(value.startedAt)
				)
					return value;
			}
		} catch {
			/* Memory remains a safe guard when storage is unavailable. */
		}
		return this.pending.get(scope);
	}
	private write(scope: string, value?: PendingSubmission) {
		if (value) this.pending.set(scope, value);
		else this.pending.delete(scope);
		try {
			if (value) this.storage?.setItem(this.key(scope), JSON.stringify(value));
			else this.storage?.removeItem(this.key(scope));
		} catch {
			/* Do not drop the in-memory unresolved ID. */
		}
	}
	async submit<T>(options: {
		scope: string;
		fingerprint: string;
		send(id: string): Promise<T>;
		receipt(id: string): Promise<NarratorSubmissionReceipt>;
		accepted(receipt: NarratorSubmissionReceipt): T;
		canRetry(): boolean;
	}): Promise<T> {
		let pending = this.read(options.scope);
		const reconcile = async (value: PendingSubmission): Promise<T | undefined> => {
			try {
				const receipt = await options.receipt(value.id);
				if (receipt.status !== "accepted") throw new SubmissionOutcomeUnknown();
				this.write(options.scope);
				// A newer body is never silently treated as the already accepted old body.
				if (value.fingerprint !== options.fingerprint)
					throw new SubmissionOutcomeUnknown("changed");
				return options.accepted(receipt);
			} catch (error) {
				if (error instanceof SubmissionOutcomeUnknown) throw error;
				const failure = error as ReceiptError;
				const elapsed = this.now() - value.startedAt;
				if (
					failure.status === 410 ||
					(failure.status === 404 &&
						failure.data?.status === "not_found" &&
						elapsed >= SUBMISSION_DEDUPE_WINDOW_MS)
				) {
					this.expired.set(options.scope, value.id);
					throw new SubmissionOutcomeUnknown("expired");
				}
				// Reserve a minute so a request near the boundary cannot arrive after dedupe expiry.
				if (
					failure.status !== 404 ||
					failure.data?.status !== "not_found" ||
					failure.data.dedupeWindowMs !== SUBMISSION_DEDUPE_WINDOW_MS ||
					elapsed < 0 ||
					elapsed >= SUBMISSION_DEDUPE_WINDOW_MS - 60_000
				)
					throw new SubmissionOutcomeUnknown();
				if (value.fingerprint !== options.fingerprint)
					throw new SubmissionOutcomeUnknown("changed");
				if (!options.canRetry()) throw new SubmissionOutcomeUnknown();
				return undefined;
			}
		};
		if (pending) {
			const accepted = await reconcile(pending);
			if (accepted !== undefined) return accepted;
		} else {
			pending = {
				id: createSubmissionId(),
				startedAt: this.now(),
				fingerprint: options.fingerprint,
			};
			this.write(options.scope, pending);
		}
		try {
			const result = await options.send(pending.id);
			this.write(options.scope);
			return result;
		} catch (error) {
			const status = (error as ReceiptError)?.status;
			if (status && status < 500 && status !== 408 && status !== 409) {
				this.write(options.scope);
				throw error;
			}
			if (status === 409) throw error;
			// Lost response: read once now. A later explicit retry reads again before POST.
			const accepted = await reconcile(pending);
			if (accepted !== undefined) return accepted;
			throw new SubmissionOutcomeUnknown();
		}
	}
}

export async function submissionFingerprint(value: unknown): Promise<string> {
	const serialized = JSON.stringify(value);
	if (serialized === undefined || serialized.length > MAX_SUBMISSION_FINGERPRINT_BYTES)
		throw new Error("Submission metadata exceeds fingerprint budget");
	const bytes = new TextEncoder().encode(serialized);
	if (bytes.byteLength > MAX_SUBMISSION_FINGERPRINT_BYTES)
		throw new Error("Submission metadata exceeds fingerprint budget");
	// Same browser-safe SHA-256 as worktree receipt metadata, including plaintext HTTP.
	const digest = sha256(bytes);
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
