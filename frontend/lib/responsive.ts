/** Mantine's default `sm` breakpoint: desktop rules begin at exactly 48em. */
export const MANTINE_SM_BREAKPOINT_EM = 48;
export const MANTINE_SM_BREAKPOINT_PX = MANTINE_SM_BREAKPOINT_EM * 16;

/** Exact complement of Mantine's `(min-width: 48em)` desktop query. */
export const MOBILE_VIEWPORT_MEDIA_QUERY = `not all and (min-width: ${MANTINE_SM_BREAKPOINT_EM}em)`;

export function isMobileViewportWidth(widthPx: number): boolean {
	return widthPx < MANTINE_SM_BREAKPOINT_PX;
}
