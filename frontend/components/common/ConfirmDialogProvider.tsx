import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { createSharedContext } from "../../lib/shared-context";
import { Z } from "../../lib/z-index";

interface ConfirmOptions {
	message: ReactNode;
	title?: ReactNode;
	confirmLabel?: ReactNode;
	cancelLabel?: ReactNode;
	confirmColor?: string;
}

interface PendingConfirm extends ConfirmOptions {
	resolve: (confirmed: boolean) => void;
}

interface ConfirmDialogContextValue {
	confirm: (options: ConfirmOptions) => Promise<boolean>;
}

/**
 * Registry-keyed for the same reason as the image viewer: the provider is mounted
 * once in `main.tsx`, while `useConfirmDialog()` is called from lazily-loaded
 * route chunks and dock panels. See `lib/shared-context.ts`.
 */
const ConfirmDialogContext = createSharedContext<ConfirmDialogContextValue | null>(
	"common/ConfirmDialogProvider",
	null,
);

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

export function useConfirmDialog() {
	const context = useContext(ConfirmDialogContext);
	if (!context) {
		throw new Error("useConfirmDialog must be used within ConfirmDialogProvider");
	}
	return context.confirm;
}
