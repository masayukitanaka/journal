// D1 アクセスヘルパー（ARCHITECT.md 3.6）。
// PoC は単一 DB（field17_2016_2026）のみを対象とする。複数 DB を UNION ALL で結合する
// 構成（ARCHITECT.md 3.4.2）は、年代分割が実際に必要になった時点で拡張する。

export interface PaperRow {
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

export function db(env: Env) {
	return env.DB_FIELD17_2016_2026;
}
