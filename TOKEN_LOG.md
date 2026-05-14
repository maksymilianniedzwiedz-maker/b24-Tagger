# B24 TAGGER — TOKEN LOG

> CC loguje tutaj zużycie kontekstu po każdym tasku oraz ręczne wpisy użytkownika
> o tygodniowym zużyciu limitu. Celem jest zbudowanie orientacyjnego obrazu
> ile % tygodniowego limitu kosztuje dany typ pracy.

## FORMAT WPISU
- [DATA] [SESJA vX.Y] [TASK: nazwa] → /context: X% | tygodniowy limit: X% (jeśli podany)
- [DATA] STRESS TEST: opis → wyniki

## LOG
> Wpisy pojawiają się tutaj automatycznie podczas pracy CC

### [2026-05-14] SESJA 86 — B24Bridge cross-domain data bus v0.24.25–v0.24.26
- TASK: deploy v0.24.25 (carry-over z Sesji 85: dup-check cross-domain auth + hostname gate `_isBrand24Host`)
- TASK: przegląd CLAUDE.md + audyt zasad + mapowanie stanu pliku (17 159 linii vs stara mapa 15 325)
- TASK: budowa B24Bridge — moduł cross-domain (b24t_bridge, GM_addValueChangeListener, TTL 8h, token/projects/lastProject, onChange/offChange)
- TASK: jednorazowa migracja starych GM kluczy → b24t_bridge (blok przy `_v === 0`)
- TASK: migracja wszystkich callerów (9+ funkcji): _gmGetProjects, _gmSaveProjects, _gmGetProjectNames, _gmSaveProjectNames, _pnSet, token capture, _newsCheckTagDodane, reset button, b24t_mini_last_project, ANNOTATOR TOOLS, _customDupCheck
- TASK: sequence guard `_dupCheckSeq` + pid NaN guard w `_customDupCheck`
- TASK: reaktywny `B24Bridge.onChange('custom-dupcheck')` w INIT — auto-ponawia dupcheck gdy brand24.com zapisze token w innej karcie
- TASK: aktualizacja CLAUDE.md (nowa HARD RULE B24Bridge + mapa sekcji do 17 159 linii, Sesja 86)
- TASK: deploy v0.24.26 na experimental
- TASK: log-session

### [2026-05-13] SESJA 85 — cross-domain nazwy projektów — root fix serii v0.24.11–v0.24.19
- TASK: dropdown kraju jako `<select>` z 49 kodami krajów (v0.24.11)
- TASK: auto-fill treści — łączy akapity do 200 znaków, przycina na granicy zdania (v0.24.11)
- TASK: GM mirror dla PROJECT_NAMES, lazy sync z LS.PROJECTS + LS.PROJECT_NAMES (v0.24.11–v0.24.16)
- TASK: przycisk "Synchronizuj nazwy projektów" w ⚙ Niestandardowe (v0.24.15)
- TASK: przycisk "Reset i przebuduj projekty" — nuclear clear GM mirrorów + rebuild z LS (v0.24.17)
- TASK: guard — nie czyść mirrorów gdy LS pusty / non-brand24 (v0.24.18)
- TASK: root fix — `_gmSaveProjects` filtruje fallbacki przed zapisem (v0.24.19)
- TASK: log-session

### [2026-05-13] SESJA 84 — ustawienia Projekty + fixy Niestandardowe v0.24.10
- TASK: sekcja "Projekty" w ⚙ — `_getMissingIds()`, przycisk "Uzupełnij nazwy", GQL probe `getProjects` batch + fallback `getProject(id)`, `_runPerProject()`, `_applyName()`, updates `LS.PROJECT_NAMES` + `LS.PROJECTS`
- TASK: `_miniScrapeCurrentPage` — treść tylko pierwszy `<p>` (poprzednio cały kontener do 3000 znaków); limit 600 znaków
- TASK: `_detectCategoryFromUrl` — fallback 8→7 (News) dla nierozpoznanych domen
- TASK: deploy v0.24.10 na experimental
- TASK: log-session

### [2026-05-13] SESJA 83 — panel Niestandardowe: scraping, dark mode, layout, ustawienia v0.24.9
- TASK: diagnoza root cause broken scraping — `_miniScrapeCurrentPage()` wywoływana tylko z martwego kodu `_openMiniMentionForm`; mini button używa `openNewsPanels('custom')`
- TASK: `_customAutoFillFromPage()` — nowa funkcja, wrappuje `_miniScrapeCurrentPage()`, wypełnia pola `b24t-news-f-*` przez requestAnimationFrame po renderze panelu
- TASK: `_scrapeSocialMetrics()` — DOM selektory Twitter/X/Facebook/LinkedIn/YouTube/Reddit; IG graceful fail (auth wall)
- TASK: fix `_parseNum` — bug decimal point destroy ("1.2K" → 12000 zamiast 1200)
- TASK: dark mode cross-domain — `GM_setValue('b24t_theme_mirror')` w `applyTheme()`; mini button czyta GM przy `injectStyles()`
- TASK: mini button top:33vh, 54×54px
- TASK: project row zawsze widoczny w custom mode; `GM_setValue('b24t_mini_last_project')` cross-domain
- TASK: language check przy zmianie projektu w `_wireNewsPanels`
- TASK: `_openCustomPanelSettings()` — popover ⚙ z AI toggle (slider) + prompt selector; chip AI ukryty w custom mode
- TASK: dioda ●Panel — `GM_xmlhttpRequest` do `/panel/` + status span w headerze
- TASK: tagi auto-expanded + padding 60→20px + usunięcie "Importuj URLe" w custom mode
- TASK: deploy v0.24.9 + log-session

### [2026-05-13] SESJA 82 — fixy floating panel Niestandardowe: zakładki + AI toggle + GM storage v0.24.7–v0.24.8
- TASK: diagnoza zakładek widocznych w custom mode — `_newsApplyResponsive()` nadpisywała `_toggleFormOnly(true)`; fix: early return gdy mode=custom — deploy v0.24.7
- TASK: AI toggle button w headerze — `<span>` → `<button>`, `_syncAiChip()`, klik zapisuje `s.custom.enabled`
- TASK: selektor projektu dla external pages — `#b24t-news-f-project-row` w colForm, `_newsRefillProjectSelect()`, `_applyNewsMode()` show/hide
- TASK: diagnoza root cause mini button na zewnętrznych stronach — localStorage izolowany per domena; Brand24 data niedostępna na google.com itp.
- TASK: fix GM storage — `GM_getValue`/`GM_setValue` grants, `_gmGetProjects()` LS-first+GM-fallback, `_gmSaveProjects()` mirror, mini button → `openNewsPanels('custom')` — deploy v0.24.8
- TASK: log-session

### [2026-05-13] SESJA 81 — plan + implementacja floating panel Niestandardowe v0.24.6
- TASK: /clear + odczyt memory planu panelu Niestandardowe
- TASK: doprecyzowanie planu — dup-check, social scraping, redesign UI, ustawienia, checklisty, ostrzeżenie językowe, feedback po submicie; zapis do memory
- TASK: implementacja v0.24.6 — `_miniScrapeCurrentPage()` (treść/data/język), auto-detect kategorii, `_miniDupCheck()` (GQL url+openUrl), `_miniLangCheck()` (inference z sufiksu nazwy projektu)
- TASK: fix `sourceUrl` → `url`+`openUrl` w GQL query (błędna nazwa pola wykryta w review)
- TASK: deploy v0.24.6 na experimental
- TASK: log-session

### [2026-05-13] SESJA 80 — fixy floating panel Niestandardowe + custom mode v0.24.2–v0.24.5
- TASK: deploy v0.24.2 z poprzedniej sesji (był lokalny, nie pushowany) — push na experimental
- TASK: diagnoza buga "panel znika po kliknięciu" — overlay pointer-events:none → kliknięcia przez przerwę trafiają w side tab Wzmianki → closeNewsPanels(); fix pointer-events na side tab w custom mode
- TASK: fix gap Wzmianki↔Net — `calc(50%+250px)` → `calc(50%+200px)` — deploy v0.24.3
- TASK: diagnoza buga "panel znika przy przeciąganiu" — drag ustawiał left/top jako viewport coords na position:relative (flex child) → offset zamiast absolute; fix: konwersja na position:fixed przy mousedown — deploy v0.24.4
- TASK: ukrycie Stats/Legenda/Języki w custom mode; cache offsetWidth/offsetHeight przy mousedown (eliminacja reflow w mousemove) — deploy v0.24.5
- TASK: omówienie planu floating panel Niestandardowe (auto-scraping, project selector, multi-tag); zapisano do memory + TASKS.md
- TASK: log-session

### [2026-05-13] SESJA 79 — fix: floating panel Niestandardowe widoczny (z-index) v0.24.2
- TASK: diagnoza buga — floating panel Niestandardowe niewidoczny + launcher nieodwoływalny po kliknięciu Niestandardowe
- TASK: root cause: overlay z-index 2147483632 < panel Taggera 2147483647 → panel przykrywa overlay; secondary bug: padding-right 12px → nakładanie na side tab; secondary bug: background = '' → transparent tło w news mode
- TASK: fix `_applyNewsMode()` — z-index 2147483647 w custom mode, padding-right 52px, explicit rgba w news mode
- TASK: deploy v0.24.2 (commit lokalny)
- TASK: log-session

### [2026-05-11] SESJA 78 — UX: floating panel Niestandardowe, ESC, fixy UI v0.24.1
- TASK: analiza stanu po sesji 77 + przegląd zmian z v0.24.0 (tryb Niestandardowe, launcher, mini-button)
- TASK: fix nakładania przycisków bocznych Net/Wzmianki — CSS calc(50%+250px)
- TASK: floating panel dla trybu Niestandardowe — overlay transparent+pointer-events:none, drag za header, auto formOnly
- TASK: ESC key — zamknięcie import modalu lub overlay (guard na INPUT/TEXTAREA/SELECT)
- TASK: ukrycie Słów kluczowych + Opisu marki w imporcie dla mode='custom' — obu handlerach
- TASK: przeniesienie selektora promptu AI z ⚙ do paneli — osobny News + Niestandardowe; _newsRefillPromptSelect
- TASK: usunięcie "auto (z domeny)" z kategorii — formularz + mini-button
- TASK: code review (znaleziono C1 bottomImportBtn + I4 ESC w polach tekstowych — naprawione)
- TASK: deploy v0.24.1 na experimental
- TASK: log-session

### [2026-05-11] SESJA 77 — fixy News: project-check + timeout/wrongcountry/ETA v0.23.104–v0.23.105
- TASK: diagnoza bug "URL już w projekcie ale nie wykryty" — _processPage dodawał tylko m.url lub m.openUrl, nie oba; fix: _addProjectUrl helper, oba URL-e do zestawu — deploy v0.23.104
- TASK: fix wrongcountry > blocked/timeout — usunięcie guard !== 'blocked'; pre-scan skip dla obcych krajów; usunięcie retry (10s×1); domain-skip po 2 timeoutach; timer ETA — deploy v0.23.105
- TASK: log-session

### [2026-05-09] SESJA 76 — przycisk Testuj klucz API v0.23.100
- TASK: analiza legendy badge'ów News (spójność z badge'ami — legenda była już aktualna od v0.23.98)
- TASK: diagnoza bug badge ⏳ AI... wisi na stałe — analiza kodu, dodano task do TASKS.md
- TASK: feat przycisk "Testuj klucz API" w ⚙ → Ustawienia AI — deploy v0.23.100
- TASK: log-session

### [2026-05-08] SESJA 75 — rewizja ikon badge'ów News v0.23.99
- TASK: rewizja ikon i badge'ów w panelu News — 📅 data, 🌐 język, ❓ typ niepewny, fix duplikatu ✓ Dodano, legenda +wpis ❓
- TASK: deploy v0.23.99 + log-session

### [2026-05-08] SESJA 74 — badge AI 4 kategorie, redesign legendy, fix scoring skanera v0.23.98
- TASK: badge AI — parsowanie `verdict`, 4 wizualnie różne kategorie (✅/⚠️/❌/🚫), backwards compat z `relevant:bool`
- TASK: omówienie kryteriów relevantności newsów (H&M jako przykład), przepisanie promptu `news_ai_scoring.txt` — hierarchia 4 kroków, nowy format `{verdict, reason}`, INPUT zsynchronizowany z payloadem wtyczki (keytopic, nazwy pól)
- TASK: fix scoring skanera — title+h1 jako jeden sygnał (+8), tagi +4→+6, cap akapitów +3→+4
- TASK: redesign legendy oznaczeń — 2-kolumnowy układ z sekcjami + karta JAK DZIAŁA SCORING
- TASK: deploy v0.23.98 + log-session

### [2026-05-08] SESJA 73 — animacje paneli statystyk + layout formularza News v0.23.96–v0.23.97
- TASK: implementacja animacji danych — _animateCountUp helper, Overall Stats (progress bar + count-up + stagger), Dashboard Annotatora (progress bar + count-up tiles), Tag Stats (stagger rows) — v0.23.96
- TASK: News panel — kolumna URL węższa, formularz szerszy, DATA/GODZINA/KAT./KRAJ rozłożone w osobnych wierszach, pole treści większe — v0.23.97
- TASK: log-session

### [2026-05-08] SESJA 72 — performance audit realizacja + wskaźnik opóźnienia v0.23.94–v0.23.95
- TASK: przegląd TASKS.md + dopisanie taska "wskaźnik opóźnienia ⚠ w meta-bar"
- TASK: implementacja 8 optymalizacji wydajności z audytu Sesji 71 — STATS_FETCH_CONCURRENCY 10→4, sleep(50) między batch delete, _bgFetchTagstats count-only GQL + parallel, News re-check concurrent (10 naraz), fetchProjectTagCounts bez tags{title}, _bgFetchAllProjects cache check, _fetchProjectStats cache strony 1, News URL prefix index O(N+M)
- TASK: deploy v0.23.94 + verify raw GitHub
- TASK: implementacja wskaźnika opóźnienia ⚠ (_nmUpdateLatencyBadge, badge w meta-bar, event wiring, Clear handler)
- TASK: deploy v0.23.95 + verify raw GitHub
- TASK: log-session

### [2026-05-08] SESJA 71 — perf Annotators Tab + audyt wydajności v0.23.93
- TASK: diagnoza wolnego ładowania zakładki Projekt — `loadAnnotatorProject` pobierało wszystkie strony wzmianek z `results{id tags{id}}` żeby liczyć tagged/untagged/reqVer/toDelete (~30 requestów dla 2000 wzmianek)
- TASK: implementacja `_fetchProjectStats()` — 3 równoległe count-only queries (total + REQ_VER + TO_DELETE) + binary search dla untagged (wzorzec z `fetchDashboardStats`); ~30 → max ~8 requestów
- TASK: implementacja `_bgFetchProject()` + `bgCache.project` z `projectId` guard; integracja w `startBgPrefetch` (pierwsze ładowanie + setInterval)
- TASK: refactor `loadAnnotatorProject()` na cache-first (gorący → render od razu + bg-refresh; zimny → fallback do `_fetchProjectStats`)
- TASK: deploy v0.23.93 + verify raw GitHub
- TASK: audyt wydajności pliku przez agenta Explore — 8 znalezisk (3 wysoki impact, 3 średni, 2 niski) zapisane w TASKS.md jako sekcja "DO ZROBIENIA — NASTĘPNA SESJA (Sesja 72)"
- TASK: dopisanie taska "Animacje pojawiania się danych w panelach statystyk" (count-up, fade+slide, skeleton loaders, RAF-lerp) do roadmapy
- TASK: log-session

### [2026-05-08] SESJA 70 — fixy tagowania plikiem zbiorczym v0.23.91–v0.23.92
- TASK: diagnoza problemów z tagowaniem z pliku zbiorczego — fallback bulkTag sekwencyjny (5 retries/ID → 22 min na 50 IDs), Stop nie zatrzymuje runTagging, per-project zakres dat zbyt szeroki, chip Untagged fałszywy warning gdy aktywny
- TASK: fix fallback bulkTag — FALLBACK_CONCURRENCY=8 concurrent, retries=2, log kontekstu błędu — v0.23.91
- TASK: fix Stop checks (multiproject loop, runTagging, batch loop), per-project date range, chip Untagged, warning untaggedId — v0.23.92
- TASK: aktualizacja MAPY SEKCJI w CLAUDE.md (Sesja 70, v0.23.92, 15 325 linii)
- TASK: log-session

### [2026-05-08] SESJA 70 — fix wykrywanie kolumny dat v0.23.90
- TASK: diagnoza buga "kolumna daty wykryta (source_file), ale wartości puste" przy wczytywaniu zbiorczego CSV z wynikami oceniania — `autoDetectColumns` regex bez kotwicy `^` łapał daty wewnątrz nazw plików w kolumnie source_file; source_file pierwsza w nagłówku → find() zatrzymywał się przed created_date
- TASK: fix jednolinijkowy — regex `/\d{4}-\d{2}-\d{2}/` → `/^\d{4}-\d{2}-\d{2}/` (linia 972); rozwiązanie konfliktu uv.lock (upstream greenlet 3.4.0)
- TASK: deploy v0.23.90 + log-session

### [2026-05-04] SESJA 69 — fix News Analytics LS zapis v0.23.89
- TASK: diagnoza buga "wyniki analytics dalej zera" — closeNewsPanels nie zapisywał do LS.NA_SESSION_STATS; po zamknięciu panelu _naNewSession widziało sessionId=null → sesja przepadała; v0.23.82 naprawiło scanStatus ale nie naprawiło LS persistence
- TASK: fix closeNewsPanels — zapis do LS przed _naFinalizeSession
- TASK: deploy v0.23.89 + log-session

### [2026-05-04] SESJA 68 — Network Monitor v0.23.88
- TASK: omówienie wymagań Network Monitor — ALL traffic (fetch + XHR), floating panel jak Annotators Tools, ring buffer, eksport JSON, toggle ⚙
- TASK: implementacja — nmState, interceptory fetch+XHR w unsafeWindow, CSS side tab 📡, OPTIONAL_FEATURES + applyFeatures, sekcja NETWORK MONITOR (buildNetworkMonitorPanel, openNetworkMonitorPanel), init
- TASK: deploy v0.23.88 na experimental
- TASK: analiza multi-project tagowania (bez zmian — już działa przez LS.PROJECTS + runMultiProjectTagging)
- TASK: log-session

### [2026-05-04] SESJA 67 — fix News project-check (3 miesiące + openUrl) v0.23.87
- TASK: diagnoza buga "ponad połowa URLi nie pokazuje się jako już w projekcie" — `_newsRunProjectCheck` sprawdzał tylko bieżący miesiąc + brak fallbacku na `m.openUrl`
- TASK: fix + deploy v0.23.87 na experimental
- TASK: log-session

### [2026-05-03] SESJA 66 — fix overwrite/multitag + raport podmian v0.23.86
- TASK: diagnoza buga "pominięto sporo wzmianek" w trybie overwrite — mapa untagged-only nie zawierała wzmianek z istniejącym tagiem
- TASK: fix mapMode override w runTagging — _forceFullMap gdy overwrite/multitag; log informacyjny gdy tryb wymusza pełną mapę
- TASK: dodanie matchDiag.overwrite + "Podmieniono tag: X" do raportu diagnostycznego i końcowego
- TASK: deploy v0.23.86 + log-session

### [2026-05-03] SESJA 65 część 2 — proporcje kolumn News + fix cross-delete/auto-delete v0.23.85
- TASK: UX proporcje kolumn panelu News — lista 28%, formularz 18%, podgląd ~54%
- TASK: diagnoza buga cross-delete 0 wzmianek — `_bgFetchAllProjects` używał `getAnnotatorDates()` = 1–3 maja; Overall Stats vs cross-delete różne funkcje dat
- TASK: fix `_getCleanupDateRange()` — prev month start → today; podmieniony w `_bgFetchAllProjects`
- TASK: fix auto-delete retry — jeśli 0 wzmianek, czeka 5s i retry z cleanup range
- TASK: deploy v0.23.85 + log-session

### [2026-05-03] SESJA 65 — 4 taski w jednej sesji v0.23.82–v0.23.84
- TASK: dopisanie 4 nowych tasków do TASKS.md (UX kolumny, project-check, News Analytics zera, zamknięcie miesiąca)
- TASK: diagnoza News Analytics zera — entry.status nadpisywane przez 'opened'/'added', _naAggSession liczył wszystko jako manual_add
- TASK: fix v0.23.82 — entry.scanStatus zapisywany w skanerze (linia 10070, 10094) i URL-only mode (9994); _naAggSession używa scanStatus || status; usunięto early-return dla braku naOutcome
- TASK: fix project-check v0.23.83 — normalizeUrl + Set + fallback bez query/hash + urlsMatch dla obciętego ID
- TASK: UX kolumny News v0.23.83 — colForm flex 23.6% (min 290 max 400); pole Treść rows 3→7 min-height 140px; fix regresji _newsApplyResponsive
- TASK: feature zamknięcia miesiąca v0.23.84 — _overallGetEffectiveDates (manual override > auto-prev jeśli niedomknięty > current); LS key OVERALL_ACTIVE_MONTH; UI ← / → / ↺ Auto; limit 12 miesięcy wstecz; "Zamknij miesiąc" czyści override
- TASK: code review subagent — naprawione C1 (guard pustego dataMonth) + C2 (auto-prev bazuje na getAnnotatorDates default — uwzględnia day≤2) + I3 (limit 12 mies wstecz)
- TASK: 3 deploye na experimental (v0.23.82, v0.23.83, v0.23.84)
- TASK: log-session

### [2026-05-03] SESJA 64 — UX: kolumna URL golden ratio + okno zamiast karty v0.23.81
- TASK: kolumna URL — zmiana z 270px na flex:0 0 38.2% (złota proporcja)
- TASK: _newsOpenUrl przebudowana — getBoundingClientRect(colPreview), window.screenX/Y; przycisk ↗ i "Otwórz w oknie" używają _newsOpenUrl
- TASK: deploy v0.23.81 (commit lokalny)
- TASK: log-session

### [2026-05-03] SESJA 63 — Fix News scan concurrency + etykiety błędów v0.23.80
- TASK: diagnoza buga "3 pierwsze URLe OK, reszta zablokowana" — analiza _newsContentScan, _scanWorker, concurrency
- TASK: fix — concurrency 8→5; blockReason (timeout/http/error/exception) + httpStatus; UI w 4 miejscach
- TASK: deploy v0.23.80 na experimental
- TASK: log-session

### [2026-04-30] SESJA 62 — Testowy push + Refactor News Analytics v0.23.77–v0.23.79
- TASK: przycisk "Testowy push" w ⚙ Analityka — end-to-end pipeline GitHub → v0.23.77
- TASK: realistyczne dane w testowym pushu (przykładowa sesja z CM) → v0.23.78
- TASK: refactor News Analytics — per-sesja CM, fix wykrywania AI, rename zakładki → v0.23.79
- TASK: log-session
- Tygodniowy limit: 9%

### [2026-04-28] SESJA 61 — Fix statusline + 3 bugi News Analytics v0.23.76
- TASK: fix statusline timer — session_id z JSON Claude Code, plik ~/.claude/session_timer.txt, fallback PPID
- TASK: fix Bug 1 — karta "Pozytywne URL" w statystykach (_naStatCard tip param, positiveCount w _naCompute)
- TASK: fix Bug 2 — _naRetryPending sekwencyjny (retryNext recursive, eliminacja race condition SHA 409)
- TASK: fix Bug 3 — _naExportCsv(filters) z filtrowaniem identycznym jak JSON export + wiring przycisku CSV
- TASK: deploy v0.23.76 na experimental
- TASK: log-session

### [2026-04-28] SESJA 60 — Audit News Analytics + fixy v0.23.75
- TASK: analiza systemu News Analytics — logika "relevant", cykl życia sesji, localStorage, push GitHub
- TASK: audit pełny — 5 problemów wykrytych (2 krytyczne/wysokie do naprawy, 3 do TASKS.md)
- TASK: fix KRYTYCZNY — NA_RECORDS_ARCHIVE (statystyki nie znikają po pushu, bufor 500 rek.)
- TASK: fix WYSOKI — visibilitychange nie kończy sesji (usunięto _naFinalizeSession)
- TASK: UX — filtr per projekt + przycisk Odśwież w zakładce Statystyki
- TASK: deploy v0.23.75 (commit lokalny)
- TASK: log-session

### [2026-04-27] SESJA 59 — Fix adaptacyjny timeout skanowania News v0.23.74
- TASK: diagnoza buga (blocked na wszystkich URLach na wolnym sprzęcie w biurze)
- TASK: implementacja `_getAdaptiveScanTimeout`, `_recordScanTiming`, refactor `_newsContentScan` z retry
- TASK: deploy v0.23.74 na experimental
- TASK: log-session

### [2026-04-26] SESJA 58 — NEWS ANALYTICS Sesja 5 + Testuj połączenie v0.23.72–v0.23.73
- TASK: implementacja eksportu CSV i JSON w zakładce Statystyki (_naExportCsv, _naExportJson, przyciski w statsOverlay)
- TASK: deploy v0.23.72 na experimental
- TASK: przycisk "Testuj połączenie" w ⚙ Analityka — GM_xmlhttpRequest, wyniki inline (401/404/brak uprawnień)
- TASK: deploy v0.23.73 na experimental
- TASK: log-session

### [2026-04-26] SESJA 57 — NEWS ANALYTICS Sesja 4 v0.23.71
- TASK: implementacja zakładki 📊 Statystyki w panelu News — _naStatCard, _naRenderStats, statsOverlay
- TASK: wiring przycisk 📊, zakładka Statystyki (mobile), filtry okres+kraj, live re-render
- TASK: code review + fix: border-radius na table, wzajemne zamykanie overlayów, kolorowa legenda score
- TASK: deploy v0.23.71 na experimental
- TASK: log-session

### [2026-04-26] SESJA 56 — NEWS ANALYTICS Sesja 2 v0.23.69
- TASK: implementacja GitHub Sync — _naPushSession, _naRetryPending, _naTryPeriodicPush, _naBuildSessionData, _naAddPending
- TASK: wypełnienie stubów visibilitychange i setInterval z Sesji 1
- TASK: sekcja Analityka w ⚙ Ustawienia (toggle + PAT + repo + status)
- TASK: deploy v0.23.69 na experimental
- TASK: log-session

### [2026-04-26] SESJA 55 — NEWS ANALYTICS Sesja 1 v0.23.68
- TASK: omówienie planu NEWS ANALYTICS — aktualizacja sekcji "Timing push" (3-poziomowe zabezpieczenie przed utratą danych)
- TASK: implementacja Sesji 1 — sekcja NEWS ANALYTICS, helpery storage, popup zgody, hooki submit, visibilitychange + interval
- TASK: deploy v0.23.68 na experimental
- TASK: log-session

### [2026-04-25] SESJA 54 — Płynna animacja pasków progresu RAF-lerp v0.23.67
- TASK: planowanie (plan mode) — analiza obecnych implementacji progress barów, projekt RAF-lerp
- TASK: implementacja — _makeBarSmoother + lazy gettery, 5 pasków, usunięcie CSS transition
- TASK: deploy v0.23.67 na experimental
- TASK: log-session

### [2026-04-24] SESJA 53 — Bugfixy regresji + stabilizacja workera v0.23.65–v0.23.66
- TASK: diagnoza "wszystkie artykuły blocked" po v0.23.64 → timeout 5s za krótki; fix + deploy v0.23.65
- TASK: diagnoza "freeze skanowania wrócił" → _newsAiAnalyze + renderUrlList poza try/catch; fix + deploy v0.23.66
- TASK: regeneracja tokenów PAT (publiczny + prywatny), aktualizacja CLAUDE.md
- TASK: analiza buga badge ▢ + "odmówiono połączenia" → zapisano 2 opcje naprawy do TASKS.md
- TASK: log-session

### [2026-04-24] SESJA 52 — Fix News scan freeze + iframe loop + perf v0.23.64
- TASK: diagnoza bug 1 — skanowanie zatrzymuje się w połowie (brak try/catch w _scanWorker)
- TASK: diagnoza bug 2 — kliknięcie rich card zawiesza UI (infinite iframe onload loop)
- TASK: fix obu bugów + perf (concurrency 5→8, timeout 8→5s)
- TASK: deploy v0.23.64 na experimental
- TASK: log-session

### [2026-04-24] SESJA 51 — Fix cross-delete v0.23.63
- TASK: diagnoza przyczyny niedziałającego przycisku "Usuń z wszystkich projektów" — błąd _tagCount + state.status idle
- TASK: fix + deploy v0.23.63 na experimental
- TASK: log-session

### [2026-04-24] SESJA 50 — Diagnoza błędu batcha + mitygacja v0.23.62
- TASK: weryfikacja kompatybilności Audit Mode i Test Run z multi-projektem
- TASK: MCP Chrome monitoring sieci podczas runów (Zalando_TR, InditexGroup_TR) — brak błędów, interceptor nieskuteczny (origFetch)
- TASK: zmiana MAX_BATCH_SIZE 500→50, TAG_CONCURRENCY 2→4
- TASK: deploy v0.23.62 na experimental
- TASK: log-session

### [2026-04-24] SESJA 49 — Multi-projektowe tagowanie z pliku v0.23.61
- TASK: planowanie (plan mode) — zbadanie flow tagowania, FILE PARSING, PROJECT DETECTION, localStorage
- TASK: implementacja — detekcja kolumny project_id, widget wykrytych projektów, runMultiProjectTagging, blokada Start, notka w mapowaniu
- TASK: fix — regex project_id (c vs k), clearFile nie czyściło dataset.blocked
- TASK: deploy v0.23.61 na experimental
- TASK: log-session

### [2026-04-18] SESJA 48 — Redesign UI Sesja B+C (Fazy 4–12) v0.23.54–v0.23.60
- TASK: Sesja B — Fazy 4-8: stats row-list, section hierarchy, action bar, log panel vars, annotator cleanup
- TASK: /compact między Sesją B a C (oszczędność tokenów zamiast /log-session)
- TASK: Sesja C — Fazy 9-12: News CSS vars, onboarding bubble, ikona ↗, section-reveal anim
- TASK: deploy v0.23.60 na experimental
- TASK: log-session

### [2026-04-18] SESJA 47 — Redesign UI: banned patterns, Geist font, teal dark mode v0.23.53
- TASK: zapoznanie z ostatnimi zmianami (v0.23.52) i planem REDESIGN_PLAN.md
- TASK: implementacja redesignu — Geist font, teal dark mode (oklch), usunięcie section stripe (BAN 1), border-left z logów (BAN 2), primary button solid, stat-card stripe
- TASK: deploy v0.23.53 na experimental
- TASK: log-session

### [2026-04-18] SESJA 46 — UI Polish (Emil Kowalski redesign) v0.23.52
- TASK: instalacja skilla emil-design-eng, weryfikacja dostępu
- TASK: analiza designu wtyczki — przegląd styles/HTML/animacji, stworzenie REDESIGN_PLAN.md (18 problemów, 4 kategorie)
- TASK: implementacja 26 zmian CSS+JS — szybsze animacje, GPU-safe side tab, stagger, box-shadow, focus-visible, transform-origin
- TASK: deploy v0.23.52 na experimental
- TASK: log-session

### [2026-04-18] SESJA 45 — Przeprojektowanie listy URLi v0.23.51
- TASK: dodanie buga do TASKS.md (chip podglądu przy "odmówiono połączenia")
- TASK: omówienie opcji redesignu listy URLi (A/B/C), wybór opcji A
- TASK: implementacja układu kart w renderUrlList — status badge z etykietą, badże na górze, URL pełnej szerokości
- TASK: deploy v0.23.51 na experimental
- TASK: dodanie taska "poszerzenie sekcji listy URLi" do TASKS.md
- TASK: log-session

### [2026-04-18] SESJA 44 — Bugfixy v0.23.50
- TASK: przegląd historii git + TASKS.md po przerwie
- TASK: diagnoza Bug 1 (skanowanie zatrzymuje się) → root cause: onload bez try/catch; `_newsParseContent` throw → Promise wisi; fix: try/catch w `_newsContentScan.onload`
- TASK: diagnoza Bug 2 (badge ▢ przy zablokowanym iframe) → root cause: `onerror` nie odpala przy X-Frame-Options; fix: `onload` + `contentDocument.body.childElementCount === 0`
- TASK: deploy v0.23.50 na experimental
- TASK: log-session

### [2026-04-17] SESJA 43 — News MAŁE + ŚREDNIE taski v0.23.48–v0.23.49
- TASK: organizacja tasków News → grupy MAŁE/ŚREDNIE/DUŻE w TASKS.md
- TASK: v0.23.48 — 4 MAŁE: chip AI w headerze, nowe nazwy wskaźników, dolny przycisk importu, fallback daty
- TASK: v0.23.49 — 4 ŚREDNIE: AI bug fix (429/timeout/parse), fallback iframe, rich preview (autor/słowa/strefy), legenda ?
- TASK: log-session

### [2026-04-17] SESJA 42 — Fix: prompt wydzielony z kodu v0.23.47
- TASK: diagnoza dlaczego AI features niewidoczne (@updateURL → main = v0.23.35, AI dopiero od v0.23.43)
- TASK: usunięcie _NEWS_AI_DEFAULT_SYSTEM z kodu, nowy plik Tagger/prompts/news_ai_scoring.txt
- TASK: _newsAiBuildSystemPrompt przebudowany — null gdy brak promptu, guard w _newsAiAnalyze
- TASK: deploy v0.23.47 na experimental
- TASK: log-session

### [2026-04-17] SESJA 41 — AI News Scoring v0.23.46
- TASK: fix git rebase abort (repo było mid-rebase z v0.21.26 w working tree)
- TASK: implementacja Kroku 2 AI News Scoring — keywordContexts, _newsAiAnalyze, badge AI, Opis marki, prompt uniwersalny
- TASK: deploy v0.23.46 na experimental
- TASK: log-session

### [2026-04-17] SESJA 40 — Ustawienia AI poprawki v0.23.45
- TASK: fix autofill hasła w polu klucza API (type=text + autocomplete=off)
- TASK: fix dropdown modelu — hardcoded kolory, color-scheme:light
- TASK: model per funkcja (news.model + tagging.model), migracja starych ustawień
- TASK: biblioteka promptów → osobny modal _showPromptLibraryModal()
- TASK: usunięcie limitu dziennego maxCallsPerDay
- TASK: max-height:90vh + scroll na modal ⚙
- TASK: hardcoded kolory w _aiRenderPromptList
- TASK: deploy v0.23.45 na experimental
- TASK: log-session

### [2026-04-17] SESJA 39 (cont.) — UX fix: Ustawienia AI w modalu, News button v0.23.44
- TASK: diagnoza — Ustawienia AI ukryte za załadowaniem pliku (b24t-settings-section display:none)
- TASK: przeniesienie Ustawień AI do showFeaturesModal() — pełne HTML + event wiring w modalu ⚙
- TASK: News — zamiana przycisku "Następny relevantny" na "Importuj URLe" (HTML + event handler)
- TASK: TASKS.md — dodano 2 drobne poprawki do następnej sesji (modal max-height, styl przycisku)
- TASK: deploy v0.23.44 na experimental
- TASK: log-session

### [2026-04-17] SESJA 39 — AI Settings v0.23.43
- TASK: omówienie uwag do panelu News → 4 taski do kolejnej sesji
- TASK: decyzja o priorytetyzacji AI, znalezienie planu w /work/implementacje/AI_IMPLEMENTATION_PLAN.md
- TASK: implementacja Ustawień AI — LS key, 5 helperów, HTML sekcja, event wiring, XSS fix
- TASK: deploy v0.23.43 na experimental
- TASK: log-session

### [2026-04-17] SESJA 38 — Fix: scroll panelu głównego v0.23.42
- TASK: diagnoza regresjii z v0.23.37 — #b24t-main-tab miał overflow:hidden zamiast overflow-y:auto
- TASK: fix jednolinijkowy — przywrócono overflow-y:auto; overflow-x:hidden
- TASK: deploy v0.23.42 na experimental
- TASK: log-session

### [2026-04-17] SESJA 37 — News Faza 2: iframe/rich-preview, detekcja iframeable, 3 zakładki v0.23.41
- TASK: implementacja Fazy 2 — detekcja iframeable w _newsContentScan (X-Frame-Options, CSP frame-ancestors)
- TASK: środkowa kolumna w overlay — colPreview (flex:1) między colList (270px) a colForm (285px)
- TASK: _newsShowPreview + _newsShowRichPreviewCard — iframe vs rich card, header z URL + przycisk Karta + link ↗
- TASK: badge ▢ w liście URLi dla stron iframeable
- TASK: 3 zakładki na wąskich ekranach [Lista|Podgląd|Formularz], breakpoint 880→960px, auto-switch po kliknięciu
- TASK: deploy v0.23.41 na experimental
- TASK: log-session

### [2026-04-17] SESJA 36 — News: fullscreen overlay, modal importu, live feedback, responsywny układ v0.23.40
- TASK: planowanie + zakres Fazy 1 (fullscreen overlay zamiast 3 pływających paneli)
- TASK: pełny rebuild HTML panelu News — overlay 95vw×95vh, 3 kolumny, modal importu
- TASK: _buildNewsPanels + _wireNewsPanels — nowy podział funkcji
- TASK: aktualizacja MAPY SEKCJI w CLAUDE.md (12 950 linii, Sesja 36)
- TASK: deploy v0.23.40 na experimental
- TASK: log-session
