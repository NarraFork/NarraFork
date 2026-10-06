/**
 * The confirm dialog's context and consumer hook, split out of
 * `ConfirmDialogProvider.tsx`.
 *
 * WHY THE SPLIT
 * ------------
 * `@vitejs/plugin-react` only treats a module as a VALID Fast Refresh boundary when every
 * export is a component. `useConfirmDialog` is a hook, so keeping it beside the provider
 * made the module an invalid boundary — and since the provider is mounted in `App.tsx`,
 * that invalidation sat on the app shell's own propagation path, downgrading shell edits
 * to full page reloads. Same shape as `image-viewer-context.ts`.
 *
 * The context stays registry-keyed (`createSharedContext`) for the separate reason
 * documented below: identity must survive re-evaluation, whichever module holds it.
 */

import type { ReactNode } from "react";
import { useContext } from "react";
import { createSharedContext } from "../../lib/shared-context";

export interface ConfirmOptions {
	message: ReactNode;
	title?: ReactNode;
	confirmLabel?: ReactNode;
	cancelLabel?: ReactNode;
	confirmColor?: string;
}

export interface PendingConfirm extends ConfirmOptions {
	resolve: (confirmed: boolean) => void;
}

export interface ConfirmDialogContextValue {
	confirm: (options: ConfirmOptions) => Promise<boolean>;
}

/**
 * Registry-keyed for the same reason as the image viewer: the provider is mounted
 * once by the app shell, while `useConfirmDialog()` is called from lazily-loaded
 * route chunks and dock panels. See `lib/shared-context.ts`.
 */
export const ConfirmDialogContext = createSharedContext<ConfirmDialogContextValue | null>(
	"common/ConfirmDialogProvider",
	null,
);

export function useConfirmDialog() {
	const context = useContext(ConfirmDialogContext);
	if (!context) {
		throw new Error("useConfirmDialog must be used within ConfirmDialogProvider");
	}
	return context.confirm;
}
