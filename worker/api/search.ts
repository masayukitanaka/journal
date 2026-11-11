import { Hono } from "hono";
import { resolveFieldDb, type PaperRow } from "../db.js";
import { SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX } from "../constants.js";

// GET /api/fields/:field/search — 論文名・著者名・キーワードの検索（SPEC.md 5章）。
// 検索方式は D1 の LIKE を初期採用（ARCHITECT.md 7-5）。将来的に速度が問題になれば転置インデックス等を検討する。
// 著者名（authorships、migrations/0004）・キーワード（paper_keywords/keywords、migrations/0005）は
// それぞれ EXISTS サブクエリで判定する（2026-11-11、キーワード対応追加。JOIN だと1論文に複数の著者・
// キーワードがマッチして行が掛け算で増えるため、素朴な LEFT JOIN + DISTINCT より EXISTS の方が安全）。
export const searchRoute = new Hono<{ Bindings: Env }>().get("/fields/:field/search", async (c) => {
	const resolved = resolveFieldDb(c.env, c.req.param("field"), c.req.query("yearRange"));
	if (!resolved.ok) {
		return c.json({ error: resolved.error }, resolved.status);
	}
	const { db: database, field } = resolved;

	const q = c.req.query("q");
	const limitParam = c.req.query("limit") ? Number(c.req.query("limit")) : SEARCH_LIMIT_DEFAULT;

	if (!q || q.trim().length === 0) {
		return c.json({ error: "'q' parameter is required" }, 400);
	}
	if (!Number.isInteger(limitParam) || limitParam <= 0) {
		return c.json({ error: "invalid 'limit' parameter" }, 400);
	}
	const limit = Math.min(limitParam, SEARCH_LIMIT_MAX);

	// LIKE の特殊文字（% _）はエスケープし、素朴な部分一致検索として扱う。
	const escaped = q.replace(/[%_]/g, (ch) => `\\${ch}`);
	const pattern = `%${escaped}%`;

	const { results } = await database
		.prepare(
			`SELECT p.id, p.field, p.title, p.year, p.cit, p.fwci, p.subfield, p.child_cnt, p.doi
			 FROM papers p
			 WHERE p.field = ?
			   AND (
			     p.title LIKE ? ESCAPE '\\'
			     OR EXISTS (SELECT 1 FROM authorships a WHERE a.paper_id = p.id AND a.author_name LIKE ? ESCAPE '\\')
			     OR EXISTS (
			       SELECT 1 FROM paper_keywords pk JOIN keywords k ON k.id = pk.keyword_id
			       WHERE pk.paper_id = p.id AND k.name LIKE ? ESCAPE '\\'
			     )
			   )
			 ORDER BY p.cit DESC LIMIT ?`,
		)
		.bind(field, pattern, pattern, pattern, limit)
		.all<PaperRow>();

	return c.json({ papers: results });
});
