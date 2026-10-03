#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
jobhunt_bridge.py — glue between career-ops `local_parser` and JobHunt-CLI.

career-ops contract (providers/local-parser.mjs):
  - This script is run as `python3 local/scripts/jobhunt_bridge.py`
    (cwd pinned to the career-ops repo root).
  - stdout MUST be a single JSON array of job objects, nothing else.
    Each object needs at least `title` and `url`; jobs missing either are
    skipped here (and would also be dropped by the provider).
  - Any diagnostic / error output goes to stderr. On failure we still print
    `[]` to stdout so the provider gets valid (empty) JSON instead of a crash.

JobHunt-CLI observed output (v0.2.6, `... search --format json`):
  a top-level JSON array where each posting uses these field names:
    id, name, url, category_name, nature_code, nature_name,
    location_names, department_name, updated_at, description, requirement, raw
  NOTE: the posting title is `name` (NOT `title`), and location is
  `location_names`. There is no per-job company field — the company is implied
  by the site argument, so we attach it ourselves.

CLI resolution: prefers a globally installed `job` (or `jobhunt`) command and
falls back to `npx jobhunt-cli`, since the package is not always installed
globally. On Windows the npm shim is `npx.cmd`.

Overridable via argv or env. Default queries mirror the user's profile
(解决方案经理 / AI 解决方案售前 / 大模型), one CLI call per keyword, results
deduped by URL; career-ops' title_filter still does the final precision pass.
  python3 jobhunt_bridge.py [site] [query(,comma...)] [limit] [nature]
    site    = JOBHUNT_SITE   (default: meituan)
    query   = JOBHUNT_QUERY  (default: profile keywords, comma-separated)
    limit   = JOBHUNT_LIMIT  (default: 30, per keyword)
    nature  = JOBHUNT_NATURE (default: "" -> CLI default = social)
"""

import json
import os
import re
import shutil
import subprocess
import sys

# Friendly company labels keyed by JobHunt site slug. Falls back to the slug
# itself (title-cased) for any site not listed here.
COMPANY_LABELS = {
    "meituan": "美团 (Meituan)",
    "didi": "滴滴 (DiDi)",
    "bytedance": "字节跳动 (ByteDance)",
    "tencent": "腾讯 (Tencent)",
    "baidu": "百度 (Baidu)",
    "jd": "京东 (JD.com)",
    "xiaomi": "小米 (Xiaomi)",
    "ali": "阿里巴巴 (Alibaba)",
}

# Default search keywords, mirroring the user's targeting in
# config/profile.yml -> target_roles.archetypes and modes/_profile.md:
# 解决方案经理(政企/To B) + AI 解决方案/售前 + 大模型/Agent. Each is one CLI
# search; a role whose title matches any of them is fetched, then career-ops'
# title_filter narrows it further. Override with argv[1] or JOBHUNT_QUERY.
DEFAULT_QUERIES = ["解决方案", "售前", "AI", "大模型"]

# Per-query budget: npx cold-start + one Meituan fetch. career-ops' provider
# timeout_ms must exceed (len(DEFAULT_QUERIES) * PER_QUERY_TIMEOUT_S).
PER_QUERY_TIMEOUT_S = 30


def log(msg):
    """All non-JSON output goes to stderr, never stdout."""
    print(msg, file=sys.stderr, flush=True)


def force_utf8():
    """Force UTF-8 on stdout/stderr.

    On a Windows GBK console Python would otherwise emit job titles as cp936
    bytes, which career-ops' provider (Node execFile, decodes UTF-8) cannot
    parse. This must run before any Chinese text reaches stdout."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass


def build_base_command():
    """Return the argv prefix used to invoke JobHunt-CLI, or None if absent."""
    for name in ("job", "jobhunt"):
        if shutil.which(name):
            return [name]
    # Fall back to npx (package not installed globally). Windows ships npx.cmd.
    npx = "npx.cmd" if os.name == "nt" else "npx"
    if shutil.which(npx) or shutil.which("npx"):
        return [npx, "jobhunt-cli"]
    return None


def extract_json_array(raw):
    """Pull the first JSON array out of stdout.

    npx can prepend install / progress noise. We locate the outermost `[` ...
    `]` slice and parse just that, so stray leading text doesn't break us."""
    text = raw.strip()
    if not text:
        raise ValueError("empty stdout from JobHunt-CLI")
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1 or end < start:
        raise ValueError("no JSON array found in JobHunt-CLI output")
    return json.loads(text[start:end + 1])


def run_cli(base, site, query, limit, nature):
    cmd = list(base) + [site, "search", query, "--limit", str(limit), "--format", "json"]
    if nature:
        cmd += ["--nature", nature]
    log("running: " + " ".join(cmd))
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=PER_QUERY_TIMEOUT_S,
        shell=False,
    )
    if result.returncode != 0:
        log("JobHunt-CLI exited %d; stderr:\n%s" % (result.returncode, result.stderr))
    return result.stdout


# career-ops compiles location keywords (e.g. "\u5317\u4eac") with a Unicode word-
# boundary regex meant for Latin (so "india" never matches "Indiana"). Chinese
# city names reach us as "\u5317\u4eac\u5e02"; "\u5e02" is a Unicode letter (\p{L}), so "\u5317\u4eac" glued
# to "\u5e02" fails the boundary and the row is WRONGLY dropped by location_filter
# (proved: "\u5317\u4eac"=>pass, "\u5317\u4eac\u5e02"=>reject). Strip trailing admin suffixes so the
# bare city name is what career-ops compares against.
_LOCATION_SEP_RE = re.compile(r"[,\uff0c\u3001;\uff1b/\uff5c|]+")
# Longest-first so a compound suffix (\u7279\u522b\u884c\u653f\u533a / \u81ea\u6cbb\u533a) is caught before a short one.
_ADMIN_SUFFIXES = ("\u7279\u522b\u884c\u653f\u533a", "\u81ea\u6cbb\u5dde", "\u81ea\u6cbb\u533a", "\u5730\u533a", "\u5e02", "\u7701", "\u53bf")


def _clean_location_token(token):
    t = token.strip()
    for suf in _ADMIN_SUFFIXES:
        if len(t) > len(suf) and t.endswith(suf):
            t = t[: -len(suf)]
            break
    return t.strip()


def normalize_location(value):
    """Normalize a JobHunt location into bare, comma-joined city names.

    Handles list / dict / string shapes, splits multi-city strings, strips the
    trailing admin suffix that breaks career-ops' CJK boundary match, and
    de-duplicates while preserving order."""
    if not value:
        return ""
    if isinstance(value, list):
        chunks = [str(v) for v in value if v]
    elif isinstance(value, dict):
        chunks = [str(value.get("name") or value.get("text") or "")]
    else:
        chunks = [str(value)]
    cleaned, seen = [], set()
    for chunk in chunks:
        for tok in _LOCATION_SEP_RE.split(chunk):
            c = _clean_location_token(tok)
            if c and c not in seen:
                seen.add(c)
                cleaned.append(c)
    return ", ".join(cleaned)


def to_records(jobs, company_label):
    out = []
    for job in jobs:
        if not isinstance(job, dict):
            continue
        title = str(job.get("name") or job.get("title") or "").strip()
        url = str(job.get("url") or job.get("jobUrl") or job.get("applyUrl") or "").strip()
        # career-ops requires both; skip anything missing either.
        if not title or not url:
            continue
        rec = {
            "title": title,
            "url": url,
            "location": normalize_location(
                job.get("location_names") or job.get("location") or job.get("locations")
            ),
            "company": company_label,
        }
        # Pass description (combining description + requirement) so scan.mjs's
        # content_filter can check JD text for ToB/大模型/解决方案 keywords.
        desc_parts = []
        for field in ("description", "requirement"):
            val = job.get(field)
            if isinstance(val, str) and val.strip():
                desc_parts.append(val.strip())
        if desc_parts:
            rec["description"] = "\n".join(desc_parts)
        # Map updated_at → postedAt so postingAgeFilter can work.
        updated = job.get("updated_at") or job.get("updated_at")
        if updated:
            rec["postedAt"] = updated
        out.append(rec)
    return out


def resolve_config():
    argv = sys.argv[1:]
    site = argv[0] if len(argv) > 0 else os.environ.get("JOBHUNT_SITE", "meituan")
    raw_query = argv[1] if len(argv) > 1 else os.environ.get("JOBHUNT_QUERY", "")
    # Explicit single/comma list overrides the profile defaults; empty -> defaults.
    queries = [q.strip() for q in raw_query.split(",") if q.strip()] or list(DEFAULT_QUERIES)
    limit = argv[2] if len(argv) > 2 else os.environ.get("JOBHUNT_LIMIT", "30")
    nature = argv[3] if len(argv) > 3 else os.environ.get("JOBHUNT_NATURE", "")
    try:
        limit = str(int(limit))
    except (TypeError, ValueError):
        limit = "30"
    return site, queries, limit, nature


def main():
    force_utf8()
    records = []
    try:
        site, queries, limit, nature = resolve_config()
        base = build_base_command()
        if base is None:
            log("JobHunt-CLI not found: no global `job`/`jobhunt` and no `npx`. "
                "Install with: npm install -g jobhunt-cli")
        else:
            company_label = COMPANY_LABELS.get(site, site.capitalize())
            seen = set()
            for query in queries:
                # One failing keyword must not sink the whole run; keep going.
                try:
                    stdout = run_cli(base, site, query, limit, nature)
                    jobs = extract_json_array(stdout)
                except Exception as exc:
                    log("query %r failed, skipping: %r" % (query, exc))
                    continue
                added = 0
                for rec in to_records(jobs, company_label):
                    key = rec["url"].rstrip("/")
                    if key in seen:
                        continue
                    seen.add(key)
                    records.append(rec)
                    added += 1
                log("query %r: %d raw, %d new (total %d)" % (query, len(jobs), added, len(records)))
    except Exception as exc:  # never let an error reach stdout
        log("jobhunt_bridge error: %r" % (exc,))
        records = []

    # stdout is ONLY ever this one JSON array.
    print(json.dumps(records, ensure_ascii=False))


if __name__ == "__main__":
    main()
