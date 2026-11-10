interface OperationBarProps {
	displayLimit: number;
	onDisplayLimitChange: (limit: number) => void;
	skeletonOnly: boolean;
	onSkeletonOnlyChange: (value: boolean) => void;
	onResetView: () => void;
	isFocused: boolean;
	panelOpen: boolean;
	onTogglePanel: () => void;
}

// SPEC.md 6.1「操作バー」, 6.4「操作」。
export function OperationBar({
	displayLimit,
	onDisplayLimitChange,
	skeletonOnly,
	onSkeletonOnlyChange,
	onResetView,
	isFocused,
	panelOpen,
	onTogglePanel,
}: OperationBarProps) {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: 16,
				padding: "10px 16px",
				borderBottom: "1px solid var(--border-color)",
				flexWrap: "wrap",
				fontSize: 13,
				background: "var(--surface)",
			}}
		>
			<label
				style={{ display: "flex", alignItems: "center", gap: 8 }}
				title="When Skeleton only is OFF, shows up to this many papers, ordered by citation count"
			>
				<span style={{ color: "var(--muted-text)" }}>Show</span>
				<select
					className="ctl-select"
					value={displayLimit}
					onChange={(e) => onDisplayLimitChange(Number(e.target.value))}
				>
					<option value={50}>50</option>
					<option value={100}>100</option>
					<option value={500}>500</option>
					<option value={2000}>2000 (all)</option>
				</select>
			</label>

			<label
				className="ctl-checkbox-label"
				title="Show only hubs (papers with many children), their ancestors, and the selected lineage"
			>
				<input
					type="checkbox"
					className="ctl-checkbox"
					checked={skeletonOnly}
					onChange={(e) => onSkeletonOnlyChange(e.target.checked)}
				/>
				Skeleton only
			</label>

			<button className="btn" onClick={onResetView}>
				{isFocused ? "Show all" : "Reset view"}
			</button>
			<button className="btn" onClick={onTogglePanel} style={{ marginLeft: "auto" }}>
				{panelOpen ? "Hide list & details" : "Show list & details"}
			</button>
		</div>
	);
}
