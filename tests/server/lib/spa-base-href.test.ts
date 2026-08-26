import { describe, expect, it } from "bun:test";
import {
	computeSpaBaseHref,
	injectSpaBaseHref,
	spaRedirectLocation,
} from "@server/lib/spa-base-href";

describe("computeSpaBaseHref", () => {
	it("uses './' at the mount root", () => {
		expect(computeSpaBaseHref("/")).toBe("./");
		expect(computeSpaBaseHref("")).toBe("./");
	});

	it("treats a final segment without a trailing slash as the document, not a directory", () => {
		// The browser resolves relative URLs against the document's DIRECTORY, so
		// `/projects` needs no climbing at all — its directory is already the root.
		expect(computeSpaBaseHref("/projects")).toBe("./");
		expect(computeSpaBaseHref("/login")).toBe("./");
	});

	it("climbs one level per directory segment", () => {
		expect(computeSpaBaseHref("/projects/abc")).toBe("../");
		expect(computeSpaBaseHref("/projects/")).toBe("../");
		expect(computeSpaBaseHref("/projects/abc/chapters/xyz")).toBe("../../../");
		expect(computeSpaBaseHref("/narrators/abc/archive")).toBe("../../");
	});

	it("ignores empty segments a proxy chain may introduce", () => {
		// `//projects//abc` must count the same as `/projects/abc`; counting the empty
		// segments would emit one `../` too many and climb past the mount root.
		expect(computeSpaBaseHref("//projects//abc")).toBe("../");
		expect(computeSpaBaseHref("///")).toBe("./");
	});

	it("never returns a rooted href", () => {
		// A rooted value would re-introduce the assumption this module exists to remove:
		// under a proxy prefix it points at the proxy's root, not ours.
		for (const path of ["/", "/projects", "/projects/abc", "/a/b/c/d/e"]) {
			expect(computeSpaBaseHref(path).startsWith("/")).toBe(false);
		}
	});
});

describe("spaRedirectLocation", () => {
	/**
	 * Where a browser actually ends up: resolve the `Location` we emit against the URL
	 * the browser requested, which under a prefix INCLUDES that prefix.
	 *
	 * Asserting the resolved destination rather than the header string is the point — a
	 * `../` miscount produces a plausible-looking header and a wrong landing page.
	 */
	function landsOn(requestPath: string, target: string, mountPrefix = ""): string {
		const location = spaRedirectLocation(requestPath, target);
		const resolved = new URL(location, `https://h${mountPrefix}${requestPath}`);
		return `${resolved.pathname}${resolved.search}`;
	}

	it("reaches the app route at the origin root", () => {
		expect(landsOn("/api/auth/sso/callback", "/login?sso_error=x")).toBe("/login?sso_error=x");
		expect(landsOn("/api/nug/oauth/callback", "/settings/providers?oauth_success=p")).toBe(
			"/settings/providers?oauth_success=p",
		);
	});

	it("reaches the same app route under a mount prefix", () => {
		// The whole reason this function exists: a rooted `/login` would land on the
		// PROXY's `/login`, i.e. outside NarraFork, at the end of a successful login.
		expect(landsOn("/api/auth/sso/callback", "/login?sso_error=x", "/nf")).toBe(
			"/nf/login?sso_error=x",
		);
		expect(
			landsOn("/api/auth/sso/callback", "/settings/security?sso_linked=1", "/proxy/7778"),
		).toBe("/proxy/7778/settings/security?sso_linked=1");
	});

	it("counts depth from the path WE received, whatever its length", () => {
		// `/:providerId/start` is one segment deeper than the callback, so a fixed climb
		// would be right for one route and wrong for the other.
		expect(landsOn("/api/auth/sso/google/start", "/login?sso_error=y", "/nf")).toBe(
			"/nf/login?sso_error=y",
		);
	});

	it("never emits a rooted Location", () => {
		for (const path of ["/api/auth/sso/callback", "/api/nug/oauth/callback", "/x"]) {
			expect(spaRedirectLocation(path, "/login").startsWith("/")).toBe(false);
		}
	});

	it("accepts a target with or without its leading slash", () => {
		expect(spaRedirectLocation("/api/x", "/login")).toBe(spaRedirectLocation("/api/x", "login"));
	});
});

describe("injectSpaBaseHref", () => {
	const html = [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="UTF-8" />',
		'<link rel="icon" href="./favicon.svg" />',
		"</head>",
		'<body><div id="root"></div><script type="module" src="./assets/index.js"></script></body>',
		"</html>",
	].join("\n");

	it("inserts the base element immediately after <head>", () => {
		const out = injectSpaBaseHref(html, "/projects/abc");
		expect(out).toContain('<head><base href="../">');
	});

	it("places the base BEFORE the icon links so they resolve against the mount root", () => {
		// `<base>` only affects references that follow it. The icon links live at the
		// top of this document's head, so appending near </head> would leave exactly
		// those two resolving against the wrong directory.
		const out = injectSpaBaseHref(html, "/projects/abc");
		expect(out.indexOf("<base")).toBeLessThan(out.indexOf('rel="icon"'));
	});

	it("replaces an existing base element instead of adding a second one", () => {
		// Browsers honour only the FIRST <base>, so a second one would be inert and the
		// stale value would keep winning while the source looked correct.
		const withBase = html.replace("<head>", '<head><base href="./">');
		const out = injectSpaBaseHref(withBase, "/projects/abc/chapters/x");
		expect(out.match(/<base\b/g)?.length).toBe(1);
		expect(out).toContain('<base href="../../../">');
	});

	it("leaves a document without <head> untouched", () => {
		const noHead = "<html><body>hi</body></html>";
		expect(injectSpaBaseHref(noHead, "/projects/abc")).toBe(noHead);
	});

	it("keeps the rest of the document byte-identical", () => {
		const out = injectSpaBaseHref(html, "/");
		expect(out.replace('<base href="./">', "")).toBe(html);
	});

	/*
	 * ⚠️ Everything above runs on a synthetic 9-line document, and that is exactly how
	 * the bug below shipped: the real `index.html` has a head comment explaining why the
	 * icon hrefs are relative, and that prose MENTIONS `<base>`. The "already has a
	 * base" regex matched the comment, so the injector replaced that text — writing the
	 * real tag INSIDE the comment. Served HTML then had no effective `<base>` at all and
	 * every deep link 404'd its entry script (blank page), while the tag was plainly
	 * visible in the source.
	 *
	 * So the contract is asserted against the SHIPPED document too. A fixture cannot
	 * stand in for it: the failure came from content the fixture did not have.
	 */
	describe("against the real app shell", () => {
		/** `<base>` written into a comment is inert, so comments are stripped first. */
		function effectiveBase(out: string): string | null {
			return out.replace(/<!--[\s\S]*?-->/g, "").match(/<base[^>]*>/)?.[0] ?? null;
		}

		it("produces an EFFECTIVE base element, not one buried in a comment", async () => {
			const shell = await Bun.file("frontend/index.html").text();
			for (const [path, href] of [
				["/", "./"],
				["/login", "./"],
				["/projects/abc", "../"],
				["/narrators/abc/archive", "../../"],
			] as const) {
				expect(effectiveBase(injectSpaBaseHref(shell, path))).toBe(`<base href="${href}">`);
			}
		});

		it("puts the effective base before the icon links", async () => {
			// Same requirement as the fixture case, re-checked on the document that
			// actually carries those links.
			const out = injectSpaBaseHref(await Bun.file("frontend/index.html").text(), "/projects/abc");
			const withoutComments = out.replace(/<!--[\s\S]*?-->/g, "");
			expect(withoutComments.indexOf("<base")).toBeLessThan(withoutComments.indexOf('rel="icon"'));
		});

		it("adds exactly one real base element, however often the shell mentions one", async () => {
			const out = injectSpaBaseHref(await Bun.file("frontend/index.html").text(), "/projects/abc");
			const real = out.replace(/<!--[\s\S]*?-->/g, "").match(/<base\b/g) ?? [];
			expect(real).toHaveLength(1);
		});
	});

	describe("comment handling", () => {
		it("does not treat a mentioned <base> in a comment as an existing element", () => {
			// The minimal reproduction of the shipped bug, kept separate from the shell
			// test so it still fails if `frontend/index.html` ever drops the comment.
			const withMention = html.replace(
				"<head>",
				"<head>\n<!-- resolved against the <base> the server injects -->",
			);
			const out = injectSpaBaseHref(withMention, "/projects/abc");
			// The comment is untouched, and a real tag exists outside it.
			expect(out).toContain("<!-- resolved against the <base> the server injects -->");
			expect(out.replace(/<!--[\s\S]*?-->/g, "")).toContain('<base href="../">');
		});

		it("still replaces a real element when a comment also mentions one", () => {
			// Order matters: the comment comes FIRST, so a comment-blind scan would stop
			// there and leave the real (stale) tag in place — the browser would honour the
			// stale value and the page would look correctly patched.
			const withBoth = html.replace(
				"<head>",
				'<head>\n<!-- see <base> notes -->\n<base href="./">',
			);
			const out = injectSpaBaseHref(withBoth, "/projects/abc");
			const withoutComments = out.replace(/<!--[\s\S]*?-->/g, "");
			expect(withoutComments.match(/<base\b/g)).toHaveLength(1);
			expect(withoutComments).toContain('<base href="../">');
			expect(withoutComments).not.toContain('<base href="./">');
		});

		it("ignores a <head> that only appears inside a comment", () => {
			const commentedHead = '<!-- <head> --><html><head><meta charset="UTF-8" /></head></html>';
			const out = injectSpaBaseHref(commentedHead, "/projects/abc");
			expect(out).toContain('<head><base href="../">');
			expect(out.indexOf("<base")).toBeGreaterThan(out.indexOf("-->"));
		});
	});
});
