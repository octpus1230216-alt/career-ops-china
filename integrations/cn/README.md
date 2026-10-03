# integrations/cn — 中国招聘 CLI 聚合桥接

把两个第三方招聘 CLI（**Hiring-Radar** + **job-pro**）聚合成一份去重缓存，再以
**只读 `local_parser`** 喂给 career-ops 的 `scan.mjs`。设计与 `templates/portals.china.example.yml`
里的 `cn_sources` / `job_boards` 块一一对应。

## 目录结构

```
integrations/cn/
├── scripts/                     # 本仓库自有的胶水脚本（聚合/去重/读取）
│   ├── cn_bridge.mjs            # 采集：跑 Hiring-Radar 全量 + job-pro 差集 → 去重 → 写 data/cn-jobs.json
│   ├── enrich-details.mjs       # job-pro JD 正文富化（进程内直调 dist/<slug>.js）
│   ├── cn_cache_reader.mjs      # 只读：把 data/cn-jobs.json 原样吐给 scan（scan 绝不重跑 CLI）
│   └── jobhunt_bridge.py        # 桥接 JobHunt-CLI，输出 jobs-json-v1
└── vendor/                      # 第三方上游的钉版副本（MIT；见 NOTICE.md），非本仓库作者
    ├── Hiring-Radar/            # 上游 https://github.com/simonlin1212/Hiring-Radar （已剔除 .git）
    └── job-pro/                 # npm @ha7ch/job-pro@1.2.1 （仅包本体，不含依赖）
```

## 数据流

```
cn_bridge.mjs  ──跑──▶  vendor/Hiring-Radar (全量)  +  vendor/job-pro (差集/富化)
      │                                   │
      └──── 去重/别名归一/落盘 ────────────┴──▶  data/cn-jobs.json (gitignored 运行产物)
                                                      │
scan.mjs  ──只读──▶  cn_cache_reader.mjs  ────────────┘
```

## 从零跑通（fresh clone 后）

vendor 里只是**源码快照**，运行依赖需各自安装：

```bash
# 1) Hiring-Radar：核心是纯标准库；只有查 Moka 系公司才需 pycryptodome
pip install -r integrations/cn/vendor/Hiring-Radar/requirements.txt

# 2) job-pro：安装其运行时依赖（mammoth / pdf-parse / puppeteer-core）
npm install --prefix integrations/cn/vendor/job-pro @ha7ch/job-pro@1.2.1

# 3) 配置：用示例作为起点，并让 cn_sources 指向本目录（模板默认已如此设置）
cp templates/portals.china.example.yml portals.yml

# 4) 带外刷新缓存（scan 本身不跑这些重 CLI）
node integrations/cn/scripts/cn_bridge.mjs --check     # 就绪体检（python/npx/Chrome/接线）
node integrations/cn/scripts/cn_bridge.mjs             # 采集 → 写 data/cn-jobs.json

# 5) 扫描（只读缓存 + 原生 provider）
node scan.mjs
```

> `cn_bridge.mjs` 的路径全部从 `portals.yml` 的 `cn_sources` 读取（`hiring_radar.dir` /
> `job_pro.package_root` / `job_pro.enrich_script` / `cache`），可用环境变量
> `HIRING_RADAR_DIR` / `JOB_PRO_DIR` / `CN_BRIDGE_TIMEOUT_MS` 覆盖。把示例配置里的这些值
> 指向 `integrations/cn/vendor/...` 即可用上本目录的副本。

## 关于第三方副本

`vendor/` 下的代码版权归各自作者、以 MIT 分发，本仓库只是**钉版快照**方便复现；上游若更新，
请从原仓库重新拉取。完整署名见 [`NOTICE.md`](NOTICE.md)。
