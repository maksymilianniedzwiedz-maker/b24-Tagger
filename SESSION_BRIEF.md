# B24 TAGGER — SESSION BRIEF

## Aktualna wersja
- Wersja: **0.24.26** (po deploy tej sesji)
- Następna: 0.24.x (patch)

## Stan wtyczki
- Branch roboczy (prywatne): `I24-maks-czyszczenie`
- Branch publiczny: `experimental` + `main`
- Zsynchronizowany: experimental (0.24.25 na starcie sesji, 0.24.26 po deploy)

## Co zrobiono w tej sesji (Sesja 86 — 2026-05-14)

### v0.24.25 (z końca poprzedniej sesji, deploy na początku tej)
- fix: dup-check cross-domain auth (tokenHeaders GM) + hostname gate
- Dodano _isBrand24Host check — token przechwytywany tylko z brand24.com/pl

### v0.24.26 — B24Bridge — centralny system danych cross-domain

**Nowa sekcja: B24BRIDGE (linie 467–613)**
- Jeden klucz GM `b24t_bridge` zastępuje 4 rozproszone klucze (`b24t_token_headers`, `b24t_brand24_base`, `b24t_projects_mirror`, `b24t_project_names_mirror`, `b24t_mini_last_project`)
- `B24Bridge.token` — zapis/odczyt auth headers z TTL 8h
- `B24Bridge.projects` — słownik projektów z filtrowaniem fallbacków
- `B24Bridge.lastProject` — ostatnio wybrany projekt cross-domain
- `GM_addValueChangeListener` — reaktywny: gdy brand24.com zapisze token, inne karty są powiadamiane natychmiast (nowy `@grant`)
- Jednorazowa migracja — czyta stare klucze GM przy pierwszym uruchomieniu, zapisuje do bridge (bez ingerencji użytkownika)

**Migracja wszystkich callerów:**
- `_gmGetProjects`, `_gmSaveProjects` → delegują do B24Bridge.projects
- `_gmGetProjectNames`, `_gmSaveProjectNames` → delegują do B24Bridge.projects
- `_pnSet` — update nazwy projektu przez B24Bridge.projects.update()
- Token capture (origFetch interceptor) → B24Bridge.token.save()
- `_newsCheckTagDodane` base URL → B24Bridge.token.base()
- Przycisk "Reset i przebuduj" → B24Bridge.projects.setAll()
- `b24t_mini_last_project` → B24Bridge.lastProject.get/set()
- ANNOTATOR TOOLS project name read/update → B24Bridge.projects
- `_customDupCheck` headers/base → B24Bridge.token.headers()/base()
- Jeśli B24Bridge.token.isValid() === false → pokazuje "otwórz brand24.com — token załaduje się automatycznie"

**Reaktywny dupcheck:**
- `B24Bridge.onChange('custom-dupcheck', ...)` w INIT — gdy brand24.com zapisze token (inny tab), auto-ponawia dup-check w panelu Niestandardowe bez reloadu

**CLAUDE.md zaktualizowane:**
- Nowa HARD RULE: cross-domain dane przez B24Bridge, nie bezpośrednio GM
- Mapa sekcji zaktualizowana do 17 149 linii (v0.24.26)

## Co przechodzi na następną sesję

### Priorytet 1: Pozostałe punkty planu floating panel Niestandardowe
- **[5] Informacja zwrotna po submicie** — link do dodanej wzmianki w Brand24 (parsowanie ID z odpowiedzi)
- **[8] Redesign UI** — styl main panelu: droplet avatary, cienie, kolory CSS vars

### Priorytet 2: Bug — badge ⏳ AI... wisi na stałe
- Sprawdzić w Network Monitor czy request wychodzi do api.anthropic.com
- Przetestować klucz API nowym przyciskiem "Testuj klucz API"

### Priorytet 3: Tech-debt — drag selector headera
- Drag używa `panelMain.querySelector('div')` — fragile; dodać `id="b24t-news-panel-header"` do headera w `_buildNewsPanels`

### Priorytet 4: Rozbudowa B24Bridge
- Rozważyć: `B24Bridge.token.onRefresh(cb)` — dedykowane zdarzenie odświeżenia tokenu
- Rozważyć: TTL token → sprawdź realną długość życia JWT Brand24 (teraz 8h hardcoded)
- Możliwość: B24Bridge.debug() widoczny w Debug Bridge panelu

## Uwagi
- CHANGELOG_FALLBACK: sprawdź czy aktualne (powinno mieć 0.24.26 jako najnowszy)
- PAT publiczny i prywatny zregenerowane 2026-04-24, ważne do ~2026-07-24
- Plan panelu Niestandardowe: memory `project_custom_mention_panel.md`
- Prompt News AI: `Tagger/prompts/news_ai_scoring.txt`
- **B24Bridge — architektura:**
  - `b24t_bridge` — jeden klucz GM, JSON, zawiera token + projects + lastProject
  - `GM_addValueChangeListener` — reaktywne powiadomienia między kartami (`remote: true` filtr)
  - Blok migracji (linia 589) — jednorazowy, czyta stare klucze jeśli `_v === 0`
  - Token TTL: 8h od savedAt
  - Fallback isFallback(): nazwa < 3 znaki, 'Brand24', 'Panel Brand24', 'Project/Projekt NNN'
