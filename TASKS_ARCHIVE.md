# B24 TAGGER — TASKS ARCHIVE

## UKOŃCZONE

- [x] **2026-04-03** Overall stats: kafelek "pozostało", pasek postępu, streaming — v0.21.1–0.21.3
- [x] **2026-04-03** Overall stats: tryb domykania miesiąca (auto-complete, baner, Zamknij miesiąc) — v0.21.4
- [x] **2026-04-03** Bugfix: news PL, wybór tagów z listy, znikające okna przy resize — v0.21.5
- [x] **2026-04-03** buildUrlMap: parallel batch fetch + stress test (MAP_FETCH_CONCURRENCY=3, 3.3×) — v0.21.6–0.21.7
- [x] **2026-04-03** Równoległe fetche w całym kodzie (fetchAllIds, _fetchOverallStats, delete engine, stats)
- [x] **2026-04-03** Responsywny UI: klasa b24t-compact, wykrywanie małego ekranu, overflow guard — v0.21.11–0.21.13
  - main panel: compact mode CSS, screen profile, minW 300
  - annotator panel: screen profile, minW 300, viewport-aware maxW, overflow-x hidden
  - news panels: PANEL_W viewport-aware (30% viewportu)
  - topbar: logo shrinkuje (flex-shrink:1), przyciski zawsze widoczne (flex-shrink:0)
- [x] **2026-04-03** Naprawienie funkcji czyszczenia plikiem
- [x] **2026-04-03** Stress test batchowania + optymalizacja MAX_BATCH_SIZE
- [x] **2026-04-04** Dynamic panel zoom — BASE_PANEL_W, #b24t-panel-inner, _applyPanelZoom — v0.21.18–0.21.21
- [x] **2026-04-08** Quick Delete batch fix — _deleteBatch zamiast hardcoded 5, DEL_BATCH_DEFAULT 10→25 — v0.21.26
- [x] **2026-04-08** Skill /log-session — komenda do zamykania sesji i aktualizacji workflow files
- [x] **2026-04-08** Reorganizacja plików workflow — PROTOCOLS.md, TASKS_ARCHIVE.md, .claudeignore, nowa sekcja DEPLOY w CLAUDE.md
