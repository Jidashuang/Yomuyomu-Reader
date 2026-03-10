# 词典与词表

## 1. JMDict（词典库）

### 1.1 下载源文件
```bash
python3 backend/download_jmdict.py
```
默认会下载并解压到：`backend/data/JMdict_e`

### 1.2 构建 SQLite 词典
```bash
python3 backend/build_jmdict_db.py --xml backend/data/JMdict_e
```
默认输出：`backend/data/jmdict.db`

也可指定输入文件：
```bash
python3 backend/build_jmdict_db.py --xml /path/to/JMdict_e.xml
```

### 1.3 运行时行为
- 服务启动后若检测到 `backend/data/jmdict.db`，会启用词典查询能力。
- 点词接口：`POST /api/dict/lookup`

## 2. JLPT 词表

### 2.1 直接抓取全量词表（推荐）
```bash
python3 backend/fetch_full_jlpt_wordlist.py
```
输出：`backend/data/jlpt_levels.json`

### 2.2 从本地 CSV/TSV/JSON 导入
```bash
python3 backend/import_jlpt_levels.py --input /path/to/jlpt.csv
```

列名不标准时可显式指定：
```bash
python3 backend/import_jlpt_levels.py \
  --input /path/to/jlpt.tsv \
  --word-col vocab \
  --level-col nlevel
```

### 2.3 运行时行为
- 前端读取 `backend/data/jlpt_levels.json` 提供 N1~N5 难度标注。
- 文件缺失时，阅读器仍可运行，但难度高亮与相关统计会降级。

## 3. 文件管理建议
以下文件默认不提交到 Git：
- `backend/data/JMdict_e`
- `backend/data/JMdict_e.gz`
- `backend/data/jmdict.db`
- `backend/data/jlpt_levels.json`

建议在本地或对象存储保留数据来源，以便重建。
