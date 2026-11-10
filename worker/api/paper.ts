import { Hono } from "hono";
import { resolveFieldDb, type PaperRow } from "../db.js";

// GET /api/fields/:field/paper/{id} — 論文の詳細と系譜（祖先の列）（SPEC.md 2章「系譜」, 5章）
// id（OpenAlex ID）は分野をまたいで一意だが、分野・年代ごとに DB を分けているため、
// どの DB を見るかの指定に :field パスパラメータが必要。
export const paperRoute = new Hono<{ Bindings: Env }>().get("/fields/:field/paper/:id", async (c) => {
	const resolved = resolveFieldDb(c.env, c.req.param("field"), c.req.query("yearRange"));
	if (!resolved.ok) {
		return c.json({ error: resolved.error }, resolved.status);
	}
	const { db: database } = resolved;

	const id = Number(c.req.param("id"));
	if (!Number.isInteger(id)) {
		return c.json({ error: "invalid paper id" }, 400);
	}

	const paper = await database
		.prepare("SELECT id, field, title, year, cit, fwci, subfield, child_cnt, doi FROM papers WHERE id = ?")
		.bind(id)
		.first<PaperRow>();

	if (!paper) {
		return c.json({ error: "paper not found" }, 404);
	}

	const lineage = await resolveLineage(database, id);

	return c.json({ paper, lineage });
});

// シードから起点までの祖先の列（SPEC.md 2章「系譜」）。
// 最も被引用数の多い祖先を 1 本の経路として辿る（複数祖先がある場合の経路選択は PoC の簡易仕様）。
async function resolveLineage(database: D1Database, startId: number): Promise<PaperRow[]> {
	const lineage: PaperRow[] = [];
	const visited = new Set<number>([startId]);
	let currentId = startId;

	for (let depth = 0; depth < 20; depth++) {
		const ancestor = await database
			.prepare(
				`SELECT p.id, p.field, p.title, p.year, p.cit, p.fwci, p.subfield, p.child_cnt, p.doi
				 FROM edges e JOIN papers p ON p.id = e.cited
				 WHERE e.citing = ?
				 ORDER BY p.cit DESC LIMIT 1`,
			)
			.bind(currentId)
			.first<PaperRow>();

		if (!ancestor || visited.has(ancestor.id)) break;
		lineage.push(ancestor);
		visited.add(ancestor.id);
		currentId = ancestor.id;
	}

	return lineage;
}
