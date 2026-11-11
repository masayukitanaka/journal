import { Hono } from "hono";
import { listAdjacentDbs, resolveFieldDb, type PaperRow } from "../db.js";

// GET /api/fields/:field/paper/{id} — 論文の詳細と系譜（祖先の列）（SPEC.md 2章「系譜」, 5章）
// id（OpenAlex ID）は分野をまたいで一意だが、分野・年代ごとに DB を分けているため、
// どの DB を見るかの指定に :field パスパラメータが必要。
export const paperRoute = new Hono<{ Bindings: Env }>().get("/fields/:field/paper/:id", async (c) => {
	const resolved = resolveFieldDb(c.env, c.req.param("field"), c.req.query("yearRange"));
	if (!resolved.ok) {
		return c.json({ error: resolved.error }, resolved.status);
	}
	const { db: database, field, yearRange } = resolved;
	// 年代境界をまたぐ系譜を補完するため、隣接する年代レンジの DB も検索対象に含める（SPEC.md 4.4）。
	const adjacentDbs = listAdjacentDbs(c.env, field, yearRange);

	const id = Number(c.req.param("id"));
	if (!Number.isInteger(id)) {
		return c.json({ error: "invalid paper id" }, 400);
	}

	// 隣接DBから補完されたノード（SPEC.md 4.4、GraphNode.a）は、現在のメインDBには存在しないことがある
	// ため、見つからなければ隣接DBも順に探す（2026-11-11。これを怠ると隣接ノード選択時に論文詳細
	// ・系譜・著者・キーワードが一切取得できず、選択操作自体が無反応に見えるバグになっていた）。
	const { paper, paperDb } = await resolvePaper(database, adjacentDbs, id);

	if (!paper || !paperDb) {
		return c.json({ error: "paper not found" }, 404);
	}

	const [lineage, authors, keywords] = await Promise.all([
		resolveLineage(paperDb, adjacentDbs, id),
		fetchAuthors(paperDb, id),
		fetchKeywords(paperDb, id),
	]);

	return c.json({ paper, lineage, authors, keywords });
});

async function resolvePaper(
	database: D1Database,
	adjacentDbs: D1Database[],
	id: number,
): Promise<{ paper: PaperRow | null; paperDb: D1Database | null }> {
	for (const db of [database, ...adjacentDbs]) {
		const paper = await db
			.prepare("SELECT id, field, title, year, cit, fwci, subfield, child_cnt, doi FROM papers WHERE id = ?")
			.bind(id)
			.first<PaperRow>();
		if (paper) return { paper, paperDb: db };
	}
	return { paper: null, paperDb: null };
}

// 著者一覧（OpenAlex の authorships 配列順、SPEC.md 4.4）。rowid は ingest 時の INSERT 順と一致し、
// 元データの著者順（筆頭著者が先頭）をそのまま保持しているため、これで並べる（2026-11-11）。
async function fetchAuthors(database: D1Database, paperId: number): Promise<string[]> {
	const { results } = await database
		.prepare("SELECT author_name FROM authorships WHERE paper_id = ? ORDER BY rowid")
		.bind(paperId)
		.all<{ author_name: string }>();
	return results.map((r) => r.author_name);
}

// キーワード一覧（関連度スコア降順、SPEC.md 4.4）。
async function fetchKeywords(database: D1Database, paperId: number): Promise<{ name: string; score: number | null }[]> {
	const { results } = await database
		.prepare(
			`SELECT k.name, pk.score FROM paper_keywords pk JOIN keywords k ON k.id = pk.keyword_id
			 WHERE pk.paper_id = ? ORDER BY pk.score DESC`,
		)
		.bind(paperId)
		.all<{ name: string; score: number | null }>();
	return results;
}

// シードから起点までの祖先の列（SPEC.md 2章「系譜」）。
// 最も被引用数の多い祖先を 1 本の経路として辿る（複数祖先がある場合の経路選択は PoC の簡易仕様）。
// 祖先（cited 側）が現在の DB に無い場合、隣接 DB（前後1年代レンジ、SPEC.md 4.4）も探す。
// edges 自体は常に citing 側（現在のノード）の DB に保存されている前提のため、edges の検索は
// 現在の DB だけで足りる（境界をまたぐのは papers の参照のみ）。
async function resolveLineage(database: D1Database, adjacentDbs: D1Database[], startId: number): Promise<PaperRow[]> {
	const lineage: PaperRow[] = [];
	const visited = new Set<number>([startId]);
	let currentId = startId;

	for (let depth = 0; depth < 20; depth++) {
		const { results: candidateEdges } = await database
			.prepare(`SELECT cited FROM edges WHERE citing = ?`)
			.bind(currentId)
			.all<{ cited: number }>();

		if (candidateEdges.length === 0) break;

		const candidateIds = candidateEdges.map((e) => e.cited).filter((id) => !visited.has(id));
		if (candidateIds.length === 0) break;

		const placeholders = candidateIds.map(() => "?").join(",");
		let candidates: PaperRow[] = [];
		for (const db of [database, ...adjacentDbs]) {
			const { results } = await db
				.prepare(
					`SELECT id, field, title, year, cit, fwci, subfield, child_cnt, doi FROM papers WHERE id IN (${placeholders})`,
				)
				.bind(...candidateIds)
				.all<PaperRow>();
			for (const row of results) {
				if (!candidates.some((c) => c.id === row.id)) candidates.push(row);
			}
		}
		if (candidates.length === 0) break;

		// 最も被引用数の多い祖先を 1 本選ぶ（元のロジックと同じ方針）。
		const ancestor = candidates.sort((a, b) => b.cit - a.cit)[0];
		lineage.push(ancestor);
		visited.add(ancestor.id);
		currentId = ancestor.id;
	}

	return lineage;
}
