import type { FileReferenceContext } from "@shared/file-reference";
import { normalizeFileReferenceContext } from "@shared/file-reference-context";
import { type ExecutionBackend, LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { resolveBackend } from "../lib/agent/execution/registry";
import type { AgentConfig } from "../lib/agent/types";

/** Registry lookup uses live connection memory; never queries the DB or remote filesystem. */
export function getAgentFileReferenceContext(
	config: Pick<AgentConfig, "cwd" | "defaultDeviceId" | "executionBackend">,
	resolve: typeof resolveBackend = resolveBackend,
): FileReferenceContext | null {
	const deviceId = config.defaultDeviceId ?? LOCAL_DEVICE_ID;
	let backend: ExecutionBackend;
	try {
		backend =
			config.executionBackend?.deviceId === deviceId
				? config.executionBackend
				: resolve({ sessionDefault: deviceId });
	} catch {
		return null;
	}
	return normalizeFileReferenceContext({
		deviceId,
		// Never use the host cwd as a guess for a remote device with no known cwd.
		cwd: backend.kind === "remote" ? backend.defaultCwd : config.cwd,
	});
}

/**
 * One context per streamed text element, including null when its source was unknown. Keyed
 * by the element id every delta carries: ids survive checkpoints, while a provider can reuse
 * an output index for a later element, which must never inherit an earlier element's device.
 */
export class FileReferenceContextTracker {
	private readonly contexts = new Map<string, FileReferenceContext | null>();

	/** The element's context, read from `getContext` at its first delta only. */
	capture(blockId: string, getContext?: () => FileReferenceContext | null | undefined) {
		if (!this.contexts.has(blockId)) {
			let context: FileReferenceContext | null = null;
			try {
				context = normalizeFileReferenceContext(getContext?.());
			} catch {
				// Location metadata is optional; an unavailable source must not lose tokens.
			}
			this.contexts.set(blockId, context ? Object.freeze(context) : null);
		}
		return this.contexts.get(blockId) ?? null;
	}

	/** A completed element's context; one without an element id has none to claim. */
	peek(blockId: string | undefined): FileReferenceContext | null {
		return blockId ? (this.contexts.get(blockId) ?? null) : null;
	}

	/** Non-streaming/fallback messages cannot safely reconstruct a context at turn end. */
	fallback(): FileReferenceContext | null {
		if (this.contexts.size !== 1) return null;
		return this.contexts.values().next().value ?? null;
	}

	clear(): void {
		this.contexts.clear();
	}
}
