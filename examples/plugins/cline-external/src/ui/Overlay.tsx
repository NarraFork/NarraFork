/** @jsxImportSource ./shim */

/**
 * A dialog that stays inside the panel.
 *
 * ## Why not Mantine `Modal`
 *
 * The panel is mounted in an iframe with a fixed height and `overflow: hidden`. Mantine's
 * `Modal` portals to `document.body` — the *iframe's* body — and sizes itself against the
 * viewport, so anything taller than the frame is silently clipped with no way to scroll to
 * it.
 *
 * This component is absolutely positioned against the panel's own scroll container, so it can
 * never exceed the visible box, and its body scrolls internally.
 *
 * ## Why not `window.confirm`
 *
 * The iframe is sandboxed with `allow-scripts` only. Without `allow-modals` the browser
 * ignores `confirm`/`alert` entirely and returns `undefined` — a destructive action guarded
 * by `if (!window.confirm(...)) return;` therefore proceeds *unconditionally*. Sign-out is
 * the destructive action this panel guards with `ConfirmOverlay` instead.
 */

import { MantineCore, useEffect } from "./host-runtime";
import { t } from "./strings";

const { Box, Button, Group, Paper, ScrollArea, Stack, Text } = MantineCore;

export interface OverlayProps {
	title: string;
	onClose: () => void;
	children: unknown;
	/** Footer actions. Omitted for a plain informational overlay. */
	footer?: unknown;
}

export function PanelOverlay({ title, onClose, children, footer }: OverlayProps) {
	// Escape closes. A dialog that can only be dismissed by finding the right button is worse
	// here than in a normal page, because the panel is small and the button may be scrolled
	// out of view.
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	return (
		<Box
			style={{
				position: "absolute",
				inset: 0,
				zIndex: 200,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				padding: "var(--mantine-spacing-md)",
				background: "rgba(0, 0, 0, 0.6)",
			}}
			// A click on the backdrop closes; clicks inside the panel must not bubble out to it.
			onClick={onClose}
		>
			<Paper
				withBorder
				radius="md"
				shadow="md"
				onClick={(event: { stopPropagation: () => void }) => event.stopPropagation()}
				style={{
					width: "100%",
					maxWidth: 620,
					// Never taller than the frame; the body scrolls instead.
					maxHeight: "100%",
					display: "flex",
					flexDirection: "column",
					overflow: "hidden",
				}}
			>
				<Box p="sm" style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
					<Text fw={600} size="sm">
						{title}
					</Text>
				</Box>
				<ScrollArea.Autosize mah="100%" style={{ flex: 1 }}>
					<Box p="sm">{children}</Box>
				</ScrollArea.Autosize>
				{footer ? (
					<Box p="sm" style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}>
						{footer}
					</Box>
				) : null}
			</Paper>
		</Box>
	);
}

export interface ConfirmOverlayProps {
	message: string;
	confirmLabel?: string;
	confirmColor?: string;
	loading?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}

/** Replacement for `window.confirm`, used for sign-out in this panel. */
export function ConfirmOverlay({
	message,
	confirmLabel,
	confirmColor = "red",
	loading,
	onConfirm,
	onCancel,
}: ConfirmOverlayProps) {
	return (
		<PanelOverlay
			title={t("confirmTitle")}
			onClose={onCancel}
			footer={
				<Group justify="flex-end" gap="xs">
					<Button size="xs" variant="default" onClick={onCancel}>
						{t("confirmCancel")}
					</Button>
					<Button size="xs" color={confirmColor} loading={loading} onClick={onConfirm}>
						{confirmLabel ?? t("confirmOk")}
					</Button>
				</Group>
			}
		>
			<Stack gap="xs">
				<Text size="sm">{message}</Text>
			</Stack>
		</PanelOverlay>
	);
}
