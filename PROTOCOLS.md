# B24 TAGGER — PROTOCOLS
> Wczytaj ten plik tylko gdy task wymaga: cofania zmian, przekazania do Cursora, lub przeglądu auto-optymalizacji.

## KIEDY SUGEROWAĆ PRZEŁĄCZENIE NA CURSOR
Jeśli użytkownik zleca ci zadanie które lepiej pasuje do Cursora, powiedz mu:
"Ten task lepiej zrobić w Cursorze — otwórz Cursor w folderze i24_analytics"

Sugeruj Cursor gdy:
- Task wymaga akceptacji zmian krok po kroku
- Task jest krótki i konkretny
- Użytkownik chce widzieć diff każdej zmiany
- Zbliżasz się do limitu tygodniowego CC

## KIEDY ZOSTAĆ W CC
Zostanie gdy:
- Task jest długi i można go puścić bez nadzoru
- Trzeba zrobić deploy, push lub stress testy
- Trzeba zaktualizować pliki workflow
- Użytkownik explicite prosi o pracę w CC

## PROTOKOŁY WORKFLOW

### Cofanie zmian
Jeśli użytkownik chce cofnąć zmianę którą zrobiłeś — powiedz mu dokładnie jaką komendę wpisać, np:
- Cofnięcie ostatniego commita (zachowuje zmiany lokalnie): `git revert HEAD`
- Powrót do konkretnej wersji pliku: `git checkout <hash> -- Tagger/b24tagger.user.js`
- Sprawdzenie historii commitów: `git log --oneline -10`
Nigdy nie mów tylko "przepraszam" — zawsze daj konkretna komendę do wykonania.

### Gdy nie możesz kontynuować taska
Jeśli napotkasz coś w kodzie czego nie rozumiesz lub nie możesz bezpiecznie wykonać:
- ZATRZYMAJ SIĘ — nie próbuj kontynuować na ślepo
- Opisz użytkownikowi prosto co jest problemem i dlaczego się zatrzymałeś
- Zaproponuj dwie opcje: pominąć ten element i przejść dalej, lub omówić rozwiązanie
- Nigdy nie rób zmian w kodzie jeśli nie jesteś pewny co robisz

### Przekazywanie zadań do Cursora
Jeśli zadanie lepiej pasuje do Cursora (wymaga akceptacji zmian krok po kroku, jest krótkie i konkretne, użytkownik chce widzieć diff) — zapytaj:
"Ten task lepiej wykonać w Cursorze, dlatego że [wyjaśnienie]. Czy się zgadzasz?"

Jeśli użytkownik powie tak — wygeneruj gotowy prompt do wklejenia w Cursor Composer zawierający:
- Opis zadania
- Relevantne sekcje kodu z numerami linii
- Hard rules których musi przestrzegać
- Konkretne instrukcje co zrobić
- Informację żeby nie pushował — deploy zostawia CC

Użytkownik kopiuje prompt i wkleja w Cursor Composer.

## PROTOKÓŁ AUTO-OPTYMALIZACJI
Po każdym zakończonym tasku wykonaj automatycznie:
1. Sprawdź /context — zaloguj do TOKEN_LOG.md
2. Jeśli widzisz w kodzie sekwencyjne pętle z await → dodaj do TASKS.md jako task "Parallel fetch: [nazwa funkcji]"
3. Jeśli widzisz zduplikowaną logikę w dwóch miejscach → dodaj do TASKS.md jako "Refaktor: [opis]"
4. Jeśli jakaś sekcja CLAUDE.md była niepotrzebnie wczytana do tego taska → zaznacz to mentalnie i przy następnym spotkaniu organizacyjnym zaproponuj jej przeniesienie do osobnego pliku

Raz na 3 sesje (przy spotkaniu organizacyjnym) sprawdź:
- Czy CLAUDE.md nie urósł o nowe sekcje które można by wydzielić?
- Czy TOKEN_LOG.md pokazuje rosnące zużycie bez powodu?
- Czy MAPA SEKCJI jest aktualna (po dużych refaktorach numery linii się przesuwają)?
