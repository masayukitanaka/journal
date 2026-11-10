import { db } from "./db.js";

// R2 グラフ JSON の形式（SPEC.md 4.5）。
export interface SeedGraph {
	seed: number;
	field: number;
	generatedAt: string;
	nodes: { id: number; y: number; t: string; c: number; k: number }[];
	edges: [number, number][];
}

export function graphKey(seed: number, depth: number): string {
	return `graph/field17/seed-${seed}-d${depth}.json`;
}

// SPEC.md 6.5「実データでは、描画ノード数を 2,000 件程度までに抑える」。
// BFS が上限を超えたら、その時点までに集めたノードを被引用数（cit）上位で絞って打ち切る。
const MAX_NODES = 2000;

// D1 のバインド変数上限は 100（SQLite 標準の 999 より小さい）。
// minCit 用に 1 個を残し、安全マージンを持って 90 とする。
const SQL_IN_CHUNK_SIZE = 90;

async function fetchEdgesChunked(
	env: Env,
	ids: number[],
	column: "citing" | "cited",
): Promise<{ cited: number; citing: number }[]> {
	const rows: { cited: number; citing: number }[] = [];
	for (let i = 0; i < ids.length; i += SQL_IN_CHUNK_SIZE) {
		const chunk = ids.slice(i, i + SQL_IN_CHUNK_SIZE);
		const placeholders = chunk.map(() => "?").join(",");
		const { results } = await db(env)
			.prepare(`SELECT cited, citing FROM edges WHERE ${column} IN (${placeholders})`)
			.bind(...chunk)
			.all<{ cited: number; citing: number }>();
		rows.push(...results);
	}
	return rows;
}

async function fetchPapersChunked(
	env: Env,
	ids: number[],
	minCit: number,
): Promise<{ id: number; year: number; title: string; cit: number; child_cnt: number }[]> {
	const rows: { id: number; year: number; title: string; cit: number; child_cnt: number }[] = [];
	for (let i = 0; i < ids.length; i += SQL_IN_CHUNK_SIZE) {
		const chunk = ids.slice(i, i + SQL_IN_CHUNK_SIZE);
		const placeholders = chunk.map(() => "?").join(",");
		const { results } = await db(env)
			.prepare(
				`SELECT id, year, title, cit, child_cnt FROM papers WHERE id IN (${placeholders}) AND cit >= ?`,
			)
			.bind(...chunk, minCit)
			.all<{ id: number; year: number; title: string; cit: number; child_cnt: number }>();
		rows.push(...results);
	}
	return rows;
}

// D1 から祖先・子孫方向に depth まで BFS し、シード周辺グラフを構築する（ARCHITECT.md 3.2, 4.2）。
export async function buildSeedGraph(
	env: Env,
	seed: number,
	depth: number,
	minCit: number,
): Promise<SeedGraph | null> {
	const seedPaper = await db(env)
		.prepare("SELECT id, field, title, year, cit, child_cnt FROM papers WHERE id = ?")
		.bind(seed)
		.first<{ id: number; field: number; title: string; year: number; cit: number; child_cnt: number }>();

	if (!seedPaper) return null;

	const nodeCit = new Map<number, number>([[seed, seedPaper.cit]]);
	const edgeSet = new Set<string>();
	const edges: [number, number][] = [];

	let frontier = [seed];
	for (let d = 0; d < depth; d++) {
		if (frontier.length === 0 || nodeCit.size >= MAX_NODES) break;

		const [ancestorRows, descendantRows] = await Promise.all([
			fetchEdgesChunked(env, frontier, "citing"),
			fetchEdgesChunked(env, frontier, "cited"),
		]);

		const newIds: number[] = [];
		for (const row of [...ancestorRows, ...descendantRows]) {
			const key = `${row.cited}-${row.citing}`;
			if (!edgeSet.has(key)) {
				edgeSet.add(key);
				edges.push([row.cited, row.citing]);
			}
			if (!nodeCit.has(row.cited)) newIds.push(row.cited);
			if (!nodeCit.has(row.citing)) newIds.push(row.citing);
		}

		const uniqueNewIds = [...new Set(newIds)];
		if (uniqueNewIds.length === 0) break;

		// ノード数が上限を超える場合、新規ノードを被引用数上位に絞って打ち切る。
		const newPapers = await fetchPapersChunked(env, uniqueNewIds, 0);
		const remainingCapacity = MAX_NODES - nodeCit.size;
		const selected = newPapers
			.sort((a, b) => b.cit - a.cit)
			.slice(0, Math.max(0, remainingCapacity));

		for (const p of selected) nodeCit.set(p.id, p.cit);
		frontier = selected.map((p) => p.id);
	}

	const idList = [...nodeCit.keys()];
	const paperRows = await fetchPapersChunked(env, idList, minCit);

	const includedIds = new Set(paperRows.map((p) => p.id));
	// seed 自身は minCit に関わらず常に含める。
	if (!includedIds.has(seed)) {
		includedIds.add(seed);
		paperRows.push({
			id: seedPaper.id,
			year: seedPaper.year,
			title: seedPaper.title,
			cit: seedPaper.cit,
			child_cnt: seedPaper.child_cnt,
		});
	}

	const filteredEdges = edges.filter(([cited, citing]) => includedIds.has(cited) && includedIds.has(citing));

	return {
		seed,
		field: seedPaper.field,
		generatedAt: new Date().toISOString(),
		nodes: paperRows.map((p) => ({ id: p.id, y: p.year, t: p.title, c: p.cit, k: p.child_cnt })),
		edges: filteredEdges,
	};
}
