import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { PublicShareMarkdown } from "./PublicShareMarkdown";

const translations = createInstance();
await translations.init({
	lng: "en",
	resources: { en: { publicShare: { mediaOmitted: "MEDIA OMITTED" } } },
});
function render(text: string) {
	return renderToStaticMarkup(
		<I18nextProvider i18n={translations}>
			<PublicShareMarkdown text={text} />
		</I18nextProvider>,
	);
}

describe("anonymous markdown pure rendering", () => {
	test("images become inert placeholders, including remote and internal resources", () => {
		const html = render(
			"![external](https://attacker.test/track.png)\n\n![internal](/api/uploads/private)\n\n![file](nf-file://open?path=secret)",
		);
		expect(html).not.toContain("<img");
		expect(html).not.toContain("src=");
		expect(html.match(/MEDIA OMITTED/g)?.length).toBe(3);
	});
	test("raw active HTML is never mounted", () => {
		const html = render(
			'<iframe src="https://attacker.test"></iframe>\n\n<script>alert(1)</script>\n\n<img src="/api/files">',
		);
		expect(html).not.toContain("<iframe");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("<img");
	});
	test("relative and file links become text while external links suppress referrers", () => {
		const html = render(
			"[private](/narrators/secret) [local](nf-file://open) [external](https://docs.test/page)",
		);
		expect(html).toContain("<span>private</span>");
		expect(html).toContain("<span>local</span>");
		expect(html).toContain('href="https://docs.test/page"');
		expect(html).toContain('rel="noopener noreferrer"');
		expect(html).toContain('referrerPolicy="no-referrer"');
	});
	test("code remains text, not executable HTML", () => {
		const html = render('```html\n<img src="/api/private" onerror="alert(1)">\n```');
		expect(html).toContain("&lt;img");
		expect(html).not.toContain("<img");
	});
});
