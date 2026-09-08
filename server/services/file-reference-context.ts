import { randomUUID } from "node:crypto";
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

/** One context per provider text lane, including null when its source was unknown. */
export class FileReferenceContextTracker {
	private readonly contexts = new Map<number | undefined, FileReferenceContext | null>();
	private readonly blockIds = new Map<number | undefined, string>();

	/** A new round may reuse the provider index before the UI retires the old lane. */
	blockId(outputIndex: number | undefined): string | undefined {
		return this.blockIds.get(outputIndex);
	}

	capture(
		outputIndex: number | undefined,
		getContext?: () => FileReferenceContext | null | undefined,
	) {
		if (!this.contexts.has(outputIndex)) {
			let context: FileReferenceContext | null = null;
			try {
				context = normalizeFileReferenceContext(getContext?.());
			} catch {
				// Location metadata is optional; an unavailable source must not lose tokens.
			}
			this.contexts.set(outputIndex, context ? Object.freeze(context) : null);
			this.blockIds.set(outputIndex, randomUUID());
		}
		return this.contexts.get(outputIndex) ?? null;
	}

	/** A provider can emit several output items which the loop later combines. */
	hasDifferentContexts(): boolean {
		const first = this.contexts.values().next().value;
		for (const context of this.contexts.values()) {
			if (context?.deviceId !== first?.deviceId || context?.cwd !== first?.cwd) return true;
		}
		return false;
	}

	complete(outputIndex: number | undefined): FileReferenceContext | null {
		const context = this.contexts.get(outputIndex) ?? null;
		this.contexts.delete(outputIndex);
		this.blockIds.delete(outputIndex);
		return context;
	}

	/** Non-streaming/fallback messages cannot safely reconstruct a context at turn end. */
	fallback(): FileReferenceContext | null {
		return this.contexts.size === 1 ? (this.contexts.values().next().value ?? null) : null;
	}

	clear(): void {
		this.contexts.clear();
		this.blockIds.clear();
	}
}
