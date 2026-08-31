/**
 * The image viewer's context and consumer hook, split out of `ImageViewerProvider.tsx`.
 *
 * WHY THE SPLIT
 * ------------
 * `@vitejs/plugin-react` only treats a module as a VALID Fast Refresh boundary when every
 * export is a component. `useImageViewer` is a hook, so keeping it beside the provider
 * produced, on any edit that propagated through the app shell:
 *
 *     invalidate /components/common/ImageViewerProvider.tsx: Could not Fast Refresh
 *       ("useImageViewer" export is incompatible)
 *
 * The provider is mounted in `App.tsx`, so that invalidation sat directly on the app
 * shell's path and downgraded shell edits to full page reloads.
 *
 * The context stays registry-keyed (`createSharedContext`) for the separate reason
 * documented below: identity must survive re-evaluation, whichever module holds it.
 */

import { useContext } from "react";
import { createSharedContext } from "../../lib/shared-context";

/**
 * Options describing the image to open in the fullscreen viewer.
 *
 * `src` is the directly-displayable URL (blob:/data:/http(s)/relative). It is
 * used both for on-screen rendering and as the primary source for copy/download.
 * `savedPath` is an optional server-side file path used as a fallback source for
 * copy/download when `src` is a bounded preview that may not be the full image.
 */
export interface ImageViewerOptions {
	src: string;
	/** Optional server file path fetched via /api/fs/preview for copy/download. */
	savedPath?: string | null;
	/** Suggested download filename (extension optional). */
	filename?: string | null;
	/** Accessible alt text / title. */
	alt?: string | null;
}

export interface ImageViewerContextValue {
	open: (options: ImageViewerOptions) => void;
}

/**
 * Registry-keyed so a Fast Refresh re-evaluation (or a duplicated production
 * chunk) cannot split provider and consumer across two context objects. The
 * viewer is opened from lazily-mounted subtrees — vlist rows, Dockview workspace
 * panels — that load long after the app shell mounted the provider, which is exactly
 * where a fresh context object used to surface as "must be used within
 * ImageViewerProvider". See `lib/shared-context.ts`.
 */
export const ImageViewerContext = createSharedContext<ImageViewerContextValue | null>(
	"common/ImageViewerProvider",
	null,
);

export function useImageViewer() {
	const ctx = useContext(ImageViewerContext);
	if (!ctx) {
		throw new Error("useImageViewer must be used within ImageViewerProvider");
	}
	return ctx.open;
}
