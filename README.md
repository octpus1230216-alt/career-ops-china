# career-ops-china

> 个人求职用的 [career-ops](https://github.com/career-ops-hq/career-ops) **fork**，把它适配到**中国招聘市场**（北京 + 真·全球远程的 AI / 解决方案 / 大模型方向）。
>
> A personal fork of the open-source **career-ops** job-search agent, adapted for the **Chinese job market**.

---

## ⚠️ 出处与致谢（请先读）

本仓库**不是**从零造的系统。核心引擎——pipeline 追踪、offer 评分、CV/PDF 生成、门户扫描、以及全部 provider（Greenhouse / Ashby / Lever / Workday，也包括 **飞书招聘 / MokaHR / local-parser** 等）——都由上游项目提供：

- 上游：<https://github.com/career-ops-hq/career-ops>（主页 <https://career-ops.org>，License **MIT**）

**本 fork 只做了中国市场的适配层**，具体见下。请勿把上游的能力当成此仓库的作者。

---

## 这个 fork 相对上游做了什么

诚实的范围说明——落在**可公开仓库里**的自有改动只有：

| 内容 | 文件 | 说明 |
|------|------|------|
| 中国 ATS 定向配置**示例模板** | [`templates/portals.china.example.yml`](templates/portals.china.example.yml) | 展示如何把 MokaHR / 飞书招聘 / 腾讯 / 美团 / 阿里 / 字节 等中国 ATS、以及外部招聘 CLI 桥接进 `scan`；含北京 + 真全球远程的 `location_filter`、标题/内容过滤写法 |
| local-parser 一处小修复 | `providers/local-parser.mjs` | 透传 `job.description`，让 `content_filter` / `country_eligibility_filter` / `visa` 相关过滤能拿到正文信号 |

其余个性化部分（真实的 `portals.yml`、`cv.md`、`config/profile.yml`、`data/`、`reports/`、`interview-prep/`）属 career-ops 的 **User Layer**，默认 `.gitignore`，**不在本仓库**。

### 关于"中国 CLI 聚合桥接"

我的日常扫描流程用到了多源聚合（Hiring-Radar + job-pro 两个招聘 CLI → 去重缓存 → 只读 `local_parser` 喂给 `scan`），这套设计在 `portals.china.example.yml` 的 `cn_sources` / `job_boards` 块里以配置形式给了示例。

**但驱动它的脚本是我本地的私有资产**（`local/scripts/*.mjs`、`local/scripts/jobhunt_bridge.py`、`local/Hiring-Radar/` 等），按 career-ops 的 `local/` 隔离约定被 gitignore，**不随本仓库分发**。因此：

> 克隆本仓库**不能开箱跑通**中国 CLI 聚合扫描——原生 provider 的公司（飞书/MokaHR/腾讯…）可以直接扫；要走 Hiring-Radar/job-pro 聚合需要你自备这些桥接脚本。

---

## 中国 ATS 写法速查

`templates/portals.china.example.yml` 里已内联注释，这里做索引：

| ATS 类型 | `careers_url` 形态 | provider |
|----------|-------------------|----------|
| MokaHR 社招 | `app.mokahr.com/social-recruitment/<org-slug>/<orgId>` | `mokahr`（上游） |
| 飞书招聘 | `<公司短名>.jobs.feishu.cn`（字节 `jobs.bytedance.com` 也走此） | `feishu-jobs`（上游） |
| 自建 ATS | `careers.tencent.com` / `zhaopin.meituan.com` / `talent.alibaba.com` | 各自专用 provider（上游） |
| 无 provider 的静态/SSR 页 | `scan_method: local_parser` + `parser.script` 输出 `jobs-json-v1` | `local-parser`（见 `docs/local-parser-cookbook.md`） |

> provider 的值只能取 `providers/*.mjs` 里已有的 id；多数情况不写 provider 更好，代码会从 `careers_url` 自动识别。

---

## 快速开始

```bash
# 1) 装依赖
npm install

# 2) 拿中国示例作为你的配置起点
cp templates/portals.china.example.yml portals.yml
#    然后把里面的 <占位符> / 公司清单改成你自己的

# 3) 改完必跑两道体检
node validate-portals.mjs        # 结构校验（0 errors 才算过）
node verify-portals.mjs          # 爬取体检（看能不能真爬到）

# 4) 零 token 扫描你的门户（只跑原生 provider / 已接线数据）
node scan.mjs
```

其余用法（评分、CV 生成、dashboard、批量等）与上游一致，见 **[`README.md` 上游文档](https://github.com/career-ops-hq/career-ops)** 及本仓库 `docs/`：

- [`docs/local-parser-cookbook.md`](docs/local-parser-cookbook.md) — 怎么写本地解析器桥接
- [`docs/SUPPORTED_JOB_BOARDS.md`](docs/SUPPORTED_JOB_BOARDS.md) — 支持的招聘板 / provider 目录
- [`docs/SUPPORTED_CLIS.md`](docs/SUPPORTED_CLIS.md)

---

## 数据与隐私约定

沿用 career-ops 的 [Data Contract](DATA_CONTRACT.md)：**User Layer 永不自动更新、且默认被 gitignore**（`cv.md`、`config/profile.yml`、`modes/_profile.md`、`portals.yml`、`data/`、`reports/`、`interview-prep/`、`documents/`、`local/`、`snapshots/`）。本仓库里能看到的只有可复用的**代码与示例模板**，不含任何真实个人资料。

---

## License

MIT，与上游一致，见 [`LICENSE`](LICENSE)。上游 career-ops 版权归其作者所有；本 fork 的中国适配部分同样以 MIT 开放。

## 免责声明

这是个人求职自动化工具的 fork，非官方、与上游项目无隶属关系。岗位数据源、爬取行为请自行遵守各招聘平台的服务条款与当地法规。
