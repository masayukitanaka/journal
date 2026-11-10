import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";
import { Header } from "./components/Header";
import { OperationBar } from "./components/OperationBar";
import { GraphView } from "./components/GraphView";
import { SidePanel } from "./components/SidePanel";
import { fetchHubs, fetchPaper, fetchSeedGraph, fetchTop } from "./api";
import { HUB_MIN_CHILD_DEFAULT, resolveLineageIds, resolveLineageSubtree, resolveSkeleton } from "./filters";
import { SAMPLE_GRAPH } from "./sampleData";
import type { GraphNode, PaperSummary, SeedGraph } from "./types";

const TOP_CITED_SEED_FALLBACK = 2194775991; // Deep Residual Learning（被引用 1 位、2026-11 時点）

function App() {
	const [graph, setGraph] = useState<SeedGraph>(SAMPLE_GRAPH);
	const [isSample, setIsSample] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);

	const [topPapers, setTopPapers] = useState<PaperSummary[]>([]);
	const [hubPapers, setHubPapers] = useState<PaperSummary[]>([]);

	const [displayLimit, setDisplayLimit] = useState<number>(500);
	const [skeletonOnly, setSkeletonOnly] = useState(false);

	const [selectedId, setSelectedId] = useState<number | null>(null);
	const [focusId, setFocusId] = useState<number | null>(null);
	const [collapsedIds, setCollapsedIds] = useState<Set<number>>(new Set());
	const [lineage, setLineage] = useState<PaperSummary[]>([]);
	// 選択中論文の詳細（doi 等、GraphNode には持たせていない情報。/api/.../paper/{id} から取得）。
	const [selectedPaper, setSelectedPaper] = useState<PaperSummary | null>(null);
	// サイドパネルはデフォルト非表示。論文選択時に自動で開く、または手動トグルで開閉する（表示エリアを広く保つため）。
	const [panelOpen, setPanelOpen] = useState(false);

	// SPEC.md 10章 P3: フロントエンドを実データに接続。失敗時はサンプルデータのまま表示を継続する（SPEC.md 7章「障害時」）。
	useEffect(() => {
		let cancelled = false;

		async function load() {
			try {
				const [topRes, hubsRes] = await Promise.all([fetchTop(10), fetchHubs(HUB_MIN_CHILD_DEFAULT, 10)]);
				if (cancelled) return;
				setTopPapers(topRes.papers);
				setHubPapers(hubsRes.papers);

				const seedId = topRes.papers[0]?.id ?? TOP_CITED_SEED_FALLBACK;
				const seedGraph = await fetchSeedGraph(seedId, 2);
				if (cancelled) return;

				setGraph(seedGraph);
				setIsSample(false);
			} catch (err) {
				if (!cancelled) {
					setLoadError(err instanceof Error ? err.message : String(err));
				}
			}
		}

		load();
		return () => {
			cancelled = true;
		};
	}, []);

	// SPEC.md 6.3: 表示の絞り込みルール。
	const visibleNodes = useMemo<GraphNode[]>(() => {
		let candidates = graph.nodes;

		if (focusId !== null) {
			const subtreeIds = resolveLineageSubtree(focusId, graph.edges);
			candidates = candidates.filter((n) => subtreeIds.has(n.id));
		} else if (skeletonOnly) {
			const { hubIds, ancestorIds } = resolveSkeleton(candidates, graph.edges, HUB_MIN_CHILD_DEFAULT);
			const selectedLineageIds = selectedId !== null ? resolveLineageIds(selectedId, candidates, graph.edges) : new Set<number>();
			candidates = candidates.filter((n) => hubIds.has(n.id) || ancestorIds.has(n.id) || selectedLineageIds.has(n.id));
		} else {
			candidates = [...candidates].sort((a, b) => b.c - a.c).slice(0, displayLimit);
		}

		// 折りたたまれた祖先の子孫を除外する（SPEC.md 6.3 条件4、6.4「子を折りたたむ」）。
		if (collapsedIds.size > 0) {
			const hiddenDescendants = new Set<number>();
			const descendantsOf = new Map<number, number[]>();
			for (const [cited, citing] of graph.edges) {
				if (!descendantsOf.has(cited)) descendantsOf.set(cited, []);
				descendantsOf.get(cited)!.push(citing);
			}
			for (const collapsedId of collapsedIds) {
				const queue = [...(descendantsOf.get(collapsedId) ?? [])];
				while (queue.length > 0) {
					const current = queue.pop()!;
					if (!hiddenDescendants.has(current)) {
						hiddenDescendants.add(current);
						queue.push(...(descendantsOf.get(current) ?? []));
					}
				}
			}
			candidates = candidates.filter((n) => !hiddenDescendants.has(n.id));
		}

		return candidates;
	}, [graph, displayLimit, skeletonOnly, focusId, collapsedIds, selectedId]);

	const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);
	const visibleEdges = useMemo(
		() => graph.edges.filter(([cited, citing]) => visibleIds.has(cited) && visibleIds.has(citing)),
		[graph.edges, visibleIds],
	);

	// キーボードナビゲーションが表示件数などの絞り込み範囲外へ出た場合に備え、グラフ全体も GraphView に渡す。
	const allNodesById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);

	const lineageIds = useMemo(
		() => (selectedId !== null ? resolveLineageIds(selectedId, graph.nodes, graph.edges) : new Set<number>()),
		[selectedId, graph],
	);

	const selectedNode = useMemo(
		() => (selectedId !== null ? graph.nodes.find((n) => n.id === selectedId) ?? null : null),
		[selectedId, graph],
	);

	// SPEC.md 6.4: 円をクリック→論文を選択、系譜を強調、祖先の折りたたみを解除。
	const handleSelect = useCallback(
		async (id: number) => {
			setSelectedId(id);
			setPanelOpen(true);
			setCollapsedIds((prev) => {
				const next = new Set(prev);
				next.delete(id);
				return next;
			});

			if (!isSample) {
				try {
					const detail = await fetchPaper(id);
					setLineage(detail.lineage);
					setSelectedPaper(detail.paper);
				} catch {
					setLineage([]);
					setSelectedPaper(null);
				}
			} else {
				setSelectedPaper(null);
			}
		},
		[isSample],
	);

	const handleDeselect = useCallback(() => {
		setSelectedId(null);
		setLineage([]);
		setSelectedPaper(null);
	}, []);

	const handleResetView = useCallback(() => {
		setFocusId(null);
		setSelectedId(null);
		setLineage([]);
	}, []);

	const handleFocusLineage = useCallback(() => {
		if (selectedId === null) return;
		setFocusId(selectedId);
		setDisplayLimit(graph.nodes.length);
	}, [selectedId, graph.nodes.length]);

	const handleToggleCollapseDescendants = useCallback(() => {
		if (selectedId === null) return;
		setCollapsedIds((prev) => {
			const next = new Set(prev);
			if (next.has(selectedId)) next.delete(selectedId);
			else next.add(selectedId);
			return next;
		});
	}, [selectedId]);

	// top/hubs/検索結果は現在のグラフ範囲外の場合がある。その場合はそのシードで新たにグラフを読み込む。
	const handleSelectFromList = useCallback(
		async (id: number) => {
			const node = graph.nodes.find((n) => n.id === id);
			if (node) {
				handleSelect(id);
				return;
			}
			if (isSample) return;
			try {
				const seedGraph = await fetchSeedGraph(id, 2);
				setGraph(seedGraph);
				setFocusId(null);
				setCollapsedIds(new Set());
				await handleSelect(id);
			} catch (err) {
				setLoadError(err instanceof Error ? err.message : String(err));
			}
		},
		[graph, handleSelect, isSample],
	);

	return (
		<div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
			<Header isSample={isSample} />
			{loadError && (
				<div
					style={{
						padding: "6px 16px",
						fontSize: 12,
						color: "var(--warn-text)",
						background: "var(--warn-bg)",
					}}
				>
					Failed to fetch from the API, showing sample data instead ({loadError})
				</div>
			)}
			<OperationBar
				displayLimit={displayLimit}
				onDisplayLimitChange={setDisplayLimit}
				skeletonOnly={skeletonOnly}
				onSkeletonOnlyChange={setSkeletonOnly}
				onResetView={handleResetView}
				isFocused={focusId !== null}
				panelOpen={panelOpen}
				onTogglePanel={() => setPanelOpen((v) => !v)}
			/>
			<div style={{ display: "flex", flex: 1, minHeight: 0 }}>
				<main style={{ flex: 1, minWidth: 0 }}>
					<GraphView
						nodes={visibleNodes}
						edges={visibleEdges}
						allNodesById={allNodesById}
						allEdges={graph.edges}
						selectedId={selectedId}
						lineageIds={lineageIds}
						onSelect={handleSelect}
						onDeselect={handleDeselect}
					/>
				</main>
				{panelOpen && (
					<SidePanel
						selectedNode={selectedNode}
						selectedPaper={selectedPaper}
						lineage={lineage}
						topPapers={topPapers}
						hubPapers={hubPapers}
						collapsedDescendants={selectedId !== null && collapsedIds.has(selectedId)}
						onToggleCollapseDescendants={handleToggleCollapseDescendants}
						onFocusLineage={handleFocusLineage}
						onDeselect={handleDeselect}
						onSelectPaperId={handleSelectFromList}
						searchEnabled={!isSample}
						onClose={() => setPanelOpen(false)}
					/>
				)}
			</div>
		</div>
	);
}

export default App;
