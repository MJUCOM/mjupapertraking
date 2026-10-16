#!/usr/bin/env python3
"""학회 논문 수집기.

config/venues.yml에 정의된 학회의 논문을 수집해 docs/data/papers.json에 병합하고,
config/topics.yml의 토픽별 Atom 피드를 docs/feeds/에 생성한다.

사용법:
    python tracker/update.py            # 최근 연도(올해, 작년, 내년)만 갱신 + 비어 있는 연도 채우기
    python tracker/update.py --full     # start_year부터 전부 다시 수집
    python tracker/update.py --venue ccs --year 2024
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import os
import re
import sys
import time
from pathlib import Path
from xml.sax.saxutils import escape

import requests
import yaml
from bs4 import BeautifulSoup, NavigableString

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config"
DOCS = ROOT / "docs"
DATA = DOCS / "data"
FEEDS = DOCS / "feeds"
PAPERS_JSON = DATA / "papers.json"
DISCOVERED_JSON = DATA / "discovered.json"

OPENALEX = "https://api.openalex.org/works"
USER_AGENT = "paper-tracker/1.0 (academic conference paper tracker)"
USENIX_DELAY = 10  # usenix.org robots.txt Crawl-delay

session = requests.Session()
session.headers["User-Agent"] = USER_AGENT


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def get(url, params=None, retries=3):
    for attempt in range(retries):
        try:
            r = session.get(url, params=params, timeout=60)
            if r.status_code == 404:
                return None
            if r.status_code in (429, 500, 502, 503, 504):
                raise requests.HTTPError(f"HTTP {r.status_code}")
            r.raise_for_status()
            return r
        except requests.RequestException as e:
            if attempt == retries - 1:
                raise
            wait = 5 * (attempt + 1)
            log(f"  retry in {wait}s: {e}")
            time.sleep(wait)


def norm_title(t: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", t.lower())


# --------------------------------------------------------------------------- OpenAlex

def openalex_params(extra: dict) -> dict:
    p = dict(extra)
    if os.environ.get("OPENALEX_API_KEY"):
        p["api_key"] = os.environ["OPENALEX_API_KEY"]
    if os.environ.get("OPENALEX_MAILTO"):
        p["mailto"] = os.environ["OPENALEX_MAILTO"]
    return p


def openalex_pages(filter_: str, select: str):
    page = 1
    while True:
        r = get(OPENALEX, openalex_params(
            {"filter": filter_, "select": select, "per-page": 200, "page": page}))
        d = r.json()
        yield from d["results"]
        if page * 200 >= d["meta"]["count"] or not d["results"]:
            return
        page += 1
        time.sleep(0.2)


def abstract_from_index(inv: dict | None) -> str:
    if not inv:
        return ""
    pos = {}
    for word, idxs in inv.items():
        for i in idxs:
            pos[i] = word
    return " ".join(pos[i] for i in sorted(pos))


def doi_volume(doi: str) -> str:
    """'10.1145/3744916.3773123' -> '10.1145/3744916', '10.1109/sp63933.2026.00012' -> '10.1109/sp63933.2026'"""
    reg, _, suffix = doi.partition("/")
    parts = suffix.split(".")
    vol = parts[0] if parts[0].isdigit() else ".".join(parts[:2])
    return f"{reg}/{vol}"


def discover_prefix(venue: dict, year: int) -> str | None:
    """프로시딩 DOI 접두어를 모르는 연도: OpenAlex source에서 가장 많이 쓰인 접두어를 찾는다."""
    srcs = venue.get("openalex_sources") or []
    if not srcs:
        return None
    counts = collections.Counter()
    for w in openalex_pages(
            f"primary_location.source.id:{'|'.join(srcs)},publication_year:{year}", "doi"):
        if w.get("doi"):
            counts[doi_volume(w["doi"].removeprefix("https://doi.org/").lower())] += 1
    if not counts:
        return None
    prefix, n = counts.most_common(1)[0]
    if n < 15:
        return None
    log(f"  discovered DOI prefix for {venue['id']} {year}: {prefix} ({n} works)")
    return prefix


def resolve_prefix(venue: dict, year: int, discovered: dict) -> str | None:
    if year in (venue.get("doi_prefixes") or {}):
        return str(venue["doi_prefixes"][year]).lower()
    if venue.get("doi_prefix_template"):
        return venue["doi_prefix_template"].format(year=year).lower()
    key = f"{venue['id']}:{year}"
    if key in discovered:
        return discovered[key]
    prefix = discover_prefix(venue, year)
    if prefix:
        discovered[key] = prefix
    return prefix


def fetch_openalex(venue: dict, year: int, discovered: dict) -> list[dict]:
    prefix = resolve_prefix(venue, year, discovered)
    if not prefix:
        return []
    # ACM 숫자형 볼륨은 뒤에 '.'을 붙여야 다른 볼륨(3658644 vs 36586440)과 섞이지 않는다
    match_prefix = prefix + "." if prefix.rsplit("/", 1)[1].isdigit() else prefix
    out = []
    select = "id,doi,title,authorships,abstract_inverted_index,publication_date,keywords,open_access"
    for w in openalex_pages(f"doi_starts_with:{match_prefix}", select):
        title = (w.get("title") or "").strip()
        if not title:
            continue
        doi = (w.get("doi") or "").removeprefix("https://doi.org/").lower()
        out.append({
            "title": title,
            "authors": [a["author"]["display_name"] for a in w.get("authorships") or []
                        if a.get("author", {}).get("display_name")],
            "abstract": abstract_from_index(w.get("abstract_inverted_index")),
            "doi": doi,
            "url": f"https://doi.org/{doi}" if doi else w["id"],
            "pdf": (w.get("open_access") or {}).get("oa_url") or "",
            "keywords": [k["display_name"] for k in w.get("keywords") or []],
            "published": w.get("publication_date") or "",
        })
    return out


# --------------------------------------------------------------------------- USENIX

def parse_usenix_authors(node) -> list[str]:
    if node is None:
        return []
    names = []
    for p in node.select("p") or [node]:
        for child in p.children:
            if isinstance(child, NavigableString):
                names.append(str(child))
    text = " ".join(names)
    authors = []
    for chunk in re.split(r",|\band\b|;", text):
        chunk = chunk.strip()
        if chunk and not re.search(r"\b(award|winner|prize)\b", chunk, re.I):
            authors.append(chunk)
    return authors


def fetch_usenix(venue: dict, year: int, _discovered: dict) -> list[dict]:
    slug = venue["slug_template"].format(yy=f"{year % 100:02d}", year=year)
    found: dict[str, dict] = {}
    for page in venue.get("pages", ["technical-sessions"]):
        url = f"https://www.usenix.org/conference/{slug}/{page}"
        r = get(url)
        time.sleep(USENIX_DELAY)
        if r is None:
            continue
        soup = BeautifulSoup(r.text, "html.parser")
        n_before = len(found)
        for art in soup.select("article.node-paper"):
            a = art.select_one("h2 a")
            people = art.select_one(".field-name-field-paper-people-text")
            if a is None or people is None:  # 키노트 등 저자 정보가 없는 항목 제외
                continue
            href = "https://www.usenix.org" + a["href"] if a["href"].startswith("/") else a["href"]
            if href in found:
                continue
            abstract = art.select_one(".field-name-field-paper-description-long")
            found[href] = {
                "title": a.get_text(" ", strip=True),
                "authors": parse_usenix_authors(people),
                "abstract": abstract.get_text(" ", strip=True) if abstract else "",
                "doi": "",
                "url": href,
                "pdf": "",
                "keywords": [],
                "published": "",
            }
        log(f"  {url}: +{len(found) - n_before}")
    return list(found.values())


FETCHERS = {"openalex": fetch_openalex, "usenix": fetch_usenix}


# --------------------------------------------------------------------------- 초록 보강

def enrich_abstracts(db: dict) -> int:
    """OpenAlex에 초록이 없는 논문을 Semantic Scholar에서 DOI로 보강한다 (실패해도 무시)."""
    missing = [p for p in db.values() if not p.get("abstract") and p.get("doi")]
    if not missing:
        return 0
    headers = {}
    if os.environ.get("S2_API_KEY"):
        headers["x-api-key"] = os.environ["S2_API_KEY"]
    filled = 0
    for i in range(0, len(missing), 400):
        chunk = missing[i:i + 400]
        try:
            r = session.post("https://api.semanticscholar.org/graph/v1/paper/batch",
                             params={"fields": "abstract"}, headers=headers, timeout=60,
                             json={"ids": [f"DOI:{p['doi']}" for p in chunk]})
            if not r.ok:
                log(f"  semantic scholar: HTTP {r.status_code}, skip")
                return filled
            for p, res in zip(chunk, r.json()):
                if res and res.get("abstract"):
                    p["abstract"] = res["abstract"].strip()
                    filled += 1
        except requests.RequestException as e:
            log(f"  semantic scholar: {e}, skip")
            return filled
        time.sleep(3)
    return filled


# --------------------------------------------------------------------------- 병합 / 출력

def load_json(path: Path, default):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return default


def paper_id(venue_id: str, year: int, p: dict) -> str:
    return f"{venue_id}{year}:{p['doi'] or norm_title(p['title'])[:80]}"


def merge(db: dict, venue: dict, year: int, papers: list[dict], today: str, exclude) -> tuple[int, int]:
    added = updated = 0
    seen_titles = {norm_title(v["title"]) for v in db.values()
                   if v["venue"] == venue["id"] and v["year"] == year}
    for p in papers:
        if any(rx.search(p["title"]) for rx in exclude):
            continue
        pid = paper_id(venue["id"], year, p)
        rec = {"id": pid, "venue": venue["id"], "year": year, **p}
        if pid in db:
            old = db[pid]
            rec["first_seen"] = old["first_seen"]
            # 이전에 있던 정보(초록 등)는 새 응답이 비어 있으면 유지
            for k in ("abstract", "pdf", "keywords", "authors"):
                if not rec.get(k) and old.get(k):
                    rec[k] = old[k]
            if rec != old:
                updated += 1
            db[pid] = rec
        elif norm_title(p["title"]) in seen_titles:
            continue
        else:
            rec["first_seen"] = today
            db[pid] = rec
            seen_titles.add(norm_title(p["title"]))
            added += 1
    return added, updated


def compile_topics(topics):
    out = []
    for t in topics:
        out.append((t,
                    [re.compile(p, re.I) for p in t.get("patterns", [])],
                    [re.compile(p, re.I) for p in t.get("exclude", [])]))
    return out


def topic_match(compiled, paper) -> bool:
    _, pats, excl = compiled
    text = " ".join([paper["title"], paper.get("abstract", ""), " ".join(paper.get("keywords", []))])
    return any(p.search(text) for p in pats) and not any(e.search(text) for e in excl)


def write_feeds(papers: list[dict], topics, venues: dict, site_url: str):
    FEEDS.mkdir(parents=True, exist_ok=True)
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    groups = [("all", "All papers", lambda p: True)]
    for c in compile_topics(topics):
        groups.append((c[0]["id"], c[0]["name"], lambda p, c=c: topic_match(c, p)))
    for fid, name, pred in groups:
        items = sorted((p for p in papers if pred(p)),
                       key=lambda p: (p["first_seen"], p["year"]), reverse=True)[:100]
        entries = []
        for p in items:
            v = venues[p["venue"]]
            entries.append(f"""  <entry>
    <title>{escape(p['title'])}</title>
    <link href="{escape(p['url'])}"/>
    <id>{escape(p['url'])}</id>
    <updated>{p['first_seen']}T00:00:00Z</updated>
    <category term="{escape(v['short'])} {p['year']}"/>
    <summary>{escape(v['short'])} {p['year']} — {escape(', '.join(p['authors'][:8]))}\n\n{escape(p.get('abstract', '')[:1500])}</summary>
  </entry>""")
        (FEEDS / f"{fid}.xml").write_text(f"""<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Paper Tracker — {escape(name)}</title>
  <id>{escape(site_url)}feeds/{fid}.xml</id>
  <link href="{escape(site_url)}"/>
  <updated>{now}</updated>
{chr(10).join(entries)}
</feed>
""", encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true", help="모든 연도 다시 수집")
    ap.add_argument("--venue", action="append", help="특정 학회만 (여러 번 지정 가능)")
    ap.add_argument("--year", type=int, action="append", help="특정 연도만")
    ap.add_argument("--no-fetch", action="store_true", help="수집 없이 설정/피드만 다시 생성")
    args = ap.parse_args()

    vconf = yaml.safe_load((CONFIG / "venues.yml").read_text(encoding="utf-8"))
    topics = yaml.safe_load((CONFIG / "topics.yml").read_text(encoding="utf-8"))["topics"]
    exclude = [re.compile(p, re.I) for p in vconf.get("exclude_title_patterns", [])]
    venues = {v["id"]: v for v in vconf["venues"]}

    DATA.mkdir(parents=True, exist_ok=True)
    db = {p["id"]: p for p in load_json(PAPERS_JSON, [])}
    discovered = load_json(DISCOVERED_JSON, {})
    today = dt.date.today().isoformat()
    this_year = dt.date.today().year
    years = list(range(vconf["start_year"], this_year + 2))

    counts = collections.Counter((p["venue"], p["year"]) for p in db.values())
    errors = []
    total_added = 0
    if not args.no_fetch:
        for vid, venue in venues.items():
            if args.venue and vid not in args.venue:
                continue
            for year in years:
                if args.year and year not in args.year:
                    continue
                recent = year >= this_year - 1
                if not (args.full or args.year or recent or counts[(vid, year)] == 0):
                    continue
                log(f"[{vid} {year}]")
                try:
                    papers = FETCHERS[venue["source"]](venue, year, discovered)
                except Exception as e:  # 한 학회 실패가 전체를 막지 않도록
                    log(f"  ERROR: {e}")
                    errors.append(f"{vid} {year}: {e}")
                    continue
                added, updated = merge(db, venue, year, papers, today, exclude)
                total_added += added
                log(f"  fetched {len(papers)}, added {added}, updated {updated}")
        log(f"[abstracts] filled {enrich_abstracts(db)} from Semantic Scholar")

    papers = sorted(db.values(), key=lambda p: (-p["year"], p["venue"], p["title"].lower()))
    PAPERS_JSON.write_text(json.dumps(papers, ensure_ascii=False, separators=(",", ":")),
                           encoding="utf-8")
    DISCOVERED_JSON.write_text(json.dumps(discovered, indent=2, sort_keys=True), encoding="utf-8")

    site_url = os.environ.get("SITE_URL", "./")
    meta = {
        "updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "venues": [{k: v[k] for k in ("id", "short", "name", "area")} for v in venues.values()],
        "topics": [{k: t.get(k, [] if k == "exclude" else "")
                    for k in ("id", "name", "description", "patterns", "exclude")} for t in topics],
        "counts": {f"{v}:{y}": n for (v, y), n in
                   sorted(collections.Counter((p["venue"], p["year"]) for p in papers).items())},
        "errors": errors,
    }
    (DATA / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    write_feeds(papers, topics, venues, site_url)

    log(f"done: {len(papers)} papers total, {total_added} new, {len(errors)} errors")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(f"### Paper tracker\n- total: {len(papers)}\n- new: {total_added}\n")
            for e in errors:
                f.write(f"- ⚠️ {e}\n")


if __name__ == "__main__":
    main()
