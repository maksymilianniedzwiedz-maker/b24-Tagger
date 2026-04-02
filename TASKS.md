# B24 TAGGER — TASKS

## KRYTYCZNE (blokują wersję stable)

- [ ] Overall stats: kafelek "pozostało do otagowania" w Annotators Tab — total + per projekt, z paskiem postępu i % ukończenia; widok nie znika podczas odświeżania — dane aktualizują się na bieżąco, przy projektach których dane się ładują pokazuje się mały wskaźnik ładowania
- [ ] Overall stats: tryb "domykania miesiąca" — gdy bieżąca data jest już w następnym miesiącu a widok pokazuje jeszcze staty z poprzedniego:
  - Projekty z zerową liczbą pozostałych wzmianek oznaczają się automatycznie jako Completed (zielony kolor, przekreślenie rzędu, znaczek ukończenia)
  - Stan Completed jest trwały — przy następnym odświeżeniu projekt pozostaje ukończony i nie zlicza nowo wpadających wzmianek; celowo ignoruje wzmianki dodawane retroaktywnie przez opóźniony crawler
  - Widok pozostaje na statach z poprzedniego miesiąca dopóki wszystkie projekty nie są Completed
  - Pojawia się przycisk manualnego zakończenia miesiąca — widoczny tylko gdy jest już nowy miesiąc ale widok wciąż pokazuje poprzedni; pozwala przejść dalej bez czekania na Completed wszystkich projektów
- [ ] Naprawienie funkcji czyszczenia plikiem
- [ ] Równoległe fetche + optymalizacja batchowania — priorytetowy task; przeprowadzić stress testy żeby znaleźć realne limity (ile równoległych requestów, jak duże batche) — testować serio ale bez absurdalnych wartości żeby nie wywołać czerwonej flagi w systemie Brand24; wyniki zapisać do TOKEN_LOG.md jako baseline
- [ ] Zbudowanie fallbacków żeby nie blokować workflow wtyczki
- [ ] Dynamiczne rozmiary elementów UI we wszystkich panelach
- [ ] Naprawić wyświetlanie się changeloga — pojawia się randomowo

## WAŻNE (wtyczka działa bez tego, ale warto)

- [ ] Z-index: aktywny/przesuwany panel zawsze on top
- [ ] News: poprawić działanie trzymających się razem paneli

## NICE TO HAVE (jeśli zostanie czas w pierwszej stable)

- [ ] Ulepszenie UI dla wygody użytkownika — do rewizji
- [ ] Kompleksowa rewizja słownictwa w całej wtyczce
- [ ] Onboarding: możliwość pominięcia, poprawki tekstów, tutorial dla nowych elementów, osobny onboarding dla funkcji annotatorskich
- [ ] Tryb pomocy: brakujące opisy, rewizja słownictwa, poprawki wyświetlania

## UKOŃCZONE
> Tutaj CC przenosi ukończone taski z datą ukończenia
