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

// Y 軸（行の並び）は、同じ月（同じ X 座標）に属するノードだけをグループにし、
// グループ内を論文名のアルファベット順に並べる。X 軸が既に月単位で左から右に並んでいるため、
// Y 軸でも「同じ月なら名前順」という一貫した規則にすることで、探している論文を見つけやすくする
// （2026-11-10 変更。以前は全ノードを「子の被引用合計」でグローバルにソートしていた）。
export function layoutGraph(nodes: GraphNode[], edges: [number, number][]): LayoutResult {
	if (nodes.length === 0) {
		return { nodes: [], edges: [], minYear: 0, maxYear: 0 };
	}

	const minYear = Math.min(...nodes.map((n) => n.y));
	const maxYear = Math.max(...nodes.map((n) => n.y));

	// 同じ月（yearToMonthIndex が同じ値）ごとにグループ化する。
	const groups = new Map<number, GraphNode[]>();
	for (const node of nodes) {
		const key = yearToMonthIndex(node.y);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)!.push(node);
	}

	const positioned: PositionedNode[] = [];
	for (const groupNodes of groups.values()) {
		const sortedGroup = [...groupNodes].sort((a, b) => a.t.localeCompare(b.t));
		sortedGroup.forEach((node, index) => {
			positioned.push({
				...node,
				x: yearToX(node.y, minYear),
				yPos: MARGIN + index * Y_ROW_HEIGHT,
			});
		});
	}

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
	isMainRange: boolean;
}

// 年ごとに薄いレーン（背景帯）を描画するための区切りを計算する。
// mainRange が指定されていれば、そのレンジ内の年とレンジ外（隣接 DB 由来、SPEC.md 4.4）の年を
// isMainRange で区別できるようにする（2026-11-11。レンジ外は「あくまでおまけ」であることを背景色で示す）。
export function computeYearLanes(minYear: number, maxYear: number, mainRange?: { start: number; end: number }): YearLane[] {
	const startYear = Math.floor(minYear);
	const endYear = Math.floor(maxYear);
	const lanes: YearLane[] = [];
	for (let year = startYear; year <= endYear; year++) {
		lanes.push({
			year,
			xStart: yearToX(year, minYear),
			xEnd: yearToX(year + 1, minYear),
			isMainRange: mainRange ? year >= mainRange.start && year <= mainRange.end : true,
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
