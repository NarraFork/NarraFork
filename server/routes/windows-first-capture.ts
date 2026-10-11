import {
	parseWindowsFirstCaptureBytes,
	WINDOWS_FIRST_CAPTURE_LIMITS,
	windowsFirstCaptureHttpSchema,
} from "@shared/windows-first-capture";
import { Hono } from "hono";
import { AppError } from "../lib/errors";
import { remoteEditorSessionProvenance } from "../middleware/remote-recovery-provenance";
import {
	captureWindowsMetadataForHttpSession,
	firstCaptureUnavailable,
} from "../services/windows-first-capture-service";

export const windowsFirstCaptureRoutes = new Hono();
const path = "/:id/windows-metadata-captures";
windowsFirstCaptureRoutes.use(path, remoteEditorSessionProvenance);
windowsFirstCaptureRoutes.post(path, async (c) => {
	c.header("Cache-Control", "no-store");
	const auth = c.get("auth");
	if (!auth || auth.type !== "session" || auth.user.sub !== c.get("user")?.sub)
		throw new AppError(
			"Proof-only Windows capture requires the original first-party HTTP session",
			403,
			"WINDOWS_FIRST_CAPTURE_SESSION_REQUIRED",
		);
	const reader = c.req.raw.body?.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	const bodySignal = AbortSignal.any([
		c.req.raw.signal,
		AbortSignal.timeout(WINDOWS_FIRST_CAPTURE_LIMITS.rpcTimeoutMs),
	]);
	const cancelBody = () => {
		void reader?.cancel(bodySignal.reason).catch(() => {});
	};
	bodySignal.addEventListener("abort", cancelBody, { once: true });
	try {
		bodySignal.throwIfAborted();
		while (reader) {
			const chunk = await reader.read();
			bodySignal.throwIfAborted();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > WINDOWS_FIRST_CAPTURE_LIMITS.httpBytes)
				throw new AppError(
					"First-capture metadata exceeds 16KiB",
					413,
					"WINDOWS_FIRST_CAPTURE_METADATA_TOO_LARGE",
				);
			chunks.push(chunk.value);
		}
	} catch (error) {
		void reader?.cancel().catch(() => {});
		throw error;
	} finally {
		bodySignal.removeEventListener("abort", cancelBody);
		reader?.releaseLock();
	}
	let request: ReturnType<typeof windowsFirstCaptureHttpSchema.parse>;
	try {
		request = parseWindowsFirstCaptureBytes(
			Buffer.concat(chunks, size),
			windowsFirstCaptureHttpSchema,
			WINDOWS_FIRST_CAPTURE_LIMITS.httpBytes,
		);
	} catch {
		throw new AppError(
			"First-capture metadata must be strict canonical JSON with only path/deviceId/requestId",
			400,
			"WINDOWS_FIRST_CAPTURE_INVALID_METADATA",
		);
	}
	try {
		return c.json(
			await captureWindowsMetadataForHttpSession({
				userId: auth.user.sub,
				narratorId: c.req.param("id"),
				request,
				signal: c.req.raw.signal,
			}),
		);
	} catch (error) {
		throw firstCaptureUnavailable(error);
	}
});
