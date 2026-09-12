import { Anchor, Group } from "@mantine/core";

export function InlineOverrideActions({
	visible,
	disabled,
	onFollowDefault,
	onSetAsDefault,
	t,
}: {
	visible: boolean;
	disabled: boolean;
	onFollowDefault: () => void;
	onSetAsDefault: () => void;
	t: (key: string) => string;
}) {
	if (!visible) return null;
	const linkStyle = {
		textDecoration: "underline",
		opacity: disabled ? 0.45 : 1,
		pointerEvents: disabled ? "none" : "auto",
	} as const;
	return (
		<Group justify="space-between" mt={4} wrap="nowrap" style={{ width: "100%" }}>
			<Anchor
				component="button"
				type="button"
				size="xs"
				c="dimmed"
				style={linkStyle}
				onClick={(event) => {
					event.stopPropagation();
					onFollowDefault();
				}}
			>
				{t("override_followDefault")}
			</Anchor>
			<Anchor
				component="button"
				type="button"
				size="xs"
				c="dimmed"
				style={linkStyle}
				onClick={(event) => {
					event.stopPropagation();
					onSetAsDefault();
				}}
			>
				{t("override_setAsDefault")}
			</Anchor>
		</Group>
	);
}
