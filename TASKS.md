# B24 TAGGER — TASKS

## WAŻNE (wtyczka działa bez tego, ale warto)

- [x] **News — implementacja skanowania treści stron (content scan)** — wieloetapowy task:
  - [x] **1. Fix: słowa kluczowe (chipy) nie wyświetlają się w panelu Import**
  - [x] **2. Funkcja `_newsContentScan(url, chips)`** — GM_xmlhttpRequest, DOMParser, punktowanie 5 stref
  - [x] **3. Integracja z importem URL** — sliding window, wyniki na żywo, pasek postępu
  - [x] **4. Nowy status `contentmatch`** — statusDot, legenda, licznik
  - [x] **5. UI: nowa legenda, pasek postępu, dynamiczna lista, selektor tagów**
  - [x] **6. Tiered scoring** — mention/contentmatch/keytopic (score 1–4/5–11/12+) — v0.23.6
  - [x] **7. Auto-fill tytułu i snippetu** do formularza wzmianki po kliknięciu URLa — v0.23.6
  - [x] **8. Rozszerzone strefy skanowania** — figcaption, podpisy, galerie, adresy/lokalizacje; badge strefy pobocznej w liście URLi — v0.23.10
  - [x] **9. Blocked strony klikalne** — manual check, osobny bulk button — v0.23.10

- [x] Z-index: aktywny/przesuwany panel zawsze on top — v0.23.0
- [x] News: poprawić działanie trzymających się razem paneli — v0.23.0

## DO ZROBIENIA — NASTĘPNA SESJA

### Floating panel Niestandardowe — pozostałe punkty planu
- [x] **[FIX] Nazwy projektów cross-domain — dropdown kraju jako `<select>` z 49 kodami** — `_COUNTRIES` + `_countryOptionsHtml()`, zamiana `<input>` na `<select>` w full panel i mini panelu — v0.24.11
- [x] **[FIX] Auto-fill treści — łączy akapity do 200 znaków, przycina na granicy zdania** — maks. 5 akapitów, fallback na cały kontener, trim na ostatniej kropce — v0.24.11
- [x] **[FIX] Nazwy projektów cross-domain — GM mirror dla PROJECT_NAMES, _gmGetProjectNames scal LS.PROJECTS + LS.PROJECT_NAMES** — v0.24.11–v0.24.16
- [x] **[FIX] Nazwy projektów cross-domain — przycisk Reset i przebuduj w ⚙ Niestandardowe** — nuclear clear obu GM mirrorów + rebuild z LS; guard gdy LS pusty (non-brand24) — v0.24.17–v0.24.18
- [x] **[FIX ROOT] _gmSaveProjects filtruje fallbacki przed zapisem** — złe nazwy z LS.PROJECTS nie wracają do mirrora nigdy — v0.24.19
- [x] **[FEATURE] Floating panel Niestandardowe — auto-scraping danych artykułu** — `_miniScrapeCurrentPage()`: treść (article/main/[itemprop=articleBody]), data (JSON-LD → meta → time[datetime]), język (html[lang]); auto-fill content+date po otwarciu modalu z wizualnym highlight — v0.24.6
- [x] **[FEATURE] Floating panel Niestandardowe — selektor projektu z LS** — już był w mini panelu od v0.24.0; `_renderTags(pid)` przeładowuje tagi przy zmianie projektu; `b24tagger_mini_last_project` pamięta ostatni wybór
- [x] **[FEATURE] Floating panel Niestandardowe — multi-tag support** — już był w mini panelu od v0.24.0; checkbox list wszystkich tagów projektu
- [x] **[FEATURE] Floating panel Niestandardowe — auto-detekcja kategorii z URL** — `_detectCategoryFromUrl(window.location.href)` przy otwarciu modalu zamiast hardcoded '8 — Web' — v0.24.6
- [x] **[FEATURE] Floating panel Niestandardowe — detekcja duplikatów** — `_miniDupCheck()`: GQL search po ostatnim segmencie URL, porównanie `url`+`openUrl` przez normalizeUrl; badge `✓ URL nowy`/`⚠ duplikat` obok pola URL — v0.24.6
- [x] **[FEATURE] Floating panel Niestandardowe — ostrzeżenie językowe** — `_miniLangCheck()`: inference języka projektu z sufiksu nazwy (_XX), porównanie z `html[lang]`; żółty pasek ostrzeżenia — v0.24.6
- [x] **[CLEANUP] Floating panel Niestandardowe — usunąć dropdown promptu AI z głównego widoku** — dropdown promptu AI jest już w ustawieniach ⚙; z formularza Niestandardowe można go usunąć — v0.24.20
- [x] **[BUG/DIAGNOZA] Tagi w panelu Niestandardowe — weryfikacja zaciągania z projektów** — CSS reset naprawił zaciąganie tagów cross-domain — v0.24.21
- [x] **[BUG/DIAGNOZA] Dup-check w panelu Niestandardowe — weryfikacja skanowania projektu** — pełna przebudowa `_customDupCheck` z B24Bridge + sequence guard + pid NaN guard — v0.24.26
- [x] **[BUG/DIAGNOZA] Diody CMS i Token — faktyczny check czy użytkownik jest zalogowany** — `_newsCheckTagDodane` prawidłowo implementuje check — v0.24.x
- [x] **[FEATURE] Floating panel Niestandardowe — blokada submitu przy ✗ CMS** — blokada submitu przy ✗ CMS zaimplementowana — v0.24.20/v0.24.22
- [ ] **[FEATURE] Floating panel Niestandardowe — link do dodanej wzmianki po submicie** — parsowanie ID wzmianki z odpowiedzi POST `/searches/add-new-mention/`; wyświetlenie linku `app.brand24.com/panel/results/...` w statusie sukcesu
- [x] **[FEATURE] Floating panel Niestandardowe — ustawienia panelu** — `_openCustomPanelSettings()`: popover pod przyciskiem ⚙; AI toggle (slider style), selektor promptu, przycisk Zapisz; chip AI ukryty w custom mode — v0.24.9
- [x] **[FEATURE] Floating panel Niestandardowe — scraping metadanych social media** — `_scrapeSocialMetrics()`: polubienia/udostępnienia/komentarze z DOM Twitter/X/Facebook/LinkedIn/YouTube/Reddit; IG zwraca null (auth wall — graceful fail); wyniki wpisywane do pól formularza — v0.24.9
- [ ] **[FEATURE] Floating panel Niestandardowe — redesign UI** — styl main panelu: droplet avatary, cienie, CSS vars; realizacja na samym końcu

- [ ] **[BUG/DIAGNOZA] News — badge ⏳ AI... wisi na stałe zamiast przejść w ✅/❌/🤖** — użytkownik widzi ⏳ na każdym artykule; możliwe przyczyny: (1) klucz API wygasł/błędny → przetestować nowym przyciskiem "Testuj klucz API" w ⚙, (2) GM_xmlhttpRequest nie trigguje callbacków (onload/onerror/ontimeout) — sprawdzić w Network Monitor czy request w ogóle wychodzi, (3) błąd parsowania odpowiedzi API — dodać `console.log` wewnątrz `_newsAiAnalyze` callbacków; po diagnozie zdecydować o naprawie
- [ ] **[UX/TECH-DEBT] Drag panelu Niestandardowe — zmiana selektora headera** — drag używa `panelMain.querySelector('div')` zamiast ID; dodać `id="b24t-news-panel-header"` do headera w `_buildNewsPanels` i użyć go w `_wireNewsPanels`

## UKOŃCZONE (sesja 2026-05-14, Sesja 86)

- [x] **[ARCH] B24Bridge — centralny system danych cross-domain** — jeden klucz GM `b24t_bridge` zastępuje 4 rozproszone klucze; `token` (TTL 8h), `projects` (filtr fallbacków), `lastProject`; `GM_addValueChangeListener` reaktywne powiadomienia między kartami; jednorazowa migracja starych kluczy GM — v0.24.26
- [x] **[REFACTOR] Migracja wszystkich callerów do B24Bridge** — `_gmGetProjects`, `_gmSaveProjects`, `_gmGetProjectNames`, `_gmSaveProjectNames`, `_pnSet`, token capture (origFetch interceptor), `_newsCheckTagDodane` base URL, przycisk "Reset i przebuduj", `b24t_mini_last_project`, ANNOTATOR TOOLS, `_customDupCheck` — v0.24.26
- [x] **[BUG] Dup-check pokazywał "otwórz Brand24" mimo załadowanego tokenu** — pełna przebudowa `_customDupCheck` z B24Bridge.token.isValid(), sequence guard `_dupCheckSeq`, pid NaN guard; reaktywny `B24Bridge.onChange('custom-dupcheck')` w INIT auto-ponawia dupcheck gdy brand24.com zapisze token — v0.24.26
- [x] **[DOCS] CLAUDE.md — nowa HARD RULE B24Bridge + mapa sekcji do 17 159 linii** — wszystkie numery linii zaktualizowane do Sesji 86

## UKOŃCZONE (sesja 2026-05-13, Sesja 84)

- [x] **[FEATURE] Ustawienia ⚙ — sekcja Projekty: Uzupełnij nazwy** — nowa sekcja w modalu ⚙; licznik projektów bez nazwy; przycisk "Uzupełnij nazwy"; GQL probe: `getProjects` batch (jeden request) + fallback `getProject(id)` per ID; updates `LS.PROJECT_NAMES` + `LS.PROJECTS[id].name` przez `_pnSet`; status ✓/⚠ po zakończeniu — v0.24.10
- [x] **[FIX] Panel Niestandardowe — treść artykułu: tylko pierwszy akapit** — `_miniScrapeCurrentPage`: `cEl.querySelector('p')` zamiast całości kontenera; limit 600 znaków (poprzednio 3000); dotyczy obu formularzy (Brand24 + mini button) — v0.24.10
- [x] **[FIX] Panel Niestandardowe — domyślna kategoria News zamiast Web** — `_detectCategoryFromUrl`: fallback `8`→`7` dla nierozpoznanych domen i null URL — v0.24.10

## UKOŃCZONE (sesja 2026-05-13, Sesja 83)

- [x] **[FEATURE] Floating panel Niestandardowe — skanowanie bieżącej strony** — `_customAutoFillFromPage()`: wrappuje `_miniScrapeCurrentPage()`, wypełnia pola URL/tytuł/treść/data/kategoria po `openNewsPanels('custom')` na zewnętrznych stronach (requestAnimationFrame po renderze) — v0.24.9
- [x] **[FEATURE] Floating panel Niestandardowe — dark mode cross-domain** — `applyTheme()` mirroruje motyw do `GM_setValue('b24t_theme_mirror')`; mini button czyta GM przy pierwszym `injectStyles()` — v0.24.9
- [x] **[UX] Floating panel Niestandardowe — przycisk ✚B24** — `top:33vh;right:18px`, 54×54px; poprzednio bottom-left, mały — v0.24.9
- [x] **[UX] Floating panel Niestandardowe — projekt zawsze widoczny + cross-domain** — wiersz projektu nie chowa się po wyborze; `GM_setValue('b24t_mini_last_project')` + pre-select przy otwarciu — v0.24.9
- [x] **[UX] Floating panel Niestandardowe — language check** — sprawdzenie języka `html[lang]` vs języka projektu przy zmianie projektu w `_wireNewsPanels` — v0.24.9
- [x] **[UX] Floating panel Niestandardowe — tagi auto-expanded** — tagi otwarte domyślnie w custom mode (`_applyNewsMode`) — v0.24.9
- [x] **[UX] Floating panel Niestandardowe — więcej wysokości** — overlay top padding 60→20px, `maxHeight: calc(100vh - 20px)` — v0.24.9
- [x] **[UX] Floating panel Niestandardowe — usunięto "Importuj URLe"** — przycisk ukrywany w custom mode — v0.24.9
- [x] **[BUG] `_parseNum` — błąd dziesiętny** — `.replace(/\./g,'')` niszczyło "1.2K" → 12000; fix: usunięto replace kropek — v0.24.9

## UKOŃCZONE (sesja 2026-05-13, Sesja 82)

- [x] **[BUG] Floating panel Niestandardowe — zakładki widoczne w trybie custom** — `_newsApplyResponsive()` nadpisywała `_toggleFormOnly(true)` przy każdym resize; fix: early return gdy `newsState.mode === 'custom'` ukrywający tabsBar — v0.24.7
- [x] **[FEATURE] Floating panel Niestandardowe — AI toggle w headerze** — chip `🤖 AI` zmieniony na klikalny `<button>`; `_syncAiChip()` synchronizuje kolor z `s.custom.enabled`; klik zapisuje przez `_aiSaveSettings()` — v0.24.7
- [x] **[BUG] Floating panel Niestandardowe — mini button nie pojawia się na zewnętrznych stronach** — root cause: `localStorage` izolowany per domena; dane projektów z Brand24 niedostępne na zewnętrznych stronach; fix: `GM_getValue`/`GM_setValue` grants + `_gmGetProjects()` (LS-first, fallback GM) + `_gmSaveProjects()` mirror przy załadowaniu projektu na Brand24; mini button klik używa `openNewsPanels('custom')` + `injectStyles()` — v0.24.8

## UKOŃCZONE (sesja 2026-05-13, Sesja 81)

- [x] **[FEATURE] Floating panel Niestandardowe — auto-scraping + dup-check + ostrzeżenie językowe + auto-kategoria** — `_miniScrapeCurrentPage()`, `_miniDupCheck()`, `_miniLangCheck()`; auto-fill content/date/kategoria przy otwarciu; badge URL nowy/duplikat; ostrzeżenie językowe z inference języka projektu z sufiksu nazwy — v0.24.6

## UKOŃCZONE (sesja 2026-05-13, Sesja 80)

- [x] **[BUG] Floating panel Niestandardowe niewidoczny — zasłonięty przez panel Taggera** — root cause: overlay z-index 2147483632 < panel Taggera 2147483647; fix: `_applyNewsMode()` podnosi overlay do 2147483647 w trybie custom; padding-right 12→52px eliminuje nakładanie na side tab; explicit `rgba(0,0,0,0.55)` w news mode naprawia transparent tło po custom→news switch — v0.24.2
- [x] **[BUG] Floating panel Niestandardowe znikał po kliknięciu + gap Wzmianki/Net** — root cause: overlay `pointer-events:none` → kliknięcia przez 52px przerwę trafiały w side tab Wzmianki → `closeNewsPanels()`; fix: `_applyNewsMode()` custom mode ustawia `pointer-events:none` na side tab Wzmianki (przywracane w news mode i `closeNewsPanels()`); fix gap: Net tab `calc(50%+250px)` → `calc(50%+200px)` — v0.24.3
- [x] **[BUG] Floating panel Niestandardowe znikał przy przeciąganiu** — root cause: drag handler ustawiał `left/top` jako absolutne koordynaty viewport na elemencie `position:relative` (flex child) → `left:1300px` na elemencie at 1300px = offset 2600px poza ekranem; fix: przy `mousedown` konwersja na `position:fixed` z aktualną pozycją z `getBoundingClientRect()` — v0.24.4
- [x] **[UX] Custom mode — tylko formularz + fix lag przeciągania** — ukryto przyciski Stats (📊), Legenda (?), Języki (⚙ Języki) w headerze w custom mode; `offsetWidth`/`offsetHeight` cachowane raz przy `mousedown` zamiast wywoływania reflow na każdy `mousemove` — v0.24.5

## UKOŃCZONE (sesja 2026-05-11, Sesja 78)

- [x] **[FIX] Przyciski boczne Wzmianki i Net nachodzą na siebie** — `#b24t-nm-tab` przesunięty z `calc(50%+175px)` na `calc(50%+250px)` — v0.24.1
- [x] **[UX] Tryb Niestandardowe jako floating panel** — overlay transparent + `pointer-events:none`; panelMain `pointer-events:auto`; auto formOnly; dragowalny za header — v0.24.1
- [x] **[UX] ESC zamyka panel importu i overlay Wzmianek** — nie aktywuje się gdy fokus w INPUT/TEXTAREA/SELECT — v0.24.1
- [x] **[UX] Import URLi w Niestandardowe ukrywa Słowa kluczowe i Opis marki** — obie sekcje ukryte gdy mode='custom'; spójne w modalOpenBtn i bottomImportBtn — v0.24.1
- [x] **[UX] Prompt AI przeniesiony z ⚙ do paneli Wzmianek** — `b24t-news-import-prompt-sel` (News) + `b24t-news-custom-prompt-sel` (Niestandardowe); `_newsRefillPromptSelect(isCustom)`; `s.custom.activePromptId` — v0.24.1
- [x] **[FIX] Usunięto opcję "auto (z domeny)" z dropdownu kategorii** — z formularza News i z mini-buttonu; domyślna kategoria = 8 (Web) — v0.24.1

## DO ZROBIENIA (archiwalne, Sesja 72, po reset limitu)

### Performance audit (z audytu Sesja 71, 2026-05-08) — uporządkowane po impact

- [x] **[PERF/WYSOKI] Overall Stats — throttling 40 jednoczesnych requestów** — `STATS_FETCH_CONCURRENCY` 10→4 (4×4 queries = max 16 równoczesnych zamiast 40) — v0.23.94
- [x] **[PERF/WYSOKI] Quick Delete — brak sleep między batchami** — `await sleep(50)` między batchami deletów — v0.23.94
- [x] **[PERF/WYSOKI] `_bgFetchTagstats` — count-only query zamiast pełnych results** — count-only GQL przez origFetch, 2 queries per projekt równolegle — v0.23.94
- [x] **[PERF/ŚREDNI] News re-check — sekwencyjne paginowanie** — równoległe pobieranie stron (10 naraz) zamiast while-loop — v0.23.94
- [x] **[PERF/ŚREDNI] `fetchProjectTagCounts` — usunąć zbędne `tags{title}`** — zmieniono na `tags{id}` — v0.23.94
- [x] **[PERF/ŚREDNI] `_bgFetchAllProjects` — sprawdzanie cache przed re-fetchem** — `_bgCacheFresh` check na starcie funkcji — v0.23.94
- [x] **[PERF/NISKI] `_fetchProjectStats` — duplikat strony 1 w binary search** — p1Res cachowany, boundary page reużywa cache gdy lo=1 — v0.23.94
- [x] **[PERF/NISKI] News URL matching — O(N²) pętla** — prefix index Map (15-char key), O(N+M) — v0.23.94

### Miscellaneous (UI/UX)

- [x] **[UX] Wskaźnik opóźnienia zapytań — ikonka ⚠ w nagłówku panelu** — p90 ostatnich 30 requestów z ring buffera NM; żółty (p90<800ms), pomarańczowy (<2000ms), czerwony (≥2000ms lub błędy); tooltip: błędy/p90/slow count; klik → Network Monitor; znika gdy brak slow/error — v0.23.95

- [x] **[UX] Animacje pojawiania się danych w panelach statystyk** — count-up easeOutQuart, progress bar od 0% (podwójny rAF), stagger fade+slide-up wierszy (Overall Stats 40ms, Dashboard 60ms, Tag Stats 35ms); `_animateCountUp` helper; `prefers-reduced-motion` respektowane — v0.23.96

## BUGI DO NAPRAWY (sesja 2026-04-11, Sesja 19)

- [x] **[BUG] Project-check pobiera tylko 60 wzmianek zamiast wszystkich** — fix: paginacja, nowy warunek break, wording komunikatu — v0.23.11
- [x] **[BUG] Keyword w div/li/dd nie wykrywany przez scanner** — fix: fallback na pełny tekst body po usunięciu szumu — v0.23.11

## BUGI DO NAPRAWY (sesja 2026-04-11)

- [x] **[BUG] Dropdown tagów w formularzu wzmianki — brak scrollowania** — fix: max-height + overflow-y:auto — v0.23.7
- [x] **[BUG] Auto-fill formularza wzmianki — pole Treść dostaje tytuł zamiast treści artykułu** — fix: _bodySnippet/_metaSnippet, snippet preferuje body — v0.23.7
- [x] **[FEATURE] Wyświetlanie dopasowanych słów kluczowych przy wzmiance** — matchedChips[] + badge'e w liście URL-i — v0.23.7
- [x] **[BUG] Priorytet reguły kodu kraju w URL — zły kolor dla cosmopolitan.com/nl** — fix: country override po content scan przez _newsCountriesInUrl() — v0.23.7
- [x] **[BUG] CMS dot nie aktualizuje się na panel.brand24.pl** — fix: timing (detectProject trigger), retry 1.5s, recheck re-fetchuje tagi — v0.23.8
- [x] **[BUG] Auto-fill Tytuł — wklejana nazwa serwisu zamiast nagłówka** — fix: kolejność h1 > content_title > og:title > title — v0.23.8
- [x] **[BUG] Auto-fill Treść — snippet za krótki, keyword poza zakresem** — fix: cały akapit ≤600 znaków, 3 zdania wokół kw — v0.23.8
- [x] **[BUG] CMS check — zawsze "zaloguj się" mimo zalogowania (brak tagu w projekcie)** — fix: async GET /searches/add-new-mention/, 2 osobne stany — v0.23.9
- [x] **[BUG] Auto-fill Treść — h1 trafia do pola Treść** — fix: h1 tylko do scoringu, nie do snippetu — v0.23.9
- [x] **[BUG] Strony niedostępne (blocked) nie można ręcznie sprawdzić** — fix: blocked klikalne, osobny bulk button — v0.23.10
- [x] **[BUG] Keyword w podpisie zdjęcia/galerii/adresie nie jest wykrywany** — fix: rozszerzone strefy, badge poboczny — v0.23.10

## KRYTYCZNE BUGI (odkryte 2026-04-10, do naprawy w kolejnej sesji)

- [x] **[BUG] Przycisk "Wczytaj URLe" nie reaguje** — fix: v0.23.5
- [x] **[BUG] Chipy słów kluczowych zniknęły z panelu Import** — fix: v0.23.5
- [x] **[BUG/FEATURE] Wskaźnik statusu CMS** — v0.23.5
- [x] **[BUG] Przycisk boczny News biały przy aktywacji** — fix: v0.23.6
- [x] **[BUG] Przycisk boczny News znika po zamknięciu paneli** — fix: v0.23.6
- [x] **[BUG] Dropdown tagów w formularzu wzmianki pusty** — fix: `_newsRefillTags()` — v0.23.6
- [x] **[BUG] "Sprawdzono X wzmianek" nadpisuje wynik skanu** — fix: osobny element — v0.23.6

## NOWE ZADANIA (sesja 2026-04-11, Sesja 20)

- [x] **News: detekcja typu strony — "artykuł" vs "katalog/firma"** — v0.23.13: og:type, JSON-LD @type, published_time, time[datetime], 5+ paragrafów; badge "nie-artykuł" (szary) i "? typ niepewny" (amber) w liście URLi
- [x] **News: wykrywanie języka strony** — v0.23.14: `<html lang>` → porównanie z `_NEWS_LANG_MAP[projectCountry]`; strony w złym języku → wrongcountry; angielski zawsze akceptowany
- [x] **News: data publikacji z widoczną datą i wykrywanie stale** — v0.23.14: badge daty (zielony/amber/czerwony); >60 dni → stale (opacity 0.55, czerwona data)
- [x] **News: wykrywanie paywalla** — v0.23.14: JSON-LD isAccessibleForFree:false, meta access/content_tier, CSS klasy paywall, text-ratio check; badge "🔒 paywall"
- [x] **News: filtr "Ukryj nie-artykuły"** — v0.23.14: toggle button nad listą URLi; ukrywa (nie usuwa) wiersze nonArticle; pokazuje się tylko gdy są nie-artykuły

## NOWE ZADANIA (sesja 2026-04-14, Sesja 22)

- [x] **Integralność danych wejściowych** — sanitizeInputRows, validateInputSchema, ograniczenie fuzzy diff≤5, raport tagowania — v0.23.23

## NOWE ZADANIA (sesja 2026-04-14, Sesja 24)

- [x] **Fix: mapowanie multi-assessment** — `processFileData` rozdziela wartości po `|` i liczy każdą część osobno; wcześniej `Influencer|Współpraca` trafiał jako osobny label zamiast doliczać do obu woreczków — v0.23.25

## NOWE ZADANIA (sesja 2026-04-14, Sesja 23)

- [x] **Multitagowanie** — separator `|` w kolumnie assessment, nowy tryb konfliktu Multitag, każdy assessment przetwarzany niezależnie — v0.23.24
- [x] **Cursor prompt — multi-assessment w notebookach** — instrukcja dodania `MULTI_ASSESSMENT = False` + `build_assessment()` per notebook i do szablonu; domyślnie wyłączone

## NOWE ZADANIA (sesja 2026-04-13, Sesja 21)

- [x] **Sprawdź już otagowane** — po zakończeniu sesji tagowania: opcja weryfikacji wierszy NO_MATCH przez pełną mapę Brand24 (bez filtru Untagged) → klasyfikacja każdego NO_MATCH jako `ALREADY_TAGGED` lub `NOT_IN_BRAND24`; wynik widoczny w raporcie końcowym i eksportowalny do CSV

## NOWE ZADANIA (sesja 2026-04-14, Sesja 26)

- [x] **Paywall precision** — dwie klasy sygnałów: twarde (access-denied, subscriber-only) vs słabe (piano, tinypass) — słabe tylko gdy body < 1200 znaków — v0.23.27
- [x] **Autofill tytułu (lepszy)** — _newsFetchPageInfo: h1 z article/main > content_title > og:title > title — v0.23.27
- [x] **Badge języka strony w liście URLi** — fioletowy badge po skanowaniu (pl, cs, de) — v0.23.27
- [x] **Hint języka projektu w formularzu** — pod polem KRAJ: "lang: cs, sk" — v0.23.27
- [x] **Lepsze wykrywanie strefy artykułu** — _CONTENT_ZONE_SEL: 13 CMS fallbacks przed doc.body (entry-content, post-content, article__body, story-body, role=article itp.) — v0.23.28
- [x] **Rozszerzone wzorce dat** — 7 nowych wzorców: itemprop datePublished, publishdate, cXenseParse, DC.date, data-date, time apostrofy, dateModified — v0.23.28
- [x] **Revert blind content autofill** — cofnięto błędny autofill pierwszego akapitu bez związku ze słowem kluczowym — v0.23.28

## NOWE ZADANIA (sesja 2026-04-14, Sesja 27)

- [x] **Fix: nomatch na Elle i podobnych stronach** — bodyEl identyfikowany przed noise removal; guard `el !== bodyEl && !el.contains(bodyEl)`; `header` → `body > header`; nowe wzorce CMS — v0.23.29

## NOWE ZADANIA (sesja 2026-04-14, Sesja 29)

- [x] **Kompaktowy widok badży w liście URL panelu News** — wszystkie badże (chip słowa kluczowego, data, język, nie-artykuł, paywall, zone hint, teaser) w jednym wierszu flex zamiast stackowania wertykalnego — v0.23.31

## NOWE ZADANIA (sesja 2026-04-14, Sesja 28)

- [x] **Domyślne skanowanie treści stron + opcja uproszczonego skanowania URL** — content scan jako domyślna metoda; skanowanie po URL przeniesione do ustawień ⚙ (off by default); żywy licznik `⟳ Skanowanie X/Y...`; ustawienie persystuje w localStorage — v0.23.30
- [x] **Pulsowanie pasków postępu podczas aktywnego procesu** — klasa `b24t-bar-active` na wszystkich paskach (tagowanie, News, Delete) — v0.23.32
- [x] **Rewizja i przeprojektowanie komunikacji wtyczka → użytkownik podczas aktywnych procesów** — badge `⟳ Running`/`⚠ Error`/`✓ Done`, `● Token` i `● CMS` z labelkami i animacjami, spójny styl przycisków wszystkich nagłówków — v0.23.32–0.23.35

## POMYSŁY (niska prioritetność, do rozważenia)

- [x] **News: wykrywanie keyword w news teaserze / zajawce** — status teasermatch, badge "w polecanym art.", NEWS_TEASER_SELECTORS — v0.23.26
- [ ] **News: wstępna blokada znanych nie-newsów (social media, mapy)** — domeny linkedin.com, facebook.com, twitter.com/x.com, maps.google.com, youtube.com oznaczać automatycznie jako nonArticle bez pobierania HTML — szybciej i precyzyjniej niż content scan
- [x] **News: integracja AI API (Claude Haiku) do analizy relevancji** — badge 4 kategorii (✅/⚠️/❌/🚫), parsowanie `verdict` z fallbackiem na `relevant:bool`, legenda zaktualizowana — v0.23.98
  - [ ] **Prompt do wtyczki** — `Tagger/work/news_ai_scoring.txt` gotowy do przeglądu i wklejenia do biblioteki promptów; rozważyć usunięcie `reason` z outputu
- [ ] **AI Tagging — tagowanie wzmianek przez Claude API** — nowy tryb tagowania równoległy do standardowego; wtyczka wyciąga tekst, tytuł, autora, źródło z panelu Brand24 i wysyła do Claude API z ustalonym promptem; wynik mapowany na tag i nakładany na wzmiankę; klucz API użytkownika w ustawieniach (localStorage); zakres: (1) konfigurowalny prompt per projekt, (2) obsługiwane labele = tagi z projektu Brand24, (3) podgląd odpowiedzi AI przed zatwierdzeniem (opcjonalnie), (4) licznik kosztu sesji w logach

## NOWE ZADANIA (sesja 2026-04-10)

- [x] **Ograniczenie wychodzenia paneli poza ekran** — v0.23.0
- [x] **Zbadać dodawanie wzmianek na panel.brand24.pl** — sprawdzić czy endpoint `/searches/add-new-mention/` istnieje i działa na polskim serwerze; jeśli nie — ustalić właściwą ścieżkę
- [ ] **Wyszukiwarka projektów w oknie tworzenia grupy** — pole tekstowe do filtrowania listy projektów po wpisaniu frazy; potrzebne gdy użytkownik ma dużo projektów
- [ ] **Auto-sugestie grup po kodach krajów** — wykrywanie kodów krajów w nazwach projektów (np. Tr, Gr, Pl, De, Fr itp.) i automatyczne sugerowanie grupowania projektów z tymi samymi kodami; użytkownik może przed zapisem dodać/usunąć projekty z proponowanej grupy
- [ ] **Wczytywanie projektów bez manualnego wchodzenia** — zbadać czy możliwe jest wczytanie danych projektu (URL-i) bez konieczności ręcznego otwierania każdego projektu w śledzeniu
- [ ] **Suwak transparentności paneli** — w ustawieniach dodać suwak do regulacji przezroczystości wszystkich paneli wtyczki
- [ ] **Uruchamianie notebooków Jupyter z poziomu wtyczki** — skrócenie workflow analizy wzmianek: zamiast ręcznego odpalania notebooka poza wtyczką, wgrywanie i uruchamianie notebooków `.ipynb` bezpośrednio z UI. Notebook zaciąga dane z BigQuery, przepuszcza przez prompt AI (Anthropic API) i zwraca plik CSV, który automatycznie wczytuje się jako plik źródłowy do tagowania/czyszczenia. Zakres funkcji:
  - wgrywanie i lokalne zapisywanie notebooków we wtyczce (żeby nie wrzucać ich każdorazowo)
  - widok z kluczowymi metadanymi: zakres dat, ID i nazwa projektu (dopasowane do bieżącego projektu wtyczki), zapytanie SQL do BQ
  - możliwość edycji zakresu dat i zapytania SQL z poziomu widoku wtyczki przed odpaleniem
  - po zakończeniu: plik CSV wynikowy automatycznie trafia jako plik źródłowy do tagowania

## NICE TO HAVE (jeśli zostanie czas w pierwszej stable)

## BUGI DO NAPRAWY (sesja 2026-04-15)

- [x] **[BUG] Modal Changelog — historia zmian wyświetla "undefined" zamiast opisów** — fix: normalizacja stringów z CHANGELOG.json do obiektów {type,text} + labelColorFallback — v0.23.37
- [x] **[BUG] Modal Changelog — nagłówek ma kanciaste rogi** — fix: `border-radius:14px 14px 0 0` na headerze — v0.23.37

- [x] **Ujednolicenie stylu modalu Changelog & Feedback** — gradient header, CSS vars, spójny styl z innymi panelami; light/dark theme automatycznie — v0.23.36
- [ ] **Pełnoekranowy widok logów — ujednolicenie stylu** — jeszcze nie objęty CSS vars / glass card stylem
- [x] **Okienko logu w głównym panelu — fix scroll i zawijanie** — fix: overflow:hidden na #b24t-main-tab, requestAnimationFrame dla auto-scroll — v0.23.37
- [x] **[BUG] Scroll panelu głównego niedostępny po załadowaniu pliku** — regresja z v0.23.37: `overflow: hidden` zamiast `overflow-y: auto; overflow-x: hidden` na #b24t-main-tab — fix: v0.23.42
- [ ] Ulepszenie UI dla wygody użytkownika — do rewizji
- [ ] **Rewizja słownictwa UI** — pierwsza runda zrobiona (v0.23.36): labelki→oceny, onboarding, help mode, komunikaty. Do dokończenia: głębszy onboarding, pełny help mode, pozostałe komunikaty w logach i panelach
- [ ] Onboarding: możliwość pominięcia, poprawki tekstów, tutorial dla nowych elementów, osobny onboarding dla funkcji annotatorskich
- [ ] Tryb pomocy: brakujące opisy, rewizja słownictwa, poprawki wyświetlania

## UKOŃCZONE (sesja 2026-04-16, Sesja 34)

- [x] **Redesign headera — BETA chip, wersja pod nazwą, dark/light do ustawień** — v0.23.38
- [x] **Scalenie meta-bar + subbar — ikonki Changelog/Feedback z tooltipem** — v0.23.38
- [x] **Rozdzielenie Changelog i Feedback na osobne modale** — v0.23.38

## UKOŃCZONE (sesja 2026-04-17, Sesja 36)

- [x] **Przebudowa panelu News — Faza 1 — fullscreen overlay** — jeden panel 95vw×95vh zamiast 3 pływających; modal importu; live feedback; responsywny układ (zakładki/kolumny) — v0.23.40
- [x] **Zaktualizuj MAPĘ SEKCJI w CLAUDE.md** — mapa nieaktualna od v0.21.27; zaktualizowana do Sesji 36 (v0.23.40, 12 950 linii)

## UKOŃCZONE (sesja 2026-04-17, Sesja 37)

- [x] **News — Faza 2: środkowa kolumna z podglądem** — detekcja `iframeable` z response headers (X-Frame-Options, CSP frame-ancestors); iframe gdy dozwolony, rich preview card gdy nie; badge `▢` w liście URLi; 3 zakładki na wąskich ekranach; auto-switch do Podglądu po kliknięciu artykułu — v0.23.41

## DROBNE POPRAWKI (odkryte Sesja 39, 2026-04-17)

- [x] **Features modal ⚙ — max-height + scroll** — `max-height:90vh;overflow-y:auto` na inner div — v0.23.45

## NEWS — PLAN REALIZACJI (od Sesji 41)

> Podział ustalony Sesja 41, 2026-04-17. Realizacja progresywna sesja po sesji.

### MAŁE (każdy izolowany, ~1–2h)

- [x] **Dolny "Importuj URLe" — odróżnienie od górnego** — "↑ Wczytaj URLe" + title tooltip; górny pozostaje "+ Importuj URLe" — v0.23.48
- [x] **Status AI w headerze panelu News** — chip "🤖 AI" widoczny gdy `_newsAiShouldRun()` (enabled + apiKey) — v0.23.48
- [x] **Przeprojektowanie wskaźników relevancji** — nowe nazwy: mention→"Wzmianka" (🟠 #fb923c), contentmatch→"W treści" (🟣 #818cf8), keytopic→"Główny temat" (🟢 #22c55e); ujednolicone kolory w liście i rich preview card — v0.23.48
- [x] **Lepsza detekcja daty** — fallback na widoczny tekst z nazwą miesiąca ("Published: 12 April 2025", "April 12, 2025") gdy meta/JSON-LD zawodzi — v0.23.48

### ŚREDNIE (~3–5h, wymagają logiki + UI)

- [x] **[BUG] Skanowanie AI News zatrzymuje się w połowie bez komunikatu** — outer try/catch, obsługa 401/429/5xx/timeout/parse z konkretnym `entry.aiError`; badge błędu per URL w liście — v0.23.49
- [x] **Fix detekcji iframe — fallback na kartę** — `iframeEl.onerror` → auto-switch na rich card, `entry.iframeable=false`, rerender listy — v0.23.49
- [x] **Rich preview card — więcej danych** — autor (meta/JSON-LD/byline), liczba słów, strefy artykułu, badge iframe — v0.23.49
- [x] **Legenda oznaczeń i chipów** — przycisk `?` w headerze panelu; overlay z grid opisów wszystkich badży; przycisk zamknięcia — v0.23.49

### DUŻE (złożona architektura, >1 dzień)

- [ ] **AI chipy na artykułach — nowe etykiety po analizie** — etykiety AI (np. "Główny temat", "Wzmianka", "Współpraca", "OOT") jako kolorowe chipy w liście URLi i w karcie; tooltip z uzasadnieniem AI; wymaga rozbudowania `_newsAiAnalyze` i struktury danych wyników
- [x] **Przeprojektowanie listy URLi — kafelki zamiast listy** — układ kart: status badge z etykietą + badże w górnym wierszu, pełny URL (11px, bez limitu 42 znaków), snippet poniżej — v0.23.51
- [x] **System statystyk AI News — accuracy tracking** — per-sesja confusion matrix (TP/FP/FN/TN) w LS.NA_SESSION_STATS; _naAggSession() oblicza CM z live entries; _naCompute() agreguje sesje; eksport CSV per sesja — v0.23.79

## UKOŃCZONE (sesja 2026-05-11, Sesja 77)

- [x] **[BUG] News project-check — URL z projektu nigdy nie matchował gdy Brand24 ma różne m.url i m.openUrl** — `_processPage` dodawał tylko jeden URL per wzmianka (`m.url || m.openUrl`); gdy canonical URL w `m.url` różnił się od oryginalnego w `m.openUrl`, user-pasted URL nie był wykrywany; fix: helper `_addProjectUrl`, oba URL-e dodawane do zestawu gdy różne — v0.23.104
- [x] **[BUG] wrongcountry nie nadpisywało blocked/timeout w skanerze News** — guard `!== 'blocked'` w sprawdzeniu kraju powodował że timed-out URL z obcego kraju pokazywał blocked zamiast wrongcountry; fix: usunięto guard, country check stosowany do wszystkich statusów — v0.23.105
- [x] **[UX] Pre-scan skip dla obcokrajowych URLi** — jeśli URL sygnalizuje zły kraj przez domenę/ścieżkę, scan HTTP request w ogóle nie jest wysyłany — v0.23.105
- [x] **[UX] Timeout: usunięcie retry** — retry przy timeout dublował czas oczekiwania (8s×2=16s/URL max 24s); teraz jeden szans 10s; strony blokujące failują 2.5× szybciej; base timeout 8s→10s — v0.23.105
- [x] **[UX] Domain-skip po 2 timeoutach** — `_domainTimeouts` counter per domena; po 2 timeoutach z tej samej domeny kolejne URLe skipowane natychmiast jako `blocked/domain_timeout`; chroni przed wszystkimi workerami zajętymi jedną nieodpowiadającą domeną — v0.23.105
- [x] **[UX] Timer ETA podczas skanowania** — `Skanowanie: X/Y — ~Xs pozostało` w progressLbl; liniowa ekstrapolacja z pomiaru throughput od 3. skanu — v0.23.105

## UKOŃCZONE (sesja 2026-05-08, Sesja 70)

- [x] **Fix: fallback bulkTag — concurrent 8× zamiast sekwencji, 2 retries zamiast 5** — przy błędzie batcha fallback tagował po 1 ID sekwencyjnie z 5 retries (max ~22 min na 50 IDs). Teraz: `FALLBACK_CONCURRENCY=8`, `retries=2`, log błędu batcha z `[BRAND24]/[SIEĆ]` + hint przed fallbackiem, podsumowanie X/N — v0.23.91
- [x] **Fix: Stop zatrzymuje multiproject loop, runTagging i batch loop** — check `state.status !== 'running'` na początku każdego projektu w `runMultiProjectTagging`, po `buildUrlMap` w `runTagging`, w inner i outer batch loop — v0.23.92
- [x] **Fix: per-project zakres dat w pliku zbiorczym (szybszy URL map, mniej NO_MATCH)** — `runMultiProjectTagging` przekazywał globalny zakres partycji do każdego projektu; teraz każdy projekt oblicza własny min/max dat ze swoich wierszy — v0.23.92
- [x] **Fix: chip Untagged — brak fałszywego błędu gdy chip już aktywny** — `activateUntaggedFilter` szukało chipa który NIE jest `Mui-active`; gdy chip był aktywny → fałszywy warning. Naprawiono + degradacja do `info` — v0.23.92
- [x] **Fix: warning gdy brak untaggedId w localStorage projektu (multi-projekt)** — v0.23.92
- [x] **Fix: Aktualizacja MAPY SEKCJI w CLAUDE.md** — zaktualizowana do Sesji 70 (v0.23.92, 15 325 linii)
- [x] **[BUG] Plik CSV ze zbiorczymi wynikami oceniania blokuje Start — "kolumna daty wykryta, ale wartości puste"** — `autoDetectColumns` używało regexa `/\d{4}-\d{2}-\d{2}/` bez kotwicy `^`; kolumna `source_file` (pierwsza w CSV) zawierała nazwy plików z datami (np. `defacto_flagging_dev_2026-04-01_...csv`) → wykrywana jako kolumna dat; fix: zmiana na `/^\d{4}-\d{2}-\d{2}/` — wartość musi zaczynać się od daty — v0.23.90

## UKOŃCZONE (sesja 2026-05-04, Sesja 69)

- [x] **[BUG] News Analytics — statystyki pokazują zera po zamknięciu panelu** — `closeNewsPanels` nie zapisywał sesji do `LS.NA_SESSION_STATS` (tylko push GitHub + czyszczenie sessionId); `_naNewSession` widziało sessionId=null → sesja przepadała; fix: zapis do LS na początku `closeNewsPanels` przed `_naFinalizeSession`, deduplikacja po sessionId — v0.23.89

## UKOŃCZONE (sesja 2026-05-04, Sesja 68)

- [x] **Network Monitor — floating panel monitorujący cały ruch sieciowy (fetch + XHR)** — ring buffer 200 wpisów; tabela real-time: czas | method | URL/GQL | status | ms; klik → szczegóły; filtry All/Errors/GQL; Pause/Clear/Export JSON; toggle w ⚙; side tab 📡 poniżej News — v0.23.88

## UKOŃCZONE (sesja 2026-05-04, Sesja 67)

- [x] **[BUG] News project-check wykrywał URLe tylko z bieżącego miesiąca** — fix: zakres dat rozszerzony do 3 miesięcy wstecz (`getMonth() - 2`); ponad połowa URLi nie pokazywała się jako "już w projekcie" gdy były dodane w poprzednich miesiącach — v0.23.87
- [x] **[BUG] News project-check ignorował pole openUrl** — `getMentions` zwraca URL w `openUrl` dla niektórych wzmianek; dodano fallback `m.url || m.openUrl` (spójnie z `buildUrlMap`) — v0.23.87

## UKOŃCZONE (sesja 2026-05-03, Sesja 66)

- [x] **[BUG] overwrite/multitag pomijał wzmianki z istniejącym tagiem** — gdy conflictMode=overwrite/multitag, mapa URL budowana ze WSZYSTKICH wzmianek (nie tylko Untagged); wcześniej wzmianki z tagiem nie były w mapie → NO_MATCH → "pominięte" — v0.23.86
- [x] **Raport tagowania: licznik podmian tagu** — nowa linia "Podmieniono tag: X" w logu diagnostycznym i RAPORCIE TAGOWANIA gdy użyto trybu overwrite — v0.23.86

## UKOŃCZONE (sesja 2026-05-03, Sesja 65)

- [x] **UX: proporcje kolumn panelu News — środek najszerszy** — lista URLi 28% (z 38.2%), formularz 18% (z 23.6%); podgląd zyskuje ~54% szerokości dla wygody czytania artykułów — v0.23.85
- [x] **[BUG] Quick Delete "wszystkie projekty" — 0 wzmianek mimo że tag istnieje** — `_bgFetchAllProjects` używał `getAnnotatorDates()` = wąskie 3 dni (1–3 maja); fix: nowy helper `_getCleanupDateRange()` = prev month start → today (~30-60 dni) — v0.23.85
- [x] **[BUG] Auto-Delete po tagowaniu pliku — "brak wzmianek"** — zabezpieczenie: jeśli pierwsza próba zwróci 0, retry po 5s z `_getCleanupDateRange()` (zabezpieczenie przed lag indeksu Brand24 lub rozbieżnością dat z pliku) — v0.23.85

## NEWS — DO ZROBIENIA (następna sesja)

- [x] **Poszerzenie sekcji listy URLi** — `flex:0 0 38.2%` (złota proporcja) zamiast `width:270px`; na 1400px panelu ≈535px — v0.23.81
- [x] **UX: stosunek kolumn w panelu News** — colForm flex 23.6% (min 290 max 400px) zamiast 285px; pole Treść rows 3→7, min-height 60→140px; fix regresji _newsApplyResponsive (list nadpisywany na 270px) — v0.23.83
- [x] **Fix: wykrywanie wzmianek już istniejących w projekcie** — normalizeUrl + Set + 2 fallbacki (bez query/hash dla utm_*/fbclid + urlsMatch dla obciętego ID) — v0.23.83
- [x] **[BUG] News Analytics — wyniki zwracają same zera** — entry.scanStatus chroni oryginalny wynik skanera przed nadpisaniem przez 'opened'/'added'; usunięto early-return dla wpisów bez naOutcome → liczą się jako skipped (FP) — v0.23.82
- [x] **Funkcja zamknięcia miesiąca** — Overall Stats automatycznie trzyma się prev miesiąca dopóki nie domknięty; przyciski ← / → / ↺ Auto; "Zamknij miesiąc" czyści override → auto-przeskok na następny; LS key OVERALL_ACTIVE_MONTH per-grupa; limit 12 miesięcy wstecz — v0.23.84

## NEWS — POZA PLANEM REALIZACJI (bez ustalonego terminu)

- [ ] **Lista URLi: rozmiar i czytelność** — większa proporcja sekcji listy w layoucie, większe chipy/badże (padding, font-size) — wchodzi w scope DUŻEGO "Przeprojektowanie listy URLi — kafelki", ale można zrobić wcześniej jako CSS-only patch
- [ ] **News kampanijne — import i skanowanie URLi z kampanii** — nowa zakładka lub sekcja w panelu News dedykowana wzmiankom kampanijnym; analogiczny workflow do standardowego News: wczytanie listy URLi (paste/plik), content scan, scoring, lista z badżami; różnica: osobna przestrzeń wyników i eksport do formularza dodawania wzmianki kampanijnej zamiast standardowej

## BUGI DO NAPRAWY — NASTĘPNA SESJA (odkryte Sesja 39+, 2026-04-17)

- [ ] **[BUG] Chip podglądu pojawia się, ale strona zawsze pokazuje "odmówiono nawiązania połączenia"** — ta sama domena za każdym razem; chip `▢` jest widoczny (iframeable=true), ale iframe nie ładuje się (np. tr.fashionnetwork.com). Dwie opcje naprawy — zacząć od Opcji 1:
  - [ ] **Opcja 1 — szybka (heurystyczna)**: w `onload` gdy `contentDocument === null` próbuj `contentWindow.location.href` — cross-origin rzuca SecurityError (OK), strona błędu przeglądarki zwraca wartość → wywołaj fallback. Brak ryzyka, może nie działać gdy `chrome-error://` też rzuca SecurityError.
  - [ ] **Opcja 2 — właściwa (podwójny request)**: w `_newsContentScan` dodaj nagłówki `Sec-Fetch-Dest: iframe` + `Sec-Fetch-Mode: navigate` + `Sec-Fetch-Site: cross-site` → CDN/WAF odpowiada tak samo jak przy prawdziwym iframe → błąd = `iframeable=false`, badge nie pojawia się. Ryzyko: strony blokujące iframe-requesty dostają status `blocked` i tracimy treść artykułu.

- [x] **[BUG] Skanowanie URLi w panelu News zatrzymuje się w połowie bez komunikatu** — fix v0.23.50: try/catch w onload `_newsContentScan`; gdy `_newsParseContent` rzuca wyjątek, Promise teraz resolves z `{status:'blocked'}` zamiast wisieć wiecznie
- [x] **[BUG] Badge `▢` iframe widoczny na stronach gdzie iframe nie działa** — fix v0.23.50: `iframeEl.onload` + detekcja pustego `contentDocument.body`; auto-switch na rich card przy X-Frame-Options block

## NEWS ANALYTICS — DO NAPRAWY (odkryte sesja 2026-04-28, Sesja 60)

- [x] **[BUG] "Rekordy w bazie" liczy wszystko, precision liczy tylko pozytywne** — fix: karta "Pozytywne URL" z `positive.length`, tooltip na "Rekordy w bazie" — v0.23.76
- [x] **[BUG] Race condition przy równoległych retry push** — fix: `_naRetryPending` sekwencyjny (`retryNext` recursive) — v0.23.76
- [x] **[BUG] CSV export ignoruje filtr projektu** — fix: `_naExportCsv(filters)` z identyczną logiką jak JSON export — v0.23.76

## DO ZROBIENIA — NASTĘPNA SESJA (priorytet)

### AI — implementacja (plan: C:/Users/maksi/work/implementacje/AI_IMPLEMENTATION_PLAN.md)
- [x] **Krok 1: Ustawienia AI** — LS key, helpery, sekcja HTML w ⚙ Ustawienia (klucz API, model, biblioteka promptów, toggle News AI) — v0.23.43
- [x] **Krok 2: AI News Scoring** — keywordContexts w _newsParseContent, _newsAiAnalyze (GM_xmlhttpRequest + prompt caching), badge ⏳/🤖 Relevant/🤖 Not relevant + tooltip, pole "Opis marki" per projekt, prompt uniwersalny z {PROJECT_NAME}/{BRAND_CONTEXT}, dropdown wyboru promptu News — v0.23.46
- [x] **Fix: prompt wydzielony z kodu** — usunięto _NEWS_AI_DEFAULT_SYSTEM; prompt jako plik Tagger/prompts/news_ai_scoring.txt; AI nie startuje bez wybranego promptu z biblioteki — v0.23.47
- [ ] **Krok 3: AI Tagowanie — faza próbkowania** — 10 wzmianek, odkryj assessment values, UI mapowania assessment→tag
- [ ] **Krok 4: AI Tagowanie — pełny run** — getMentionsWithFilters → batche (batchSize=10) → bulkTagMentions; pasek postępu; licznik; fallbacki (401/429/timeout)
- [ ] **Tryb weryfikacji AI** — eksport do XLSX z kolumnami: URL, wynik AI, uzasadnienie, wynik skanera, data, język, typ strony

## UKOŃCZONE (sesja 2026-05-03, Sesja 64)

- [x] **UX: kolumna URL — złota proporcja** — `flex:0 0 38.2%` zamiast `width:270px;flex-shrink:0`; responsywna szerokość ~535px przy panelu 1400px — v0.23.81
- [x] **UX: otwieranie artykułu — nowe okno zamiast nowej karty** — `_newsOpenUrl` przebudowana na `getBoundingClientRect(colPreview)` + `window.screenX/Y`; przycisk `↗` z `<a target="_blank">` na `<button>` z dataset.wired; "Otwórz w nowej karcie" → button z addEventListener po innerHTML — v0.23.81

## UKOŃCZONE (sesja 2026-05-03, Sesja 63)

- [x] **Fix: News scan — concurrency 8→5 + rozróżnienie przyczyn zablokowania URL** — `blockReason`: timeout / http (+ httpStatus) / error / exception; UI zaktualizowane w 4 miejscach (_statusDot, row.title, badge, sidebar) — v0.23.80

## UKOŃCZONE (sesja 2026-04-27, Sesja 59)

- [x] **[BUG] News — adaptacyjny timeout skanowania** — `_scanTimings[]` sliding window, `_getAdaptiveScanTimeout()` (p90×2, min 8s, max 40s), retry przy `ontimeout` z 2× timeout zamiast od razu `blocked`; `onerror` nadal blocked bez retry — v0.23.74

## UKOŃCZONE (sesja 2026-04-26, Sesja 58)

- [x] **NEWS ANALYTICS — Sesja 5: eksport CSV/JSON w zakładce Statystyki** — _naExportCsv (surowe rekordy LS + pending, BOM UTF-8), _naExportJson (output _naCompute z aktywnym filtrem); przyciski ↓ CSV i ↓ JSON w nagłówku statsOverlay — v0.23.72
- [x] **UX: przycisk "Testuj połączenie" w ⚙ Analityka** — GM_xmlhttpRequest GET /repos/{repo}; wyniki inline: ✓ OK / ⚠ brak uprawnień / ✗ 401 / ✗ 404 / ✗ brak połączenia; czyta PAT+repo z inputów live — v0.23.73

## UKOŃCZONE (sesja 2026-04-26, Sesja 57)

- [x] **NEWS ANALYTICS — Sesja 4: zakładka 📊 Statystyki w panelu News** — _naStatCard, _naRenderStats (hero metrics, tabela skanera z paskami, sygnały, rozkład score, AI confusion matrix, sesje), statsOverlay z filtrami okres+kraj, przycisk 📊 w headerze, zakładka w tabsBar, live re-render, wzajemne zamykanie legend↔stats — v0.23.71

## UKOŃCZONE (sesja 2026-04-26, Sesja 56)

- [x] **NEWS ANALYTICS — Sesja 2: GitHub Sync + Ustawienia** — _naGetSettings/_naSaveSettings, _naBuildSessionData, _naAddPending, _naPushSession (GM_xmlhttpRequest, GET+PUT GitHub Contents API), _naRetryPending, _naTryPeriodicPush; wypełnienie stubów visibilitychange i setInterval; push przy closeNewsPanels; sekcja Analityka w ⚙ (toggle + PAT + repo + status) — v0.23.69

## UKOŃCZONE (sesja 2026-04-26, Sesja 55)

- [x] **NEWS ANALYTICS — Sesja 1: Storage + Popup + Hooki danych** — nowa sekcja `// NEWS ANALYTICS`: _naRecord, _naNewSession, _naFlushSkipped, _naFinalizeSession, _naShowConsentIfNeeded; hooki submit (added/duplicate/error/manual_add); visibilitychange + auto-flush co 5 min (stubs dla push); 3 klucze LS (NA_RECORDS, NA_PENDING, NA_CONSENT); debug naDebug() — v0.23.68
- [x] **Plan NEWS_ANALYTICS_PLAN.md** — zaktualizowano sekcję "Timing push" o 3-poziomowe zabezpieczenie przed utratą danych (visibilitychange, auto-flush 5min, pending queue)

## UKOŃCZONE (sesja 2026-04-25, Sesja 54)

- [x] **UX: płynna animacja pasków progresu** — RAF-lerp (`_makeBarSmoother`) zamiast CSS transition; 5 pasków: main panel, News scan, Quick Delete ALL/by-tag, Quick Delete VIEW, Quick Tag — v0.23.67

## UKOŃCZONE (sesja 2026-04-24, Sesja 53)

- [x] **[BUG] Wszystkie artykuły oznaczane jako `blocked` po v0.23.64** — timeout 5s za krótki → większość requestów trafiała do `ontimeout`; fix: przywrócony timeout 8000ms; `_newsAiAnalyze` przeniesione poza try/catch (nie nadpisuje statusu przy błędzie AI) — v0.23.65
- [x] **[BUG] Freeze skanowania powrócił po v0.23.65** — `_newsAiAnalyze` i `renderUrlList()` poza głównym try/catch zabijały workera przy wyjątku; fix: oba opakowane w dedykowane `try/catch` — v0.23.66
- [x] **Tokeny PAT zregenerowane** — publiczny i prywatny, ważność 90 dni (do ~2026-07-24)

## UKOŃCZONE (sesja 2026-04-24, Sesja 52)

- [x] **[BUG] News — skanowanie zatrzymywało się w połowie (np. 42/175)** — brak try/catch w _scanWorker; wyjątek z renderUrlList/AI callback zabijał workera cicho; fix: try/catch owijający przetwarzanie, scanDone++ i renderUrlList() zawsze poza blokiem — v0.23.64
- [x] **[BUG] News — kliknięcie rich card URL zawieszało UI** — infinite loop: stary iframeEl.onload (_iframeFallback) triggerowany przy src='' → znów src='' → pętla renderUrlList(); fix: onload/onerror=null na starcie _newsShowPreview i wewnątrz _iframeFallback — v0.23.64
- [x] **Perf: News skanowanie szybsze** — concurrency 5→8, timeout 8000→5000ms — v0.23.64

## UKOŃCZONE (sesja 2026-04-24, Sesja 51)

- [x] **Fix: cross-delete "Usuń z wszystkich projektów" nie reagował** — handler czytał `_tagCount` z `getKnownProjects()` (brak tej właściwości) zamiast z `bgCache.allProjects[tagId].results`; `state.status === 'idle'` przerywał pętlę po pierwszym batchu — v0.23.63

## UKOŃCZONE (sesja 2026-04-24, Sesja 50)

- [x] **Mitygacja błędu batcha** — `MAX_BATCH_SIZE` 500→50, `TAG_CONCURRENCY` 2→4; fallback przy błędzie na max 50 wzmianek zamiast 500 — v0.23.62

## DO ZROBIENIA — Audit Mode + multi-projekt

- [ ] **Audit Mode nie obsługuje multi-projektu** — ignoruje kolumnę `project_id`, audytuje tylko `state.projectId`. Do rozważenia: pętla per projekt jak w `runMultiProjectTagging`.

## UKOŃCZONE (sesja 2026-04-24, Sesja 49)

- [x] **Multi-projektowe tagowanie z pliku** — kolumna project_id/projekt_id; widget wykrytych projektów (✓ znany / ✕ nieznany); blokada Start dla nieznanych projektów; mapowanie po nazwie tagu; sekwencyjny run per projekt z osobnymi logami; zbiorczy raport — v0.23.61

## UKOŃCZONE (sesja 2026-04-18, Sesja 48)

- [x] **Redesign UI — Sesja B (Fazy 4–8)** — stats row-list (no hero metrics), section hierarchy, action bar reorganizacja, log panel theme-aware, annotator CSS vars — v0.23.55–v0.23.59
- [x] **Redesign UI — Sesja C (Fazy 9–12)** — News CSS vars (submit btn, lang map modal), onboarding bubble theme-aware, ikona ↗, b24t-section-reveal animation — v0.23.60
- [x] **REDESIGN_PLAN.md Fazy 1–12 — wszystkie ukończone** ✓

## UKOŃCZONE (sesja 2026-04-18, Sesja 47)

- [x] **Redesign UI — Priorytet 1 i 2 z REDESIGN_PLAN.md** — Geist font, teal dark mode (oklch), usunięcie section stripe (BAN 1), border-left z logów (BAN 2), primary button solid, stat-card stripe — v0.23.53

## UKOŃCZONE (sesja 2026-04-18, Sesja 46)

- [x] **UI Polish — redesign animacji wg filozofii Emil Kowalski** — 26 zmian CSS+JS: szybsze animacje (modal 0.22s, log 0.08s, progress 0.25s, stat-pop 0.22s, :active 0.08s), GPU-safe side tab (tylko box-shadow), stagger kart URLi i toastów, box-shadow na hover stat-card/file-zone, focus-visible na wszystkich przyciskach, transform-origin na help-tip — v0.23.52

## BATCH ERROR — DIAGNOZA I FIX (sesja 2026-04-20)

> Problem: przy tagowaniu dużych plików (kilkaset wzmianek) sporadycznie pojawia się błąd batcha — po 4 próbach retry odpala się fallback i taguje po jednej wzmiance na raz. Po przejściu na single-mention błędu nie ma. Problem był nieobecny przez kilka dni po wdrożeniu countermeasures, potem pojawił się ponownie mimo braku zmian po naszej stronie.

- [ ] **[DIAGNOZA] Root cause analysis błędu batcha** — MCP monitoring niekonkluzywny (plugin używa `origFetch`, nie da się interceptować external wrapperem). Jeśli błąd wraca po v0.23.62: dodać `console.log` wewnątrz retry `bulkTagMentions`, deploy debug, run na dużym pliku, revert.

- [x] **[PLAN B] Mniejsze batche + równoległość** — `MAX_BATCH_SIZE` 500→50, `TAG_CONCURRENCY` 2→4 — v0.23.62. Fallback per batch był już lokalny; zmiana redukuje koszt fallbacku 10×.

- [x] **[PLAN B] Lepszy fallback dla wadliwych batchów** — fallback był już lokalny per batch (nie zamrażał całego workflow) — potwierdzono przy analizie kodu w Sesji 50.

## UKOŃCZONE
> Zarchiwizowane w TASKS_ARCHIVE.md
