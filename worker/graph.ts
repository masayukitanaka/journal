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

// D1（Workers Binding API 経由）のバインド変数上限は 100（SQLite 標準の 999 より小さい）。
// minCit 用に 1 個を残し、安全マージンを持って 98 とする（2026-11-12、チャンク数を減らすため90から引き上げ）。
const SQL_IN_CHUNK_SIZE = 98;

// チャンククエリの同時実行数の上限（2026-11-12、パフォーマンス改善。docs/optimizing.md 2.2）。
// 全チャンクを無制限に Promise.all すると、通常規模の論文（新規ノード数が数百〜数千件程度）では
// 大幅な高速化になる（実測: 28秒 → 2.8秒）が、被引用数が極端に多い論文（例: 子 14万件超 →
// チャンク約1,350本）をシードにすると、一度に大量のクエリを投げてしまい "D1 DB is overloaded.
// Too many resources consumed within a 10 second window" が発生することを確認した。
// MAX_CONCURRENT_CHUNKS=8〜20の範囲で試したが、この極端なケースではバッチサイズを下げても
// オーバーロード自体は解消しなかった（根本原因はチャンク数そのものが多すぎること）。
// 通常規模の論文では安全かつ高速に動作するため、20を既定にしている。超高被引用論文（docs/
// optimizing.md 2.2「未解決の既知の制約」参照）への対応は、edges への cit 非正規化等の
// ingest 側の設計変更を要する別タスクとして切り出した（2026-11-12、ユーザー承認）。
const MAX_CONCURRENT_CHUNKS = 20;

// chunks を MAX_CONCURRENT_CHUNKS 件ずつのバッチに区切り、バッチ内は並列・バッチ間は直列に実行する。
async function runChunksBatched<T, R>(chunks: T[], run: (chunk: T) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	for (let i = 0; i < chunks.length; i += MAX_CONCURRENT_CHUNKS) {
		const batch = chunks.slice(i, i + MAX_CONCURRENT_CHUNKS);
		const batchResults = await Promise.all(batch.map(run));
		results.push(...batchResults);
	}
	return results;
}

// チャンクごとの D1 クエリをバッチ並列実行する（2026-11-12、パフォーマンス改善。docs/optimizing.md 2.2）。
// 以前はチャンクを for ループで直列 await しており、ids が数千〜数万件規模（被引用数の多い論文を
// シードにした場合）だと数百回のラウンドトリップが直列に積み上がり、応答に30秒前後かかっていた。
async function fetchEdgesChunked(
	database: D1Database,
	ids: number[],
	column: "citing" | "cited",
): Promise<{ cited: number; citing: number }[]> {
	const chunks: number[][] = [];
	for (let i = 0; i < ids.length; i += SQL_IN_CHUNK_SIZE) {
		chunks.push(ids.slice(i, i + SQL_IN_CHUNK_SIZE));
	}
	const results = await runChunksBatched(chunks, (chunk) => {
		const placeholders = chunk.map(() => "?").join(",");
		return database
			.prepare(`SELECT cited, citing FROM edges WHERE ${column} IN (${placeholders})`)
			.bind(...chunk)
			.all<{ cited: number; citing: number }>();
	});
	return results.flatMap((r) => r.results);
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
	const extraResults = await Promise.all(adjacentDbs.map((adjacentDb) => fetchEdgesChunked(adjacentDb, ids, column)));
	for (const extra of extraResults) {
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

// チャンクごとの D1 クエリをバッチ並列実行する（2026-11-12、パフォーマンス改善。docs/optimizing.md 2.2）。
// 被引用数の多い論文をシードにすると ids が数万件規模になり、直列実行では応答に30秒前後かかっていた
// （実測: depth=0 の papers fetch だけで 24,943ms、ids.length=20,886 件 → チャンク233本を直列実行）。
async function fetchPapersChunked(database: D1Database, ids: number[], minCit: number): Promise<PaperLookupRow[]> {
	const chunks: number[][] = [];
	for (let i = 0; i < ids.length; i += SQL_IN_CHUNK_SIZE) {
		chunks.push(ids.slice(i, i + SQL_IN_CHUNK_SIZE));
	}
	const results = await runChunksBatched(chunks, (chunk) => {
		const placeholders = chunk.map(() => "?").join(",");
		return database
			.prepare(`SELECT id, year, title, cit, child_cnt FROM papers WHERE id IN (${placeholders}) AND cit >= ?`)
			.bind(...chunk, minCit)
			.all<PaperLookupRow>();
	});
	return results.flatMap((r) => r.results);
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
