import duckdb

f = "./part_0048.parquet"   # 手元の 400MB のファイル
con = duckdb.connect()

# 1. 行数
rows = con.execute(f"SELECT COUNT(*) FROM read_parquet('{f}')").fetchone()[0]

# 2. 列ごとの割合（上位 10）
cols = con.execute(f"""
SELECT split_part(path_in_schema, ', ', 1) AS col,
       ROUND(100.0 * SUM(total_compressed_size) / SUM(SUM(total_compressed_size)) OVER (), 1) AS pct
FROM parquet_metadata('{f}')
GROUP BY 1 ORDER BY 2 DESC LIMIT 10
""").fetchall()

# 3. 分野 17・2016 年以降の論文数と参考文献数
fx = con.execute(f"""
SELECT COUNT(*) AS papers, SUM(len(referenced_works)) AS refs
FROM read_parquet('{f}')
WHERE publication_year >= 2006
  AND regexp_extract(primary_topic.field.id, '([0-9]+)$', 1) = '17'
""").fetchone()

print("行数:", rows)
print("列の割合（上位10）:")
for c in cols:
    print(" ", c)
print("分野17・2016年以降: 論文数", fx[0], "／ 参考文献の数", fx[1])