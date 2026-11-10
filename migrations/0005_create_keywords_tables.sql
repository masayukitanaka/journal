-- Migration number: 0005 	 OpenAlex の keywords（STRUCT(id, display_name, score)[]）を辞書化する。
-- 元データはキーワードごとに id（スラッグ、例: "https://openalex.org/keywords/mysql"）・表示名・スコアを持つ配列。
-- D1 では配列を直接扱えないため、keywords（辞書）+ paper_keywords（中間テーブル）に正規化する（多対多）。
-- 投入は S3 からの ingest 実装時に行う（このマイグレーションはテーブル定義のみ先行で追加）。

-- キーワード辞書。OpenAlex の語彙は全体で有限（約数万語）のため、分野 DB をまたいで重複しても小さい。
CREATE TABLE keywords (
  id   TEXT PRIMARY KEY,  -- OpenAlex の keyword スラッグ（例: "mysql"）。id URL の末尾を正規化して保存する
  name TEXT NOT NULL      -- OpenAlex の display_name（例: "MySQL"）
);

-- 論文とキーワードの中間テーブル（多対多）。1論文に複数行、1キーワードも複数論文に紐づく。
CREATE TABLE paper_keywords (
  paper_id   INTEGER NOT NULL,
  keyword_id TEXT NOT NULL,
  score      REAL,  -- OpenAlex の score（関連度、0.0〜1.0）。将来の絞り込み・並び替え用に保持
  PRIMARY KEY (paper_id, keyword_id)
) WITHOUT ROWID;
CREATE INDEX idx_paper_keywords_keyword ON paper_keywords(keyword_id);
