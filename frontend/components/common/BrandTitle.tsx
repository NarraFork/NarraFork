/**
 * The instance name, with a "powered by NarraFork" attribution line when it has
 * been customized.
 *
 * Shared by the app header (desktop and mobile variants) and the login page so the
 * three surfaces cannot drift apart on either the name or the attribution rule.
 *
 * ## The height constraint
 *
 * `AppShell.Header` is a fixed 60px (`APP_SHELL_HEADER_HEIGHT`), and that constant
 * is asserted by `frontend/lib/safe-area.test.ts` — the attribution line must fit
 * INSIDE the existing header rather than grow it. Hence the explicit line heights:
 * a `Title order={3}` at its default ~1.35 line-height plus a second line would
 * overflow, so the title is tightened to 1.1 (≈22px at 20px font) and the
 * attribution is a 9px line at line-height 1. Total ≈31px, comfortably within the
 * 60px band that `Group h="100%"` centers content in.
 *
 * Do not replace `gap={0}` with a spacing utility: any gap adds to that total,
 * which is the one dimension that cannot grow here.
 *
 * ## Why it forwards a ref and spreads the rest
 *
 * The header wraps this in a `Tooltip`, which `cloneElement`s its child with a ref
 * plus `onMouseEnter`/`onMouseLeave`/`onClick`. A component that swallowed those
 * would leave the sidebar-collapse tooltip silently dead — it renders fine and
 * simply never appears. So the outer element takes the ref and every unlisted prop.
 */

import { Stack, type StackProps, Text, Title } from "@mantine/core";
import { DEFAULT_BRAND_NAME } from "@shared/branding";
import { forwardRef } from "react";
import { useBranding } from "../../hooks/useBranding";

export interface BrandTitleProps extends Omit<StackProps, "children" | "gap"> {
	/** Mantine heading order. The header uses 3, the login card uses 2. */
	order?: 1 | 2 | 3 | 4 | 5 | 6;
	/** Center both lines — used by the login card. */
	centered?: boolean;
}

export const BrandTitle = forwardRef<HTMLDivElement, BrandTitleProps>(function BrandTitle(
	{ order = 3, centered, ...stackProps },
	ref,
) {
	const branding = useBranding();
	// Attribution is tied to the NAME, not to `customized`: renaming is what removes
	// "NarraFork" from view, whereas a recoloured icon leaves the name intact and
	// needs no attribution line.
	const renamed = branding.name !== DEFAULT_BRAND_NAME;

	return (
		<Stack ref={ref} gap={0} {...stackProps}>
			<Title
				order={order}
				ta={centered ? "center" : undefined}
				// Tightened only when the second line is present, so an unbranded
				// instance keeps the exact typography it had before.
				style={renamed ? { lineHeight: 1.1 } : undefined}
			>
				{branding.name}
			</Title>
			{renamed && (
				<Text
					fz={9}
					c="dimmed"
					ta={centered ? "center" : undefined}
					style={{ lineHeight: 1, userSelect: "none", whiteSpace: "nowrap" }}
				>
					powered by NarraFork
				</Text>
			)}
		</Stack>
	);
});
