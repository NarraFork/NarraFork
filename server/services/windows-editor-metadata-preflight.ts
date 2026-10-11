import { logger } from "../lib/logger";
import { productionDefaultWindowsIoSigner } from "../lib/windows-io-authority-broker-client";
import { runWindowsIoBounded } from "../lib/windows-io-authority-budget";
import { EditorDocumentError } from "./editor-document-service";
import {
	assertRemoteEditorSessionOrigin,
	RemoteEditorOriginError,
	type RemoteEditorSessionOrigin,
	requireRemoteEditorSessionOrigin,
} from "./remote-history-recovery-auth";
import type { RemoteWorkspaceHistoryRuntime } from "./remote-workspace-history-runtime";

export const WINDOWS_EDITOR_FRESH_CHECK_MS = 5_000;
export const WINDOWS_EDITOR_METADATA_BLOCKERS = Object.freeze([
	"EDITOR_METADATA_SIGNER_NOT_READY",
	"EDITOR_METADATA_V2_ENROLLMENT_REQUIRED",
	"EDITOR_METADATA_ORIGIN_WIRE_UNCONNECTED",
	"EDITOR_METADATA_REQUEST_CHANNEL_UNCONNECTED",
	"EDITOR_METADATA_DESCRIPTOR_PREAUTH_UNCONNECTED",
] as const);
interface Check {
	registry: { readonly options: Pick<RemoteWorkspaceHistoryRuntime["options"], "db"> };
	userId: string;
	phase: "source" | "save";
	signal: AbortSignal;
	origin?: RemoteEditorSessionOrigin;
	/** Reuses actual original target/narrator/project/device/path authorization. */
	authorize(signal: AbortSignal): Promise<void>;
	/** Actual frozen runtime/scope/lease checks, never a bool availability resolver. */
	assertCurrent(): void;
	/** Internal journal row ID only; never raw paths, source payload or credential refs. */
	correlationId?: string;
}
function originError(error: unknown): never {
	if (error instanceof RemoteEditorOriginError)
		throw new EditorDocumentError(
			error.reason,
			"Original HTTP editor session is unavailable",
			403,
			{ reason: error.reason },
		);
	throw error;
}
/** One bounded fresh check. Neither the original expiry nor request deadline is renewed. */
export async function checkWindowsEditorSession(input: Check): Promise<RemoteEditorSessionOrigin> {
	const started = performance.now();
	const bounded = AbortSignal.any([
		input.signal,
		AbortSignal.timeout(WINDOWS_EDITOR_FRESH_CHECK_MS),
	]);
	let reason = "EDITOR_METADATA_FRESH_CHECK_FAILED";
	try {
		const result = await runWindowsIoBounded(bounded, async () => {
			bounded.throwIfAborted();
			const origin = input.origin ?? requireRemoteEditorSessionOrigin(input.userId);
			assertRemoteEditorSessionOrigin(input.registry, origin, input.userId, bounded);
			input.assertCurrent();
			await input.authorize(bounded);
			bounded.throwIfAborted();
			input.assertCurrent();
			assertRemoteEditorSessionOrigin(input.registry, origin, input.userId, bounded);
			return origin;
		});
		reason = "EDITOR_METADATA_FRESH_CHECK_VALIDATED";
		return result;
	} catch (error) {
		if (error instanceof RemoteEditorOriginError) reason = error.reason;
		return originError(error);
	} finally {
		const durationMs = Math.round(performance.now() - started);
		if (durationMs >= 250)
			logger.warn("Slow Windows editor origin check", {
				phase: input.phase,
				reason,
				durationMs,
				...(input.correlationId ? { correlationId: input.correlationId } : {}),
			});
	}
}
/** Deliberately has NO injectable resolver/ready boolean. Current production has no
 * original inspect wire, request-scoped channel or descriptor preauthorization. Even
 * installing a key cannot bypass these independently missing contracts. */
export async function preflightWindowsEditorMetadata(input: Check): Promise<never> {
	await checkWindowsEditorSession(input);
	const signerMissing = productionDefaultWindowsIoSigner() === null;
	const blockers = signerMissing
		? WINDOWS_EDITOR_METADATA_BLOCKERS
		: WINDOWS_EDITOR_METADATA_BLOCKERS.slice(1);
	const reason = blockers[0];
	throw new EditorDocumentError(
		"EDITOR_WINDOWS_METADATA_NOT_READY",
		"Windows editor metadata capture is not connected to the original authorized operation",
		422,
		{ reason, blockers },
	);
}
