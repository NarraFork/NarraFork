/**
 * A permission card's textareas in the transcript paint with the reader's typography (D49).
 *
 * The transcript reserves a live permission card's height before it paints
 * (`vlist-permission-prediction` → `measureInlinePermission`), and its height model counts each
 * textarea row as the xs size on the base line box at the reader's line-height setting
 * (`typographyMetrics().line.xsBase`: 22px at the default). Mantine's textarea painted its own
 * 1.55 × font size instead (18.6px), whatever the setting, so every card came out shorter than
 * reserved — about 3px a row at the default, more at a larger setting — and the row was corrected
 * a frame later. The owner chose (D49, 2026-11-06) that the textarea follows the setting and the
 * model stays as it is: here it takes the same size, line box and letter spacing the model counts
 * (`TYPE_ROLE_STYLE.textarea`, the `--nf-type-*` variables), and no `min-height` of Mantine's own,
 * so a box is exactly `rows × line + padding + border` at a small setting too.
 *
 * Only inside the transcript: the vlist's bridge (`vlist-permission-bridge.tsx`) wraps every
 * form it mounts in {@link TranscriptPermissionTypography}. The same cards elsewhere (the question
 * inbox) keep Mantine's textarea.
 */
import { getTypographyRevision, onTypographyChange } from "@shared/pretext-layout/typography";
import {
	type CSSProperties,
	createContext,
	type ReactNode,
	useContext,
	useSyncExternalStore,
} from "react";
import { ensureTypographyCssVars, TYPE_ROLE_STYLE } from "../../../lib/typography-css-vars";

// The textareas paint with the reader's typography variables.
ensureTypographyCssVars();

const InTranscript = createContext(false);

/** Marks a permission form as mounted in the transcript (see the module note). */
export function TranscriptPermissionTypography({ children }: { children: ReactNode }) {
	return <InTranscript.Provider value={true}>{children}</InTranscript.Provider>;
}

const TRANSCRIPT_TEXTAREA_INPUT: CSSProperties = { ...TYPE_ROLE_STYLE.textarea, minHeight: 0 };

const subscribeNothing = () => () => {};

/**
 * The input style a permission card's textarea adds in the transcript (spread it last into the
 * Textarea's `styles.input`), or undefined elsewhere.
 *
 * Subscribes to the typography: the autosize recomputes its height on every render from the
 * computed style, and a slider drag changes only the variables, which re-render nothing.
 */
export function usePermissionTextareaStyle(): CSSProperties | undefined {
	const inTranscript = useContext(InTranscript);
	useSyncExternalStore(inTranscript ? onTypographyChange : subscribeNothing, getTypographyRevision);
	return inTranscript ? TRANSCRIPT_TEXTAREA_INPUT : undefined;
}
