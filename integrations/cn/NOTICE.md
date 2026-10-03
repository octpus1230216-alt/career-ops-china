# Third-Party Notices (NOTICE)

本目录 `integrations/cn/vendor/` 下包含**第三方开源项目的源码副本**，版权归各自作者所有，
以 MIT License 分发。本仓库仅为便于复现做了**钉版快照**（pinned copies），不主张对其作者身份或
原始开发的所有权。各项目的原始出处与其随附 `LICENSE` 文件如下。

---

## Hiring-Radar

- 原始项目：<https://github.com/simonlin1212/Hiring-Radar>
- 许可：MIT License — Copyright (c) 2026 Simon
- 副本位置：`vendor/Hiring-Radar/`（已剔除 `.git` 元数据，其余文件原样保留，含其 `LICENSE`）
- 说明：`requirements.txt` 声明核心功能为纯标准库；仅查询 Moka 系公司时需 `pycryptodome`。

## @ha7ch/job-pro（job.pro）

- 原始项目：npm [`@ha7ch/job-pro`](https://www.npmjs.com/package/@ha7ch/job-pro) · <https://job.ha7ch.com>
- 版本快照：`1.2.1`
- 许可：MIT（见其 `package.json` 的 `license` 字段；npm 发布包未附带独立 LICENSE 文件）
- 副本位置：`vendor/job-pro/`（仅包本体 `dist/` + `package.json`，**不含** `node_modules`）
- 运行时依赖（需自行 `npm install`）：`mammoth`、`pdf-parse`、`puppeteer-core`

---

## 本仓库自有部分

`integrations/cn/scripts/`（`cn_bridge.mjs`、`enrich-details.mjs`、`cn_cache_reader.mjs`、
`jobhunt_bridge.py`）为本 fork 编写的胶水层，随本仓库以 MIT 提供。

> 免责声明：第三方工具由其作者各自维护，本 fork 只做聚合/去重的桥接调用，不对其数据准确性、
> 可用性或 legality of scraping 负责。使用方须自行遵守各招聘平台服务条款与当地法规。
