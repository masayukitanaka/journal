// API レスポンスの型（worker/db.ts の PaperRow, worker/graph.ts の SeedGraph に対応）。

export interface PaperSummary {
	id: number;
	field: number;
	title: string;
	year: number;
	cit: number;
	fwci: number | null;
	subfield: number | null;
	child_cnt: number;
	doi: string | null;
}

export interface GraphNode {
	id: number;
	y: number; // 出版年
	t: string; // 論文名
	c: number; // 被引用数
	k: number; // 分岐数
}

export interface SeedGraph {
	seed: number;
	field: number;
	generatedAt: string;
	nodes: GraphNode[];
	edges: [number, number][];
}

export interface PaperDetail {
	paper: PaperSummary;
	lineage: PaperSummary[];
}
