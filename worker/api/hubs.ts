import { Hono } from "hono";
import { resolveFieldDb, type PaperRow } from "../db.js";
import { HUB_MIN_CHILD_DEFAULT, TOP_LIMIT_DEFAULT, TOP_LIMIT_MAX } from "../constants.js";

// GET /api/fields/:field/hubs — 分岐数の上位論文（SPEC.md 5章、2章「ハブ」）
export const hubsRoute = new Hono<{ Bindings: Env }>().get("/fields/:field/hubs", async (c) => {
	const resolved = resolveFieldDb(c.env, c.req.param("field"), c.req.query("yearRange"));
	if (!resolved.ok) {
		return c.json({ error: resolved.error }, resolved.status);
	}
	const { db: database, field } = resolved;

	const minChildParam = c.req.query("minChild")
		? Number(c.req.query("minChild"))
		: HUB_MIN_CHILD_DEFAULT;
	const limitParam = c.req.query("limit") ? Number(c.req.query("limit")) : TOP_LIMIT_DEFAULT;

	if (!Number.isInteger(minChildParam) || minChildParam < 0) {
		return c.json({ error: "invalid 'minChild' parameter" }, 400);
	}
	if (!Number.isInteger(limitParam) || limitParam <= 0) {
		return c.json({ error: "invalid 'limit' parameter" }, 400);
	}
	const limit = Math.min(limitParam, TOP_LIMIT_MAX);

	const { results } = await database
		.prepare(
			"SELECT id, field, title, year, cit, fwci, subfield, child_cnt, doi FROM papers WHERE field = ? AND child_cnt >= ? ORDER BY child_cnt DESC LIMIT ?",
		)
		.bind(field, minChildParam, limit)
		.all<PaperRow>();

	return c.json({ papers: results }, 200, { "Cache-Control": "public, max-age=3600" });
});
