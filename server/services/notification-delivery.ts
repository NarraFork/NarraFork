import { createHmac } from "node:crypto";
import { logger } from "@server/lib/logger";

export type NotificationChannel = "dingtalk" | "feishu";
export type NotificationDeliveryResult = {
	channel: NotificationChannel;
	status: "success" | "failed" | "not_sent";
	reason?:
		| "busy"
		| "disabled"
		| "not_configured"
		| "cancelled"
		| "timeout"
		| "http_error"
		| "business_error"
		| "invalid_response"
		| "response_too_large"
		| "delivery_error";
};

export const NOTIFICATION_TIMEOUT_MS = 10_000;
export const NOTIFICATION_RESPONSE_MAX_BYTES = 8 * 1024;
export const NOTIFICATION_MAX_QUEUED = 32;
let active = 0;
const waiters: Array<() => void> = [];

async function acquire(signal?: AbortSignal): Promise<() => void> {
	if (signal?.aborted) throw new DeliveryError("cancelled");
	if (active >= 2) {
		if (waiters.length >= NOTIFICATION_MAX_QUEUED) throw new DeliveryError("busy");
		await new Promise<void>((resolve, reject) => {
			const wake = () => {
				signal?.removeEventListener("abort", abort);
				resolve();
			};
			const abort = () => {
				const index = waiters.indexOf(wake);
				if (index >= 0) waiters.splice(index, 1);
				reject(new DeliveryError("cancelled"));
			};
			waiters.push(wake);
			signal?.addEventListener("abort", abort, { once: true });
		});
	} else {
		active++;
	}
	return () => {
		const next = waiters.shift();
		if (next) next();
		else active--;
	};
}

class DeliveryError extends Error {
	constructor(readonly reason: NonNullable<NotificationDeliveryResult["reason"]>) {
		super(reason);
	}
}

async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) throw new DeliveryError("invalid_response");
	const chunks: Uint8Array[] = [];
	let size = 0;
	const cancel = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", cancel, { once: true });
	try {
		if (signal.aborted) throw new DeliveryError("cancelled");
		while (true) {
			const { value, done } = await reader.read();
			if (signal.aborted) throw new DeliveryError("cancelled");
			if (done) break;
			size += value.byteLength;
			if (size > NOTIFICATION_RESPONSE_MAX_BYTES) {
				void reader.cancel().catch(() => {});
				throw new DeliveryError("response_too_large");
			}
			chunks.push(value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		try {
			return JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			throw new DeliveryError("invalid_response");
		}
	} finally {
		signal.removeEventListener("abort", cancel);
		reader.releaseLock();
	}
}

/** Shared by automatic, explicit and test notifications. No retries or provider response leakage. */
export async function deliverNotification(input: {
	channel: NotificationChannel;
	webhook: string;
	secret: string;
	title: string;
	message: string;
	signal?: AbortSignal;
	source: "narrator" | "automatic" | "test";
	narratorId?: string;
	userId?: string;
	/** Shortened only by unit tests. Production callers use the fixed 10s budget. */
	timeoutMs?: number;
}): Promise<NotificationDeliveryResult> {
	const started = Date.now();
	let release: (() => void) | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	const controller = new AbortController();
	const abort = () => controller.abort();
	input.signal?.addEventListener("abort", abort, { once: true });
	let result: NotificationDeliveryResult;
	try {
		if (input.signal?.aborted) controller.abort();
		// One total budget includes queue admission, fetch and response-body reads.
		timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, input.timeoutMs ?? NOTIFICATION_TIMEOUT_MS);
		release = await acquire(controller.signal);
		if (controller.signal.aborted) throw new DeliveryError("cancelled");
		let url = input.webhook;
		let body: Record<string, unknown>;
		if (input.channel === "dingtalk") {
			if (input.secret) {
				const timestamp = Date.now().toString();
				const sign = createHmac("sha256", input.secret)
					.update(`${timestamp}\n${input.secret}`)
					.digest("base64");
				const signedUrl = new URL(url);
				signedUrl.searchParams.set("timestamp", timestamp);
				signedUrl.searchParams.set("sign", sign);
				url = signedUrl.toString();
			}
			body = { msgtype: "markdown", markdown: { title: input.title, text: input.message } };
		} else {
			body = {
				msg_type: "interactive",
				card: {
					header: { title: { tag: "plain_text", content: input.title } },
					elements: [{ tag: "markdown", content: input.message }],
				},
			};
			if (input.secret) {
				const timestamp = Math.floor(Date.now() / 1000).toString();
				body.timestamp = timestamp;
				body.sign = createHmac("sha256", `${timestamp}\n${input.secret}`)
					.update("")
					.digest("base64");
			}
		}
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: controller.signal,
			redirect: "error",
		});
		if (!response.ok) {
			void response.body?.cancel().catch(() => {});
			throw new DeliveryError("http_error");
		}
		const payload = await readResponse(response, controller.signal);
		if (!payload || typeof payload !== "object") throw new DeliveryError("invalid_response");
		const fields = payload as Record<string, unknown>;
		const code = input.channel === "dingtalk" ? fields.errcode : (fields.code ?? fields.StatusCode);
		if (typeof code !== "number") throw new DeliveryError("invalid_response");
		if (code !== 0) throw new DeliveryError("business_error");
		result = { channel: input.channel, status: "success" };
	} catch (error) {
		const reason = timedOut
			? "timeout"
			: input.signal?.aborted
				? "cancelled"
				: error instanceof DeliveryError
					? error.reason
					: "delivery_error";
		result = { channel: input.channel, status: "failed", reason };
	} finally {
		if (timer) clearTimeout(timer);
		input.signal?.removeEventListener("abort", abort);
		release?.();
	}
	logger.info("Webhook notification delivery", {
		source: input.source,
		narratorId: input.narratorId,
		userId: input.userId,
		channel: input.channel,
		durationMs: Date.now() - started,
		status: result.status,
		reason: result.reason,
	});
	return result;
}
