import { useState } from "react";
import type { GraphNode, PaperSummary } from "../types";
import { searchPapers } from "../api";
import { formatChildCount, formatCitationCount, formatYearMonth } from "../layout";
import { doiUrl, openAlexPageUrl } from "../links";

interface SidePanelProps {
	selectedNode: GraphNode | null;
	selectedPaper: PaperSummary | null;
	lineage: PaperSummary[];
	topPapers: PaperSummary[];
	hubPapers: PaperSummary[];
	collapsedDescendants: boolean;
	onToggleCollapseDescendants: () => void;
	onFocusLineage: () => void;
	onDeselect: () => void;
	onSelectPaperId: (id: number) => void;
	searchEnabled: boolean;
	onClose: () => void;
	field: number;
	yearRange: string | undefined;
}

// SPEC.md 6.1「サイドパネル（右）」, 6.4「操作」。
export function SidePanel({
	selectedNode,
	selectedPaper,
	lineage,
	topPapers,
	hubPapers,
	collapsedDescendants,
	onToggleCollapseDescendants,
	onFocusLineage,
	onDeselect,
	onSelectPaperId,
	searchEnabled,
	onClose,
	field,
	yearRange,
}: SidePanelProps) {
	return (
		<aside
			style={{
				width: 320,
				flexShrink: 0,
				borderLeft: "1px solid var(--border-color)",
				overflowY: "auto",
				padding: 16,
				fontSize: 13,
				display: "flex",
				flexDirection: "column",
				gap: 20,
				background: "var(--surface)",
			}}
		>
			<button className="btn btn-ghost" onClick={onClose} style={{ alignSelf: "flex-end" }}>
				Close ✕
			</button>
			{searchEnabled && <SearchBox field={field} yearRange={yearRange} onSelect={onSelectPaperId} />}

			<section>
				<h2 style={{ fontSize: 13, margin: "0 0 8px", color: "var(--muted-text)", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>
					Selected paper
				</h2>
				{selectedNode ? (
					<div>
						<div style={{ fontWeight: 600, marginBottom: 4 }}>{selectedNode.t}</div>
						<div style={{ color: "var(--muted-text)", marginBottom: 8 }}>
							{formatYearMonth(selectedNode.y)} · {formatCitationCount(selectedNode.c)} · {formatChildCount(selectedNode.k)}
						</div>
						<ExternalLinks paper={selectedPaper} />
						<div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
							<button className="btn" onClick={onToggleCollapseDescendants}>
								{collapsedDescendants ? "Expand children" : "Collapse children"}
							</button>
							<button className="btn" onClick={onFocusLineage}>Focus lineage</button>
							<button className="btn btn-ghost" onClick={onDeselect}>Deselect</button>
						</div>
						{lineage.length > 0 && (
							<div>
								<div style={{ fontWeight: 600, marginBottom: 4 }}>Lineage (ancestors)</div>
								<ol style={{ margin: 0, paddingLeft: 18 }}>
									{lineage.map((p) => (
										<li key={p.id} className="list-item" style={{ marginBottom: 2 }}>
											<button className="link-btn" onClick={() => onSelectPaperId(p.id)}>
												{p.title} ({formatYearMonth(p.year)})
											</button>
										</li>
									))}
								</ol>
							</div>
						)}
					</div>
				) : (
					<div style={{ color: "var(--muted-text)" }}>Click a node or a list item to select a paper</div>
				)}
			</section>

			<PaperList title="Top cited (10)" papers={topPapers} onSelect={onSelectPaperId} />
			<PaperList title="Top hubs (10)" papers={hubPapers} onSelect={onSelectPaperId} />
		</aside>
	);
}

// 論文の外部ページへのリンク。OpenAlex は id さえあれば常に作れる。DOI は取得済みの PaperSummary がある場合のみ。
function ExternalLinks({ paper }: { paper: PaperSummary | null }) {
	if (!paper) return null;
	const doi = doiUrl(paper.doi);
	return (
		<div style={{ display: "flex", gap: 14, marginBottom: 10, fontSize: 12 }}>
			<a href={openAlexPageUrl(paper.id)} target="_blank" rel="noopener noreferrer" style={{ color: "var(--link-color)" }}>
				View on OpenAlex ↗
			</a>
			{doi && (
				<a href={doi} target="_blank" rel="noopener noreferrer" style={{ color: "var(--link-color)" }}>
					View paper (DOI) ↗
				</a>
			)}
		</div>
	);
}

// SPEC.md 5章「/api/fields/:field/search」。
function SearchBox({
	field,
	yearRange,
	onSelect,
}: {
	field: number;
	yearRange: string | undefined;
	onSelect: (id: number) => void;
}) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<PaperSummary[]>([]);
	const [loading, setLoading] = useState(false);

	const runSearch = async (q: string) => {
		setQuery(q);
		if (q.trim().length === 0) {
			setResults([]);
			return;
		}
		setLoading(true);
		try {
			const res = await searchPapers(field, yearRange, q, 10);
			setResults(res.papers);
		} catch {
			setResults([]);
		} finally {
			setLoading(false);
		}
	};

	return (
		<section>
			<h2 style={{ fontSize: 13, margin: "0 0 8px", color: "var(--muted-text)", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>
				Search papers
			</h2>
			<div className="search-input-wrap">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
					<circle cx="11" cy="11" r="7" />
					<path d="m21 21-4.3-4.3" />
				</svg>
				<input
					type="text"
					className="ctl-input"
					value={query}
					onChange={(e) => runSearch(e.target.value)}
					placeholder="Title or author name..."
				/>
			</div>
			{loading && <div style={{ color: "var(--muted-text)", marginTop: 6 }}>Searching...</div>}
			{results.length > 0 && (
				<ol style={{ margin: "10px 0 0", paddingLeft: 18 }}>
					{results.map((p) => (
						<li key={p.id} className="list-item" style={{ marginBottom: 2 }}>
							<button className="link-btn" onClick={() => onSelect(p.id)}>
								{p.title}
							</button>
							<div style={{ color: "var(--muted-text)", fontSize: 11 }}>
								{formatYearMonth(p.year)} · {formatCitationCount(p.cit)}
							</div>
						</li>
					))}
				</ol>
			)}
		</section>
	);
}

function PaperList({
	title,
	papers,
	onSelect,
}: {
	title: string;
	papers: PaperSummary[];
	onSelect: (id: number) => void;
}) {
	return (
		<section>
			<h2 style={{ fontSize: 13, margin: "0 0 8px", color: "var(--muted-text)", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>
				{title}
			</h2>
			<ol style={{ margin: 0, paddingLeft: 18 }}>
				{papers.map((p) => (
					<li key={p.id} className="list-item" style={{ marginBottom: 2 }}>
						<button className="link-btn" onClick={() => onSelect(p.id)}>
							{p.title}
						</button>
						<div style={{ color: "var(--muted-text)", fontSize: 11 }}>
							{formatYearMonth(p.year)} · {formatCitationCount(p.cit)} · {formatChildCount(p.child_cnt)}
						</div>
					</li>
				))}
			</ol>
		</section>
	);
}
