// Generic Greenhouse Boards adapter factory.
//
// Greenhouse (boards-api.greenhouse.io) is a widely-used SaaS ATS. Multiple
// Chinese companies (or their international arms) self-host their public job
// board on a `<slug>` namespace there. The unauthenticated REST surface is
// stable across tenants:
//
//   GET https://boards-api.greenhouse.io/v1/boards/<slug>/jobs
//     → { jobs: [...], meta: { total: <int> } }
//
//   GET https://boards-api.greenhouse.io/v1/boards/<slug>/jobs/<id>?content=true
//     → full job object including the rendered description HTML
//
//   GET https://boards-api.greenhouse.io/v1/boards/<slug>/departments
//     → { departments: [{ id, name, child_ids[], parent_id }] }
//
//   GET https://boards-api.greenhouse.io/v1/boards/<slug>/offices
//     → { offices: [{ id, name, location, child_ids[], parent_id }] }
//
// All endpoints are GET-only, return JSON, and require no auth headers.
//
// ---- PositionSummary field mapping (Greenhouse → canonical) ----
//   post_id       ← String(job.id)
//   title         ← job.title
//   project       ← job.departments[0]?.name (or "")
//   recruit_label ← job.metadata where name matches "Employment Type" (else "")
//   bgs           ← ""  (Greenhouse has no BG dimension)
//   work_cities   ← job.location.name
//   apply_url     ← job.absolute_url
//
// ---- Discovery notes ----
//   * Greenhouse returns the full job list in a single call — no pagination is
//     required for ATS sizes seen so far (<2000 jobs).
//   * The `meta.total` field is always present.
//   * `content=true` on the detail endpoint returns description as escaped HTML.
import { extractResumeSignals, scoreOverlap, checkResume } from "./tencent.js";
export { checkResume };
// ---------- createAdapter ----------
export function createAdapter(cfg) {
    const API_ROOT = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(cfg.slug)}`;
    const SOURCE = `boards-api.greenhouse.io/${cfg.slug}`;
    const BOARD_URL = `https://job-boards.greenhouse.io/${encodeURIComponent(cfg.slug)}`;
    const HEADERS = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/json",
    };
    function summarize(job) {
        const id = String(job.id ?? "");
        const dept = job.departments?.[0]?.name ?? "";
        const employmentType = (job.metadata ?? []).find((m) => (m.name ?? "").toLowerCase() === "employment type")?.value;
        const recruit_label = typeof employmentType === "string" ? employmentType : "";
        return {
            post_id: id,
            title: job.title ?? "",
            project: dept,
            recruit_label,
            bgs: "",
            work_cities: job.location?.name ?? "",
            apply_url: job.absolute_url ?? `${BOARD_URL}/jobs/${id}`,
        };
    }
    let _allCache = null;
    async function fetchAllRaw() {
        const now = Date.now();
        if (_allCache && now - _allCache.fetchedAt < 5 * 60 * 1000) {
            return _allCache.ok ? { ok: true, jobs: _allCache.jobs } : { ok: false, message: _allCache.message };
        }
        let response;
        try {
            response = await fetch(`${API_ROOT}/jobs?content=false`, { headers: HEADERS });
        }
        catch (err) {
            const msg = `network error: ${err instanceof Error ? err.message : String(err)}`;
            _allCache = { ok: false, message: msg, fetchedAt: now };
            return { ok: false, message: msg };
        }
        if (!response.ok) {
            const msg = `HTTP ${response.status}: ${response.statusText}`;
            _allCache = { ok: false, message: msg, fetchedAt: now };
            return { ok: false, message: msg };
        }
        let payload;
        try {
            payload = (await response.json());
        }
        catch (err) {
            const msg = `bad JSON: ${err instanceof Error ? err.message : String(err)}`;
            _allCache = { ok: false, message: msg, fetchedAt: now };
            return { ok: false, message: msg };
        }
        const jobs = payload.jobs ?? [];
        _allCache = { ok: true, jobs, fetchedAt: now };
        return { ok: true, jobs };
    }
    function applyFilters(jobs, opts) {
        const kw = (opts.keyword ?? "").trim().toLowerCase();
        const deptFilters = (opts.departments ?? []).map((s) => String(s).toLowerCase());
        const cityFilters = (opts.cities ?? []).map((s) => String(s).toLowerCase());
        return jobs.filter((job) => {
            if (kw) {
                const blob = [
                    job.title ?? "",
                    job.location?.name ?? "",
                    (job.departments ?? []).map((d) => d.name).join(" "),
                ]
                    .join(" ")
                    .toLowerCase();
                if (!blob.includes(kw))
                    return false;
            }
            if (deptFilters.length) {
                const blob = (job.departments ?? [])
                    .map((d) => (d.name ?? "").toLowerCase())
                    .join(" ");
                if (!deptFilters.some((d) => blob.includes(d)))
                    return false;
            }
            if (cityFilters.length) {
                const blob = (job.location?.name ?? "").toLowerCase();
                if (!cityFilters.some((c) => blob.includes(c)))
                    return false;
            }
            return true;
        });
    }
    async function searchPositions(opts = {}) {
        const pageSize = Math.max(1, Math.min(200, opts.pageSize ?? 20));
        const page = Math.max(1, opts.page ?? 1);
        const pool = await fetchAllRaw();
        if (!pool.ok) {
            return {
                ok: false,
                message: pool.message,
                source: SOURCE,
                apply_url: BOARD_URL,
                positions: [],
            };
        }
        const filtered = applyFilters(pool.jobs, opts);
        const offset = (page - 1) * pageSize;
        const paginated = filtered.slice(offset, offset + pageSize);
        return {
            ok: true,
            source: SOURCE,
            scope: opts.scope,
            query: opts,
            page,
            page_size: pageSize,
            total: filtered.length,
            positions: paginated.map(summarize),
        };
    }
    async function fetchAllPositions(opts = {}) {
        const pool = await fetchAllRaw();
        if (!pool.ok) {
            return {
                ok: false,
                message: pool.message,
                source: SOURCE,
                apply_url: BOARD_URL,
                fetched: 0,
                positions: [],
            };
        }
        const filtered = applyFilters(pool.jobs, opts);
        return {
            ok: true,
            source: SOURCE,
            scope: opts.scope,
            total: filtered.length,
            fetched: filtered.length,
            positions: filtered.map(summarize),
        };
    }
    async function fetchPositionDetail(postId) {
        const id = (postId ?? "").trim();
        if (!id) {
            return { ok: false, source: SOURCE, message: "post_id is required" };
        }
        let response;
        try {
            response = await fetch(`${API_ROOT}/jobs/${encodeURIComponent(id)}?content=true`, { headers: HEADERS });
        }
        catch (err) {
            return {
                ok: false,
                source: SOURCE,
                post_id: id,
                message: `network error: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
        if (!response.ok) {
            return {
                ok: false,
                source: SOURCE,
                post_id: id,
                message: `HTTP ${response.status}: ${response.statusText}`,
            };
        }
        let job;
        try {
            job = (await response.json());
        }
        catch (err) {
            return {
                ok: false,
                source: SOURCE,
                post_id: id,
                message: `bad JSON: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
        const summary = summarize(job);
        const html = job.content ?? "";
        // Crude HTML-to-text: decode common entities, strip tags.
        const description = html
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\s+/g, " ")
            .trim();
        return {
            ok: true,
            source: SOURCE,
            post_id: id,
            title: job.title ?? "",
            project: summary.project,
            recruit_label: summary.recruit_label,
            requisition_id: job.requisition_id ?? "",
            first_published: job.first_published ?? "",
            updated_at: job.updated_at ?? "",
            description,
            work_cities: job.location?.name ?? "",
            apply_url: summary.apply_url,
        };
    }
    // ---------- fetchDictionaries ----------
    let _dictCache = null;
    async function fetchDictionaries() {
        if (_dictCache !== null)
            return _dictCache;
        try {
            const [deptRes, offRes] = await Promise.all([
                fetch(`${API_ROOT}/departments`, { headers: HEADERS }),
                fetch(`${API_ROOT}/offices`, { headers: HEADERS }),
            ]);
            if (!deptRes.ok && !offRes.ok) {
                const r = {
                    ok: false,
                    source: SOURCE,
                    message: `HTTP ${deptRes.status}/${offRes.status}`,
                };
                _dictCache = r;
                return r;
            }
            const deptJson = deptRes.ok
                ? (await deptRes.json())
                : { departments: [] };
            const offJson = offRes.ok
                ? (await offRes.json())
                : { offices: [] };
            const result = {
                ok: true,
                source: SOURCE,
                departments: (deptJson.departments ?? []).map((d) => ({
                    id: d.id ?? 0,
                    name: d.name ?? "",
                    parent_id: d.parent_id ?? null,
                })),
                offices: (offJson.offices ?? []).map((o) => ({
                    id: o.id ?? 0,
                    name: o.name ?? "",
                    location: o.location ?? "",
                    parent_id: o.parent_id ?? null,
                })),
            };
            _dictCache = result;
            return result;
        }
        catch (err) {
            const r = {
                ok: false,
                source: SOURCE,
                message: `network error: ${err instanceof Error ? err.message : String(err)}`,
            };
            _dictCache = r;
            return r;
        }
    }
    // ---------- notices (stub) ----------
    const NOTICES_STUB = {
        ok: false,
        source: SOURCE,
        message: `${cfg.label}: Greenhouse boards have no announcements endpoint`,
    };
    async function listNotices() {
        return NOTICES_STUB;
    }
    async function getNotice(_id) {
        return NOTICES_STUB;
    }
    async function findNoticesByQuestion(_question, _opts = {}) {
        return NOTICES_STUB;
    }
    // ---------- matchResume ----------
    async function matchResume(text, opts = {}) {
        const topN = Math.max(1, opts.topN ?? 5);
        const candidates = Math.max(topN, opts.candidates ?? 20);
        const { terms, cities } = extractResumeSignals(text ?? "");
        if (!terms.length) {
            return {
                ok: false,
                source: SOURCE,
                message: "could not extract any technical signals from the text",
                preview: (text ?? "").slice(0, 120),
            };
        }
        const pool = await fetchAllRaw();
        if (!pool.ok) {
            return { ok: false, source: SOURCE, message: pool.message, positions: [] };
        }
        const scored = [];
        for (const job of pool.jobs) {
            const blob = [
                job.title ?? "",
                job.location?.name ?? "",
                (job.departments ?? []).map((d) => d.name).join(" "),
            ].join(" ");
            const { score, reasons } = scoreOverlap(blob, terms, cities);
            if (score > 0)
                scored.push({ score, raw: job, reasons });
        }
        scored.sort((a, b) => b.score - a.score);
        let shortlist = scored.slice(0, Math.max(topN, candidates));
        if (!shortlist.length) {
            shortlist = pool.jobs.slice(0, candidates).map((raw) => ({
                score: 0,
                raw,
                reasons: [],
            }));
        }
        const matches = shortlist.slice(0, topN).map((s) => {
            const mr = s.reasons.length > 0
                ? s.reasons.slice(0, 5)
                : ["no specific keyword overlap — surfaced from full board listing"];
            return { ...summarize(s.raw), match_reasons: mr };
        });
        return {
            ok: true,
            source: SOURCE,
            extracted_terms: terms,
            city_preferences: cities,
            matches,
            note: "match_reasons surfaces overlapping keywords, not a probability of getting an interview. " +
                "The only authority on selection is HR.",
        };
    }
    return {
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
