/**
 * Instance identity settings: the display name and the icon accent colour.
 *
 * Instance-level (stored in `settings.json`, admin-only via the PATCH route)
 * rather than a per-user preference: "which deployment am I looking at" is a
 * property of the deployment, and every user of one instance must see the same
 * answer.
 *
 * The preview is rendered locally from the shipped SVG's single accent fill
 * (`recolorBrandSvg`), so dragging the colour picker responds instantly instead of
 * waiting for the server to re-encode PNGs. The server does the same substitution
 * for the SVG and a pixel-accurate equivalent for the PNGs — see
 * `server/lib/branding/png-recolor.ts`.
 */

import { ColorInput, Group, Paper, Stack, Text, TextInput, Title } from "@mantine/core";
import {
	BRAND_NAME_MAX_LENGTH,
	DEFAULT_BRAND_ICON_COLOR,
	DEFAULT_BRAND_NAME,
	recolorBrandSvg,
} from "@shared/branding";
import { useTranslation } from "react-i18next";

/**
 * The shipped `favicon.svg`, inlined for the preview.
 *
 * Inlined rather than fetched so the preview cannot show a stale icon: fetching
 * `/favicon.svg` would hit the browser cache, and fetching `/api/branding/...`
 * would show the SAVED colour rather than the one being edited.
 *
 * Kept byte-identical to `frontend/public/favicon.svg`; a test asserts they match
 * so a future logo change cannot leave the preview showing the old mark.
 */
const BRAND_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#4c6ef5"/>
  <g fill="none" stroke="#fff" stroke-width="32" stroke-linecap="round" stroke-linejoin="round">
    <path d="M256 400 V200"/>
    <path d="M256 200 Q256 160 216 130 L176 108"/>
    <path d="M256 200 Q256 160 296 130 L336 108"/>
  </g>
  <circle cx="176" cy="108" r="24" fill="#fff"/>
  <circle cx="336" cy="108" r="24" fill="#fff"/>
  <circle cx="256" cy="400" r="24" fill="#fff"/>
</svg>`;

/** Mantine 6-shade swatches, matching the palette used across the app. */
const COLOR_SWATCHES = [
	DEFAULT_BRAND_ICON_COLOR,
	"#12b886",
	"#40c057",
	"#fab005",
	"#fd7e14",
	"#fa5252",
	"#e64980",
	"#be4bdb",
	"#228be6",
	"#868e96",
];

export interface BrandingSectionProps {
	brandName: string;
	setBrandName: (v: string) => void;
	brandIconColor: string;
	setBrandIconColor: (v: string) => void;
}

export function BrandingSection({
	brandName,
	setBrandName,
	brandIconColor,
	setBrandIconColor,
}: BrandingSectionProps) {
	const { t } = useTranslation("settings");
	const previewSvg = recolorBrandSvg(BRAND_LOGO_SVG, brandIconColor);
	const previewSrc = `data:image/svg+xml,${encodeURIComponent(previewSvg)}`;

	return (
		<Stack>
			<Title order={5} mt="sm">
				{t("brandingSubSection")}
			</Title>
			<Text size="xs" c="dimmed">
				{t("brandingSubSectionDesc")}
			</Text>
			<Group align="flex-start" wrap="nowrap" gap="md">
				<Stack gap="sm" style={{ flex: 1, minWidth: 0 }}>
					<TextInput
						label={t("brandName")}
						description={t("brandNameDesc")}
						placeholder={DEFAULT_BRAND_NAME}
						value={brandName}
						maxLength={BRAND_NAME_MAX_LENGTH}
						onChange={(e) => setBrandName(e.currentTarget.value)}
					/>
					<ColorInput
						label={t("brandIconColor")}
						description={t("brandIconColorDesc")}
						format="hex"
						value={brandIconColor}
						// ColorInput hands back "" while the field is being cleared; treating
						// that as the default keeps the preview and the saved value in a valid
						// state instead of rendering an icon with no fill.
						onChange={(v) => setBrandIconColor(v || DEFAULT_BRAND_ICON_COLOR)}
						swatches={COLOR_SWATCHES}
						swatchesPerRow={10}
					/>
				</Stack>
				<Paper withBorder p="xs" radius="md">
					<Stack gap={6} align="center">
						{/* Decorative: the colour it previews is stated by the controls beside
						    it, so an alt text would only repeat them to a screen reader. */}
						<img src={previewSrc} alt="" width={56} height={56} style={{ display: "block" }} />
						<Text size="xs" c="dimmed">
							{t("brandIconPreview")}
						</Text>
					</Stack>
				</Paper>
			</Group>
		</Stack>
	);
}
