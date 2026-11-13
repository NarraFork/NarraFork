import type { OutlineAnswerHttpInput, OutlineQuestionView } from "@shared/outline-api";
import { useEffect, useRef, useState } from "react";
import { readSession, removeSession, writeSession } from "../../lib/session-store";

export interface OutlineAnswerDraft {
	option: number | null;
	text: string;
	/** Version read when editing began, not the latest background refetch. */
	versionSeq?: number;
}

const empty: OutlineAnswerDraft = { option: null, text: "" };
const listeners = new Set<(id: string, draft: OutlineAnswerDraft) => void>();
const key = (id: string) => `outline:${id}`;

function readDraft(id: string): OutlineAnswerDraft {
	try {
		const saved = readSession("ask-draft", key(id));
		if (!saved) return empty;
		const draft = JSON.parse(saved) as OutlineAnswerDraft;
		return {
			option: Number.isInteger(draft.option) && (draft.option ?? 0) > 0 ? draft.option : null,
			text: typeof draft.text === "string" ? draft.text : "",
			versionSeq: Number.isInteger(draft.versionSeq) ? draft.versionSeq : undefined,
		};
	} catch {
		return empty;
	}
}

export function useOutlineAnswerDrafts(questionIds: readonly string[]) {
	const [drafts, setDrafts] = useState<Record<string, OutlineAnswerDraft>>({});
	const latest = useRef(drafts);
	const scope = JSON.stringify(questionIds);
	useEffect(() => {
		const ids = new Set<string>(JSON.parse(scope));
		latest.current = Object.fromEntries(
			[...ids].map((id) => [id, latest.current[id] ?? readDraft(id)]),
		);
		setDrafts(latest.current);
		const receive = (id: string, draft: OutlineAnswerDraft) => {
			if (!ids.has(id)) return;
			latest.current = { ...latest.current, [id]: draft };
			setDrafts(latest.current);
		};
		listeners.add(receive);
		return () => {
			listeners.delete(receive);
		};
	}, [scope]);
	const change = (id: string, draft: OutlineAnswerDraft) => {
		latest.current = { ...latest.current, [id]: draft };
		setDrafts(latest.current);
		if (draft.option === null && !draft.text) removeSession("ask-draft", key(id));
		else writeSession("ask-draft", key(id), JSON.stringify(draft));
		for (const receive of listeners) receive(id, draft);
	};
	return {
		get: (id: string) => drafts[id] ?? readDraft(id),
		change,
		// A delayed conflict must not overwrite text typed meanwhile in another surface.
		resetChoices: (ids: readonly string[]) => {
			for (const id of ids)
				change(id, {
					...(latest.current[id] ?? readDraft(id)),
					option: null,
					versionSeq: undefined,
				});
		},
		clear: (ids: readonly string[]) => {
			for (const id of ids) change(id, empty);
		},
	};
}

/** Match AskUserQuestion: authored text is the answer, not a note on an old selection. */
export function outlineAnswerInput(
	q: OutlineQuestionView,
	draft: OutlineAnswerDraft,
): OutlineAnswerHttpInput | null {
	const text = draft.text.trim();
	const base = { blockId: q.blockId, versionSeq: draft.versionSeq ?? q.versionSeq };
	if (text) return { ...base, text };
	if (draft.option !== null && q.options[draft.option - 1] !== undefined)
		return { ...base, option: draft.option };
	return null;
}
