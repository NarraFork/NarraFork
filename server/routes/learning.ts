import {
	getLearningCategories,
	getLearningDoc,
	getLearningDocSummaries,
	searchLearningDocs,
} from "@shared/learning-content";
import { Hono } from "hono";

export const learningRoutes = new Hono();

learningRoutes.get("/", (c) => {
	const lang = c.req.query("lang");
	return c.json({
		categories: getLearningCategories(lang),
		docs: getLearningDocSummaries(lang),
	});
});

learningRoutes.get("/search", (c) => {
	const lang = c.req.query("lang");
	const query = c.req.query("q") ?? "";
	return c.json({ results: searchLearningDocs(query, lang) });
});

learningRoutes.get("/:id", (c) => {
	const lang = c.req.query("lang");
	const doc = getLearningDoc(c.req.param("id"), lang);
	if (!doc) return c.json({ error: "Learning document not found" }, 404);
	return c.json(doc);
});
