# B24 TAGGER — TASKS

## KRYTYCZNE (blokują wersję stable)

- [x] Naprawienie funkcji czyszczenia plikiem
- [x] Równoległe fetche buildUrlMap — DONE v0.21.6; stress test 256 stron potwierdził 0% duplikatów przy c=1/2/3/5; MAP_FETCH_CONCURRENCY=3 jako default (3.3× szybciej), TOKEN_LOG zaktualizowany
- [x] Równoległe fetche w całym kodzie — przejrzeć wszystkie miejsca gdzie są sekwencyjne pętle z await (poza buildUrlMap) i wprowadzić batch/parallel tam gdzie to możliwe (np. fetchAllIds, _fetchOverallStats, inne fetche w delete engine i stats)
- [x] Stress test batchowania + optymalizacja MAX_BATCH_SIZE — po wdrożeniu parallel fetches zbadać czy większe batche (np. 100, 200) są bezpieczne; połączyć z concurrency dla maksymalnej wydajności
- [ ] Zbudowanie fallbacków żeby nie blokować workflow wtyczki
- [x] Dynamiczne rozmiary elementów UI we wszystkich panelach
- [ ] Naprawić wyświetlanie się changeloga — pojawia się randomowo
- [ ] **Sprawdzić batch/concurrency w delete** — czy ustawienia faktycznie mają zastosowanie we wszystkich funkcjach: usuń po tagu, usuń wyświetlane wzmianki, quick tag, etc.

## WAŻNE (wtyczka działa bez tego, ale warto)

- [ ] **News: skanowanie treści strony w poszukiwaniu słów kluczowych** — obecnie wtyczka sprawdza słowa kluczowe tylko w URL-u. Problem: news może być relewantny bo mówi o H&M w treści, ale URL tego nie zdradza. Rozwiązanie: w procesie ładowania listy URL-i wtyczka ma szybko otwierać każdą stronę w tle (background fetch lub ukryty iframe/tab), przeszukiwać jej treść pod kątem wariantów słów kluczowych (np. "h&m", "h & m", "hm.com", "hennes & mauritz") i oznaczać URL jako prawdopodobnie relewantny jeszcze zanim annotator go otworzy. Priorytet: dokładność rozpoznawania relewantnych newsów przed manualnym przeglądem.



- [ ] Z-index: aktywny/przesuwany panel zawsze on top
- [ ] News: poprawić działanie trzymających się razem paneli

## NICE TO HAVE (jeśli zostanie czas w pierwszej stable)

- [ ] Ulepszenie UI dla wygody użytkownika — do rewizji
- [ ] Kompleksowa rewizja słownictwa w całej wtyczce
- [ ] Onboarding: możliwość pominięcia, poprawki tekstów, tutorial dla nowych elementów, osobny onboarding dla funkcji annotatorskich
- [ ] Tryb pomocy: brakujące opisy, rewizja słownictwa, poprawki wyświetlania

## UKOŃCZONE
> Zarchiwizowane w TASKS_ARCHIVE.md
