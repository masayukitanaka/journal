-- Migration number: 0006 	 docs/optimizing.md 2.0「hubs エンドポイントのインデックス欠如」対応。
-- GET /api/fields/:field/hubs は `WHERE field = ? AND child_cnt >= ? ORDER BY child_cnt DESC` を実行するが、
-- child_cnt 列にインデックスが無く、field 絞り込み後の全行をソートしていた（実測 約8秒、/top の264msの約30倍）。
-- フロント初期表示で fetchTop と fetchHubs を Promise.all しているため、この1本が初期表示全体を遅らせていた。

CREATE INDEX idx_papers_field_childcnt ON papers(field, child_cnt DESC);
