import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphNode } from "../types";
import { computeMonthGridLines, computeYearLanes, formatChildCount, formatCitationCount, formatYearMonth, layoutGraph, nodeColor, nodeRadius } from "../layout";
import { getChildIds, getParentIds, isHub } from "../filters";

interface GraphViewProps {
	nodes: GraphNode[];
	edges: [number, number][];
	// 表示件数などで絞り込まれる前の全ノード・全エッジ（キーボード移動が表示範囲外へ出た場合に使う）。
	allNodesById: Map<number, GraphNode>;
	allEdges: [number, number][];
	selectedId: number | null;
	lineageIds: Set<number>;
	onSelect: (id: number) => void;
	onDeselect: () => void;
}

interface Transform {
	x: number;
	y: number;
	scale: number;
}

// キーボードナビゲーション（仮選択）: 上下キーでの兄弟巡回の基準となるグループ。
// 右キー（親→子）で入った場合は「どの親の子一覧か」、左キー（子→親）で入った場合は「どの子の親一覧か」を覚えておく。
type SiblingGroup = { via: "children-of"; parentId: number } | { via: "parents-of"; childId: number };

interface TentativeSelection {
	nodeId: number;
	group: SiblingGroup | null;
}

// SPEC.md 6.2: 枝は親（祖先）から子（子孫）へ伸びる Bezier 曲線。
function bezierPath(x1: number, y1: number, x2: number, y2: number): string {
	const midX = (x1 + x2) / 2;
	return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
}

export function GraphView({ nodes, edges, allNodesById, allEdges, selectedId, lineageIds, onSelect, onDeselect }: GraphViewProps) {
	const svgRef = useRef<SVGSVGElement>(null);
	const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, scale: 1 });
	const [hoveredId, setHoveredId] = useState<number | null>(null);
	const [isDragging, setIsDragging] = useState(false);
	const dragStart = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
	// 親/子方向へのキーボード移動で仮選択中のノード（まだ正式な選択ではない）。
	const [tentative, setTentative] = useState<TentativeSelection | null>(null);

	// キーボード操作で selectedId / tentative が表示件数などの絞り込み範囲外へ出ることがあるため、
	// その場合は allNodesById から補ってレイアウト対象に含める（本来の被引用合計順ソートに従って正しい位置に挿入される）。
	// ノードを補った場合、関連する枝を描画するためエッジも allEdges に切り替える。
	const { layoutNodes, layoutEdges } = useMemo(() => {
		const existingIds = new Set(nodes.map((n) => n.id));
		const extra: GraphNode[] = [];
		if (selectedId !== null && !existingIds.has(selectedId)) {
			const n = allNodesById.get(selectedId);
			if (n) extra.push(n);
		}
		if (tentative !== null && !existingIds.has(tentative.nodeId) && tentative.nodeId !== selectedId) {
			const n = allNodesById.get(tentative.nodeId);
			if (n) extra.push(n);
		}
		if (extra.length === 0) return { layoutNodes: nodes, layoutEdges: edges };
		return { layoutNodes: [...nodes, ...extra], layoutEdges: allEdges };
	}, [nodes, edges, selectedId, tentative, allNodesById, allEdges]);

	const layout = useMemo(() => layoutGraph(layoutNodes, layoutEdges), [layoutNodes, layoutEdges]);
	const maxChildCount = useMemo(() => Math.max(1, ...layoutNodes.map((n) => n.k)), [layoutNodes]);
	const nodeById = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout.nodes]);

	// selectedId がマウスクリック等で変わったら仮選択は解除する（選択とは独立した一時状態のため）。
	useEffect(() => {
		setTentative(null);
	}, [selectedId]);

	// キーボード操作で仮選択が変わるたび、selectedId ノードと tentative ノードの両方がぎりぎり
	// 画面に収まるようにパン・ズームを自動調整する。選択確定（Enter/Space）直後も
	// selectedId ノードを画面中心へ寄せる。Esc での解除やマウス操作では動かさない。
	// confirmedRef: Enter/Space で確定した直後の1回だけ true にするフラグ（Esc と区別するため）。
	const confirmedRef = useRef(false);
	useEffect(() => {
		const svg = svgRef.current;
		if (!svg) return;
		const rect = svg.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;

		const selectedNode = selectedId !== null ? nodeById.get(selectedId) : undefined;
		const justConfirmed = confirmedRef.current;
		confirmedRef.current = false;

		if (tentative !== null) {
			const tentativeNode = nodeById.get(tentative.nodeId);
			if (!selectedNode || !tentativeNode) return;

			const PADDING = 80;
			const minX = Math.min(selectedNode.x, tentativeNode.x) - PADDING;
			const maxX = Math.max(selectedNode.x, tentativeNode.x) + PADDING;
			const minY = Math.min(selectedNode.yPos, tentativeNode.yPos) - PADDING;
			const maxY = Math.max(selectedNode.yPos, tentativeNode.yPos) + PADDING;
			const spanX = Math.max(maxX - minX, 1);
			const spanY = Math.max(maxY - minY, 1);

			const scale = Math.min(4, Math.max(0.2, Math.min(rect.width / spanX, rect.height / spanY)));
			const centerX = (minX + maxX) / 2;
			const centerY = (minY + maxY) / 2;
			setTransform({
				scale,
				x: rect.width / 2 - centerX * scale,
				y: rect.height / 2 - centerY * scale,
			});
		} else if (justConfirmed && selectedNode) {
			// 仮選択を確定（Enter/Space）して tentative が無くなった直後: 選択ノードを中心へ寄せる。
			setTransform((t) => ({
				...t,
				x: rect.width / 2 - selectedNode.x * t.scale,
				y: rect.height / 2 - selectedNode.yPos * t.scale,
			}));
		}
	}, [tentative, selectedId, nodeById]);

	useEffect(() => {
		// 候補の中に preferId（直前にいたノード）があればそれを優先し、無ければ「一番上」に相当するものを選ぶ。
		// これにより「左キーで親へ→右キーで子へ」が元のノードへ戻る往復になる。
		// 候補はまだ画面上にレイアウトされていない（表示件数で絞り込まれ範囲外の）場合があるため、
		// layout 後の yPos ではなく allNodesById の被引用数を近似基準にする（layoutGraph のソート基準と同じ発想）。
		function pickCandidate(ids: number[], preferId: number | null): number | null {
			if (preferId !== null && ids.includes(preferId)) return preferId;
			let best: number | null = null;
			let bestCit = -Infinity;
			for (const id of ids) {
				const n = allNodesById.get(id);
				if (n && n.c > bestCit) {
					bestCit = n.c;
					best = id;
				}
			}
			return best;
		}

		function handleKeyDown(e: KeyboardEvent) {
			if (selectedId === null) return;
			const tag = (e.target as HTMLElement | null)?.tagName;
			if (tag === "INPUT" || tag === "TEXTAREA") return;

			if (e.key === "Escape") {
				if (tentative !== null) {
					e.preventDefault();
					setTentative(null);
				}
				return;
			}

			if (e.key === "Enter" || e.key === " ") {
				if (tentative !== null) {
					e.preventDefault();
					confirmedRef.current = true;
					onSelect(tentative.nodeId);
					setTentative(null);
				}
				return;
			}

			if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
				e.preventDefault();
				const currentId = tentative?.nodeId ?? selectedId;
				const ids = e.key === "ArrowRight" ? getChildIds(currentId, allEdges) : getParentIds(currentId, allEdges);
				// 直前にいたノード（左右移動前に居た場所）が候補に含まれていればそこへ戻る。
				const preferId = tentative?.group
					? tentative.group.via === "children-of"
						? tentative.group.parentId
						: tentative.group.childId
					: null;
				const next = pickCandidate(ids, preferId);
				if (next === null) return;
				// 往復の結果 selectedId 自身に戻ってきた場合、仮選択は不要（selectedId との自己ペアで
				// 画面フィット計算が壊れるのを防ぐ）。仮選択を解除するだけで、選択状態は保たれる。
				if (next === selectedId) {
					setTentative(null);
					return;
				}
				setTentative({
					nodeId: next,
					group: e.key === "ArrowRight" ? { via: "children-of", parentId: currentId } : { via: "parents-of", childId: currentId },
				});
				return;
			}

			if (e.key === "ArrowUp" || e.key === "ArrowDown") {
				if (tentative === null || tentative.group === null) return;
				e.preventDefault();
				const siblingIds =
					tentative.group.via === "children-of"
						? getChildIds(tentative.group.parentId, allEdges)
						: getParentIds(tentative.group.childId, allEdges);
				const siblings = siblingIds
					.map((id) => allNodesById.get(id))
					.filter((n): n is NonNullable<typeof n> => n !== undefined)
					// 子の被引用合計順が本来の並びだが、ここでは簡易的に自身の被引用数で近似する。
					.sort((a, b) => b.c - a.c);
				const currentIndex = siblings.findIndex((n) => n.id === tentative!.nodeId);
				if (currentIndex === -1 || siblings.length <= 1) return;
				const nextIndex =
					e.key === "ArrowDown"
						? Math.min(currentIndex + 1, siblings.length - 1)
						: Math.max(currentIndex - 1, 0);
				if (nextIndex === currentIndex) return;
				setTentative({ nodeId: siblings[nextIndex].id, group: tentative.group });
			}
		}

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [selectedId, tentative, allEdges, allNodesById, onSelect]);
	const yearLanes = useMemo(
		() => computeYearLanes(layout.minYear, layout.maxYear),
		[layout.minYear, layout.maxYear],
	);
	const monthGridLines = useMemo(
		() => computeMonthGridLines(layout.minYear, layout.maxYear),
		[layout.minYear, layout.maxYear],
	);
	const laneHeight = useMemo(
		() => (layout.nodes.length > 0 ? Math.max(...layout.nodes.map((n) => n.yPos)) + 60 : 0),
		[layout.nodes],
	);

	// Cmd/Ctrl + ホイールのみズーム。通常のホイール（トラックパッドのスクロール含む）はパン。
	const handleWheel = (e: React.WheelEvent) => {
		e.preventDefault();
		if (e.metaKey || e.ctrlKey) {
			const delta = e.deltaY > 0 ? 0.9 : 1.1;
			setTransform((t) => ({ ...t, scale: Math.min(4, Math.max(0.2, t.scale * delta)) }));
			return;
		}
		setTransform((t) => ({ ...t, x: t.x - e.deltaX, y: t.y - e.deltaY }));
	};

	const handlePointerDown = (e: React.PointerEvent) => {
		setIsDragging(true);
		dragStart.current = { x: e.clientX, y: e.clientY, tx: transform.x, ty: transform.y };
	};

	const handlePointerMove = (e: React.PointerEvent) => {
		if (!isDragging) return;
		const dx = e.clientX - dragStart.current.x;
		const dy = e.clientY - dragStart.current.y;
		setTransform((t) => ({ ...t, x: dragStart.current.tx + dx, y: dragStart.current.ty + dy }));
	};

	const handlePointerUp = () => setIsDragging(false);

	// 仮選択中はその情報を優先してホバー表示と同じツールチップを出す（キーボード操作中はマウスが動いていないため）。
	const hoveredNode =
		tentative !== null ? nodeById.get(tentative.nodeId) : hoveredId !== null ? nodeById.get(hoveredId) : undefined;

	return (
		<div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden", background: "var(--graph-bg)" }}>
			<svg
				ref={svgRef}
				width="100%"
				height="100%"
				onWheel={handleWheel}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				onPointerLeave={handlePointerUp}
				onClick={() => onDeselect()}
				style={{ cursor: isDragging ? "grabbing" : "grab" }}
			>
				<g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}>
					{yearLanes.map((lane, i) => (
						<g key={lane.year}>
							<rect
								x={lane.xStart}
								y={0}
								width={lane.xEnd - lane.xStart}
								height={laneHeight}
								fill={i % 2 === 0 ? "var(--lane-bg-even)" : "var(--lane-bg-odd)"}
							/>
							<text
								x={lane.xStart + 6}
								y={16}
								fontSize={11}
								fill="var(--muted-text)"
								style={{ userSelect: "none" }}
							>
								{lane.year}
							</text>
						</g>
					))}
					{monthGridLines.map((line) => (
						<line
							key={line.x}
							x1={line.x}
							y1={0}
							x2={line.x}
							y2={laneHeight}
							stroke="var(--muted-text)"
							strokeWidth={line.isYearStart ? 1 : 0.5}
							opacity={line.isYearStart ? 0.25 : 0.1}
						/>
					))}
					{layout.edges.map(([cited, citing], i) => {
						const from = nodeById.get(cited);
						const to = nodeById.get(citing);
						if (!from || !to) return null;
						const dimmed = selectedId !== null && !(lineageIds.has(cited) && lineageIds.has(citing));
						return (
							<path
								key={`${cited}-${citing}-${i}`}
								d={bezierPath(from.x, from.yPos, to.x, to.yPos)}
								fill="none"
								stroke="var(--edge-color)"
								strokeWidth={1}
								opacity={dimmed ? 0.08 : 0.35}
							/>
						);
					})}
					{layout.nodes.map((node) => {
						const dimmed = selectedId !== null && !lineageIds.has(node.id);
						const isSelected = node.id === selectedId;
						const isTentative = node.id === tentative?.nodeId;
						return (
							<circle
								key={node.id}
								cx={node.x}
								cy={node.yPos}
								r={nodeRadius(node.k)}
								fill={nodeColor(node.k, maxChildCount)}
								opacity={dimmed && !isTentative ? 0.15 : 1}
								stroke={isTentative ? "var(--tentative-stroke)" : isSelected ? "var(--selected-stroke)" : "none"}
								strokeWidth={isTentative ? 3 : isSelected ? 2 : 0}
								style={{ cursor: "pointer", transition: "opacity 0.2s, r 0.2s" }}
								onPointerEnter={() => setHoveredId(node.id)}
								onPointerLeave={() => setHoveredId(null)}
								onClick={(e) => {
									e.stopPropagation();
									onSelect(node.id);
								}}
							/>
						);
					})}
				</g>
			</svg>
			{hoveredNode && (
				<div
					style={{
						position: "absolute",
						left: hoveredNode.x * transform.scale + transform.x + 12,
						top: hoveredNode.yPos * transform.scale + transform.y - 8,
						background: "var(--tooltip-bg)",
						color: "var(--tooltip-text)",
						padding: "6px 10px",
						borderRadius: 6,
						fontSize: 12,
						maxWidth: 280,
						pointerEvents: "none",
						boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
					}}
				>
					<div style={{ fontWeight: 600 }}>{hoveredNode.t}</div>
					<div>
						{formatYearMonth(hoveredNode.y)} · {formatCitationCount(hoveredNode.c)} · {formatChildCount(hoveredNode.k)}
						{isHub(hoveredNode) ? " · Hub" : ""}
					</div>
				</div>
			)}
		</div>
	);
}

export type { Transform };
