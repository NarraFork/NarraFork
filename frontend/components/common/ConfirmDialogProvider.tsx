import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Z } from "../../lib/z-index";
/*
 * The context, its types and `useConfirmDialog` live in `confirm-dialog-context.ts`.
 *
 * A hook export beside this component makes the module an INVALID Fast Refresh boundary,
 * and this provider is mounted in `App.tsx` — so that invalidation sat on the app shell's
 * own path and turned shell edits into full page reloads. See that file's header.
 */
import {
	ConfirmDialogContext,
	type ConfirmOptions,
	type PendingConfirm,
} from "./confirm-dialog-context";

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
	const { t } = useTranslation("common");
	const [pending, setPending] = useState<PendingConfirm | null>(null);

	const confirm = useCallback((options: ConfirmOptions) => {
		return new Promise<boolean>((resolve) => {
			setPending((current) => {
				current?.resolve(false);
				return { ...options, resolve };
			});
		});
	}, []);

	const close = useCallback(
		(confirmed: boolean) => {
			pending?.resolve(confirmed);
			setPending(null);
		},
		[pending],
	);

	const value = useMemo(() => ({ confirm }), [confirm]);

	return (
		<ConfirmDialogContext.Provider value={value}>
			{children}
			<Modal
				opened={!!pending}
				onClose={() => close(false)}
				title={pending?.title ?? t("confirmTitle")}
				size="sm"
				centered
				zIndex={Z.modal}
			>
				{pending && (
					<Stack>
						{typeof pending.message === "string" ? (
							<Text size="sm">{pending.message}</Text>
						) : (
							pending.message
						)}
						<Group justify="flex-end" gap="xs">
							<Button variant="subtle" onClick={() => close(false)}>
								{pending.cancelLabel ?? t("cancel")}
							</Button>
							<Button color={pending.confirmColor ?? "red"} onClick={() => close(true)}>
								{pending.confirmLabel ?? t("confirm")}
							</Button>
						</Group>
					</Stack>
				)}
			</Modal>
		</ConfirmDialogContext.Provider>
	);
}

// `useConfirmDialog` moved to `confirm-dialog-context.ts` — see the import comment above.
