import { Hono } from "hono";
import { db, type PaperRow } from "../db.js";
import { FIELD_COMPUTER_SCIENCE, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX } from "../constants.js";

// GET /api/fields/17/search — 論文名・著者名の検索（SPEC.md 5章）。
// 検索方式は D1 の LIKE を初期採用（ARCHITECT.md 7-5）。将来的に速度が問題になれば転置インデックス等を検討する。
// 著者名は authorships テーブル（migrations/0004、1論文に複数行）を LEFT JOIN し、
// タイトルまたは著者名のどちらかに部分一致すればヒットさせる。1論文に複数の著者がマッチしうるため DISTINCT で重複を除く。
// authorships テーブルへの実データ投入は S3 からの ingest 実装時に行う想定（それまでは LEFT JOIN 先が常に空でもタイトル検索は従来通り動作する）。
export const searchRoute = new Hono<{ Bindings: Env }>().get("/", async (c) => {
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

	const { results } = await db(c.env)
		.prepare(
			`SELECT DISTINCT p.id, p.field, p.title, p.year, p.cit, p.fwci, p.subfield, p.child_cnt, p.doi
			 FROM papers p
			 LEFT JOIN authorships a ON a.paper_id = p.id
			 WHERE p.field = ? AND (p.title LIKE ? ESCAPE '\\' OR a.author_name LIKE ? ESCAPE '\\')
			 ORDER BY p.cit DESC LIMIT ?`,
		)
		.bind(FIELD_COMPUTER_SCIENCE, pattern, pattern, limit)
		.all<PaperRow>();

	return c.json({ papers: results });
});
