# B24 TAGGER — SESSION BRIEF

## Aktualna wersja
- Wersja: **0.21.26**
- Następna: 0.22.0 (nowa sesja)

## Stan wtyczki
- Branch roboczy (prywatne): `I24-maks-czyszczenie`
- Branch publiczny: `experimental`
- Zsynchronizowany: tak (deploy 0.21.26 wykonany)

## Co zrobiono w tej sesji (0.21.x)

### Główne zmiany
- **Quick Delete batch fix** (v0.21.26) — batch deletowania używa teraz `_deleteBatch` zamiast hardcoded `5`; ustawienie w UI działa poprawnie; `DEL_BATCH_DEFAULT` 10→25
- **Skill `/log-session`** — nowa komenda do zamykania sesji (aktualizuje workflow files + push)
- **Reorganizacja plików workflow** — PROTOCOLS.md, TASKS_ARCHIVE.md, .claudeignore; przepisana sekcja DEPLOY w CLAUDE.md

### Wcześniejsze deploye sesji (0.21.16–0.21.25)
- Flex layout audit, dynamic panel zoom, responsywny UI, parallel fetches, buildUrlMap sliding window pool

## Co przechodzi na następną sesję
- Fallbacki żeby nie blokować workflow wtyczki
- Naprawić wyświetlanie changeloga (pojawia się randomowo)
- News: skanowanie treści strony pod kątem słów kluczowych
- Z-index: aktywny panel zawsze on top
- News: panele trzymające się razem

## Uwagi
- deploy.py nadal istnieje lokalnie jako backup, ale nowy workflow używa git bezpośrednio
- CLAUDE.md skrócony: PROTOCOLS i TASKS_ARCHIVE wydzielone do osobnych plików
