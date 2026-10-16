"use strict";

const PAGE = 50;
const NEW_DAYS = 30;
const LS_KEY = "paper-tracker.customTopics";

const $ = (id) => document.getElementById(id);
const state = {
  topic: "rust",
  q: "",
  venues: new Set(),
  years: new Set(),
  since: 0,
  sort: "year",
  titleOnly: false,
  shown: PAGE,
};

let papers = [];
let meta = null;
let topics = [];          // {id, name, description, patterns, exclude, custom, rx, ex}
let venueById = {};
let initialImport = "";   // 최초 수집일: 이 날 들어온 논문은 NEW 표시를 하지 않는다

// ------------------------------------------------------------------ util

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function safeRegex(src, flags = "i") {
  try { return new RegExp(src, flags); } catch { return null; }
}

function compileTopic(t) {
  return {
    ...t,
    rx: (t.patterns || []).map((p) => safeRegex(p)).filter(Boolean),
    ex: (t.exclude || []).map((p) => safeRegex(p)).filter(Boolean),
  };
}

function matchesTopic(p, t) {
  const text = state.titleOnly ? p.title : p._text;
  return t.rx.some((r) => r.test(text)) && !t.ex.some((r) => r.test(p._text));
}

// 사용자가 입력한 키워드 → 정규식 패턴 목록
function keywordToPatterns(input) {
  const s = input.trim();
  if (s.startsWith("/") && s.lastIndexOf("/") > 0) {
    const body = s.slice(1, s.lastIndexOf("/"));
    return safeRegex(body) ? [body] : [];
  }
  return s.split(",").map((w) => w.trim()).filter(Boolean).map((w) => {
    let p = reEsc(w).replace(/\s+/g, "[\\s-]+");
    if (/^\w/.test(w)) p = "\\b" + p;
    if (/\w$/.test(w)) p = p + "\\b";
    return p;
  });
}

function parseQuery(q) {
  const terms = [];
  q.replace(/"([^"]+)"|(\S+)/g, (_, phrase, word) => { terms.push((phrase || word).toLowerCase()); });
  return terms;
}

function highlight(text, regexes) {
  if (!text) return "";
  const ranges = [];
  for (const r of regexes) {
    const g = new RegExp(r.source, r.flags.includes("g") ? r.flags : r.flags + "g");
    let m;
    while ((m = g.exec(text)) !== null) {
      if (m[0].length === 0) { g.lastIndex++; continue; }
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  if (!ranges.length) return esc(text);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0]];
  for (const [s, e] of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (s <= last[1]) last[1] = Math.max(last[1], e); else merged.push([s, e]);
  }
  let out = "", pos = 0;
  for (const [s, e] of merged) {
    out += esc(text.slice(pos, s)) + "<mark>" + esc(text.slice(s, e)) + "</mark>";
    pos = e;
  }
  return out + esc(text.slice(pos));
}

function daysAgo(dateStr) {
  return (Date.now() - new Date(dateStr + "T00:00:00Z").getTime()) / 86400000;
}

// ------------------------------------------------------------------ state <-> URL

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.has("topic")) state.topic = h.get("topic");
  if (h.has("q")) state.q = h.get("q");
  if (h.has("v")) state.venues = new Set(h.get("v").split(",").filter(Boolean));
  if (h.has("y")) state.years = new Set(h.get("y").split(",").filter(Boolean).map(Number));
  if (h.has("since")) state.since = Number(h.get("since")) || 0;
  if (h.has("sort")) state.sort = h.get("sort");
  state.titleOnly = h.get("title") === "1";
}

function writeHash() {
  const h = new URLSearchParams();
  if (state.topic !== "all") h.set("topic", state.topic);
  if (state.q) h.set("q", state.q);
  if (state.venues.size) h.set("v", [...state.venues].join(","));
  if (state.years.size) h.set("y", [...state.years].join(","));
  if (state.since) h.set("since", state.since);
  if (state.sort !== "year") h.set("sort", state.sort);
  if (state.titleOnly) h.set("title", "1");
  const s = h.toString();
  history.replaceState(null, "", s ? "#" + s : location.pathname + location.search);
}

// ------------------------------------------------------------------ custom topics

function loadCustomTopics() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); } catch { return []; }
}
function saveCustomTopics() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(
      topics.filter((t) => t.custom).map(({ id, name, patterns }) => ({ id, name, patterns }))));
  } catch { /* private mode 등 */ }
}

function topicYaml(t) {
  const slug = t.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "topic";
  return `  - id: ${slug}\n    name: ${t.name}\n    patterns:\n` +
    t.patterns.map((p) => `      - '${p.replace(/'/g, "''")}'`).join("\n") + "\n";
}

// ------------------------------------------------------------------ filtering

function baseFiltered({ ignoreVenueYear = false } = {}) {
  const terms = parseQuery(state.q);
  return papers.filter((p) => {
    if (!ignoreVenueYear) {
      if (state.venues.size && !state.venues.has(p.venue)) return false;
      if (state.years.size && !state.years.has(p.year)) return false;
    }
    if (state.since && daysAgo(p.first_seen) > state.since) return false;
    for (const t of terms) if (!p._lower.includes(t)) return false;
    return true;
  });
}

function currentTopic() {
  return topics.find((t) => t.id === state.topic) || null;
}

function applyTopic(list) {
  const t = currentTopic();
  return t ? list.filter((p) => matchesTopic(p, t)) : list;
}

// 토픽 패턴이 제목에 있으면 크게, 초록 매칭 횟수만큼 조금 가산
function relevance(p) {
  const t = currentTopic();
  if (!t) return 0;
  let score = t.rx.some((r) => r.test(p.title)) ? 100 : 0;
  for (const r of t.rx) score += (p._text.match(new RegExp(r.source, "gi")) || []).length;
  return score;
}

function sortList(list) {
  const vOrder = Object.fromEntries(meta.venues.map((v, i) => [v.id, i]));
  const by = {
    year: (a, b) => b.year - a.year || vOrder[a.venue] - vOrder[b.venue] || a.title.localeCompare(b.title),
    added: (a, b) => b.first_seen.localeCompare(a.first_seen) || b.year - a.year,
    venue: (a, b) => vOrder[a.venue] - vOrder[b.venue] || b.year - a.year,
    title: (a, b) => a.title.localeCompare(b.title),
    relevance: (a, b) => relevance(b) - relevance(a) || b.year - a.year,
  }[state.sort] || (() => 0);
  return list.slice().sort(by);
}

// ------------------------------------------------------------------ render

function renderTopicChips(base) {
  const el = $("topicChips");
  const chips = [{ id: "all", name: "전체", n: base.length }].concat(
    topics.map((t) => ({ id: t.id, name: t.name, custom: t.custom, n: base.filter((p) => matchesTopic(p, t)).length })));
  el.innerHTML = chips.map((c) => `
    <span class="chip ${c.id === state.topic ? "on" : ""} ${c.custom ? "custom" : ""}" data-topic="${esc(c.id)}"
      title="${c.custom ? "브라우저에 저장된 개인 키워드" : ""}">
      ${esc(c.name)} <span class="n">${c.n}</span>
      ${c.custom ? `<button class="x" data-remove="${esc(c.id)}" aria-label="삭제">×</button>` : ""}
    </span>`).join("");
}

function renderTopicInfo() {
  const t = currentTopic();
  const el = $("topicInfo");
  if (!t) { el.hidden = true; return; }
  el.hidden = false;
  const pats = t.patterns.map((p) => `<code>${esc(p)}</code>`).join(" ");
  el.innerHTML = `${t.description ? esc(t.description) + " · " : ""}패턴: ${pats}` +
    (t.custom
      ? ` <button type="button" class="ghost" id="copyYaml">topics.yml용 복사</button>
         <span>— 이 키워드는 이 브라우저에만 저장됩니다. RSS 피드와 다른 기기에서도 보려면 복사해 <code>config/topics.yml</code>에 붙여넣으세요.</span>`
      : "");
  const btn = $("copyYaml");
  if (btn) btn.onclick = async () => {
    try { await navigator.clipboard.writeText(topicYaml(t)); btn.textContent = "복사됨"; }
    catch { prompt("아래 내용을 config/topics.yml에 붙여넣으세요", topicYaml(t)); }
  };
}

function renderFilterChips() {
  $("venueChips").innerHTML = meta.venues.map((v) =>
    `<span class="chip ${state.venues.has(v.id) ? "on" : ""}" data-venue="${v.id}" title="${esc(v.name)}">${esc(v.short)}</span>`).join("");
  const years = [...new Set(papers.map((p) => p.year))].sort((a, b) => b - a);
  $("yearChips").innerHTML = years.map((y) =>
    `<span class="chip ${state.years.has(y) ? "on" : ""}" data-year="${y}">${y}</span>`).join("");
}

function renderMatrix(list) {
  const years = [...new Set(papers.map((p) => p.year))].sort((a, b) => a - b);
  const cnt = {};
  for (const p of list) cnt[p.venue + ":" + p.year] = (cnt[p.venue + ":" + p.year] || 0) + 1;
  const rowsHtml = meta.venues.map((v) => {
    let total = 0;
    const cells = years.map((y) => {
      const n = cnt[v.id + ":" + y] || 0;
      total += n;
      const sel = state.venues.size === 1 && state.venues.has(v.id) && state.years.size === 1 && state.years.has(y);
      return `<td class="${n ? "c" : "z"} ${sel ? "sel" : ""}" data-cell="${v.id}:${y}">${n || "·"}</td>`;
    }).join("");
    return `<tr><td class="v">${esc(v.short)}</td>${cells}<th>${total}</th></tr>`;
  }).join("");
  $("matrix").innerHTML = `<tr><th></th>${years.map((y) => `<th>${y}</th>`).join("")}<th>합계</th></tr>${rowsHtml}`;
}

function renderResults(list) {
  const t = currentTopic();
  const hl = [...(t ? t.rx : []), ...parseQuery(state.q).map((w) => new RegExp(reEsc(w), "i"))];
  $("resultCount").textContent = `${list.length.toLocaleString()}편`;
  $("results").innerHTML = list.slice(0, state.shown).map((p) => {
    const v = venueById[p.venue];
    const isNew = p.first_seen > initialImport && daysAgo(p.first_seen) <= NEW_DAYS;
    const tags = topics.filter((x) => x.id !== state.topic && matchesTopic(p, x))
      .map((x) => `<span class="tag">${esc(x.name)}</span>`).join("");
    const scholar = "https://scholar.google.com/scholar?q=" + encodeURIComponent(p.title);
    return `<li class="paper">
      <div class="meta">
        <span class="badge ${v.area}">${esc(v.short)} ${p.year}</span>
        ${isNew ? `<span class="badge new" title="${p.first_seen} 추가">NEW</span>` : ""}
        ${tags}
      </div>
      <h3><a href="${esc(p.url)}" target="_blank" rel="noopener">${highlight(p.title, hl)}</a></h3>
      <div class="authors">${highlight(p.authors.join(", "), hl)}</div>
      ${p.abstract ? `<div class="abstract" hidden>${highlight(p.abstract, hl)}</div>` : ""}
      <div class="links">
        ${p.abstract ? `<button class="lk" data-abs>초록</button>` : ""}
        <a href="${esc(p.url)}" target="_blank" rel="noopener">${p.doi ? "DOI" : "논문 페이지"}</a>
        ${p.pdf ? `<a href="${esc(p.pdf)}" target="_blank" rel="noopener">PDF</a>` : ""}
        <a href="${scholar}" target="_blank" rel="noopener">Scholar</a>
      </div>
    </li>`;
  }).join("");
  $("more").hidden = list.length <= state.shown;
  // 토픽/검색으로 좁혔을 때는 초록을 펼쳐서 매칭 위치를 바로 보여준다
  if (t || state.q) document.querySelectorAll(".abstract").forEach((a) => { a.hidden = false; });
}

let lastList = [];
function render() {
  const base = baseFiltered();
  renderTopicChips(base);
  renderTopicInfo();
  renderFilterChips();
  renderMatrix(applyTopic(baseFiltered({ ignoreVenueYear: true })));
  lastList = sortList(applyTopic(base));
  renderResults(lastList);
  const t = currentTopic();
  $("feedLink").href = `feeds/${t && !t.custom ? t.id : "all"}.xml`;
  writeHash();
}

// ------------------------------------------------------------------ events

function bind() {
  $("topicChips").addEventListener("click", (e) => {
    const rm = e.target.closest("[data-remove]");
    if (rm) {
      e.stopPropagation();
      topics = topics.filter((t) => t.id !== rm.dataset.remove);
      saveCustomTopics();
      if (state.topic === rm.dataset.remove) state.topic = "all";
      state.shown = PAGE; render();
      return;
    }
    const c = e.target.closest("[data-topic]");
    if (c) { state.topic = c.dataset.topic; state.shown = PAGE; render(); }
  });
  $("addTopicForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("addTopicInput").value.trim();
    const patterns = keywordToPatterns(input);
    if (!patterns.length) { alert("유효한 키워드/정규식이 아닙니다."); return; }
    const name = input.startsWith("/") ? input : input.split(",")[0].trim();
    const id = "custom-" + Date.now().toString(36);
    topics.push(compileTopic({ id, name, patterns, exclude: [], custom: true }));
    saveCustomTopics();
    $("addTopicInput").value = "";
    state.topic = id; state.shown = PAGE; render();
  });
  let timer;
  $("search").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.q = e.target.value.trim(); state.shown = PAGE; render(); }, 150);
  });
  $("venueChips").addEventListener("click", (e) => {
    const c = e.target.closest("[data-venue]"); if (!c) return;
    const v = c.dataset.venue;
    state.venues.has(v) ? state.venues.delete(v) : state.venues.add(v);
    state.shown = PAGE; render();
  });
  $("yearChips").addEventListener("click", (e) => {
    const c = e.target.closest("[data-year]"); if (!c) return;
    const y = Number(c.dataset.year);
    state.years.has(y) ? state.years.delete(y) : state.years.add(y);
    state.shown = PAGE; render();
  });
  $("matrix").addEventListener("click", (e) => {
    const c = e.target.closest("[data-cell]"); if (!c) return;
    const [v, y] = c.dataset.cell.split(":");
    const already = state.venues.size === 1 && state.venues.has(v) && state.years.size === 1 && state.years.has(+y);
    state.venues = already ? new Set() : new Set([v]);
    state.years = already ? new Set() : new Set([+y]);
    state.shown = PAGE; render();
  });
  $("since").addEventListener("change", (e) => { state.since = Number(e.target.value); state.shown = PAGE; render(); });
  $("titleOnly").addEventListener("change", (e) => { state.titleOnly = e.target.checked; state.shown = PAGE; render(); });
  $("sort").addEventListener("change", (e) => { state.sort = e.target.value; render(); });
  $("more").addEventListener("click", () => { state.shown += PAGE; renderResults(lastList); });
  $("results").addEventListener("click", (e) => {
    const b = e.target.closest("[data-abs]"); if (!b) return;
    const abs = b.closest(".paper").querySelector(".abstract");
    abs.hidden = !abs.hidden;
  });
  $("exportCsv").addEventListener("click", () => {
    const rows = [["venue", "year", "title", "authors", "url", "doi", "first_seen"]].concat(
      lastList.map((p) => [venueById[p.venue].short, p.year, p.title, p.authors.join("; "), p.url, p.doi, p.first_seen]));
    const csv = rows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
    a.download = `papers-${state.topic}.csv`;
    a.click();
  });
}

// ------------------------------------------------------------------ init

async function init() {
  const [m, ps] = await Promise.all([
    fetch("data/meta.json", { cache: "no-cache" }).then((r) => r.json()),
    fetch("data/papers.json", { cache: "no-cache" }).then((r) => r.json()),
  ]);
  meta = m;
  venueById = Object.fromEntries(meta.venues.map((v) => [v.id, v]));
  papers = ps.filter((p) => venueById[p.venue]);
  for (const p of papers) {
    p._text = [p.title, p.abstract || "", (p.keywords || []).join(" ")].join(" ");
    p._lower = (p._text + " " + p.authors.join(" ")).toLowerCase();
  }
  initialImport = papers.reduce((min, p) => (p.first_seen < min ? p.first_seen : min), "9999");
  topics = meta.topics.map(compileTopic).concat(loadCustomTopics().map((t) => compileTopic({ ...t, custom: true })));

  readHash();
  if (state.topic !== "all" && !currentTopic()) state.topic = "all";
  $("search").value = state.q;
  $("since").value = String(state.since);
  $("sort").value = state.sort;
  $("titleOnly").checked = state.titleOnly;

  const updated = new Date(meta.updated);
  $("subtitle").textContent =
    `${meta.venues.map((v) => v.short).join(" · ")} — ${papers.length.toLocaleString()}편 · ` +
    `마지막 갱신 ${updated.toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" })}`;

  bind();
  render();
}

init().catch((e) => {
  $("subtitle").textContent = "데이터를 불러오지 못했습니다: " + e.message;
  console.error(e);
});
