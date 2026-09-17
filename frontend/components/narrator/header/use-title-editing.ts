import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../../lib/api";

export interface UseTitleEditingOptions {
	narratorId: string;
	/** Current narrator (read for the existing title); may be undefined while loading. */
	narrator: { title?: string | null } | undefined;
	/** narrator translation fn (namespace "narrator"). */
	t: (key: string, opts?: Record<string, unknown>) => string;
}

export interface UseTitleEditingResult {
	editingTitle: boolean;
	titleValue: string;
	setTitleValue: React.Dispatch<React.SetStateAction<string>>;
	generatingTitle: boolean;
	titleInputRef: React.RefObject<HTMLInputElement | null>;
	/** Enter edit mode, seeding the input with the current title. */
	startEditingTitle: () => void;
	/** Persist the trimmed title (no-op if unchanged); stays in edit mode on failure. */
	saveTitle: () => Promise<void>;
	/** Ask the server to generate a title, filling the input with the result. */
	handleGenerateTitle: () => Promise<void>;
	/** Enter submits (unless composing), Escape cancels. */
	handleTitleKeyDown: (e: React.KeyboardEvent) => void;
}

/**
 * Inline title editing for the narrator header: enter/leave edit mode, autosave
 * on blur/Enter, and AI title generation. Extracted verbatim from NarratorPanel
 * (header title slot). Uses the query client + api directly since those are
 * ambient; only the current narrator/id and translation fn are injected.
 */
export function useTitleEditing(options: UseTitleEditingOptions): UseTitleEditingResult {
	const { narratorId, narrator, t } = options;
	const qc = useQueryClient();

	const [editingTitle, setEditingTitle] = useState(false);
	const [titleValue, setTitleValue] = useState("");
	const [generatingTitle, setGeneratingTitle] = useState(false);
	const titleInputRef = useRef<HTMLInputElement>(null);

	const startEditingTitle = () => {
		setTitleValue(narrator?.title || "");
		setEditingTitle(true);
	};
	useEffect(() => {
		if (editingTitle) {
			titleInputRef.current?.focus();
			titleInputRef.current?.select();
		}
	}, [editingTitle]);
	const saveTitle = async () => {
		if (generatingTitle) return;
		const trimmed = titleValue.trim();
		if (trimmed && trimmed !== narrator?.title) {
			try {
				await api.updateNarratorTitle(narratorId, trimmed);
			} catch {
				// Stay in edit mode: the text the user typed is only in this input, and
				// leaving it would drop it. Without this the failure was invisible AND
				// unrecoverable — every click-away re-fired the blur handler and failed
				// again, so the field looked stuck for no stated reason.
				notifications.show({ message: t("titleUpdateFailed"), color: "red", autoClose: 4000 });
				return;
			}
			qc.invalidateQueries({ queryKey: ["narrators", narratorId], exact: true });
		}
		setEditingTitle(false);
	};
	const handleGenerateTitle = async () => {
		setGeneratingTitle(true);
		try {
			const { title } = await api.generateNarratorTitle(narratorId);
			setTitleValue(title);
			qc.invalidateQueries({ queryKey: ["narrators", narratorId], exact: true });
		} catch {
			notifications.show({ message: t("generateTitleFailed"), color: "red", autoClose: 4000 });
		} finally {
			setGeneratingTitle(false);
		}
	};
	const handleTitleKeyDown = (e: React.KeyboardEvent) => {
		// See AskInPassingCard: Enter during IME composition is the candidate pick,
		// not a submit.
		if (e.key === "Enter" && !e.nativeEvent.isComposing) {
			e.preventDefault();
			saveTitle();
		} else if (e.key === "Escape") {
			setEditingTitle(false);
		}
	};

	return {
		editingTitle,
		titleValue,
		setTitleValue,
		generatingTitle,
		titleInputRef,
		startEditingTitle,
		saveTitle,
		handleGenerateTitle,
		handleTitleKeyDown,
	};
}
