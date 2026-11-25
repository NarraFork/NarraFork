import { api } from "@frontend/lib/api";
import { readComposerDocument } from "@shared/composer-document";
import { useQuery } from "@tanstack/react-query";
import { AgentReferenceLink } from "../markdown/AgentReferenceLink";

export interface ComposerNarratorReferencesProps {
	narratorId: string;
	messageId: string;
	hasComposerDocument: boolean;
	revision?: number;
	queued?: boolean;
}

/** Mounted summary rows opt in explicitly; cached detail contains only authored references. */
export function ComposerNarratorReferences({
	narratorId,
	messageId,
	hasComposerDocument,
	revision = 0,
	queued = false,
}: ComposerNarratorReferencesProps) {
	const { data = [] } = useQuery({
		queryKey: ["composer-narrator-references", narratorId, messageId, queued, revision],
		enabled: hasComposerDocument && !!narratorId && !!messageId,
		staleTime: 30_000,
		gcTime: 60_000,
		retry: false,
		queryFn: async ({ signal }) => {
			const detail = queued
				? await api.getBufferedMessageComposerDocument(narratorId, messageId, signal)
				: await api.getMessageComposerDocument(narratorId, messageId, signal);
			const document = readComposerDocument(detail.composerDocument);
			return (
				document?.paragraphs.flatMap((paragraph) =>
					paragraph.children.flatMap((node) => (node.type === "narratorReference" ? [node] : [])),
				) ?? []
			);
		},
	});
	if (!hasComposerDocument || !data.length) return null;
	return (
		<span
			data-composer-narrator-references=""
			style={{ display: "inline-flex", minWidth: 0, overflow: "hidden", height: 20 }}
		>
			{data.map((reference) => (
				<AgentReferenceLink
					key={reference.id}
					id={reference.narratorId}
					label={`@${reference.label}`}
				/>
			))}
		</span>
	);
}
