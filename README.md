# Paper Tracker

CCS · NDSS · USENIX Security · IEEE S&P · SOSP · OSDI · ICSE 논문을 2022년부터 수집하고,
매일 자동으로 새 논문을 추가하는 정적 웹사이트. 키워드(토픽)로 관련 논문을 찾고, 기본으로 **Rust** 토픽을 추적한다.

```
config/venues.yml     추적할 학회와 데이터 소스
config/topics.yml     추적 키워드(토픽) — 여기 추가하면 사이트 탭 + RSS 피드가 생김
tracker/update.py     수집기 (OpenAlex + usenix.org)
docs/                 GitHub Pages로 서비스되는 사이트
  data/papers.json    수집된 논문 DB (first_seen = 처음 발견된 날짜)
  data/meta.json      학회/토픽/통계
  data/discovered.json 자동 발견된 프로시딩 DOI 접두어
  feeds/<topic>.xml   토픽별 Atom 피드 (예: feeds/rust.xml)
scripts/cron_update.sh       매일 cron으로 수집 → 커밋 → push (서버에서 실행)
.github/workflows/update.yml  수동 실행용 (usenix.org가 Actions IP를 403으로 막아 정기 수집은 cron에서)
```

## 데이터 소스

| 학회 | 소스 | 비고 |
|---|---|---|
| CCS, NDSS, S&P, SOSP, ICSE | [OpenAlex](https://openalex.org) (프로시딩 DOI 접두어로 조회) | 초록 포함. 프로시딩이 출판되어 DOI가 등록된 뒤 반영 |
| USENIX Security, OSDI | usenix.org 프로그램 / accepted papers 페이지 | 초록 포함. 학회 전 accepted 목록이 뜨면 바로 반영 |

> DBLP는 현재 봇 차단(Anubis)이 걸려 있어 사용하지 않는다.

**새 연도 처리**: OpenAlex 학회는 `doi_prefixes`에 없는 연도를 만나면 해당 학회의 OpenAlex source에서
가장 많이 쓰인 DOI 접두어를 자동으로 찾아 `docs/data/discovered.json`에 기록한다.
잘못 잡혔으면 `config/venues.yml`의 `doi_prefixes`에 직접 적으면 그것이 우선한다
(ACM 프로시딩 DOI는 ACM DL의 프로시딩 페이지 URL `dl.acm.org/doi/proceedings/10.1145/XXXXXXX`에서 확인 가능).
USENIX 학회는 `usenixsecurity{yy}`, `osdi{yy}` 규칙으로 매년 자동으로 시도한다.

## 사용법

### 로컬 실행

```bash
pip install -r requirements.txt
python tracker/update.py            # 최근 연도 갱신 (+ 비어 있는 연도 채우기)
python tracker/update.py --full     # 전체 재수집 (USENIX crawl-delay 때문에 10분 정도)
python tracker/update.py --venue icse --year 2026
python tracker/update.py --no-fetch # 수집 없이 meta/피드만 다시 생성 (토픽만 바꿨을 때)

cd docs && python -m http.server 8000   # http://localhost:8000
```

### 사이트

**https://mjucom.github.io/mjupapertraking/** (GitHub Pages, `main` 브랜치 `/docs`)

서버의 cron이 매일 03:00(KST)에 `scripts/cron_update.sh`를 실행해 수집 → 커밋 → push 하면
GitHub Pages가 자동으로 다시 배포한다 (로그: `logs/`).
로컬에서 미리 보려면 `./serve.sh` (127.0.0.1:8000).

### 설정 메모

- cron 확인/해제: `crontab -l` / `crontab -e` — `cron_update.sh` 줄 (매일 수집).
- GitHub Actions는 USENIX 페이지가 403으로 막혀서 수동 실행 전용으로 남겨 두었다 (Workflow permissions: Read and write 설정 완료).
- (선택) OpenAlex 무료 API 키(https://openalex.org/settings/api)를 Secrets에 `OPENALEX_API_KEY`로 등록.
   키가 없어도 동작하지만 같은 IP 공유 무료 한도를 쓴다.

## 키워드 추가

- **사이트에서 바로**: "키워드 추가" 칸에 `WebAssembly, wasm` 처럼 입력(쉼표=OR) 또는 `/eBPF|BPF verifier/` 같은 정규식.
  브라우저(localStorage)에만 저장된다. "topics.yml용 복사" 버튼으로 YAML 조각을 복사할 수 있다.
- **영구 등록**: `config/topics.yml`에 추가한 뒤 `python3 tracker/update.py --no-fetch`를 실행하면 토픽 탭과 `feeds/<id>.xml` 피드가 바로 생긴다 (다음 cron 실행 때도 자동 반영).

```yaml
  - id: wasm
    name: WebAssembly
    patterns:
      - '\bwebassembly\b'
      - '\bwasm\b'
```

패턴은 제목 + 초록 + OpenAlex 키워드에 대해 대소문자 무시로 매칭한다 (Python/JS 공통 정규식 문법).

## 학회 추가

`config/venues.yml`에 항목을 추가한다. OpenAlex에 있는 학회라면 source ID는
`https://api.openalex.org/sources?search=<학회 이름>` 으로 찾을 수 있다.
