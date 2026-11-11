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
	a?: boolean; // 隣接する年代レンジの DB から補完されたノードか（2026-11-11、省略時/false はメイン DB 由来）
}

export interface SeedGraph {
	seed: number;
	field: number;
	generatedAt: string;
	nodes: GraphNode[];
	edges: [number, number][];
}

export interface KeywordInfo {
	name: string;
	score: number | null;
}

export interface PaperDetail {
	paper: PaperSummary;
	lineage: PaperSummary[];
	authors: string[];
	keywords: KeywordInfo[];
}
