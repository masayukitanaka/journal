import { Hono } from "hono";
import { resolveFieldDb, type PaperRow } from "../db.js";
import { TOP_LIMIT_DEFAULT, TOP_LIMIT_MAX } from "../constants.js";

// GET /api/fields/:field/top — 被引用の上位論文（SPEC.md 5章）
export const topRoute = new Hono<{ Bindings: Env }>().get("/fields/:field/top", async (c) => {
	const resolved = resolveFieldDb(c.env, c.req.param("field"), c.req.query("yearRange"));
	if (!resolved.ok) {
		return c.json({ error: resolved.error }, resolved.status);
	}
	const { db: database, field } = resolved;

	const fromYear = c.req.query("from") ? Number(c.req.query("from")) : undefined;
	const limitParam = c.req.query("limit") ? Number(c.req.query("limit")) : TOP_LIMIT_DEFAULT;

	if (fromYear !== undefined && !Number.isInteger(fromYear)) {
		return c.json({ error: "invalid 'from' parameter" }, 400);
	}
	if (!Number.isInteger(limitParam) || limitParam <= 0) {
		return c.json({ error: "invalid 'limit' parameter" }, 400);
	}
	const limit = Math.min(limitParam, TOP_LIMIT_MAX);

	const query = fromYear
		? database
				.prepare(
					"SELECT id, field, title, year, cit, fwci, subfield, child_cnt, doi FROM papers WHERE field = ? AND year >= ? ORDER BY cit DESC LIMIT ?",
				)
				.bind(field, fromYear, limit)
		: database
				.prepare(
					"SELECT id, field, title, year, cit, fwci, subfield, child_cnt, doi FROM papers WHERE field = ? ORDER BY cit DESC LIMIT ?",
				)
				.bind(field, limit);

	const { results } = await query.all<PaperRow>();

	return c.json(
		{ papers: results },
		200,
		{ "Cache-Control": "public, max-age=3600" }, // SPEC.md 5.1: 上位・ハブの一覧は 1 時間
	);
});
