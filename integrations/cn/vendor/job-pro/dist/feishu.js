// Generic Feishu Recruiting (ATSX) adapter factory.
//
// Feishu Recruiting (飞书招聘) is ByteDance's SaaS ATS platform. Multiple companies
// self-host it at dedicated subdomains:
//
//   *.jobs.feishu.cn   — standard Feishu subdomains (NIO, etc.)
//   *.jobs.f.mioffice.cn — Xiaomi fork (not this adapter)
//   {tenant}.jobs.feishu.cn/{companyId}/ — multi-tenant portals (MiniMax)
//
// API surface (identical across all hosts, verified 2026-05):
//   POST https://<host>/api/v1/search/job/posts
//   GET  https://<host>/api/v1/config/job/filters/<channel>
//
// Portal scoping is controlled by two required headers:
//   portal-channel:  the channel slug ("campus", "internship", or company-path like "379481")
//   website-path:    same value as portal-channel
//
// For NIO (nio.jobs.feishu.cn):
//   host    = "nio.jobs.feishu.cn"
//   channel = "campus"
//   apply_url prefix = "https://nio.jobs.feishu.cn/campus/position"
//
// For MiniMax (vrfi1sk8a0.jobs.feishu.cn / company path 379481):
//   host    = "vrfi1sk8a0.jobs.feishu.cn"
//   channel = "379481"            ← company PATH is the portal-channel!
//   apply_url prefix is channel-specific:
//     campus = "https://vrfi1sk8a0.jobs.feishu.cn/379481/position"
//     social = "https://vrfi1sk8a0.jobs.feishu.cn/index/position"
//
// ---- PositionSummary field mapping (Feishu → canonical) ----
//   post_id       ← String(item.id)
//   title         ← item.title
//   project       ← item.job_category.name  (or job_function.name if category null)
//   recruit_label ← item.recruit_type.name
//   bgs           ← ""  (not exposed in public search)
//   work_cities   ← city_list joined " / " (city_info used as fallback)
//   apply_url     ← `${applyUrlPrefix}/${id}/detail`
//
// ---- Discovery notes (2026-05) ----
//   - "site not exist" (-9000003) → wrong portal-channel header
//   - 400 empty body → tenant subdomain not configured on Feishu backend
//   - NIO: job_category is null; project comes from job_function.name
//   - MiniMax: job_function is null; project comes from job_category.name
//   - Both: city_info is null; city_list always populated
import { extractResumeSignals, scoreOverlap, checkResume, pickDistinctiveTerms } from "./tencent.js";
export { checkResume };
// ---------- createAdapter ----------
export function createAdapter(cfg) {
    const API_ROOT = `https://${cfg.host}/api/v1`;
    const source = cfg.host;
    const supportedScopes = cfg.supportedScopes ?? ["social", "campus", "intern", "all"];
    /**
     * Translate a CLI `--scope` value into Feishu wire-level params.
     *
     * Two strategies, in priority order:
     *   1. If the tenant has a dedicated `socialChannel`/`internChannel`
     *      configured (typical of NIO's separate campus/society subdomains),
     *      swap the `portal-channel` header value.
     *   2. Otherwise stay on the default channel and constrain by
     *      `recruitment_id_list`. Feishu's canonical IDs are
     *      `101` = 社招 (social), `201` = 校招 (campus), `202` = 实习 (intern).
     *
     * `scope === undefined` (caller didn't pass --scope) and `scope === "all"`
     * both preserve historical behaviour — the adapter's original `channel`
     * with no extra recruitment filter (so 1.0.93 callers get bit-for-bit
     * identical queries).
     */
    function channelForScope(s) {
        // NOTE: `!== undefined`, not truthiness — `""` is a real channel value
        // on custom-domain portals (hr.sensetime.com main site).
        if (s === undefined || s === "all")
            return { channel: cfg.channel };
        if (s === "social") {
            if (cfg.socialChannel !== undefined)
                return { channel: cfg.socialChannel };
            return { channel: cfg.channel, recruitmentIdList: ["101"] };
        }
        if (s === "intern") {
            if (cfg.internChannel !== undefined)
                return { channel: cfg.internChannel };
            return { channel: cfg.channel, recruitmentIdList: ["202"] };
        }
        if (s === "campus") {
            if (cfg.campusChannel !== undefined)
                return { channel: cfg.campusChannel };
            return { channel: cfg.channel, recruitmentIdList: ["201"] };
        }
        return { channel: cfg.channel };
    }
    function makeHeaders(channel) {
        return {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            Accept: "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "portal-channel": channel,
            "portal-platform": "pc",
            "website-path": channel,
            Referer: `https://${cfg.host}/${channel}/position`,
        };
    }
    async function call(path, body, channel = cfg.channel) {
        const url = `${API_ROOT}${path}`;
        let response;
        try {
            response = await fetch(url, {
                method: "POST",
                headers: makeHeaders(channel),
                body: JSON.stringify(body),
            });
        }
        catch (err) {
            return {
                ok: false,
                message: `network error: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
        if (!response.ok) {
            return { ok: false, message: `HTTP ${response.status}: ${response.statusText}` };
        }
        let payload;
        try {
            payload = (await response.json());
        }
        catch (err) {
            return { ok: false, message: `bad JSON: ${err instanceof Error ? err.message : err}` };
        }
        return {
            ok: payload.code === 0,
            data: payload.data,
            message: payload.message || (payload.code === 0 ? "ok" : "upstream error"),
        };
    }
    function summarizePosition(item, channel = cfg.channel) {
        const id = String(item.id ?? "");
        const cityList = item.city_list ?? [];
        let work_cities;
        if (cityList.length > 1) {
            work_cities = cityList.map((c) => c.name ?? "").filter(Boolean).join(" / ");
        }
        else {
            work_cities = cityList[0]?.name ?? item.city_info?.name ?? "";
        }
        // NIO: job_category null, job_function has the name.
        // MiniMax: job_function null, job_category has the name.
        const project = item.job_category?.name ??
            item.job_function?.name ??
            "";
        const applyUrlPrefix = cfg.applyUrlPrefixByChannel?.[channel] ?? cfg.applyUrlPrefix;
        return {
            post_id: id,
            title: item.title ?? "",
            project,
            recruit_label: item.recruit_type?.name ?? "",
            bgs: "",
            work_cities,
            apply_url: id ? `${applyUrlPrefix}/${encodeURIComponent(id)}/detail` : `https://${cfg.host}/${channel}/position`,
        };
    }
    const asStringList = (v) => {
        if (v === undefined)
            return undefined;
        const arr = Array.isArray(v) ? v : [v];
        return arr.map(String);
    };
    // ---------- searchPositions ----------
    async function searchPositions(opts = {}) {
        const pageSize = Math.max(1, Math.min(100, opts.pageSize ?? 20));
        const page = Math.max(1, opts.page ?? 1);
        const offset = (page - 1) * pageSize;
        const keyword = (opts.keyword ?? "").trim().slice(0, 60);
        const scopeTranslation = channelForScope(opts.scope);
        const payload = {
            keyword,
            limit: pageSize,
            offset,
            portal_type: 3,
            portal_entrance: 1,
            language: "zh",
        };
        // Caller's explicit recruitmentIdList wins over the scope-derived one.
        // This preserves any 1.0.93 callsite that passed recruitmentIdList directly.
        const callerRecruitmentIdList = asStringList(opts.recruitmentIdList);
        const recruitmentIdList = callerRecruitmentIdList !== undefined && callerRecruitmentIdList.length > 0
            ? callerRecruitmentIdList
            : scopeTranslation.recruitmentIdList;
        if (recruitmentIdList !== undefined && recruitmentIdList.length > 0) {
            payload.recruitment_id_list = recruitmentIdList;
        }
        const jobCategoryIdList = asStringList(opts.jobCategoryIdList);
        if (jobCategoryIdList?.length) {
            payload.job_category_id_list = jobCategoryIdList;
        }
        const cityIdList = asStringList(opts.cityIdList);
        if (cityIdList?.length) {
            payload.location_code_list = cityIdList;
        }
        const subjectIdList = asStringList(opts.subjectIdList);
        if (subjectIdList?.length) {
            payload.subject_id_list = subjectIdList;
        }
        const response = await call("/search/job/posts", payload, scopeTranslation.channel);
        if (!response.ok || !response.data) {
            return {
                ok: false,
                message: response.message,
                source,
                query: payload,
                positions: [],
            };
        }
        const rows = response.data.job_post_list ?? [];
        return {
            ok: true,
            source,
            query: payload,
            scope: opts.scope,
            page,
            page_size: pageSize,
            total: response.data.count ?? rows.length,
            positions: rows.map((item) => summarizePosition(item, scopeTranslation.channel)),
        };
    }
    // ---------- fetchAllPositions ----------
    /** Enumerate one scope's channel to exhaustion with post_id dedupe. */
    async function fetchAllOneScope(scope, opts, seen, bucket) {
        const pageSize = Math.max(1, Math.min(100, opts.pageSize ?? 100));
        const maxPages = Math.max(1, opts.maxPages ?? 50);
        let total;
        for (let page = 1; page <= maxPages; page++) {
            const result = await searchPositions({ ...opts, scope, page, pageSize });
            if (!result.ok)
                return { ok: false, message: result.message, total: total ?? 0, truncated: true };
            if (total === undefined)
                total = result.total;
            if (!result.positions.length)
                return { ok: true, total: total ?? 0, truncated: false };
            let added = 0;
            for (const p of result.positions) {
                if (seen.has(p.post_id))
                    continue;
                seen.add(p.post_id);
                bucket.push(p);
                added += 1;
            }
            // No fresh ids = upstream replaying pages; stop instead of looping.
            if (added === 0)
                return { ok: true, total: total ?? 0, truncated: false };
            if (total !== undefined && bucket.length >= total)
                return { ok: true, total, truncated: false };
            if (result.positions.length < pageSize)
                return { ok: true, total: total ?? 0, truncated: false };
        }
        return { ok: true, total: total ?? 0, truncated: true };
    }
    async function fetchAllPositions(opts = {}) {
        const seen = new Set();
        const bucket = [];
        // scope === "all" sweeps every distinct configured channel (deduped by
        // post_id) — a Feishu post only exists on its own portal channel, so a
        // single-channel sweep silently misses the other portals (audit: minimax
        // `all` returned 77 campus posts while 190 social posts existed).
        // Other scopes (or none) keep the historical single-channel behaviour.
        const sweeps = opts.scope === "all"
            ? (() => {
                const chs = new Set();
                const order = [];
                const pairs = [
                    [undefined, cfg.channel],
                    ["social", cfg.socialChannel],
                    ["campus", cfg.campusChannel],
                    ["intern", cfg.internChannel],
                ];
                for (const [sc, ch] of pairs) {
                    if (ch === undefined || chs.has(ch))
                        continue;
                    chs.add(ch);
                    order.push(sc);
                }
                return order;
            })()
            : [opts.scope];
        let totalSum = 0;
        let truncated = false;
        const errors = [];
        for (const sweep of sweeps) {
            const r = await fetchAllOneScope(sweep, opts, seen, bucket);
            if (!r.ok) {
                errors.push(r.message ?? "unknown error");
                truncated = true;
                continue;
            }
            totalSum += r.total;
            if (r.truncated)
                truncated = true;
        }
        if (bucket.length === 0 && errors.length === sweeps.length) {
            return {
                ok: false,
                message: errors.join("; "),
                source,
                fetched: 0,
                positions: bucket,
            };
        }
        return {
            ok: true,
            source,
            // Dedupe can make unique count < per-channel total sum; report the sum
            // as the upstream-declared total and fetched as unique rows harvested.
            total: totalSum || bucket.length,
            fetched: bucket.length,
            positions: bucket,
            ...(truncated ? { truncated: true } : {}),
            ...(errors.length ? { errors } : {}),
        };
    }
    // ---------- fetchPositionDetail ----------
    // Feishu has no public per-post detail REST endpoint.
    // Paginate search and filter by id.
    async function fetchPositionDetail(postId) {
        const id = (postId ?? "").trim();
        if (!id)
            return { ok: false, source, message: "post_id is required" };
        const pageSize = 100;
        const maxPages = 5;
        // A post only exists on its own portal channel, so sweep every distinct
        // configured channel (default first) — otherwise detail fails for any
        // job that lives on a non-default channel (e.g. hr.sensetime.com campus
        // jobs on "edu" while the default channel is the social main site).
        const channels = [];
        for (const c of [cfg.channel, cfg.socialChannel, cfg.campusChannel, cfg.internChannel]) {
            if (c !== undefined && !channels.includes(c))
                channels.push(c);
        }
        for (const channel of channels) {
            for (let page = 1; page <= maxPages; page++) {
                const offset = (page - 1) * pageSize;
                const payload = {
                    keyword: "",
                    limit: pageSize,
                    offset,
                    portal_type: 3,
                    portal_entrance: 1,
                    language: "zh",
                };
                const response = await call("/search/job/posts", payload, channel);
                if (!response.ok || !response.data)
                    break;
                const posts = response.data.job_post_list ?? [];
                const found = posts.find((p) => String(p.id) === id);
                if (found) {
                    const summary = summarizePosition(found, channel);
                    return {
                        ok: true,
                        source,
                        post_id: id,
                        title: found.title ?? "",
                        direction: found.sub_title ?? "",
                        description: found.description ?? "",
                        requirements: found.requirement ?? "",
                        work_cities: found.city_list ?? (found.city_info ? [found.city_info] : []),
                        apply_url: summary.apply_url,
                    };
                }
                if (posts.length < pageSize)
                    break;
            }
        }
        return {
            ok: false,
            source,
            post_id: id,
            message: `post ${id} not found in public search results (searched up to ${maxPages * 100} posts)`,
        };
    }
    // ---------- fetchDictionaries ----------
    let _filterCache = null;
    async function fetchDictionaries() {
        if (_filterCache !== null)
            return _filterCache;
        const url = `${API_ROOT}/config/job/filters/${cfg.channel}`;
        let response;
        try {
            response = await fetch(url, { headers: makeHeaders(cfg.channel) });
        }
        catch (err) {
            const r = {
                ok: false,
                source,
                message: `network error: ${err instanceof Error ? err.message : String(err)}`,
            };
            _filterCache = r;
            return r;
        }
        if (!response.ok) {
            const r = { ok: false, source, message: `HTTP ${response.status}` };
            _filterCache = r;
            return r;
        }
        let payload;
        try {
            payload = await response.json();
        }
        catch (err) {
            const r = {
                ok: false,
                source,
                message: `bad JSON: ${err instanceof Error ? err.message : String(err)}`,
            };
            _filterCache = r;
            return r;
        }
        if (payload.code !== 0 || !payload.data) {
            const r = {
                ok: false,
                source,
                message: payload.message ?? "upstream error",
            };
            _filterCache = r;
            return r;
        }
        const d = payload.data;
        const jobCategories = (d.job_type_list ?? []).map((cat) => ({
            id: cat.id ?? "",
            name: cat.name ?? "",
            en_name: cat.en_name ?? "",
            depth: cat.depth ?? 1,
            parent_id: cat.parent?.id ?? null,
        }));
        const cities = (d.city_list ?? []).map((c) => ({
            code: c.code ?? "",
            name: c.name ?? "",
            en_name: c.en_name ?? "",
        }));
        const subjects = (d.job_subject_list ?? []).map((s) => ({
            id: s.id ?? "",
            name: s.name?.zh_cn ?? s.name?.i18n ?? "",
            group: s.subject_group_info?.name ?? "",
        }));
        const recruitmentTypes = [
            { id: "201", name: "正式" },
            { id: "202", name: "实习" },
        ];
        const result = {
            ok: true,
            source,
            jobCategories,
            cities,
            subjects,
            recruitmentTypes,
        };
        _filterCache = result;
        return result;
    }
    // ---------- stub notices ----------
    const NOTICES_STUB = {
        ok: false,
        source,
        message: `${cfg.label}: no public notices endpoint`,
    };
    async function listNotices() {
        return NOTICES_STUB;
    }
    async function getNotice(_id) {
        return { ok: false, source, message: `${cfg.label}: no public notices endpoint` };
    }
    async function findNoticesByQuestion(_question, _opts = {}) {
        return { ok: false, source, message: `${cfg.label}: no public notices endpoint` };
    }
    // ---------- matchResume ----------
    async function matchResume(text, opts = {}) {
        const topN = Math.max(1, opts.topN ?? 5);
        const candidates = Math.max(topN, opts.candidates ?? 20);
        const { terms, cities } = extractResumeSignals(text ?? "");
        if (!terms.length) {
            return {
                ok: false,
                source,
                message: "could not extract any technical signals from the text",
                preview: (text ?? "").slice(0, 120),
            };
        }
        const queries = pickDistinctiveTerms(terms, 3);
        if (!queries.length)
            queries.push(terms[0] ?? "");
        const [posLists, rawResults] = await Promise.all([
            Promise.all(queries.map((q) => searchPositions({ keyword: q, page: 1, pageSize: 100 }))),
            Promise.all(queries.map((q) => call("/search/job/posts", {
                keyword: q, limit: 100, offset: 0, portal_type: 3, portal_entrance: 1, language: "zh",
            }))),
        ]);
        const seen = new Set();
        const pool = [];
        let lastErr;
        for (const l of posLists) {
            if (!l.ok) {
                lastErr = l.message;
                continue;
            }
            for (const p of l.positions) {
                if (!seen.has(p.post_id)) {
                    seen.add(p.post_id);
                    pool.push(p);
                }
            }
        }
        if (!pool.length) {
            const broad = await searchPositions({ page: 1, pageSize: 100 });
            if (broad.ok)
                pool.push(...broad.positions);
        }
        if (!pool.length) {
            return { ok: false, source, message: lastErr ?? "no positions returned", positions: [] };
        }
        const rawPosts = rawResults.flatMap((r) => r.ok ? (r.data?.job_post_list ?? []) : []);
        const rawById = new Map();
        for (const p of rawPosts) {
            rawById.set(String(p.id ?? ""), p);
        }
        const scored = [];
        for (const p of pool) {
            const rp = rawById.get(p.post_id);
            const blob = [
                p.title,
                p.project,
                p.recruit_label,
                p.work_cities,
                rp?.description ?? "",
                rp?.requirement ?? "",
            ].join(" ");
            const { score, reasons } = scoreOverlap(blob, terms, cities);
            if (score > 0) {
                scored.push({
                    score,
                    position: p,
                    reasons,
                    description: rp?.description,
                    requirements: rp?.requirement,
                });
            }
        }
        scored.sort((a, b) => b.score - a.score);
        let shortlist = scored.slice(0, Math.max(topN, candidates));
        if (!shortlist.length) {
            shortlist = pool.slice(0, candidates).map((position) => ({
                score: 0,
                position,
                reasons: [],
                description: rawById.get(position.post_id)?.description,
                requirements: rawById.get(position.post_id)?.requirement,
            }));
        }
        const matches = shortlist.slice(0, topN).map((s) => {
            const mr = s.reasons.length > 0
                ? s.reasons.slice(0, 5)
                : ["no specific keyword overlap — surfaced from initial keyword search"];
            return {
                ...s.position,
                description: s.description,
                requirements: s.requirements,
                match_reasons: mr,
            };
        });
        return {
            ok: true,
            source,
            extracted_terms: terms,
            city_preferences: cities,
            matches,
            note: "match_reasons surfaces overlapping keywords, not a probability of getting an interview. " +
                "The only authority on selection is HR.",
        };
    }
    return {
        supportedScopes,
        channelForScope,
        searchPositions,
        fetchAllPositions,
        fetchPositionDetail,
        fetchDictionaries,
        listNotices,
        getNotice,
        findNoticesByQuestion,
        matchResume,
        checkResume,
    };
}
