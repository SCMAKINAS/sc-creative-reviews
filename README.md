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
| `index.html` | Die komplette Review-App Marketing-Creatives (Single File, keine Build-Schritte) |
| `artworks/index.html` | Artwork-Review-App fürs Design-Team (Vuven & Max) — eigene Seite, gleiche Edge Function (`?format=artworks`) |
| `sketches/index.html` | Redirect auf `/artworks/` (Pfad reserviert für die künftige Sketch-Review-App) |
| `creative-review-function.ts` | Quellcode der Supabase Edge Function (Referenz/Versionierung — deployt wird über Supabase, nicht von hier) |
| `README.md` | Diese Doku |

## Formate

Jedes Review-Format hat einen eigenen Board-Bereich (große Text-Überschrift), eine eigene Airtable-Base und eigene Review-Achsen/Tags. Umschalter in der App (SHOOTING | MEMES | BRANDING). API-Aufrufe: `?format=statics|memes|branding` (Default statics).

| Format | Board-Überschrift | Airtable-Base | Achsen | Prefix |
|---|---|---|---|---|
| statics | „AI Shooting Assets for Approval" | `appKktIMvTU1AqOEN` | Ausdruck / Model / Produktdarstellung | AST |
| memes | „Memes" (unter „Social Media Content for Approval") | `appW9B8mQaT7krmg2` | Witz / Brand / Umsetzung | MEM |
| branding | „Branding Shots" (unter „Social Media Content for Approval") | `appPaEX5g0qOOz5L4` | Vibe / Brand / Umsetzung | BRD |
| postcards | „Post Card Campaign" (unter „Brand Campaign Activations") | `appy3ipkgyDgyrHMJ` | Vibe / Brand / Umsetzung | PCD |

Die Bereichs-Erkennung ist geometrisch: Jedes Bild gehört zur **nächstgelegenen Überschrift seiner Zeile** (Bilder dürfen auch links der Überschrift beginnen — Model-Kartei neben den Statics, Social-Spalten nebeneinander); untere Grenze ist die nächste Überschriften-Zeile darunter. Kleine Labels (< 500 Board-Einheiten hoch) zählen nicht als Überschrift. Social-Zeile aktuell: „Memes" · „Band photos" · „Branding Shots".

**Postcards-Besonderheit (Vorder-/Rückseite):** Board-Konvention im Bereich „Post Card Campaign": pro räumlicher Gruppe liegt die **obere Reihe = Vorderseiten**, die **untere Reihe = Rückseiten**. Der Sync legt nur Fronts als Assets an und hängt die Rückseiten der Gruppe als Attachment-Feld **„Back Preview"** an jedes Front-Asset (räumlich nächste zuerst). Die App zeigt auf der Karte links unten einen **RÜCKSEITE-Toggle** (Front → Back 1 → Back 2 → Front); Postcard-Karten rendern mit `object-fit: contain` (Querformat komplett sichtbar). First trial — bewusst rudimentär.

**Neues Format hinzufügen:** Bereich mit großer Überschrift in Figma anlegen (im „Creative Review"-Node) → Airtable-Base klonen (Assets + Reviews, Achsen-Felder anpassen) → `FORMATS`-Eintrag in der Edge Function + `FMT`-Eintrag in `index.html` → Airtable-Token um die neue Base erweitern. (Für „Band photos" und „Branding Shots" sind die Board-Überschriften schon da.)

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

**Figma-Token rotieren:** Liegt in der Supabase-Tabelle `app_config` (Key `figma_token`) und hat Vorrang vor den Secrets `FIGMA_TOKEN_II`/`FIGMA_TOKEN`. Rotation per SQL: `update app_config set value='figd_…', updated_at=now() where key='figma_token';` — kein Redeploy nötig (Token-Cache hat 5 Min TTL).

**Handy-Push bei neuen Batches:** Nach jedem Sync mit neuen Assets schickt die Function eine Push-Notification über ntfy.sh („Shooting-Assets: 161 neu im Review", Tap öffnet die App). Reviewer abonnieren einmalig das geheime Topic in der ntfy-App (Topic-Name steht in `app_config`, Key `ntfy_topic` — per SQL rotierbar, falls er leakt). Der Link in der Notification enthält bewusst KEINEN Review-Key.

## Artwork Review (Design-Team) — `?format=artworks`

Zweite App auf derselben Edge Function: **Artwork-Ranking fürs Produktdesign** statt Marketing-Creatives. (Hieß kurz „Sketch Review" — echte Sketch-Reviews kommen später als eigene App; der Format-Key `sketches` ist dafür reserviert und läuft aktuell nur noch als Übergangs-Alias auf `artworks`.) **Kein Figma-Sync** — bewertet werden Artworks aus SCA PRODUCT-LAB. Die Queue ist der Airtable-View **„⭐ 1. Open for ranking (Max/Vuven)"** (Schritt 1 der Artwork-Pipeline: 1. Ranking → 2. Requesting Robert → 3. Artist reply → 4. Price approval → 5. Final Stages). Was zur Abstimmung ansteht, steuert das Team allein über diesen View. App-URL: `https://scmakinas.github.io/sc-creative-reviews/artworks/` (+`?key=` wie gehabt, gleicher REVIEW_KEY, gleicher localStorage-Key). `/sketches/` leitet dorthin um (alte Links inkl. `?key=` funktionieren weiter).

**Entscheider-Modell (anders als bei den Creatives):** Vuven und Max sind **gleichberechtigt** und voten blind (keiner sieht das Votum des anderen vor dem eigenen). Die Votes landen in den **bestehenden Feldern `Vuven Rank` / `Max Rank`** (Confirm=Yes, Reject=No) — die App ersetzt das manuelle Ranking, nicht die Pipeline.

| Konstellation | Wirkung in Airtable |
|---|---|
| Beide **Yes** | `App Review Ergebnis` = Confirmed — das Artwork fällt aus dem Ranking-View und läuft über die View-Filter weiter zu Schritt 2 (Robert/Requesting) |
| Beide **No** | Ergebnis = Rejected — aussortiert |
| Uneins | Ergebnis = **Konflikt**. Tab KONFLIKTE in der App zeigt beide Votes; `POST /resolve` schreibt die Einigung, **vereinheitlicht beide Ranks** und hängt die Klärungs-Notiz ans Artwork-Feld „Notes:" |

**Queue-Definition:** Artwork liegt im Ranking-View + hat ein Bild + eigener Rank leer. UNDO leert den Rank wieder — das Artwork fällt zurück in den View.

**Learnings/Design-Brain:** Jede Notiz > 3 Zeichen (bei Confirm, Reject oder Konflikt-Klärung) wird automatisch Regel-Vorschlag `SKR-xx` in der Tabelle „Artwork Rules" (Status „Vorschlag" — Vuven/Max bestätigen/verwerfen per Status-Feld in Airtable). Reject-Tags landen als Select-Optionen in „Artwork Reviews" und stehen via `GET /failtags?format=artworks` allen Geräten zur Verfügung.

**Routen (alle mit `?format=artworks`):** `GET /queue?reviewer=Vuven|Max` · `POST /review` `{recordId,reviewer,verdict:Confirm|Reject,tags?,comment?,seconds?,session?}` · `POST /unreview` `{reviewId}` · `GET /conflicts` · `POST /resolve` `{recordId,verdict,comment?}` · `GET /rules` · `GET /failtags` · `GET /probe` (prüft PAT-Zugriff + Queue-Stände) · `POST /notify` `{message?}` (Handy-Push, s.u.). Sync/Layout/Baseline existieren für artworks bewusst nicht.

**Handy-Push bei neuen Artworks:** `POST /notify?format=artworks` zählt die offene Ranking-Queue live und schickt einen ntfy-Push („X Artworks offen im Ranking", Titel „Artwork Review", Tap öffnet die Artwork-App — bewusst OHNE Key im Link). **Gleiches geheimes Topic wie die Creative-Review-Pushes** (`app_config`, Key `ntfy_topic` — eine Topic-Rotation greift damit automatisch für beide Apps; Titel/Link unterscheiden die Quelle). Kein Cron: Der Import-Prozess (Design-Engine-Session, die neue Artworks in die Base einspielt) ruft die Route **nach dem Einspielen** auf. Bei leerer Queue wird nichts gesendet.

## Bekannte Stolperfallen

- **Figma-Rate-Limit (429) gilt pro Figma-USER, nicht pro Token** — ein zweiter Token desselben Accounts hilft nicht. Seit 06.08.2026 lädt der Sync nur noch den „Creative Review"-Teilbaum (~128 KB) statt des Full-Files (~50 MB); das Budget hält damit locker. Bei 429 trotzdem: nicht hämmern, 10–15 Min warten, erneut. Bild-Renders (`images/…`) sind teurer als der Node-Fetch — bei großen Importen synct man in Häppchen (`?limit=40`).
- **Airtable-Attachment-URLs laufen ab** (~2 h). Die App lädt die Queue live, daher unkritisch — aber Bild-URLs nie irgendwo statisch ablegen.
- **Sync-Limit:** Edge Functions haben 150 s Idle-Timeout. `?limit=100` pro Lauf ist sicher; einfach wiederholen.
- **Board-Layout:** Die Bereichs-Erkennung erwartet große Überschriften. Neue Karteien/Spalten neben oder unter einem Review-Bereich brauchen ebenfalls eine große Überschrift, sonst werden ihre Bilder dem Bereich zugerechnet.

## Airtable-Referenz

- Statics-Base `appKktIMvTU1AqOEN` — Models `tblRUZ99u9ApeOdMu`, Expressions `tbl1RQkCERHpz8Nug`, Depictions `tbly4pX6YMtAfHYyz`, Assets `tbl2rpHgH2D0hebQ4`, Reviews `tbltxjO4jLxWbqTRy`, Regeln `tblZIQ6vTEQGwD2fn`
- Memes-Base `appW9B8mQaT7krmg2` — Assets `tblQIYC1QRsU9Xp1r`, Reviews `tblHCqfdQ6OzHHCdi`
- Branding-Base `appPaEX5g0qOOz5L4` — Assets `tblN6h6bLwkaGWsUo`, Reviews `tblXNaFF8fy5xdugq`
- **Artwork Review:** SCA PRODUCT-LAB `appJr0gEyT3BUVr0A` — Artworks `tbl1LaUaqitf5OMyW` (Queue-View `viwjoPLvEwk7aFl6z` „⭐ 1. Open for ranking"; Votes in „Vuven Rank"/„Max Rank", App-Spalten „App Review Ergebnis/Datum"), Artwork Reviews `tblByFgL2zJbJG3cP`, Artwork Rules `tblgRflphUBCOOt4o`. **Der `AIRTABLE_PAT` in Supabase muss diese Base einschließen!** (Die Tabelle „Sketches" `tbl7RrV9rtGqM0zgb` trägt noch ungenutzte App-Spalten aus der ersten Iteration — bei Bedarf löschbar.)
- Figma-Board `pPSeVQKzDjuHv3Gf8wDp3u`, Review-Bereich Node `3156:787` („Creative Review")

Die Fail-Tag-Vorschläge in der App basieren auf Max' Original-Feedback (Gruppen-DM Jonas/Max/Flo, Static-Reviews 27.07. + 31.07.2026) und dem Visual Direction Sheet V2.1.
