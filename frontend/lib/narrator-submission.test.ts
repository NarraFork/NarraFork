import { describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import type { NarratorSubmissionReceipt } from "./api/narrators";
import {
	MAX_SUBMISSION_FINGERPRINT_BYTES,
	NarratorSubmissionReconciler,
	SUBMISSION_DEDUPE_WINDOW_MS,
	SubmissionOutcomeUnknown,
	submissionFingerprint,
} from "./narrator-submission";

const accepted: NarratorSubmissionReceipt = {
	status: "accepted",
	id: "buffer",
	bufferedAt: "2026-01-01",
	state: "queued",
	messageId: null,
	dedupeExpiresAt: "2026-01-08",
};
const absent = () =>
	Object.assign(new Error("Not found"), {
		status: 404,
		data: { status: "not_found", dedupeWindowMs: SUBMISSION_DEDUPE_WINDOW_MS },
	});
const unknown = () => new Error("Response lost");
function storage() {
	const data = new Map<string, string>();
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, value);
		},
		removeItem: (key: string) => {
			data.delete(key);
		},
	};
}
function setup() {
	const store = storage();
	const reconciler = new NarratorSubmissionReconciler(store);
	const send = mock(async (_id: string) => "sent");
	const receipt = mock(async (_id: string) => accepted);
	const options = {
		scope: "user/source",
		fingerprint: "body",
		send,
		receipt,
		accepted: (_value: NarratorSubmissionReceipt) => "reconciled",
		canRetry: () => true,
	};
	return { store, reconciler, send, receipt, options };
}

describe("user submission receipt reconciliation", () => {
	test("LAN HTTP without randomUUID/subtle preserves SHA-256, initial send and same-ID receipt retry", async () => {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
		const entropy = mock(globalThis.crypto.getRandomValues.bind(globalThis.crypto));
		Object.defineProperty(globalThis, "crypto", {
			configurable: true,
			value: { getRandomValues: entropy },
		});
		try {
			const body = {
				message: "private metadata 中文",
				narratorId: "precise-target",
				document: { version: 1 },
			};
			const fingerprint = await submissionFingerprint(body);
			expect(fingerprint).toBe(createHash("sha256").update(JSON.stringify(body)).digest("hex"));
			const { reconciler, options, store, send, receipt } = setup();
			options.fingerprint = fingerprint;
			expect(await reconciler.submit(options)).toBe("sent");
			const initialId = send.mock.calls[0][0];
			expect(initialId).toMatch(/^submission-[a-f0-9]{32}$/u);
			send.mockRejectedValueOnce(unknown());
			receipt.mockRejectedValue(absent());
			await expect(reconciler.submit(options)).rejects.toBeInstanceOf(SubmissionOutcomeUnknown);
			const retryId = send.mock.calls[1][0];
			expect(retryId).not.toBe(initialId);
			const persisted = store.getItem("nf:pending-submission:user/source");
			expect(persisted).toContain(fingerprint);
			expect(persisted).not.toContain(body.message);
			expect(await new NarratorSubmissionReconciler(store).submit(options)).toBe("sent");
			expect(send.mock.calls[2][0]).toBe(retryId);
			expect(receipt.mock.calls[1][0]).toBe(retryId);
			expect(entropy).toHaveBeenCalledTimes(2);
		} finally {
			if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
			else Reflect.deleteProperty(globalThis, "crypto");
		}
	});
	test("ordinary correlation-ID fallback remains unique when the entire Crypto object is unavailable", async () => {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
		Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
		try {
			const { reconciler, options, send } = setup();
			options.fingerprint = await submissionFingerprint({ message: "fallback" });
			expect(options.fingerprint).toBe(
				createHash("sha256").update('{"message":"fallback"}').digest("hex"),
			);
			await reconciler.submit(options);
			await reconciler.submit(options);
			expect(send.mock.calls[0][0]).toMatch(/^submission-[A-Za-z0-9_-]+$/u);
			expect(send.mock.calls[0][0]).not.toBe(send.mock.calls[1][0]);
		} finally {
			if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
			else Reflect.deleteProperty(globalThis, "crypto");
		}
	});
	test("metadata budget counts UTF-8 bytes and never substitutes a weaker fingerprint", async () => {
		await expect(
			submissionFingerprint("a".repeat(MAX_SUBMISSION_FINGERPRINT_BYTES)),
		).rejects.toThrow("metadata");
		await expect(
			submissionFingerprint("中".repeat(Math.ceil(MAX_SUBMISSION_FINGERPRINT_BYTES / 3))),
		).rejects.toThrow("metadata");
		expect(await submissionFingerprint({ message: "" })).toMatch(/^[a-f0-9]{64}$/u);
	});
	test("successful active sends allocate a fresh ID each time", async () => {
		const { reconciler, options, send, receipt } = setup();
		await reconciler.submit(options);
		await reconciler.submit(options);
		expect(send.mock.calls[0][0]).not.toBe(send.mock.calls[1][0]);
		expect(receipt).not.toHaveBeenCalled();
	});
	test("lost POST response checks GET and never reposts when accepted", async () => {
		const { reconciler, options, send, receipt } = setup();
		send.mockRejectedValue(unknown());
		expect(await reconciler.submit(options)).toBe("reconciled");
		expect(send).toHaveBeenCalledTimes(1);
		expect(receipt).toHaveBeenCalledWith(send.mock.calls[0][0]);
	});
	test("unknown survives reload and explicit retry GETs before reusing the exact same ID", async () => {
		const { reconciler, options, store, send, receipt } = setup();
		send.mockRejectedValue(unknown());
		receipt.mockRejectedValue(absent());
		await expect(reconciler.submit(options)).rejects.toBeInstanceOf(SubmissionOutcomeUnknown);
		const id = send.mock.calls[0][0];
		send.mockResolvedValue("sent");
		expect(await new NarratorSubmissionReconciler(store).submit(options)).toBe("sent");
		expect(receipt.mock.calls[1][0]).toBe(id);
		expect(send.mock.calls[1][0]).toBe(id);
	});
	test("unproven 404, receipt outage, changed body and canceled upload never blindly POST", async () => {
		for (const failure of [Object.assign(new Error("404"), { status: 404 }), unknown()]) {
			const { reconciler, options, send, receipt } = setup();
			send.mockRejectedValue(unknown());
			receipt.mockRejectedValue(failure);
			await expect(reconciler.submit(options)).rejects.toBeInstanceOf(SubmissionOutcomeUnknown);
			await expect(reconciler.submit(options)).rejects.toBeInstanceOf(SubmissionOutcomeUnknown);
			expect(send).toHaveBeenCalledTimes(1);
		}
		const { reconciler, options, send, receipt } = setup();
		send.mockRejectedValue(unknown());
		receipt.mockRejectedValue(absent());
		await expect(reconciler.submit(options)).rejects.toBeInstanceOf(SubmissionOutcomeUnknown);
		await expect(reconciler.submit({ ...options, fingerprint: "edited" })).rejects.toMatchObject({
			reason: "changed",
		});
		await expect(reconciler.submit({ ...options, canRetry: () => false })).rejects.toBeInstanceOf(
			SubmissionOutcomeUnknown,
		);
		expect(send).toHaveBeenCalledTimes(1);
	});
	test("seven-day expiry never automatically reposts, definitive refusal allows a new ID", async () => {
		const { store, options, send, receipt } = setup();
		let now = 1_000;
		const reconciler = new NarratorSubmissionReconciler(store, () => now);
		send.mockRejectedValue(unknown());
		receipt.mockRejectedValue(absent());
		await expect(reconciler.submit(options)).rejects.toBeInstanceOf(SubmissionOutcomeUnknown);
		expect(reconciler.startNewAfterExpiry(options.scope)).toBe(false);
		now += SUBMISSION_DEDUPE_WINDOW_MS;
		await expect(reconciler.submit(options)).rejects.toMatchObject({ reason: "expired" });
		expect(send).toHaveBeenCalledTimes(1);
		expect(reconciler.startNewAfterExpiry(options.scope)).toBe(true);
		send.mockResolvedValue("sent");
		await reconciler.submit(options);
		expect(send.mock.calls[0][0]).not.toBe(send.mock.calls[1][0]);
		const other = setup();
		other.send.mockRejectedValueOnce(Object.assign(new Error("forbidden"), { status: 403 }));
		await expect(other.reconciler.submit(other.options)).rejects.toThrow("forbidden");
		await other.reconciler.submit(other.options);
		expect(other.send.mock.calls[0][0]).not.toBe(other.send.mock.calls[1][0]);
	});
	test("fingerprints bind content and reference identity, not just display labels", async () => {
		expect(await submissionFingerprint({ text: "@same", narratorId: "a" })).not.toBe(
			await submissionFingerprint({ text: "@same", narratorId: "b" }),
		);
	});
});
