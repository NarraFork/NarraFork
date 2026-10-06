import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { type SharePreviewRef, sharePreviewHeight } from "@shared/share-preview";
import i18next from "i18next";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { ImageViewerContext } from "../../frontend/components/common/image-viewer-context";
import { ShareFilePreview } from "../../frontend/components/narrator/vlist/render/ShareFilePreview";
import en from "../../frontend/locales/en/narrator.json";

const i18n = i18next.createInstance();
await i18n.init({
	lng: "en",
	resources: { en: { narrator: en } },
	interpolation: { escapeValue: false },
});
const fixtures: Record<string, SharePreviewRef> = await (await fetch("/fixtures")).json();
const root = createRoot(document.getElementById("root") as HTMLElement);
root.render(
	<MantineProvider forceColorScheme="dark">
		<I18nextProvider i18n={i18n}>
			<ImageViewerContext.Provider value={{ open() {} }}>
				{Object.entries(fixtures).map(([name, preview]) => (
					<section key={name} data-case={name} style={{ width: 600, margin: 16 }}>
						<h2>{name}</h2>
						<ShareFilePreview preview={preview} height={sharePreviewHeight(preview.kind, 600)} />
					</section>
				))}
			</ImageViewerContext.Provider>
		</I18nextProvider>
	</MantineProvider>,
);
Object.assign(window, { sharePreviewHarness: { unmount: () => root.unmount() } });
