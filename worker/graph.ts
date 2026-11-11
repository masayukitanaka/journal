// R2 グラフ JSON の形式（SPEC.md 4.5）。
// a: 隣接する年代レンジの DB から補完されたノードかどうか（2026-11-11、省略時/false はメイン DB 由来）。
export interface SeedGraph {
	seed: number;
	field: number;
	generatedAt: string;
	nodes: { id: number; y: number; t: string; c: number; k: number; a?: boolean }[];
	edges: [number, number][];
}

// R2 バケットは分野・年代をまたいで共有し、プレフィックスで分ける（ARCHITECT.md 3.5）。
export function graphKey(field: number, seed: number, depth: number): string {
	return `graph/field${field}/seed-${seed}-d${depth}.json`;
}

// SPEC.md 6.5「実データでは、描画ノード数を 2,000 件程度までに抑える」。
// BFS が上限を超えたら、その時点までに集めたノードを被引用数（cit）上位で絞って打ち切る。
const MAX_NODES = 2000;

// D1 のバインド変数上限は 100（SQLite 標準の 999 より小さい）。
// minCit 用に 1 個を残し、安全マージンを持って 90 とする。
const SQL_IN_CHUNK_SIZE = 90;

async function fetchEdgesChunked(
	database: D1Database,
	ids: number[],
	column: "citing" | "cited",
): Promise<{ cited: number; citing: number }[]> {
	const rows: { cited: number; citing: number }[] = [];
	for (let i = 0; i < ids.length; i += SQL_IN_CHUNK_SIZE) {
		const chunk = ids.slice(i, i + SQL_IN_CHUNK_SIZE);
		const placeholders = chunk.map(() => "?").join(",");
		const { results } = await database
			.prepare(`SELECT cited, citing FROM edges WHERE ${column} IN (${placeholders})`)
			.bind(...chunk)
			.all<{ cited: number; citing: number }>();
		rows.push(...results);
	}
	return rows;
}

// edges は citing 側の DB に保存される方針（SPEC.md 4.4）のため、frontier ノードを cited 側として
// 子孫を探す場合、citing 側（子孫）が新しい年代レンジの隣接 DB に保存されていることがある。
// 祖先方向（column="citing" で frontier を citing として検索）は、frontier 自身がこの DB にいる
// 前提上、そのノードが citing であるエッジは常にこの DB 内に保存されているため隣接 DB を見る必要はない。
async function fetchEdgesChunkedWithAdjacent(
	database: D1Database,
	adjacentDbs: D1Database[],
	ids: number[],
	column: "citing" | "cited",
): Promise<{ cited: number; citing: number }[]> {
	const rows = await fetchEdgesChunked(database, ids, column);
	if (column === "citing" || adjacentDbs.length === 0) return rows;

	const seen = new Set(rows.map((r) => `${r.cited}-${r.citing}`));
	for (const adjacentDb of adjacentDbs) {
		const extra = await fetchEdgesChunked(adjacentDb, ids, column);
		for (const row of extra) {
			const key = `${row.cited}-${row.citing}`;
			if (!seen.has(key)) {
				seen.add(key);
				rows.push(row);
			}
		}
	}
	return rows;
}

type PaperLookupRow = { id: number; year: number; title: string; cit: number; child_cnt: number };
// adjacent: true はメインの DB ではなく隣接する年代レンジの DB から補完したノードであることを示す
// （2026-11-11、フロントで「おまけ」であることを色分け表示するために使う）。
type PaperLookupRowWithSource = PaperLookupRow & { adjacent: boolean };

async function fetchPapersChunked(database: D1Database, ids: number[], minCit: number): Promise<PaperLookupRow[]> {
	const rows: PaperLookupRow[] = [];
	for (let i = 0; i < ids.length; i += SQL_IN_CHUNK_SIZE) {
		const chunk = ids.slice(i, i + SQL_IN_CHUNK_SIZE);
		const placeholders = chunk.map(() => "?").join(",");
		const { results } = await database
			.prepare(
				`SELECT id, year, title, cit, child_cnt FROM papers WHERE id IN (${placeholders}) AND cit >= ?`,
			)
			.bind(...chunk, minCit)
			.all<PaperLookupRow>();
		rows.push(...results);
	}
	return rows;
}

// 現在の DB で見つからなかった論文を、隣接する年代レンジの DB（前後1つずつ、SPEC.md 4.4）からも探す。
// edges は citing 側の DB に保存される方針のため、祖先（cited）が前の年代レンジの DB にいることがある
// （2026-11-11 実装。年代境界をまたぐ系譜が欠落する問題への最小対応）。
async function fetchPapersWithAdjacent(
	database: D1Database,
	adjacentDbs: D1Database[],
	ids: number[],
	minCit: number,
): Promise<PaperLookupRowWithSource[]> {
	const mainRows = await fetchPapersChunked(database, ids, minCit);
	const rows: PaperLookupRowWithSource[] = mainRows.map((r) => ({ ...r, adjacent: false }));
	const foundIds = new Set(rows.map((r) => r.id));
	const missingIds = ids.filter((id) => !foundIds.has(id));
	if (missingIds.length === 0 || adjacentDbs.length === 0) return rows;

	for (const adjacentDb of adjacentDbs) {
		if (missingIds.length === 0) break;
		const extra = await fetchPapersChunked(adjacentDb, missingIds, minCit);
		for (const row of extra) {
			if (!foundIds.has(row.id)) {
				foundIds.add(row.id);
				rows.push({ ...row, adjacent: true });
				missingIds.splice(missingIds.indexOf(row.id), 1);
			}
		}
	}
	return rows;
}

// D1 から祖先・子孫方向に depth まで BFS し、シード周辺グラフを構築する（ARCHITECT.md 3.2, 4.2）。
// adjacentDbs: 年代境界をまたぐ系譜を補完するための隣接 DB（前後1レンジ分、SPEC.md 4.4。省略時は補完なし）。
export async function buildSeedGraph(
	database: D1Database,
	seed: number,
	depth: number,
	minCit: number,
	adjacentDbs: D1Database[] = [],
): Promise<SeedGraph | null> {
	const seedPaper = await database
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
			fetchEdgesChunkedWithAdjacent(database, adjacentDbs, frontier, "citing"),
			fetchEdgesChunkedWithAdjacent(database, adjacentDbs, frontier, "cited"),
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
		const newPapers = await fetchPapersWithAdjacent(database, adjacentDbs, uniqueNewIds, 0);
		const remainingCapacity = MAX_NODES - nodeCit.size;
		const selected = newPapers
			.sort((a, b) => b.cit - a.cit)
			.slice(0, Math.max(0, remainingCapacity));

		for (const p of selected) nodeCit.set(p.id, p.cit);
		frontier = selected.map((p) => p.id);
	}

	const idList = [...nodeCit.keys()];
	const paperRows = await fetchPapersWithAdjacent(database, adjacentDbs, idList, minCit);

	const includedIds = new Set(paperRows.map((p) => p.id));
	// seed 自身は minCit に関わらず常に含める（メイン DB の論文のはずなので adjacent: false）。
	if (!includedIds.has(seed)) {
		includedIds.add(seed);
		paperRows.push({
			id: seedPaper.id,
			year: seedPaper.year,
			title: seedPaper.title,
			cit: seedPaper.cit,
			child_cnt: seedPaper.child_cnt,
			adjacent: false,
		});
	}

	const filteredEdges = edges.filter(([cited, citing]) => includedIds.has(cited) && includedIds.has(citing));

	return {
		seed,
		field: seedPaper.field,
		generatedAt: new Date().toISOString(),
		nodes: paperRows.map((p) => ({ id: p.id, y: p.year, t: p.title, c: p.cit, k: p.child_cnt, ...(p.adjacent ? { a: true } : {}) })),
		edges: filteredEdges,
	};
}
