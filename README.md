# Stay Cold · Creative Review — Multi-Format Learnings

Review-Tool für AI-Creatives: Figma-Board → Airtable → Swipe-Review-App → Learnings (Rollup + bestätigte Flags). Formate: AI-Shooting-Statics, Memes — weitere folgen.

## Architektur

```
Figma-Board, Section "Creative Review" (Node 3156:787)
  oben "AI Shooting Assets for Approval" · unten "Social Media Content for Approval" (Memes, Band photos)
        │  POST /sync?format=…   (nur dieser Teilbaum wird geladen — ~128 KB statt ~50 MB Full-File)
        ▼
Supabase Edge Function "creative-review"   (Projekt: ekiwwjzmiywaxvxdhzat, eu-west-2)
        │  liest/schreibt
        ▼
Airtable  statics: "Creative Review v3" (appKktIMvTU1AqOEN)
          memes:   "Creative Review — Memes" (appW9B8mQaT7krmg2)
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
| `creative-review-function.ts` | Quellcode der Supabase Edge Function (Referenz/Versionierung — deployt wird über Supabase, nicht von hier) |
| `README.md` | Diese Doku |

## Formate

Jedes Review-Format hat einen eigenen Board-Bereich (große Text-Überschrift), eine eigene Airtable-Base und eigene Review-Achsen/Tags. Umschalter in der App (STATICS | MEMES). API-Aufrufe: `?format=statics|memes` (Default statics).

| Format | Board-Überschrift | Airtable-Base | Achsen | Prefix |
|---|---|---|---|---|
| statics | „AI Shooting Assets for Approval" | `appKktIMvTU1AqOEN` | Ausdruck / Model / Produktdarstellung | AST |
| memes | „Memes" (unter „Social Media Content for Approval") | `appW9B8mQaT7krmg2` | Witz / Brand / Umsetzung | MEM |

Die Bereichs-Erkennung ist geometrisch: Überschrift gefunden → rechte Grenze = nächste Überschrift **in derselben Zeile** (z. B. die Model-Kartei rechts neben den Statics), untere Grenze = nächste Überschrift **darunter** (z. B. „Social Media Content" unter den AI-Shootings). Kleine Labels (< 500 Board-Einheiten hoch) zählen nicht als Überschrift.

**Neues Format hinzufügen:** Bereich mit großer Überschrift in Figma anlegen (im „Creative Review"-Node) → Airtable-Base klonen (Assets + Reviews, Achsen-Felder anpassen) → `FORMATS`-Eintrag in der Edge Function + `FMT`-Eintrag in `index.html` → Airtable-Token um die neue Base erweitern. (Für „Band photos" ist die Board-Überschrift schon da.)

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
| `POST /sync?limit=N&format=F` | Board-Bereich ziehen, neue Bilder als Assets anlegen (Dedupe über Figma Node ID). Benannte Sections/Frames/Groups = Szenen-Cluster; lose Bilder werden räumlich geclustert. |
| `GET /queue?reviewer=Name&format=F` | Offene Assets für diese Person |
| `POST /review?format=F` | Ein Review speichern |
| `POST /unreview?format=F` | Review zurücknehmen (App: UNDO) |
| `GET /vocab` / `POST /vocab` | Vokabular lesen / neuen Eintrag anlegen (model/expression/depiction) |
| `POST /assign` | Model/Expression/Depiction pro Cluster auf alle Assets erben |
| `GET /rules` | Creative-Regeln (Fest + Vorschlag) |
| `GET /failtags?format=F` | Alle bekannten Fail-Tag-Optionen pro Achse (geteilte Freitext-Tags) |
| `POST /baseline?format=F` | Aktuellen Board-Stand einfrieren (Sync überspringt ihn) |
| `GET /rollup` | Trefferquoten pro Entität + bestätigte Kritik-Flags |
| `GET /layout` · `GET /probe` · `GET /render` | Diagnose |

Alle Aufrufe mit Header `x-review-key: <REVIEW_KEY>`.

## Standard-Prozesse

**Neue Bilder reviewen (nach jedem Upload):** Der Sync wird **manuell angestoßen** — bewusst kein Polling/Cron, damit das Figma-Rate-Budget geschont wird.
1. Flo/Jonas legen die Bilder in den passenden Board-Bereich — idealerweise **pro Szene eine benannte Section** (der Name wird zum Cluster in Airtable). Alte Pakete löscht Flo nach Feedback vom Board.
2. Jonas ruft Claude zu („neue Creatives syncen" / Skill `/creative-review-sync`) oder manuell: `curl -X POST "<API>/sync?limit=100" -H "x-review-key: <KEY>"` — wiederholen bis `"Nichts Neues"`, für Memes zusätzlich mit `&format=memes`.
3. Max, Jonas, Flo reviewen in der App. Neue Fail-Gründe entstehen über das Freitext-Feld direkt in der App.
4. Learnings ziehen: `GET /rollup` → `flags` mit Max' bestätigten Kritikpunkten durchgehen, betroffene Models/Szenen in den Karteien auf „Bedingt"/„Aussortiert" setzen.

**Baseline (Übersprungenes):** Board-Bilder, die außerhalb der App gefeedbackt wurden, kann `POST /baseline` einfrieren — der Sync ignoriert sie dann dauerhaft (Supabase-Tabelle `sync_baseline`). Am 31.07.2026 wurden so die 227 Rest-Bilder des ersten Pakets ausgenommen (Feedback lief via Slack).

**App ändern:** `index.html` in diesem Repo editieren/ersetzen → GitHub Pages deployt automatisch (~1 Min). Kein Build nötig.

**Backend ändern:** Funktion in Supabase deployen (Dashboard oder via Claude). Danach die Kopie `creative-review-function.ts` hier im Repo aktualisieren, damit Repo = Realität.

**Review-Key rotieren:** In Supabase → Edge Functions → Secrets → `REVIEW_KEY` neu setzen. Nur ASCII-Zeichen (Umlaute funktionieren in HTTP-Headern nicht). Danach allen Reviewern die neue URL mit `?key=` schicken.

**Figma-Token rotieren:** Liegt in der Supabase-Tabelle `app_config` (Key `figma_token`) und hat Vorrang vor den Secrets `FIGMA_TOKEN_II`/`FIGMA_TOKEN`. Rotation per SQL: `update app_config set value='figd_…', updated_at=now() where key='figma_token';` — kein Redeploy nötig (Cache greift pro Instanz, neue Instanzen lesen sofort den neuen Wert).

## Bekannte Stolperfallen

- **Figma-Rate-Limit (429) gilt pro Figma-USER, nicht pro Token** — ein zweiter Token desselben Accounts hilft nicht. Seit 06.08.2026 lädt der Sync nur noch den „Creative Review"-Teilbaum (~128 KB) statt des Full-Files (~50 MB); das Budget hält damit locker. Bei 429 trotzdem: nicht hämmern, 10–15 Min warten, erneut. Bild-Renders (`images/…`) sind teurer als der Node-Fetch — bei großen Importen synct man in Häppchen (`?limit=40`).
- **Airtable-Attachment-URLs laufen ab** (~2 h). Die App lädt die Queue live, daher unkritisch — aber Bild-URLs nie irgendwo statisch ablegen.
- **Sync-Limit:** Edge Functions haben 150 s Idle-Timeout. `?limit=100` pro Lauf ist sicher; einfach wiederholen.
- **Board-Layout:** Die Bereichs-Erkennung erwartet große Überschriften. Neue Karteien/Spalten neben oder unter einem Review-Bereich brauchen ebenfalls eine große Überschrift, sonst werden ihre Bilder dem Bereich zugerechnet.

## Airtable-Referenz

- Statics-Base `appKktIMvTU1AqOEN` — Models `tblRUZ99u9ApeOdMu`, Expressions `tbl1RQkCERHpz8Nug`, Depictions `tbly4pX6YMtAfHYyz`, Assets `tbl2rpHgH2D0hebQ4`, Reviews `tbltxjO4jLxWbqTRy`, Regeln `tblZIQ6vTEQGwD2fn`
- Memes-Base `appW9B8mQaT7krmg2` — Assets `tblQIYC1QRsU9Xp1r`, Reviews `tblHCqfdQ6OzHHCdi`
- Figma-Board `pPSeVQKzDjuHv3Gf8wDp3u`, Review-Bereich Node `3156:787` („Creative Review")

Die Fail-Tag-Vorschläge in der App basieren auf Max' Original-Feedback (Gruppen-DM Jonas/Max/Flo, Static-Reviews 27.07. + 31.07.2026) und dem Visual Direction Sheet V2.1.
