# Stay Cold · Creative Review v3 — AI Shooting Learnings

Review-Tool für AI-Photoshoot-Bilder: Figma-Board → Airtable → Swipe-Review-App → Learnings (Rollup + bestätigte Flags).

## Architektur

```
Figma-Board "scenes for approval"          (Quelle: Flos AI-Shootings)
        │  POST /sync
        ▼
Supabase Edge Function "creative-review"   (Projekt: ekiwwjzmiywaxvxdhzat, eu-west-2)
        │  liest/schreibt
        ▼
Airtable "Creative Review v3 — AI Shooting Learnings"  (appKktIMvTU1AqOEN)
  Tabellen: Models · Expressions · Depictions · Assets · Reviews
        ▲
        │  GET /queue · POST /review · POST /unreview
Review-App (index.html in diesem Repo, gehostet via GitHub Pages)
```

- **API-Basis:** `https://ekiwwjzmiywaxvxdhzat.supabase.co/functions/v1/creative-review`
- **Auth:** Header `x-review-key` (Secret `REVIEW_KEY` in Supabase). Die App fragt den Key einmalig ab bzw. nimmt ihn per `?key=` aus der URL und speichert ihn im Gerät.
- **Wichtig:** Supabase liefert auf `*.supabase.co` kein HTML aus (text/html wird zu text/plain umgeschrieben, dokumentierte Sicherheitsmaßnahme). Deshalb liegt die App hier im Repo und läuft über GitHub Pages — die API-Calls gehen an Supabase (CORS offen).

## Dateien in diesem Repo

| Datei | Zweck |
|---|---|
| `index.html` | Die komplette Review-App (Single File, keine Build-Schritte) |
| `creative-review-function.ts` | Quellcode der Supabase Edge Function (Referenz/Versionierung — deployt wird über Supabase, nicht von hier). Auto-Sync: pg_cron-Job `creative-review-board-mirror`, alle 2 h |
| `README.md` | Diese Doku |

## Rollen & Reviewer

| Reviewer | Rolle | Wirkung |
|---|---|---|
| Max | **Decision** | Zählt. Schreibt den Asset-Status fort (Passt/Abweichung). |
| Jonas | Shadow | Kalibrierung. Ändert nichts am Status. |
| Flo | Shadow | Kalibrierung. Ändert nichts am Status. |

Jeder Reviewer hat eine eigene Queue (`/queue?reviewer=Name`) — alle bewerten dieselben Assets unabhängig. Aus der Übereinstimmung entsteht die Agreement-Rate für die Freigabe-Übergabe.

**Bestätigte Kritik:** Markieren Decision **und** mindestens ein Shadow dieselbe Achse desselben Assets als Off, gilt die Kritik als bestätigt. `GET /rollup` liefert diese Fälle im Feld `flags` — das ist die Basis, um Models und Szenen aus den Karteien zu werfen.

## API-Routen

| Route | Zweck |
|---|---|
| `POST /sync?limit=N` | Figma-Board ziehen, neue Bilder als Assets anlegen (Dedupe über Figma Node ID). Benannte Sections/Frames/Groups im Board = Szenen-Cluster; lose Bilder werden räumlich geclustert. |
| `GET /queue?reviewer=Name` | Offene Assets für diese Person |
| `POST /review` | Ein Review speichern |
| `POST /unreview` | Review zurücknehmen (App: „Letztes zurücknehmen") |
| `GET /vocab` / `POST /vocab` | Vokabular lesen / neuen Eintrag anlegen (model/expression/depiction) |
| `POST /assign` | Model/Expression/Depiction pro Cluster auf alle Assets erben |
| `GET /rollup` | Trefferquoten pro Entität + bestätigte Kritik-Flags |
| `GET /layout` · `GET /probe` · `GET /render` | Diagnose |

Alle Aufrufe mit Header `x-review-key: <REVIEW_KEY>`.

## Standard-Prozesse

**Neue Bilder reviewen (nach jedem AI-Shooting):**
1. Flo legt die Bilder in die Board-Spalte „scenes for approval" — idealerweise **pro Szene eine benannte Section** (der Name wird zum Cluster in Airtable). Alte Pakete löscht Flo nach Feedback vom Board.
2. **Automatisch:** Der Supabase-Cron `creative-review-board-mirror` synct alle 2 Stunden (Minute 20) — neue Bilder erscheinen ohne Zutun in der App-Queue. **Sofort:** Skill `/creative-review-sync` in Claude starten (synct bis „Nichts Neues" und meldet Queue-Stände) oder manuell `curl -X POST "<API>/sync?limit=100" -H "x-review-key: <KEY>"`.
3. Max, Jonas, Flo reviewen in der App. Neue Fail-Gründe entstehen über das Freitext-Feld direkt in der App.

**Baseline (Übersprungenes):** Board-Bilder, die außerhalb der App gefeedbackt wurden, kann `POST /baseline` einfrieren — der Sync ignoriert sie dann dauerhaft (gespeichert in Supabase-Tabelle `sync_baseline`). Am 31.07.2026 wurden so die 227 Rest-Bilder des ersten Pakets ausgenommen (Feedback lief via Slack).
4. Learnings ziehen: `GET /rollup` → `flags` mit Max' bestätigten Kritikpunkten durchgehen, betroffene Models/Szenen in den Karteien auf „Bedingt"/„Aussortiert" setzen.

**App ändern:** `index.html` in diesem Repo editieren/ersetzen → GitHub Pages deployt automatisch (~1 Min). Kein Build nötig.

**Backend ändern:** Funktion in Supabase deployen (Dashboard oder via Claude). Danach die Kopie `creative-review-function.ts` hier im Repo aktualisieren, damit Repo = Realität.

**Key rotieren:** In Supabase → Edge Functions → Secrets → `REVIEW_KEY` neu setzen. Nur ASCII-Zeichen verwenden (Umlaute funktionieren in HTTP-Headern nicht). Danach allen Reviewern die neue URL mit `?key=` schicken.

## Bekannte Stolperfallen

- **Figma-Rate-Limit (429):** Das Full-File-Lesen des großen Boards ist teuer. Bei 429 nicht hämmern — das Fenster kann über eine Stunde dauern. Ausweich-Token liegt als Secret `FIGMA_TOKEN_II` (hat im Code Vorrang vor `FIGMA_TOKEN`).
- **Airtable-Attachment-URLs laufen ab** (~2 h). Die App lädt die Queue live, daher unkritisch — aber Bild-URLs nie irgendwo statisch ablegen.
- **Sync-Limit:** Edge Functions haben 150 s Idle-Timeout. `?limit=100` pro Lauf ist sicher; einfach wiederholen.

## Airtable-Referenz

- Base: `appKktIMvTU1AqOEN` — Tabellen: Models `tblRUZ99u9ApeOdMu`, Expressions `tbl1RQkCERHpz8Nug`, Depictions `tbly4pX6YMtAfHYyz`, Assets `tbl2rpHgH2D0hebQ4`, Reviews `tbltxjO4jLxWbqTRy`
- Figma-Board: `pPSeVQKzDjuHv3Gf8wDp3u`, Spalte „scenes for approval"

Die Fail-Tag-Vorschläge in der App basieren auf Max' Original-Feedback (Gruppen-DM Jonas/Max/Flo, Static-Reviews 27.07. + 31.07.2026) und dem Visual Direction Sheet V2.1.
