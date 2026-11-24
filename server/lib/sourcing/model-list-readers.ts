/**
 * Cached, per-group model readers registered by the existing catalog owners.
 *
 * This leaf owns no catalog and starts no refresh. Keeping registration separate from
 * templates avoids importing HTTP routes (and their startup side effects) just to use a
 * template. Readers stay synchronous: the agent's legacy listers keep their current
 * ordering, while management GETs can use the template's async listModels contract.
 */
import type { SourceProtocol } from "@shared/sourcing/identify";
import type { SourceGroupView } from "./source-groups";

export type ModelListSource =
	| SourceProtocol
	| "codex"
	| "tokendance"
	| "command-code"
	| "nug"
	| "plugin";

type ModelListReader = (group: SourceGroupView) => readonly string[];
const readers = new Map<ModelListSource, ModelListReader>();
const singletonSources: Partial<Record<SourceGroupView["templateId"], ModelListSource>> = {
	codex: "codex",
	tokendance: "tokendance",
	"command-code": "command-code",
	nug: "nug",
	plugin: "plugin",
};

/** Replaces a reader; an older owner's disposer cannot remove the replacement. */
export function registerModelListReader(
	source: ModelListSource,
	reader: ModelListReader,
): () => void {
	readers.set(source, reader);
	return () => {
		if (readers.get(source) === reader) readers.delete(source);
	};
}

/** Read existing upstream ids without applying the agent's hidden/disabled filtering. */
export function readTemplateModelList(group: SourceGroupView): string[] {
	// Known services such as Kimi can speak more than one protocol. The connection's
	// actual protocol, not the recognised vendor, chooses its catalog owner.
	const source =
		singletonSources[group.templateId] ?? group.endpoint.protocol ?? "completions-compatible";
	return [...(readers.get(source)?.(group) ?? [])];
}
