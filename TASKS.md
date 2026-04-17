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
- [ ] **News: integracja AI API (Claude Haiku 4.5) do analizy relevancji** — użytkownik podaje własny klucz API w ustawieniach; AI analizuje tylko URLe już odfiltrowane przez plugin (keyword match); zakres: (1) ocena relevancji 1–5 z krótkim uzasadnieniem widocznym jako badge, (2) lepszy dobór snippetu do auto-fill formularza, (3) ekstrakcja daty gdy parser zawodzi; koszt ~$0.001/URL → ~$0.05 za typową sesję 50 URLi
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
- [ ] **News panel — dolny "Importuj URLe" bez odróżnienia od górnego** — oba przyciski robią to samo; rozważyć tooltip "Otwórz import URLi" lub lekką zmianę stylu (np. ikona zamiast `+`) żeby były wizualnie spójne a nie identyczne

## DO ZROBIENIA — NASTĘPNA SESJA (priorytet)

### AI — implementacja (plan: C:/Users/maksi/work/implementacje/AI_IMPLEMENTATION_PLAN.md)
- [x] **Krok 1: Ustawienia AI** — LS key, helpery, sekcja HTML w ⚙ Ustawienia (klucz API, model, biblioteka promptów, toggle News AI) — v0.23.43
- [ ] **Krok 2: AI News Scoring** — rozszerzenie `_newsParseContent` o `keywordContexts`; `_newsAiAnalyze` z GM_xmlhttpRequest + prompt caching; badge w liście URLi (pending/relevant/not-relevant) + tooltip; counter dzienny
  - **Prompt uniwersalny** — szablon z `{PROJECT_NAME}` (auto z `_pnResolve`) i `{BRAND_CONTEXT}` (pole "Opis marki" w panelu News); użytkownik wkleja prompt raz do biblioteki i wypełnia tylko opis marki per-projekt
  - **Pole "Opis marki"** — małe textarea w panelu News widoczne gdy AI włączone; persystuje w localStorage jako `b24t_news_ai_brand_ctx_{projectId}`; podmieniane w prompt przed wysłaniem do API
- [ ] **Krok 3: AI Tagowanie — faza próbkowania** — 10 wzmianek, odkryj assessment values, UI mapowania assessment→tag
- [ ] **Krok 4: AI Tagowanie — pełny run** — getMentionsWithFilters → batche (batchSize=10) → bulkTagMentions; pasek postępu; licznik; fallbacki (401/429/timeout)
- [ ] **Tryb weryfikacji AI** — eksport do XLSX z kolumnami: URL, wynik AI, uzasadnienie, wynik skanera, data, język, typ strony

### News — poprawki panelu (odkryte Sesja 39)
- [ ] **Lista URLi: rozmiar i czytelność** — większa proporcja sekcji listy w layoucie, większe chipy/badże (padding, font-size)
- [ ] **Fix detekcji iframeable** — badge `▢` pojawia się mimo faktycznej blokady; poprawić logikę lub zwiększyć ostrożność przy oznaczaniu jako iframeable
- [ ] **Rich preview: więcej danych** — dodać autora, liczbę słów, strefę artykułu, wynik scoringu, matched keywords
- [ ] **Lepsza detekcja daty** — regex na widoczny tekst w treści artykułu (np. "Published: 12 April 2025") jako fallback gdy meta/JSON-LD zawodzi

- [ ] **News kampanijne — import i skanowanie URLi z kampanii** — nowa zakładka lub sekcja w panelu News dedykowana wzmiankom kampanijnym; analogiczny workflow do standardowego News: wczytanie listy URLi (paste/plik), content scan, scoring, lista z badżami; różnica: osobna przestrzeń wyników i eksport do formularza dodawania wzmianki kampanijnej zamiast standardowej.

## UKOŃCZONE
> Zarchiwizowane w TASKS_ARCHIVE.md
