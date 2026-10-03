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
| 中国 CLI 聚合桥接脚本 | [`integrations/cn/scripts/`](integrations/cn/) | 自写的胶水层：`cn_bridge.mjs`（采集去重）/ `enrich-details.mjs` / `cn_cache_reader.mjs`（只读喂 scan）/ `jobhunt_bridge.py` |
| 第三方 CLI 钉版副本 | [`integrations/cn/vendor/`](integrations/cn/vendor/) | **他人开源项目**的源码快照：Hiring-Radar、job-pro（MIT，署名见 [`integrations/cn/NOTICE.md`](integrations/cn/NOTICE.md)） |

其余个性化部分（真实的 `portals.yml`、`cv.md`、`config/profile.yml`、`data/`、`reports/`、`interview-prep/`）属 career-ops 的 **User Layer**，默认 `.gitignore`，**不在本仓库**。

### 关于"中国 CLI 聚合桥接"

我的日常扫描流程用到了多源聚合（**Hiring-Radar** + **job-pro** 两个招聘 CLI → 去重缓存 → 只读 `local_parser` 喂给 `scan`）。这套东西**已随仓库放在 [`integrations/cn/`](integrations/cn/) 下**，clone 即自带：

- `integrations/cn/scripts/` —— 我写的胶水脚本（采集去重的 `cn_bridge.mjs`、只读喂 scan 的 `cn_cache_reader.mjs`、JD 富化的 `enrich-details.mjs`、桥接 JobHunt-CLI 的 `jobhunt_bridge.py`）。
- `integrations/cn/vendor/Hiring-Radar/`、`integrations/cn/vendor/job-pro/` —— 两个第三方 CLI 的**钉版源码快照**（MIT，作者不是我，署名见 [`integrations/cn/NOTICE.md`](integrations/cn/NOTICE.md)）。
- `templates/portals.china.example.yml` 的 `cn_sources` / `job_boards` 已把路径指向 `integrations/cn/`，配置自洽。

> **能开箱到什么程度**：原生 provider 的公司（飞书 / MokaHR / 腾讯 / 美团 / 阿里 / 字节…）clone 后可直接 `node scan.mjs`。要走 Hiring-Radar / job-pro 聚合，源码已给你，但需**各自安装运行时依赖**（`pip install -r …/Hiring-Radar/requirements.txt`、在 `vendor/job-pro` 里 `npm install`），再 `node integrations/cn/scripts/cn_bridge.mjs` 刷缓存。JobHunt-CLI **未** vendored（体积/许可考量），`jobhunt_bridge.py` 需你自备该 CLI。完整步骤见 [`integrations/cn/README.md`](integrations/cn/README.md)。

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

## 第三方工具致谢

本 fork 的中国聚合扫描会**桥接调用**以下他人开发的开源工具（版权归各自作者，本仓库非其作者）：

| 工具 | 出处 | 是否随仓库 | 用途 |
|------|------|-----------|------|
| **career-ops**（上游本体） | <https://github.com/career-ops-hq/career-ops> · MIT | 是（整个仓库基于它） | 求职引擎 / provider / 评分 / CV 生成 |
| **Hiring-Radar** | <https://github.com/simonlin1212/Hiring-Radar> · MIT | **是**，vendored 于 `integrations/cn/vendor/Hiring-Radar/` | 全量枚举中国 ATS 招聘（`hiring_radar.py`） |
| **job-pro** | npm [`@ha7ch/job-pro`](https://www.npmjs.com/package/@ha7ch/job-pro) · <https://job.ha7ch.com> · MIT | **是**，vendored 于 `integrations/cn/vendor/job-pro/`（不含依赖，需 `npm install`） | 中国大厂校招/社招查询 + JD 正文富化 |
| **JobHunt-CLI** | <https://github.com/git-ellea/jobhunt-cli> | **否**，需自备 | 终端招聘追踪 CLI，经 `jobhunt_bridge.py` 桥接（以你实际安装来源为准） |

> vendored 副本均为**钉版源码快照**，完整许可与署名见 [`integrations/cn/NOTICE.md`](integrations/cn/NOTICE.md)。上述工具由各自作者维护，本仓库只做聚合与去重的胶水层，不对其数据准确性或可用性负责。

---

## License

MIT，与上游一致，见 [`LICENSE`](LICENSE)。上游 career-ops 版权归其作者所有；本 fork 的中国适配部分同样以 MIT 开放。

## 免责声明

这是个人求职自动化工具的 fork，非官方、与上游项目无隶属关系。岗位数据源、爬取行为请自行遵守各招聘平台的服务条款与当地法规。
