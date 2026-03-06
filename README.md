# YomuYomu 日语原著阅读器

一个对标蒙哥阅读器能力的可运行原型，当前已支持：

- 多格式导入：`TXT`、`EPUB`、`PDF`（需 `pypdf`）、`MOBI`（需 Calibre `ebook-convert`）
- 连续阅读：章节自然衔接滚动，可从目录快速定位
- 翻页控制：上一页/下一页、自动翻页（可调间隔），支持 `PageUp/PageDown`
- 点词查义：优先走后端分词 + 词典查询
- 外部词典联动：点词后一键拉起 `MOJi`（日版/英版 URL Scheme，失败回退网页）
- 日语分词/词形还原：`SudachiPy` 或 `MeCab(fugashi)`，无依赖时自动回退
- 词典：`JMDict` SQLite 查询（可选）
- 难度呈现：`N1` 红色、`N2` 黄虚线、`N3` 绿色下划线（支持显示开关）
- 生词记忆强化：阅读中自动加亮生词本词汇
- 难词速览：自动检索当前章节高难词并在侧栏展示释义
- 词频统计：全书总词数、词汇量与高频词分布
- 生词本 + 间隔复习
- 批注与书签
- TTS（日语语音）
- 云同步（简易快照存储）

## 1. 目录

```text
.
├── index.html
├── styles.css
├── app.js
└── backend
    ├── server.py
    ├── build_jmdict_db.py
    ├── fetch_full_jlpt_wordlist.py
    ├── import_jlpt_levels.py
    ├── requirements.txt
    └── data
```

## 2. 启动方式（推荐）

在项目根目录运行：

```bash
python3 backend/server.py --host 127.0.0.1 --port 8000
```

打开：

`http://127.0.0.1:8000`

说明：
- 前端静态页面和 API 由同一个服务提供。
- 如果只用 `python3 -m http.server`，前端仍可跑，但 `EPUB/PDF/MOBI`、云同步、后端词典能力不可用。

## 3. 让别人直接访问（Render 免费部署）

这个项目不是“只能你自己本机跑”的玩具。  
只要部署到云端，别人打开一个网址就能用你的阅读器。

本仓库已准备好部署文件：
- `Dockerfile`
- `render.yaml`
- `backend/requirements-deploy.txt`

按下面步骤做即可：

1. 把最新代码推到 GitHub（你已经做过这一步）。
2. 打开 [Render](https://render.com) 并用 GitHub 登录。
3. 进入 `New +` -> `Web Service` -> 选择你的仓库 `Jidashuang/Yomuyomu-Reader`。
4. Render 会自动识别 `Dockerfile`，保持默认配置，点击 `Create Web Service`。
5. 等待部署完成后，会得到一个公网地址，例如 `https://xxx.onrender.com`。
6. 把这个网址发给别人，别人直接打开就能使用。

说明（免费版常见现象）：
- 首次打开可能要等几十秒（冷启动）。
- 当前“云同步”仍是本地文件方案，免费容器重启后可能丢失同步数据。

## 4. 可选依赖安装

```bash
python3 -m pip install -r backend/requirements.txt
```

包含：
- `sudachipy` + `sudachidict_core`：分词和词形还原（推荐）
- `fugashi` + `unidic-lite`：MeCab 路线
- `pypdf`：PDF 文本提取

## 5. 构建 JMDict 词典库

推荐新手直接用内置脚本下载（会保存到 `backend/data/JMdict_e`）：

```bash
python3 backend/download_jmdict.py
```

然后执行构建：

```bash
python3 backend/build_jmdict_db.py --xml backend/data/JMdict_e
```

如果你已经有自己的 JMDict 源文件，也可以直接指定路径：

```bash
python3 backend/build_jmdict_db.py --xml /path/to/JMdict_e.xml
```

默认输出：

`backend/data/jmdict.db`

服务启动后会自动检测该库并启用查询。

说明：
- `backend/data/JMdict_e` 文件较大（~60MB），已默认加入 `.gitignore`，不会再上传到 GitHub。
- 若使用 `JMdict_e.xml`，通常只有英文释义（前端会标注为 `英释`）。
- 构建脚本已支持提取 `gloss_zh`（若源 XML 含中文释义，会优先显示中文）。

## 6. 导入能力说明

- `TXT`：前后端都支持
- `EPUB`：后端纯 Python 解析（zip + OPF + spine）
- `PDF`：后端 `pypdf` 解析
- `MOBI`：后端调用 Calibre `ebook-convert` 转 `EPUB` 再解析

如果 `MOBI` 报错，请先安装 Calibre 并确保命令行可执行：

`ebook-convert`

## 7. 云同步说明

当前为单机演示版云同步：

- 推送：`POST /api/sync/push`
- 拉取：`GET /api/sync/pull?userId=...`
- 存储位置：`backend/data/cloud/<userId>.json`

后续可替换为真实用户系统和对象存储/数据库。

## 8. JLPT 难度词表（必需）

前端会尝试加载：

`backend/data/jlpt_levels.json`

支持两种格式：

```json
{
  "語彙": "N1",
  "改札": "N2"
}
```

```json
[
  { "word": "語彙", "level": "N1" },
  { "word": "改札", "level": "N2" }
]
```

不提供该文件时，难度标注与难词速览不会生效。

推荐直接抓取更完整词表（N1-N5，多源合并）：

```bash
python3 backend/fetch_full_jlpt_wordlist.py
```

该脚本会从多个开源仓库抓取并合并去重，生成 `backend/data/jlpt_levels.json`。
当前数据源：
- `open-anki-jlpt-decks`（MIT）
- `Bluskyo/JLPT_Vocabulary`（Tanos 衍生完整表）

冲突处理策略：
- 同一词在多个来源等级冲突时，取“更简单”的等级（N5 优先于 N1），避免把常见词误标为高难词。

如果遇到 `SSL: CERTIFICATE_VERIFY_FAILED`：

```bash
python3 -m pip install certifi
python3 backend/fetch_full_jlpt_wordlist.py
```

或（临时方案）：

```bash
python3 backend/fetch_full_jlpt_wordlist.py --insecure
```

也可用导入脚本将 `csv/tsv/json` 转为标准词表：

```bash
python3 backend/import_jlpt_levels.py --input /path/to/jlpt.csv
```

可选参数（当列名不标准时）：

```bash
python3 backend/import_jlpt_levels.py \
  --input /path/to/jlpt.tsv \
  --word-col vocab \
  --level-col nlevel
```

## 9. 后续增强建议

1. 引入认证（JWT/OAuth）与多端冲突解决策略。
2. 加入段落级进度同步、阅读历史回放。
3. 增加 AI 句法解析、难句改写、上下文释义。
4. 将批注/词本导出为 Anki 兼容格式。
