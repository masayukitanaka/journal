-- Migration number: 0001 	 2026-11-09T19:11:43.749Z

-- 論文（SPEC.md 4.4, ARCHITECT.md 3.4）
CREATE TABLE papers (
  id        INTEGER PRIMARY KEY,   -- OpenAlex の W 番号（数値部分）。分野をまたいで一意
  field     INTEGER NOT NULL,      -- OpenAlex Field ID（計算機科学は 17、人文系は 12）
  title     TEXT NOT NULL,
  year      INTEGER NOT NULL,
  cit       INTEGER NOT NULL,      -- 被引用数（OpenAlex 値）
  fwci      REAL,                  -- Field-weighted Citation Impact（OpenAlex `fwci`）
  subfield  INTEGER,
  child_cnt INTEGER NOT NULL DEFAULT 0   -- 取り込み済みの直接の子（分岐数）
);
CREATE INDEX idx_papers_field_year ON papers(field, year);
CREATE INDEX idx_papers_field_cit  ON papers(field, cit DESC);

-- 引用エッジ（cited = 祖先、citing = 子孫）
CREATE TABLE edges (
  cited   INTEGER NOT NULL,
  citing  INTEGER NOT NULL,
  PRIMARY KEY (cited, citing)
) WITHOUT ROWID;
CREATE INDEX idx_edges_citing ON edges(citing);
