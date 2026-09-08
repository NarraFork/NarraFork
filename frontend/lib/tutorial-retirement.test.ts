import { describe, expect, test } from "bun:test";
import { isRedirect } from "@tanstack/react-router";
import { Route as LessonRoute } from "../routes/tutorial/$lessonId";
import { Route as OverviewRoute } from "../routes/tutorial/index";

// Exercise the actual route guards, without mounting the authenticated app shell.
describe("retired tutorial bookmarks", () => {
	for (const [name, route] of [
		["overview", OverviewRoute],
		["lesson", LessonRoute],
	] as const) {
		test(`${name} replaces the old URL with the learning guide`, () => {
			expect(route.options.component).toBeUndefined();
			expect(route.options.loader).toBeUndefined();
			expect(route.options.beforeLoad).toBeFunction();
			try {
				route.options.beforeLoad?.({} as never);
				throw new Error("The retired route did not redirect");
			} catch (error) {
				expect(isRedirect(error)).toBe(true);
				if (!isRedirect(error)) throw error;
				expect(error.options.to).toBe("/learn");
				expect(error.options.replace).toBe(true);
			}
		});
	}
});
