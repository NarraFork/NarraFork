import { describe, expect, it } from "bun:test";
import { DockviewDefaultTab, type IDockviewPanelHeaderProps } from "dockview-react";
import i18next from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { DefaultSurfaceTab, withSurfaceTabMenu } from "./SurfaceTab";

function ChatTab(props: IDockviewPanelHeaderProps) {
	return <span data-custom-tab>{props.api.title}</span>;
}

describe("shared surface tab wrapper", () => {
	it("keeps stable identities for both default and custom renderers", () => {
		expect(withSurfaceTabMenu(DockviewDefaultTab)).toBe(DefaultSurfaceTab);
		expect(withSurfaceTabMenu(ChatTab)).toBe(withSurfaceTabMenu(ChatTab));
		expect(withSurfaceTabMenu(ChatTab)).not.toBe(DefaultSurfaceTab);
	});
	it("preserves a custom close-less tab and forwards its props", () => {
		const Tab = withSurfaceTabMenu(ChatTab);
		const props = { api: { title: "Protagonist" } } as IDockviewPanelHeaderProps;
		const i18n = i18next.createInstance();
		void i18n.init({ lng: "en", resources: { en: { common: {} } }, initImmediate: false });
		const html = renderToStaticMarkup(
			<I18nextProvider i18n={i18n}>
				<Tab {...props} />
			</I18nextProvider>,
		);
		expect(html).toContain("Protagonist");
		expect(html).toContain("data-custom-tab");
		expect(html).not.toContain("button");
	});
});
