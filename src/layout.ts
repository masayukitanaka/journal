import type { GraphNode } from "./types";

export interface PositionedNode extends GraphNode {
	x: number; // SVG 座標（出版年から計算）
	yPos: number; // SVG 座標（並び順から計算）
}

export interface LayoutResult {
	nodes: PositionedNode[];
	edges: [number, number][];
	minYear: number;
	maxYear: number;
}

const X_PER_MONTH = 28;
const Y_ROW_HEIGHT = 22;
const MARGIN = 60;

// year + (month-1)/12 の小数値から、年月を一意に表す整数インデックス（年*12+月）を求める。
// 浮動小数の誤差で月がずれないよう四捨五入する。
function yearToMonthIndex(year: number): number {
	const y = Math.floor(year);
	const month = Math.round((year - y) * 12);
	return y * 12 + month;
}

// SPEC.md 6.2: 行の並び（Y 軸）は、子の被引用合計の多い順に上から配置する（系統の並びを安定させるため）。
function computeChildCitationSum(nodes: GraphNode[], edges: [number, number][]): Map<number, number> {
	const citById = new Map(nodes.map((n) => [n.id, n.c]));
	const sums = new Map<number, number>(nodes.map((n) => [n.id, 0]));

	for (const [cited, citing] of edges) {
		const childCit = citById.get(citing) ?? 0;
		sums.set(cited, (sums.get(cited) ?? 0) + childCit);
	}
	return sums;
}

export function layoutGraph(nodes: GraphNode[], edges: [number, number][]): LayoutResult {
	if (nodes.length === 0) {
		return { nodes: [], edges: [], minYear: 0, maxYear: 0 };
	}

	const childCitationSum = computeChildCitationSum(nodes, edges);
	const sorted = [...nodes].sort((a, b) => {
		const diff = (childCitationSum.get(b.id) ?? 0) - (childCitationSum.get(a.id) ?? 0);
		return diff !== 0 ? diff : b.c - a.c;
	});

	const minYear = Math.min(...nodes.map((n) => n.y));
	const maxYear = Math.max(...nodes.map((n) => n.y));

	const positioned: PositionedNode[] = sorted.map((node, index) => ({
		...node,
		x: yearToX(node.y, minYear),
		yPos: MARGIN + index * Y_ROW_HEIGHT,
	}));

	return { nodes: positioned, edges, minYear, maxYear };
}

// 月単位の離散レーンに配置する（同じ年月のノードは同じ X 座標になる）。
export function yearToX(year: number, minYear: number): number {
	return MARGIN + (yearToMonthIndex(year) - yearToMonthIndex(minYear)) * X_PER_MONTH;
}

const MONTH_NAMES = [
	"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// year + (month-1)/12 の小数値を「Jun 2016」のような表示に戻す。
export function formatYearMonth(year: number): string {
	const y = Math.floor(year);
	const monthIndex = Math.round((year - y) * 12);
	return `${MONTH_NAMES[monthIndex]} ${y}`;
}

// 分岐数（直接の子の数）を "N child"/"N children" の英語複数形で表示する。
export function formatChildCount(count: number): string {
	return `${count} ${count === 1 ? "child" : "children"}`;
}

// 被引用数を "N citation"/"N citations" の英語複数形で表示する。
export function formatCitationCount(count: number): string {
	return `${count.toLocaleString()} ${count === 1 ? "citation" : "citations"}`;
}

export interface YearLane {
	year: number;
	xStart: number;
	xEnd: number;
}

// 年ごとに薄いレーン（背景帯）を描画するための区切りを計算する。
export function computeYearLanes(minYear: number, maxYear: number): YearLane[] {
	const startYear = Math.floor(minYear);
	const endYear = Math.floor(maxYear);
	const lanes: YearLane[] = [];
	for (let year = startYear; year <= endYear; year++) {
		lanes.push({
			year,
			xStart: yearToX(year, minYear),
			xEnd: yearToX(year + 1, minYear),
		});
	}
	return lanes;
}

export interface MonthGridLine {
	x: number;
	isYearStart: boolean;
}

// 月単位の区切り線（縦線）の X 座標を計算する。年始めの区切りは太線で区別できるようフラグを立てる。
export function computeMonthGridLines(minYear: number, maxYear: number): MonthGridLine[] {
	const startIndex = yearToMonthIndex(minYear);
	const endIndex = yearToMonthIndex(maxYear) + 1;
	const lines: MonthGridLine[] = [];
	for (let monthIndex = startIndex; monthIndex <= endIndex; monthIndex++) {
		lines.push({
			x: MARGIN + (monthIndex - startIndex) * X_PER_MONTH,
			isYearStart: monthIndex % 12 === 0,
		});
	}
	return lines;
}

// SPEC.md 6.2: 円のサイズは分岐数の対数に比例（ハブほど大きい）。分岐 0 の論文は小さい点。
// 実データでは分岐数の分布が大きく偏る（平均 14、最大 7735 件、2026-11-09 実測）ため対数スケールを使う。
// 色でもハブの強さを表現しているため、サイズ差は控えめにする（2026-11 変更: 底 e → 底 10、RADIUS_SCALE を縮小）。
const MIN_RADIUS = 3;
const RADIUS_SCALE = 3;

export function nodeRadius(childCount: number): number {
	if (childCount === 0) return MIN_RADIUS;
	return MIN_RADIUS + Math.log10(childCount + 1) * RADIUS_SCALE;
}

// SPEC.md 6.2: 円の色は分岐 0 は灰色、分岐がある論文は琥珀色から赤へ（分岐の多さに比例）。
const GRAY = "#9ca3af";
const AMBER = { r: 245, g: 158, b: 11 }; // amber-500
const RED = { r: 220, g: 38, b: 38 }; // red-600

export function nodeColor(childCount: number, maxChildCount: number): string {
	if (childCount === 0) return GRAY;
	const t = maxChildCount > 0 ? Math.min(1, childCount / maxChildCount) : 0;
	const r = Math.round(AMBER.r + (RED.r - AMBER.r) * t);
	const g = Math.round(AMBER.g + (RED.g - AMBER.g) * t);
	const b = Math.round(AMBER.b + (RED.b - AMBER.b) * t);
	return `rgb(${r}, ${g}, ${b})`;
}
