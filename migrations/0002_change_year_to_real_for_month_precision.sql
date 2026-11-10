-- Migration number: 0002 	 月単位の精度を持たせるため、papers.year を INTEGER から REAL に変更する。
-- 値は year + (month - 1) / 12 の形式（例: 2016年6月 → 2016.417）。
-- SQLite は列型の直接変更ができないため、テーブルを再作成して差し替える。

CREATE TABLE papers_new (
  id        INTEGER PRIMARY KEY,
  field     INTEGER NOT NULL,
  title     TEXT NOT NULL,
  year      REAL NOT NULL,
  cit       INTEGER NOT NULL,
  fwci      REAL,
  subfield  INTEGER,
  child_cnt INTEGER NOT NULL DEFAULT 0
);

INSERT INTO papers_new (id, field, title, year, cit, fwci, subfield, child_cnt)
SELECT id, field, title, year, cit, fwci, subfield, child_cnt FROM papers;

DROP TABLE papers;
ALTER TABLE papers_new RENAME TO papers;

CREATE INDEX idx_papers_field_year ON papers(field, year);
CREATE INDEX idx_papers_field_cit  ON papers(field, cit DESC);
