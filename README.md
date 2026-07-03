# 🦦 Otter Monitor

System monitoringu sond pomiarowych z alertami e-mail, zaprojektowany pod wdrożenie na
[Railway](https://railway.com). Cyklicznie odpytuje API sond i wysyła powiadomienia, gdy:

- **sonda przestaje przesyłać dane** (konfigurowalny limit czasu per sonda),
- **pomiar przekroczy ustalony próg** (reguły min/max per sonda i per pomiar).

Gdy sytuacja wraca do normy, system wysyła osobny e-mail „powrót do normy".
Alerty są deduplikowane — jeden e-mail na początek problemu (opcjonalnie cykliczne
przypomnienia), jeden na jego koniec.

## Funkcje

- **Panel WWW** (po polsku): pulpit z bieżącym stanem sond, wykresy historii pomiarów
  (6 h / 24 h / 7 dni / 30 dni), zarządzanie regułami progowymi, historia alertów,
  ustawienia powiadomień. Tryb jasny i ciemny, wersja mobilna.
- **Bezpieczny dostęp**: logowanie e-mail + hasło (bcrypt), sesje HttpOnly/SameSite,
  limit prób logowania, nagłówki bezpieczeństwa (helmet, CSP), cała aplikacja i API
  dostępne wyłącznie po zalogowaniu.
- **Elastyczny parser**: automatycznie wykrywa kolumnę czasu i wszystkie pola liczbowe
  w odpowiedzi API — nowe pomiary pojawiają się w panelu bez zmian w kodzie.
  W panelu jest podgląd surowej odpowiedzi API do diagnostyki.
- **Baza SQLite** — bez zewnętrznych zależności; wystarczy wolumen Railway.

## Wdrożenie na Railway — krok po kroku

1. **Utwórz projekt**: na [railway.com](https://railway.com) → *New Project* →
   *Deploy from GitHub repo* → wybierz to repozytorium. Railway sam wykryje Node.js
   i użyje `railway.json`.

2. **Podepnij wolumen** (żeby baza przeżywała deploye): w ustawieniach serwisu →
   *Volumes* → *Add Volume* → mount path: `/data`.

3. **Ustaw zmienne środowiskowe** (zakładka *Variables*):

   | Zmienna | Wartość | Uwagi |
   |---|---|---|
   | `ADMIN_EMAIL` | twój e-mail | login do panelu i domyślny adresat alertów |
   | `ADMIN_PASSWORD` | silne hasło | min. 8 znaków |
   | `DATA_DIR` | `/data` | ścieżka wolumenu z kroku 2 |
   | `SENSOR_TOKEN` | token API sond | np. `vqqPass89` |
   | `SMTP_HOST` | np. `smtp.gmail.com` | serwer poczty wychodzącej |
   | `SMTP_PORT` | `587` | `465` przy `SMTP_SECURE=true` |
   | `SMTP_USER` | login SMTP | |
   | `SMTP_PASS` | hasło SMTP | dla Gmaila: [hasło aplikacji](https://myaccount.google.com/apppasswords) |
   | `MAIL_FROM` | `Otter Monitor <adres@...>` | nadawca alertów |

   Pełna lista (w tym `SENSOR_URLS`, `POLL_INTERVAL_SECONDS`, `SESSION_SECRET`,
   `APP_URL`) — w [.env.example](.env.example).

4. **Wygeneruj domenę**: *Settings* → *Networking* → *Generate Domain*.
   Wygenerowany adres ustaw dodatkowo jako `APP_URL`, żeby e-maile zawierały
   działający link „Otwórz panel".

5. **Zaloguj się** pod wygenerowanym adresem danymi z `ADMIN_EMAIL` / `ADMIN_PASSWORD`
   i skonfiguruj reguły progowe w zakładce **Reguły**. W **Ustawieniach** możesz dodać
   kolejnych adresatów alertów i wysłać testowy e-mail.

> **Wskazówka dot. poczty:** zamiast Gmaila możesz użyć dowolnego SMTP —
> np. [Resend](https://resend.com) (`smtp.resend.com`, user `resend`, pass = klucz API)
> albo [Brevo](https://brevo.com). Ważne, żeby nadawca był zgodny z domeną/kontem SMTP.

## Uruchomienie lokalne

```bash
npm install
cp .env.example .env   # uzupełnij wartości
node --env-file=.env server.js
# panel: http://localhost:3000
```

## Jak działa wykrywanie problemów

- Co `POLL_INTERVAL_SECONDS` (domyślnie 5 min) system pobiera dane wszystkich sond.
- **Brak danych**: jeśli najnowszy rekord sondy jest starszy niż jej limit
  (domyślnie 30 min, zmienisz w karcie sondy na pulpicie → „Ustawienia"), wysyłany
  jest alert. Obejmuje to też awarie API (błąd HTTP, timeout, niepoprawny JSON).
- **Progi**: każda reguła porównuje ostatnią wartość wskazanego pomiaru z zakresem
  min/max. Wyjście poza zakres → alert; powrót → e-mail „powrót do normy".
- **Przypomnienia**: w Ustawieniach możesz włączyć cykliczne przypomnienia
  o trwających alertach (co N minut).

## Struktura projektu

```
server.js          # HTTP, API, autoryzacja tras
src/config.js      # zmienne środowiskowe
src/db.js          # schemat SQLite
src/parser.js      # elastyczny parser odpowiedzi API sond
src/poller.js      # cykliczne pobieranie danych
src/alerts.js      # silnik alertów i deduplikacja powiadomień
src/mailer.js      # wysyłka e-maili (nodemailer)
src/auth.js        # sesje, bcrypt, magazyn sesji w SQLite
public/            # frontend (panel + logowanie)
```
