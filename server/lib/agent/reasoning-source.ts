/**
 * Re-export shim for thinking-signature source identity.
 *
 * The implementation moved to `@shared/agent-protocol/reasoning-source` so the
 * shared protocol layer — which bundled plugin code reuses — has no
 * `server/` imports. Host importers keep using this path unchanged.
 */
export {
	type ReasoningSourceKey,
	signatureSourcesCompatible,
} from "@shared/agent-protocol/reasoning-source";
