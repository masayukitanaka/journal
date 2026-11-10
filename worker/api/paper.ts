import { Hono } from "hono";
import { db, type PaperRow } from "../db.js";

// GET /api/fields/17/paper/{id} — 論文の詳細と系譜（祖先の列）（SPEC.md 2章「系譜」, 5章）
export const paperRoute = new Hono<{ Bindings: Env }>().get("/:id", async (c) => {
	const id = Number(c.req.param("id"));
	if (!Number.isInteger(id)) {
		return c.json({ error: "invalid paper id" }, 400);
	}

	const paper = await db(c.env)
		.prepare("SELECT id, field, title, year, cit, fwci, subfield, child_cnt, doi FROM papers WHERE id = ?")
		.bind(id)
		.first<PaperRow>();

	if (!paper) {
		return c.json({ error: "paper not found" }, 404);
	}

	const lineage = await resolveLineage(c.env, id);

	return c.json({ paper, lineage });
});

// シードから起点までの祖先の列（SPEC.md 2章「系譜」）。
// 最も被引用数の多い祖先を 1 本の経路として辿る（複数祖先がある場合の経路選択は PoC の簡易仕様）。
async function resolveLineage(env: Env, startId: number): Promise<PaperRow[]> {
	const lineage: PaperRow[] = [];
	const visited = new Set<number>([startId]);
	let currentId = startId;

	for (let depth = 0; depth < 20; depth++) {
		const ancestor = await db(env)
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
