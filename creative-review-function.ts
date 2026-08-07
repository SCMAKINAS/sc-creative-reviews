// Stay Cold · Creative Review — Figma Board -> Airtable, multi-format
// Auth: eigener Header x-review-key (deshalb verify_jwt=false).
//
// Formate (?format=statics|memes|branding, Default statics): eigener Board-Bereich,
// eigene Airtable-Base, eigene Review-Achsen. Siehe FORMATS unten.
//
// ROUTEN
//   POST /sync     Review-Bereich ziehen, nach Board-Struktur gruppieren,
//                  lose Bilder raeumlich clustern, Assets anlegen (?limit=N, ?gap=N)
//   GET  /probe    Diagnose: Figma-Fetch des Review-Bereichs messen
//   GET  /layout   Diagnose: Bounding-Boxes der Bilder im Bereich
//   GET  /render   Diagnose/Notbehelf: Node-IDs rendern ohne File-Fetch (?ids=a,b,c)
//   GET  /vocab    Models / Expressions / Depictions
//   POST /vocab    neuen Vokabular-Eintrag anlegen  {kind,name,category?}
//   POST /assign   Cluster zuordnen                 {cluster,model,expression,depiction}
//   GET  /queue    offene Assets fuer die App (?reviewer=Name fuer persoenliche Queue)
//   POST /review   ein Einzelbild-Review
//   POST /unreview Review zuruecknehmen {reviewId, recordId?}
//   GET  /rules    Creative-Regeln (Fest + Vorschlag)
//   GET  /failtags alle bekannten Fail-Tag-Optionen pro Achse
//   POST /baseline aktuellen Board-Stand einfrieren (wird vom Sync uebersprungen)
//   GET  /rollup   Trefferquoten pro Entitaet + bestaetigte Kritik-Flags
//
// SONDERFORMAT ?format=sketches (Design-Team-Abstimmung, SCA PRODUCT-LAB):
// KEIN Figma-Sync — bewertet werden ARTWORKS aus dem Airtable-View
// "⭐ 1. Open for ranking (Max/Vuven)". Votes landen in den bestehenden
// Feldern "Max Rank"/"Vuven Rank" (Yes/No). Siehe SK-Block unten:
//   GET  /queue?format=sketches&reviewer=Vuven|Max   offene Artworks
//   POST /review?format=sketches    {recordId,reviewer,verdict,tags?,comment?}
//   POST /unreview?format=sketches  {reviewId}
//   GET  /conflicts?format=sketches Konflikte (Vuven vs. Max) mit beiden Votes
//   POST /resolve?format=sketches   {recordId,verdict,comment?} Konflikt klaeren
//   GET  /rules?format=sketches     Sketch-Regelkatalog (SKR-xx)
//   GET  /failtags?format=sketches  bekannte Feedback-Tags
//   GET  /probe?format=sketches     Airtable-Zugriff + Queue-Staende pruefen

const FIGMA_FILE = "pPSeVQKzDjuHv3Gf8wDp3u";
// Der gesamte Review-Bereich als ein Node (Link von Jonas, 06.08.2026):
// oben AI-Shootings (statics), unten Social Media (Memes, Band photos,
// Branding Shots). Nur DIESER Teilbaum wird geladen (nodes-API) statt des
// ganzen Boards -- Groessenordnungen billiger im Figma-Rate-Budget.
const REVIEW_ROOT = "3156:787";

// Ein Review-Format = eigener Board-Bereich + eigene Airtable-Base + eigene Achsen.
// Neue Formate: Bereich in Figma anlegen (Text-Ueberschrift!), Base klonen, hier eintragen.
type Fmt = {
  base: string; assets: string; reviews: string;
  column: string[];             // Kandidaten fuer die Bereichs-Ueberschrift (lowercase-Match)
  axes: Record<string, string>; // Achse -> Fail-Feld
  prefix: string;               // Asset-ID-Praefix
  label: string;                // Anzeigename fuer Notifications
};
const FORMATS: Record<string, Fmt> = {
  statics: {
    base: "appKktIMvTU1AqOEN", assets: "tbl2rpHgH2D0hebQ4", reviews: "tbltxjO4jLxWbqTRy",
    column: ["scenes for approval", "ai shooting"],
    axes: { Ausdruck: "Fail Ausdruck", Model: "Fail Model", Produktdarstellung: "Fail Produktdarstellung" },
    prefix: "AST", label: "Shooting-Assets",
  },
  memes: {
    base: "appW9B8mQaT7krmg2", assets: "tblQIYC1QRsU9Xp1r", reviews: "tblHCqfdQ6OzHHCdi",
    column: ["social media assets", "memes"],
    axes: { Witz: "Fail Witz", Brand: "Fail Brand", Umsetzung: "Fail Umsetzung" },
    prefix: "MEM", label: "Memes",
  },
  branding: {
    base: "appPaEX5g0qOOz5L4", assets: "tblN6h6bLwkaGWsUo", reviews: "tblXNaFF8fy5xdugq",
    column: ["branding shots", "branding"],
    axes: { Vibe: "Fail Vibe", Brand: "Fail Brand", Umsetzung: "Fail Umsetzung" },
    prefix: "BRD", label: "Branding Shots",
  },
};
function fmtOf(req: Request): (Fmt & { key: string }) | null {
  const k = new URL(req.url).searchParams.get("format") ?? "statics";
  return FORMATS[k] ? { key: k, ...FORMATS[k] } : null;
}

// Vokabular, Regeln und Rollup leben weiterhin in der Statics-Base.
const BASE = FORMATS.statics.base;
const T = {
  models: "tblRUZ99u9ApeOdMu",
  expressions: "tbl1RQkCERHpz8Nug",
  depictions: "tbly4pX6YMtAfHYyz",
  assets: FORMATS.statics.assets,
  reviews: FORMATS.statics.reviews,
  regeln: "tblZIQ6vTEQGwD2fn",
};

// Figma-Token: app_config-Tabelle (per SQL rotierbar) hat Vorrang vor den
// Env-Secrets FIGMA_TOKEN_II / FIGMA_TOKEN. Cache mit 5-Min-TTL, damit eine
// Rotation auch warme Instanzen ohne Redeploy erreicht.
let FIGMA_TOKEN_CACHE: { v: string; t: number } | null = null;
async function figmaToken(): Promise<string> {
  if (FIGMA_TOKEN_CACHE && Date.now() - FIGMA_TOKEN_CACHE.t < 300_000) return FIGMA_TOKEN_CACHE.v;
  let v = "";
  try {
    const rows = await pg("app_config?key=eq.figma_token&select=value");
    if (rows?.[0]?.value) v = rows[0].value;
  } catch (_e) { /* Fallback auf Env */ }
  if (!v) v = Deno.env.get("FIGMA_TOKEN_II") ?? Deno.env.get("FIGMA_TOKEN") ?? "";
  FIGMA_TOKEN_CACHE = { v, t: Date.now() };
  return v;
}
const AIRTABLE_PAT = Deno.env.get("AIRTABLE_PAT") ?? "";
const REVIEW_KEY = Deno.env.get("REVIEW_KEY") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type,x-review-key",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });

// ---------- Airtable ----------
async function at(base: string, path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(`https://api.airtable.com/v0/${base}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${AIRTABLE_PAT}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const b = await r.json();
  if (!r.ok) throw new Error(`Airtable ${r.status}: ${JSON.stringify(b)}`);
  return b;
}
async function atAll(base: string, table: string, params = ""): Promise<any[]> {
  const out: any[] = [];
  let offset = "";
  do {
    const q = new URLSearchParams(params);
    if (offset) q.set("offset", offset);
    const p = await at(base, `${table}?${q}`);
    out.push(...p.records);
    offset = p.offset ?? "";
  } while (offset);
  return out;
}
async function atCreate(base: string, table: string, rows: any[]): Promise<any[]> {
  const made: any[] = [];
  for (let i = 0; i < rows.length; i += 10) {
    const r = await at(base, table, {
      method: "POST",
      body: JSON.stringify({ records: rows.slice(i, i + 10), typecast: true }),
    });
    made.push(...r.records);
  }
  return made;
}
async function atPatch(base: string, table: string, rows: any[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < rows.length; i += 10) {
    const r = await at(base, table, {
      method: "PATCH",
      body: JSON.stringify({ records: rows.slice(i, i + 10), typecast: true }),
    });
    n += r.records.length;
  }
  return n;
}

// ---------- Postgres (Baseline + Config via PostgREST) ----------
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
async function pg(path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal",
      ...(init.headers ?? {}),
    },
  });
  if (!r.ok) throw new Error(`Postgres ${r.status}: ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
async function baselineIds(): Promise<Set<string>> {
  const rows = await pg("sync_baseline?select=node_id") ?? [];
  return new Set(rows.map((r: any) => r.node_id));
}

// ---------- Push-Notification (ntfy.sh) ----------
// Handy-Push an alle Abonnenten des geheimen Topics (app_config.ntfy_topic,
// per SQL rotierbar). JSON-Publish, weil Umlaute nicht in HTTP-Header duerfen.
// Ein Notification-Fehler darf den Sync NIE brechen. Kein Review-Key im Link!
async function notify(message: string) {
  try {
    const rows = await pg("app_config?key=eq.ntfy_topic&select=value");
    const topic = rows?.[0]?.value;
    if (!topic) return;
    await fetch("https://ntfy.sh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topic,
        title: "Creative Review",
        message,
        click: "https://scmakinas.github.io/sc-creative-reviews/",
        tags: ["framed_picture"],
      }),
    });
  } catch (e) {
    console.log(`[notify] ${String(e)}`);
  }
}

// ---------- Figma ----------
async function figma(path: string): Promise<any> {
  const tok = await figmaToken();
  if (!tok) throw new Error("Kein Figma-Token konfiguriert (app_config.figma_token oder Secret).");
  const r = await fetch(`https://api.figma.com/v1/${path}`, { headers: { "X-Figma-Token": tok } });
  const b = await r.json();
  if (!r.ok) throw new Error(`Figma ${r.status}: ${JSON.stringify(b)}`);
  return b;
}

type N = { id: string; x: number; y: number; w: number; h: number; name: string; section?: string | null };

function walk(node: any, texts: any[], imgs: N[], section: string | null = null) {
  const bb = node?.absoluteBoundingBox;
  if (node?.type === "TEXT" && bb) texts.push({ t: String(node.characters ?? ""), x: bb.x, y: bb.y, h: bb.height });
  const isImg = node?.type === "IMAGE" ||
    (Array.isArray(node?.fills) && node.fills.some((f: any) => f?.type === "IMAGE" && f?.visible !== false));
  if (isImg && bb && node.visible !== false) {
    imgs.push({ id: node.id, x: bb.x, y: bb.y, w: bb.width, h: bb.height, name: node.name ?? "", section });
    return; // Kinder eines Bild-Nodes nicht weiter absteigen
  }
  // Szenen-Gruppierung: benannte Sections/Frames/Groups im Board tragen die Struktur.
  const isContainer = node?.type === "SECTION" || node?.type === "FRAME" || node?.type === "GROUP";
  const next = isContainer && node.name ? `${String(node.name)} [${node.id}]` : section;
  for (const c of node?.children ?? []) walk(c, texts, imgs, next);
}

// Union-Find, 2D-Naehe. Kein Edit-Access am Board noetig.
function cluster(nodes: N[], gap: number): N[][] {
  const p = nodes.map((_, i) => i);
  const find = (i: number): number => (p[i] === i ? i : (p[i] = find(p[i])));
  const near = (a: N, b: N) =>
    a.x - (b.x + b.w) < gap && b.x - (a.x + a.w) < gap &&
    a.y - (b.y + b.h) < gap && b.y - (a.y + a.h) < gap;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (near(nodes[i], nodes[j])) p[find(i)] = find(j);
    }
  }
  const g = new Map<number, N[]>();
  nodes.forEach((n, i) => {
    const r = find(i);
    if (!g.has(r)) g.set(r, []);
    g.get(r)!.push(n);
  });
  return [...g.values()].sort((a, b) => {
    const ay = Math.min(...a.map((n) => n.y)), by = Math.min(...b.map((n) => n.y));
    if (Math.abs(ay - by) > 40) return ay - by;
    return Math.min(...a.map((n) => n.x)) - Math.min(...b.map((n) => n.x));
  });
}

// Gemeinsame Vorstufe: Review-Bereich holen, Format-Teilbereich finden, Bilder filtern.
// Board-Layout (Stand 06.08.): EINE Section "Creative Review"; oben "AI Shooting
// Assets for Approval" (Model-Kartei ggf. rechts daneben), weit darunter "Social
// Media Content for Approval" mit Spalten "Memes", "Band photos", "Branding Shots".
function findHead(texts: any[], f: Fmt) {
  return texts.find((t) => {
    const s = String(t.t).trim().toLowerCase();
    return f.column.some((c) => s.includes(c));
  });
}
async function reviewRoot(): Promise<any | null> {
  const resp = await figma(`files/${FIGMA_FILE}/nodes?ids=${encodeURIComponent(REVIEW_ROOT)}`);
  return resp?.nodes?.[REVIEW_ROOT]?.document ?? null;
}
async function boardColumn(f: Fmt) {
  const doc = await reviewRoot();
  if (!doc) return { error: json({ error: `Review-Bereich ${REVIEW_ROOT} nicht im Board gefunden.` }, 404) };
  const texts: any[] = [], imgs: N[] = [];
  for (const c of doc.children ?? []) walk(c, texts, imgs, null);
  // Nur grosse Texte sind Bereichs-Ueberschriften; kleine Labels zwischen Bildern ignorieren.
  const heads = texts.filter((t) => (t.h ?? 0) >= 500);
  const head = findHead(heads, f);
  if (!head) return { error: json({ error: `Bereich "${f.column[0]}" nicht im Board gefunden.` }, 404) };
  // Ueberschriften derselben ZEILE = konkurrierende Spalten (Model-Kartei neben den
  // Statics; Memes/Band photos/Branding Shots nebeneinander). Jedes Bild gehoert zur
  // NAECHSTGELEGENEN Zeilen-Ueberschrift — Bilder duerfen auch links davon beginnen.
  const rowHeads = heads.filter((t) => Math.abs(t.y - head.y) < 2500);
  // Untere Grenze: naechste Ueberschriften-Zeile unterhalb (z. B. "Social Media
  // Content for Approval" unter den AI-Shootings).
  const below = heads.filter((t) => t.y > head.y + 2500).map((t) => t.y);
  const yMax = below.length ? Math.min(...below) - 20 : Infinity;
  const inCol = imgs.filter((n) => {
    if (n.y <= head.y || n.y >= yMax) return false;
    const cx = n.x + n.w / 2;
    let best = rowHeads[0];
    for (const t of rowHeads) if (Math.abs(cx - t.x) < Math.abs(cx - best.x)) best = t;
    return best === head;
  });
  return { inCol, texts: texts.length, imgs: imgs.length };
}

// ---------- Diagnose ----------
async function probe(req: Request) {
  const f = fmtOf(req) ?? { ...FORMATS.statics, key: "statics" };
  const t0 = Date.now();
  const doc = await reviewRoot();
  const fetchMs = Date.now() - t0;
  if (!doc) return json({ error: `Review-Bereich ${REVIEW_ROOT} nicht gefunden.` }, 404);
  const texts: any[] = [], imgs: N[] = [];
  for (const c of doc.children ?? []) walk(c, texts, imgs, null);
  let nodes = 0;
  const count = (n: any) => { nodes++; for (const c of n?.children ?? []) count(c); };
  count(doc);
  const head = findHead(texts.filter((t) => (t.h ?? 0) >= 500), f);
  return json({
    fetchMs,
    approxKB: Math.round(JSON.stringify(doc).length / 1024),
    nodes,
    texts: texts.length,
    images: imgs.length,
    columnFound: !!head,
  });
}

// Diagnose/Notbehelf: rendert gegebene Node-IDs ohne den teuren File-Fetch.
async function render(req: Request) {
  const ids = (new URL(req.url).searchParams.get("ids") ?? "").trim();
  if (!ids) return json({ error: "ids fehlt (?ids=a,b,c)" }, 400);
  const r = await figma(`images/${FIGMA_FILE}?ids=${encodeURIComponent(ids)}&format=jpg&scale=1`);
  return json({ images: r.images ?? {} });
}

async function layout(req: Request) {
  const f = fmtOf(req);
  if (!f) return json({ error: "unbekanntes format" }, 400);
  const col = await boardColumn(f);
  if ("error" in col) return col.error;
  const rows = col.inCol!
    .sort((a, b) => (Math.abs(a.y - b.y) > 40 ? a.y - b.y : a.x - b.x))
    .map((n) => [n.id, Math.round(n.x), Math.round(n.y), Math.round(n.w), Math.round(n.h), n.section ?? ""]);
  return json({ count: rows.length, columns: "id,x,y,w,h,section", rows });
}

async function sync(req: Request) {
  const t0 = Date.now();
  const mark = (s: string) => console.log(`[sync] ${s} +${Date.now() - t0}ms`);
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get("limit") ?? "40", 10) || 40));
  const gapParam = parseInt(url.searchParams.get("gap") ?? "", 10);

  const f = fmtOf(req);
  if (!f) return json({ error: "unbekanntes format" }, 400);
  mark(`format: ${f.key}`);
  mark("figma fetch start");
  const col = await boardColumn(f);
  if ("error" in col) return col.error;
  const inCol = col.inCol!;
  mark(`walked: ${col.texts} texts, ${col.imgs} images, ${inCol.length} in column`);
  if (!inCol.length) return json({ created: 0, remaining: 0, note: "Board-Bereich ist leer — nichts zu importieren." });

  // 1. Wahl: Board-Struktur (benannte Sections/Frames/Groups) = Szene.
  // Fallback fuer lose Bilder: raeumliches Clustering.
  const bySection = new Map<string, N[]>();
  const loose: N[] = [];
  for (const n of inCol) {
    if (n.section) {
      if (!bySection.has(n.section)) bySection.set(n.section, []);
      bySection.get(n.section)!.push(n);
    } else loose.push(n);
  }
  const hs = inCol.map((n) => n.h).sort((a, b) => a - b);
  const gap = Number.isFinite(gapParam) && gapParam > 0
    ? gapParam
    : Math.max(12, hs[Math.floor(hs.length / 2)] * 0.55);
  const named: { label: string | null; nodes: N[] }[] =
    [...bySection.entries()].map(([label, nodes]) => ({ label: label.replace(/ \[[^\]]+\]$/, ""), nodes }));
  const spatial = loose.length ? cluster(loose, gap).map((nodes) => ({ label: null, nodes })) : [];
  const groups = [...named, ...spatial].sort((a, b) =>
    Math.min(...a.nodes.map((n) => n.y)) - Math.min(...b.nodes.map((n) => n.y)));
  mark(`grouped: ${inCol.length} images -> ${named.length} sections + ${spatial.length} spatial (gap ${Math.round(gap)})`);

  const existing = await atAll(f.base, f.assets, "fields[]=Figma Node ID&fields[]=Asset ID");
  mark(`airtable existing: ${existing.length} assets`);
  const seen = new Set(existing.map((r) => r.fields["Figma Node ID"]).filter(Boolean));
  // Baseline: Board-Stand, der bewusst NICHT importiert wird (bereits via Slack
  // gefeedbackt). Nur Neues nach der Baseline landet in der App.
  const base = await baselineIds();
  base.forEach((id) => seen.add(id));
  mark(`baseline: ${base.size} nodes ausgeschlossen`);
  let seq = existing.reduce((m, r) => {
    const k = parseInt(String(r.fields["Asset ID"] ?? "").split("-")[1] ?? "0", 10);
    return Number.isFinite(k) && k > m ? k : m;
  }, 0);

  const batch = `${new Date().toISOString().slice(0, 10)}-A`;
  const rows: any[] = [];
  const wanted: string[] = [];
  let remaining = 0;
  groups.forEach((g, gi) => {
    const cl = g.label ?? `CL-${String(gi + 1).padStart(2, "0")}`;
    const boardY = Math.round(Math.min(...g.nodes.map((n) => n.y)));
    g.nodes.sort((a, b) => (Math.abs(a.y - b.y) > 20 ? a.y - b.y : a.x - b.x))
      .forEach((n, k) => {
        if (seen.has(n.id)) return;
        if (rows.length >= limit) { remaining++; return; }
        wanted.push(n.id);
        rows.push({
          node: n.id,
          fields: {
            "Asset ID": `${f.prefix}-${String(++seq).padStart(4, "0")}`,
            "Figma Node ID": n.id,
            "Figma Link": `https://www.figma.com/board/${FIGMA_FILE}?node-id=${n.id.replace(":", "-")}`,
            Cluster: cl,
            "Board Y": boardY,
            Position: k + 1,
            Batch: batch,
            Status: "Queued",
            "Pulled at": new Date().toISOString(),
          },
        });
      });
  });
  if (!rows.length) return json({ created: 0, remaining, clusters: groups.length, note: "Nichts Neues." });

  // Renders in Haeppchen, sonst wird die URL zu lang.
  const urls: Record<string, string> = {};
  for (let i = 0; i < wanted.length; i += 40) {
    const ids = wanted.slice(i, i + 40).join(",");
    const r = await figma(`images/${FIGMA_FILE}?ids=${encodeURIComponent(ids)}&format=jpg&scale=1`);
    Object.assign(urls, r.images ?? {});
    mark(`rendered ${Math.min(i + 40, wanted.length)}/${wanted.length}`);
  }
  const payload = rows.map((r) => {
    const u = urls[r.node];
    return { fields: { ...r.fields, ...(u ? { Preview: [{ url: u }] } : {}) } };
  });

  const made = await atCreate(f.base, f.assets, payload);
  mark(`airtable created: ${made.length}`);
  // Handy-Push an die Reviewer, sobald neue Assets in der Queue liegen.
  if (made.length) await notify(`${f.label}: ${made.length} neu im Review`);
  return json({
    created: made.length,
    expected: payload.length,
    remaining,
    clusters: groups.length,
    gap: Math.round(gap),
    batch,
    ...(made.length !== payload.length ? { warning: "Weniger Records als erwartet — Base pruefen." } : {}),
  });
}

// ---------- Vokabular ----------
const KIND: Record<string, { t: string; p: string; label: string }> = {
  model: { t: T.models, p: "MOD", label: "Name / Kuerzel" },
  expression: { t: T.expressions, p: "EXP", label: "Bezeichnung" },
  depiction: { t: T.depictions, p: "DEP", label: "Bezeichnung" },
};
const ID_FIELD: Record<string, string> = {
  model: "Model ID", expression: "Expression ID", depiction: "Depiction ID",
};

async function vocab() {
  const out: any = {};
  for (const k of Object.keys(KIND)) {
    const recs = await atAll(BASE, KIND[k].t);
    out[k] = recs.map((r) => ({
      id: r.fields[ID_FIELD[k]],
      name: r.fields[KIND[k].label] ?? "",
      category: r.fields["Kategorie"] ?? null,
      urteil: r.fields["Urteil"] ?? null,
    })).filter((x) => x.id);
  }
  return json(out);
}

async function addVocab(req: Request) {
  const b = await req.json();
  const k = KIND[b.kind];
  if (!k) return json({ error: "kind muss model|expression|depiction sein" }, 400);
  if (!b.name) return json({ error: "name fehlt" }, 400);
  const recs = await atAll(BASE, k.t, `fields[]=${encodeURIComponent(ID_FIELD[b.kind])}`);
  const seq = recs.reduce((m, r) => {
    const n = parseInt(String(r.fields[ID_FIELD[b.kind]] ?? "").split("-")[1] ?? "0", 10);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0) + 1;
  const id = `${k.p}-${String(seq).padStart(2, "0")}`;
  const fields: any = { [ID_FIELD[b.kind]]: id, [k.label]: b.name, Urteil: "In Pruefung" };
  if (b.category) fields["Kategorie"] = b.category;
  await atCreate(BASE, k.t, [{ fields }]);
  return json({ id, name: b.name });
}

// ---------- Zuordnung pro Cluster ----------
async function assign(req: Request) {
  const b = await req.json();
  if (!b.cluster) return json({ error: "cluster fehlt" }, 400);
  const recs = await atAll(BASE, T.assets, "filterByFormula=" + encodeURIComponent(`{Cluster}=\"${b.cluster}\"`));
  if (!recs.length) return json({ error: `Cluster ${b.cluster} hat keine Assets.` }, 404);
  const fields: any = {};
  if (b.model) fields["Model ID"] = b.model;
  if (b.expression) fields["Expression ID"] = b.expression;
  if (b.depiction) fields["Depiction ID"] = b.depiction;
  if (b.produkt) fields["Produkt"] = b.produkt;
  if (b.colorway) fields["Colorway"] = b.colorway;
  const n = await atPatch(BASE, T.assets, recs.map((r) => ({ id: r.id, fields })));
  return json({ cluster: b.cluster, updated: n });
}

// ---------- Queue ----------
// Mit ?reviewer=Name liefert die Queue alle Assets, die DIESE Person noch nicht
// bewertet hat (Decision und Shadows laufen parallel auf dieselben Assets).
// Ohne reviewer: altes Verhalten (Status Queued).
async function queue(req: Request) {
  const f = fmtOf(req);
  if (!f) return json({ error: "unbekanntes format" }, 400);
  const reviewer = new URL(req.url).searchParams.get("reviewer");
  let recs;
  if (reviewer) {
    const all = await atAll(f.base, f.assets, "sort[0][field]=Asset ID&sort[0][direction]=asc");
    const revs = await atAll(
      f.base, f.reviews,
      "filterByFormula=" + encodeURIComponent(`{Reviewer}=\"${reviewer}\"`) + "&fields[]=Asset ID",
    );
    const done = new Set(revs.map((r) => r.fields["Asset ID"]).filter(Boolean));
    recs = all.filter((r) => !done.has(r.fields["Asset ID"]));
  } else {
    recs = await atAll(
      f.base, f.assets,
      "filterByFormula=" + encodeURIComponent(`{Status}=\"Queued\"`) +
        "&sort[0][field]=Asset ID&sort[0][direction]=asc",
    );
  }
  return json({
    assets: recs.map((r) => ({
      recordId: r.id,
      id: r.fields["Asset ID"],
      cluster: r.fields["Cluster"] ?? "",
      position: r.fields["Position"] ?? null,
      model: r.fields["Model ID"] ?? null,
      expression: r.fields["Expression ID"] ?? null,
      depiction: r.fields["Depiction ID"] ?? null,
      produkt: r.fields["Produkt"] ?? "",
      colorway: r.fields["Colorway"] ?? "",
      batch: r.fields["Batch"] ?? "",
      // Thumbnail zuerst (schnell), volle Aufloesung fuer Zoom/Nachladen.
      image: r.fields["Preview"]?.[0]?.thumbnails?.large?.url ?? r.fields["Preview"]?.[0]?.url ?? null,
      imageFull: r.fields["Preview"]?.[0]?.url ?? null,
      figma: r.fields["Figma Link"] ?? null,
    })),
  });
}

// ---------- Review ----------
async function review(req: Request) {
  const f = fmtOf(req);
  if (!f) return json({ error: "unbekanntes format" }, 400);
  const b = await req.json();
  for (const k of ["recordId", "assetId", "reviewer", "role", "verdict"]) {
    if (!b[k]) return json({ error: `${k} fehlt` }, 400);
  }
  const passt = b.verdict === "Passt";
  const fields: any = {
    Review: `${b.assetId} · ${b.reviewer}`,
    "Asset ID": b.assetId,
    Reviewer: b.reviewer,
    Rolle: b.role,
    Gesamt: passt ? "Passt" : "Abweichung",
    Kommentar: b.comment ?? "",
    Sekunden: b.seconds ?? null,
    Session: b.session ?? "",
    "Reviewed at": new Date().toISOString(),
  };
  for (const [axis, failField] of Object.entries(f.axes)) {
    fields[axis] = passt ? "Passt" : b.axis === axis ? "Off" : "Passt";
    if (!passt && b.axis === axis) fields[failField] = b.tags ?? [];
  }

  const rec = await atCreate(f.base, f.reviews, [{ fields }]);

  // Nur Decision schreibt den Asset-Status fort. Shadow aendert nichts.
  if (b.role === "Decision") {
    await atPatch(f.base, f.assets, [{ id: b.recordId, fields: { Status: passt ? "Passt" : "Abweichung" } }]);
  }

  // Positiver Decision-Kommentar (Max) => automatisch als Regel-Vorschlag
  // in die Regeln-Tabelle. Max bestaetigt/verwirft dort (Status).
  let ruleId: string | null = null;
  if (b.role === "Decision" && passt && (b.comment ?? "").trim().length > 3) {
    try {
      const regeln = await atAll(BASE, T.regeln, "fields[]=Regel ID");
      const seq = regeln.reduce((m, r) => {
        const n = parseInt(String(r.fields["Regel ID"] ?? "").split("-")[1] ?? "0", 10);
        return Number.isFinite(n) && n > m ? n : m;
      }, 0) + 1;
      ruleId = `REG-${String(seq).padStart(2, "0")}`;
      await atCreate(BASE, T.regeln, [{ fields: {
        "Regel ID": ruleId,
        Regel: String(b.comment).trim(),
        Achse: "Allgemein",
        Status: "Vorschlag",
        Quelle: `Review ${b.assetId} · ${b.reviewer} (${f.key})`,
        Erstellt: new Date().toISOString(),
      } }]);
    } catch (e) {
      console.log(`[rules] Vorschlag fehlgeschlagen: ${String(e)}`);
      ruleId = null;
    }
  }
  return json({ ok: true, reviewId: rec[0].id, ...(ruleId ? { ruleProposal: ruleId } : {}) });
}

// ---------- Fail-Tags ----------
// Liefert alle bekannten Fail-Tag-Optionen pro Achse, damit selbst angelegte
// Tags (z. B. "Koerperhaltung") auf allen Geraeten als Chips erscheinen.
async function failtags(req: Request) {
  const f = fmtOf(req);
  if (!f) return json({ error: "unbekanntes format" }, 400);
  try {
    const r = await fetch(`https://api.airtable.com/v0/meta/bases/${f.base}/tables`, {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
    });
    if (r.ok) {
      const b = await r.json();
      const tbl = (b.tables ?? []).find((t: any) => t.id === f.reviews);
      const out: Record<string, string[]> = {};
      for (const [axis, fname] of Object.entries(f.axes)) {
        const fld = tbl?.fields?.find((x: any) => x.name === fname);
        out[axis] = (fld?.options?.choices ?? []).map((c: any) => c.name);
      }
      return json({ source: "meta", tags: out });
    }
  } catch (_e) { /* Fallback unten */ }
  const failFields = Object.values(f.axes);
  const revs = await atAll(f.base, f.reviews, failFields.map((x) => `fields[]=${encodeURIComponent(x)}`).join("&"));
  const out: Record<string, string[]> = {};
  for (const axis of Object.keys(f.axes)) out[axis] = [];
  for (const r of revs) {
    for (const [axis, fname] of Object.entries(f.axes)) {
      for (const t of r.fields[fname] ?? []) if (!out[axis].includes(t)) out[axis].push(t);
    }
  }
  return json({ source: "reviews", tags: out });
}

// ---------- Baseline ----------
// Friert den aktuellen Board-Stand ein: alle Bilder in der Spalte, die noch
// nicht als Asset importiert sind, werden kuenftig vom Sync uebersprungen.
async function baseline(req: Request) {
  const f = fmtOf(req);
  if (!f) return json({ error: "unbekanntes format" }, 400);
  const col = await boardColumn(f);
  if ("error" in col) return col.error;
  const existing = await atAll(f.base, f.assets, "fields[]=Figma Node ID");
  const imported = new Set(existing.map((r) => r.fields["Figma Node ID"]).filter(Boolean));
  const toSkip = col.inCol!.filter((n) => !imported.has(n.id)).map((n) => ({ node_id: n.id }));
  for (let i = 0; i < toSkip.length; i += 500) {
    await pg("sync_baseline", { method: "POST", body: JSON.stringify(toSkip.slice(i, i + 500)) });
  }
  return json({ baselined: toSkip.length, importiert: imported.size, boardGesamt: col.inCol!.length });
}

// ---------- Regeln ----------
async function rules() {
  const recs = await atAll(BASE, T.regeln, "sort[0][field]=Regel ID&sort[0][direction]=asc");
  return json({
    rules: recs
      .filter((r) => r.fields["Status"] !== "Verworfen")
      .map((r) => ({
        id: r.fields["Regel ID"] ?? "",
        regel: r.fields["Regel"] ?? "",
        achse: r.fields["Achse"] ?? "Allgemein",
        status: r.fields["Status"] ?? "Vorschlag",
        quelle: r.fields["Quelle"] ?? "",
      })),
  });
}

// ---------- Undo ----------
// Nimmt ein Review zurueck (App-Funktion "UNDO").
// Bei Decision-Reviews wird der Asset-Status wieder auf Queued gesetzt.
async function unreview(req: Request) {
  const f = fmtOf(req);
  if (!f) return json({ error: "unbekanntes format" }, 400);
  const b = await req.json();
  if (!b.reviewId) return json({ error: "reviewId fehlt" }, 400);
  const rec = await at(f.base, `${f.reviews}/${b.reviewId}`);
  await at(f.base, `${f.reviews}/${b.reviewId}`, { method: "DELETE" });
  if (rec?.fields?.["Rolle"] === "Decision" && b.recordId) {
    await atPatch(f.base, f.assets, [{ id: b.recordId, fields: { Status: "Queued" } }]);
  }
  return json({ ok: true });
}

// ---------- Rollup (Statics: Vokabular-Mapping) ----------
async function rollup() {
  const revs = await atAll(BASE, T.reviews);
  const assets = await atAll(BASE, T.assets, "fields[]=Asset ID&fields[]=Model ID&fields[]=Expression ID&fields[]=Depiction ID");
  const map = new Map<string, any>();
  assets.forEach((a) => map.set(a.fields["Asset ID"], a.fields));

  const acc: Record<string, Record<string, { n: number; ok: number; tags: Record<string, number> }>> = {
    model: {}, expression: {}, depiction: {},
  };
  const KEYMAP: Record<string, string> = { model: "Model ID", expression: "Expression ID", depiction: "Depiction ID" };

  for (const r of revs) {
    if (r.fields["Rolle"] !== "Decision") continue; // Shadow zaehlt nicht
    const a = map.get(r.fields["Asset ID"]);
    if (!a) continue;
    const ok = r.fields["Gesamt"] === "Passt";
    const tags = [
      ...(r.fields["Fail Ausdruck"] ?? []),
      ...(r.fields["Fail Model"] ?? []),
      ...(r.fields["Fail Produktdarstellung"] ?? []),
    ];
    for (const kind of Object.keys(acc)) {
      const id = a[KEYMAP[kind]];
      if (!id) continue;
      acc[kind][id] = acc[kind][id] ?? { n: 0, ok: 0, tags: {} };
      acc[kind][id].n++;
      if (ok) acc[kind][id].ok++;
      tags.forEach((t: string) => (acc[kind][id].tags[t] = (acc[kind][id].tags[t] ?? 0) + 1));
    }
  }

  // Bestaetigte Kritik: Decision UND mindestens ein Shadow markieren dieselbe
  // Achse desselben Assets als Off. Diese Flags sind die Basis, um Models /
  // Szenen aus den Karteien zu werfen.
  const AXES = [
    { axis: "Ausdruck", fail: "Fail Ausdruck", kind: "expression" },
    { axis: "Model", fail: "Fail Model", kind: "model" },
    { axis: "Produktdarstellung", fail: "Fail Produktdarstellung", kind: "depiction" },
  ];
  const byAsset = new Map<string, { dec: any[]; sha: any[] }>();
  for (const r of revs) {
    const aid = r.fields["Asset ID"];
    if (!aid) continue;
    const slot = byAsset.get(aid) ?? { dec: [], sha: [] };
    if (r.fields["Rolle"] === "Decision") slot.dec.push(r);
    else if (r.fields["Rolle"] === "Shadow") slot.sha.push(r);
    byAsset.set(aid, slot);
  }
  const conf: Record<string, Record<string, { n: number; assets: string[]; tags: Record<string, number> }>> = {
    model: {}, expression: {}, depiction: {},
  };
  for (const [aid, s] of byAsset) {
    const af = map.get(aid);
    if (!af) continue;
    for (const ax of AXES) {
      const decOff = s.dec.some((r) => r.fields[ax.axis] === "Off");
      const shaOff = s.sha.some((r) => r.fields[ax.axis] === "Off");
      if (!decOff || !shaOff) continue;
      const id = af[KEYMAP[ax.kind]];
      if (!id) continue;
      const c = conf[ax.kind][id] = conf[ax.kind][id] ?? { n: 0, assets: [], tags: {} };
      c.n++;
      c.assets.push(aid);
      for (const r of [...s.dec, ...s.sha]) {
        for (const t of r.fields[ax.fail] ?? []) c.tags[t] = (c.tags[t] ?? 0) + 1;
      }
    }
  }
  const flags = Object.entries(conf).flatMap(([kind, o]) =>
    Object.entries(o).map(([id, v]) => ({
      kind, id, bestaetigt: v.n, assets: v.assets,
      gruende: Object.entries(v.tags).sort((a: any, b: any) => b[1] - a[1]).map(([t]) => t),
    }))).sort((a, b) => b.bestaetigt - a.bestaetigt);

  const shape = (o: Record<string, any>, kind: string) =>
    Object.entries(o).map(([id, v]) => {
      const rate = v.ok / v.n;
      return {
        id, n: v.n, ok: v.ok, rate: Math.round(rate * 100),
        bestaetigt: conf[kind][id]?.n ?? 0,
        vorschlag: rate >= 0.8 ? "Traegt" : rate >= 0.5 ? "Bedingt" : "Traegt nicht",
        topGrund: Object.entries(v.tags).sort((a: any, b: any) => b[1] - a[1])[0]?.[0] ?? null,
      };
    }).sort((a, b) => a.rate - b.rate);

  return json({
    model: shape(acc.model, "model"),
    expression: shape(acc.expression, "expression"),
    depiction: shape(acc.depiction, "depiction"),
    flags,
  });
}

// ---------- Sketch-Review (format=sketches) ----------
// Design-Team-Abstimmung in SCA PRODUCT-LAB. Bewertet werden ARTWORKS —
// die Queue ist der Airtable-View "⭐ 1. Open for ranking (Max/Vuven)"
// (Pipeline-Schritt 1; welche Artworks anstehen, steuert das Team ueber
// diesen View). Kein Figma-Sync. Zwei gleichberechtigte Entscheider
// (Vuven, Max) voten blind; die Votes landen in den BESTEHENDEN Feldern
// "Vuven Rank"/"Max Rank" (Confirm=Yes, Reject=No):
//   beide Yes -> "App Review Ergebnis" = Confirmed (weiter zu Schritt 2,
//                Robert/Requesting — gesteuert durch die View-Filter)
//   beide No  -> Rejected (aussortiert)
//   uneins    -> Konflikt; /conflicts zeigt beide Votes, /resolve schreibt
//                die Einigung und vereinheitlicht beide Ranks.
// Kommentare > 3 Zeichen werden automatisch als Regel-Vorschlag (SKR-xx)
// in "Sketch Rules" gesammelt — Futter fuers Design-Brain; Max/Vuven
// bestaetigen/verwerfen per Status in Airtable.
const SK = {
  base: "appJr0gEyT3BUVr0A",     // SCA PRODUCT-LAB
  artworks: "tbl1LaUaqitf5OMyW",  // Tabelle "Artworks" (Queue-Quelle)
  view: "viwjoPLvEwk7aFl6z",      // View "⭐ 1. Open for ranking (Max/Vuven)"
  reviews: "tblByFgL2zJbJG3cP",   // Tabelle "Sketch Reviews"
  rules: "tblgRflphUBCOOt4o",     // Tabelle "Sketch Rules"
  reviewers: ["Vuven", "Max"],
  f: {
    autoId: "Auto-ID",
    desc: "Artwork-Description",
    tags: "Tags",
    image: "Attachments",
    notes: "Notes:",
    buyStatus: "buy process Status",
    result: "App Review Ergebnis",
    resultAt: "App Review Datum",
  },
};
// Votes leben in den bestehenden Ranking-Feldern der Artworks-Tabelle.
const skVoteField = (reviewer: string) => `${reviewer} Rank`;
const skToRank = (verdict: string) => (verdict === "Confirm" ? "Yes" : "No");
const skToVerdict = (rank: any) => (rank === "Yes" ? "Confirm" : rank === "No" ? "Reject" : null);

function skShape(r: any) {
  const f = r.fields ?? {};
  const img = f[SK.f.image]?.[0];
  return {
    recordId: r.id,
    id: `ART-${f[SK.f.autoId] ?? "?"}`,
    name: String(f[SK.f.desc] ?? "").trim(),
    concept: (f[SK.f.tags] ?? []).join(" · "),
    date: String(r.createdTime ?? "").slice(0, 10) || null,
    image: img?.thumbnails?.large?.url ?? img?.url ?? null,
    imageFull: img?.url ?? null,
    votes: { Vuven: skToVerdict(f[skVoteField("Vuven")]), Max: skToVerdict(f[skVoteField("Max")]) },
    result: f[SK.f.result] ?? null,
    status: f[SK.f.buyStatus] ?? null,
  };
}
function skFieldParams(): string {
  const names = [
    SK.f.autoId, SK.f.desc, SK.f.tags, SK.f.image, SK.f.buyStatus,
    skVoteField("Vuven"), skVoteField("Max"), SK.f.result,
  ];
  return names.map((n) => `fields[]=${encodeURIComponent(n)}`).join("&");
}

// Offene Artworks fuer einen Reviewer: im Ranking-View, Bild da, eigener Rank leer.
async function skQueue(req: Request) {
  const reviewer = new URL(req.url).searchParams.get("reviewer") ?? "";
  if (!SK.reviewers.includes(reviewer)) {
    return json({ error: `reviewer muss ${SK.reviewers.join("|")} sein` }, 400);
  }
  const formula = `AND({${SK.f.image}}!='', {${skVoteField(reviewer)}}='')`;
  const recs = await atAll(
    SK.base, SK.artworks,
    `view=${SK.view}&filterByFormula=${encodeURIComponent(formula)}&${skFieldParams()}` +
      `&sort[0][field]=${encodeURIComponent(SK.f.autoId)}&sort[0][direction]=asc`,
  );
  return json({ sketches: recs.map(skShape) });
}

async function skReview(req: Request) {
  const b = await req.json();
  for (const k of ["recordId", "reviewer", "verdict"]) {
    if (!b[k]) return json({ error: `${k} fehlt` }, 400);
  }
  if (!SK.reviewers.includes(b.reviewer)) return json({ error: "reviewer muss Vuven|Max sein" }, 400);
  if (!["Confirm", "Reject"].includes(b.verdict)) return json({ error: "verdict muss Confirm|Reject sein" }, 400);

  const sk = await at(SK.base, `${SK.artworks}/${b.recordId}`);
  if (sk.fields?.[skVoteField(b.reviewer)]) {
    return json({ error: `${b.reviewer} hat dieses Artwork bereits bewertet.` }, 409);
  }
  const title = `ART-${sk.fields?.[SK.f.autoId] ?? b.recordId}`;

  const rec = await atCreate(SK.base, SK.reviews, [{ fields: {
    Review: `${title} — ${b.reviewer}`,
    Artwork: [b.recordId],
    "Sketch Record ID": b.recordId,
    Reviewer: b.reviewer,
    Votum: b.verdict,
    "Feedback Tags": b.tags ?? [],
    Kommentar: b.comment ?? "",
    Datum: new Date().toISOString(),
  } }]);

  // Vote in den bestehenden Rank-Feldern vermerken (Confirm=Yes, Reject=No);
  // liegt der andere Rank schon vor -> Konsens-Logik. Die Ranks selbst sind
  // der Prozess-Trigger fuer die nachgelagerten Pipeline-Views (Robert etc.).
  const rank = skToRank(b.verdict);
  const patch: any = { [skVoteField(b.reviewer)]: rank };
  const other = SK.reviewers.find((r) => r !== b.reviewer)!;
  const otherRank = sk.fields?.[skVoteField(other)] ?? null;
  let result: string | null = null;
  if (otherRank) {
    result = otherRank === rank ? (rank === "Yes" ? "Confirmed" : "Rejected") : "Konflikt";
    patch[SK.f.result] = result;
    patch[SK.f.resultAt] = new Date().toISOString();
  }
  await atPatch(SK.base, SK.artworks, [{ id: b.recordId, fields: patch }]);

  // Substanzielle Kommentare (Confirm UND Reject) werden Regel-Vorschlaege —
  // Ziel ist, moeglichst viele Learnings einzusammeln.
  let ruleId: string | null = null;
  if ((b.comment ?? "").trim().length > 3) {
    try {
      ruleId = await skAddRule(String(b.comment).trim(), `Sketch-Review ${title} · ${b.reviewer} (${b.verdict})`);
    } catch (e) {
      console.log(`[sk-rules] Vorschlag fehlgeschlagen: ${String(e)}`);
    }
  }
  return json({ ok: true, reviewId: rec[0].id, result, ...(ruleId ? { ruleProposal: ruleId } : {}) });
}

async function skAddRule(text: string, quelle: string): Promise<string> {
  const rules = await atAll(SK.base, SK.rules, "fields[]=Rule%20ID");
  const seq = rules.reduce((m, r) => {
    const n = parseInt(String(r.fields["Rule ID"] ?? "").split("-")[1] ?? "0", 10);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0) + 1;
  const id = `SKR-${String(seq).padStart(2, "0")}`;
  await atCreate(SK.base, SK.rules, [{ fields: {
    "Rule ID": id,
    Regel: text,
    Bereich: "Allgemein",
    Status: "Vorschlag",
    Quelle: quelle,
    Erstellt: new Date().toISOString().slice(0, 10),
  } }]);
  return id;
}

// Undo: Review-Record loeschen, Rank-Feld leeren; ein bereits berechnetes
// Ergebnis wird zurueckgenommen (das Artwork faellt damit zurueck in den
// Ranking-View).
async function skUnreview(req: Request) {
  const b = await req.json();
  if (!b.reviewId) return json({ error: "reviewId fehlt" }, 400);
  const rec = await at(SK.base, `${SK.reviews}/${b.reviewId}`);
  const reviewer = rec?.fields?.["Reviewer"];
  const recordId = b.recordId ?? rec?.fields?.["Sketch Record ID"];
  await at(SK.base, `${SK.reviews}/${b.reviewId}`, { method: "DELETE" });
  if (!reviewer || !recordId) return json({ ok: true, note: "Review geloescht, Artwork unveraendert." });

  const sk = await at(SK.base, `${SK.artworks}/${recordId}`);
  const patch: any = { [skVoteField(reviewer)]: null };
  if (sk.fields?.[SK.f.result]) {
    patch[SK.f.result] = null;
    patch[SK.f.resultAt] = null;
  }
  await atPatch(SK.base, SK.artworks, [{ id: recordId, fields: patch }]);
  return json({ ok: true });
}

// Konflikte: beide haben gevotet, aber unterschiedlich. Liefert beide Votes
// inkl. Tags/Kommentaren zum Ausdiskutieren.
async function skConflicts() {
  // Ohne View: Konflikt-Artworks sind bereits beidseitig geranked und
  // koennen aus dem Ranking-View herausgefallen sein.
  const formula = `{${SK.f.result}}='Konflikt'`;
  const sks = await atAll(SK.base, SK.artworks, `filterByFormula=${encodeURIComponent(formula)}&${skFieldParams()}`);
  if (!sks.length) return json({ conflicts: [] });
  const revs = await atAll(SK.base, SK.reviews);
  const byId = new Map<string, any[]>();
  for (const r of revs) {
    const sid = r.fields?.["Sketch Record ID"];
    if (!sid) continue;
    if (!byId.has(sid)) byId.set(sid, []);
    byId.get(sid)!.push(r);
  }
  return json({
    conflicts: sks.map((s) => ({
      ...skShape(s),
      reviews: (byId.get(s.id) ?? []).map((r) => ({
        reviewId: r.id,
        reviewer: r.fields?.["Reviewer"] ?? "",
        verdict: r.fields?.["Votum"] ?? "",
        tags: r.fields?.["Feedback Tags"] ?? [],
        comment: r.fields?.["Kommentar"] ?? "",
        date: r.fields?.["Datum"] ?? null,
      })),
    })),
  });
}

// Einigung nach Diskussion: vereinheitlicht BEIDE Ranks auf die finale
// Entscheidung (damit laeuft das Artwork sauber in die Pipeline weiter),
// setzt das Ergebnis und haengt die Klaerungs-Notiz ans Notes-Feld.
async function skResolve(req: Request) {
  const b = await req.json();
  for (const k of ["recordId", "verdict"]) {
    if (!b[k]) return json({ error: `${k} fehlt` }, 400);
  }
  if (!["Confirm", "Reject"].includes(b.verdict)) return json({ error: "verdict muss Confirm|Reject sein" }, 400);
  const sk = await at(SK.base, `${SK.artworks}/${b.recordId}`);
  const confirmed = b.verdict === "Confirm";
  const rank = skToRank(b.verdict);
  const patch: any = {
    [skVoteField("Vuven")]: rank,
    [skVoteField("Max")]: rank,
    [SK.f.result]: confirmed ? "Confirmed" : "Rejected",
    [SK.f.resultAt]: new Date().toISOString(),
  };
  if ((b.comment ?? "").trim()) {
    const old = String(sk.fields?.[SK.f.notes] ?? "").trim();
    const line = `Konflikt geklaert (${new Date().toISOString().slice(0, 10)}, ${confirmed ? "Yes" : "No"}): ${String(b.comment).trim()}`;
    patch[SK.f.notes] = old ? `${old}\n${line}` : line;
  }
  await atPatch(SK.base, SK.artworks, [{ id: b.recordId, fields: patch }]);
  let ruleId: string | null = null;
  if ((b.comment ?? "").trim().length > 3) {
    try {
      const title = `ART-${sk.fields?.[SK.f.autoId] ?? b.recordId}`;
      ruleId = await skAddRule(String(b.comment).trim(), `Konflikt-Klaerung ${title} (${b.verdict})`);
    } catch (e) {
      console.log(`[sk-rules] Vorschlag fehlgeschlagen: ${String(e)}`);
    }
  }
  return json({ ok: true, result: patch[SK.f.result], ...(ruleId ? { ruleProposal: ruleId } : {}) });
}

async function skRules() {
  const recs = await atAll(SK.base, SK.rules, "sort[0][field]=Rule%20ID&sort[0][direction]=asc");
  return json({
    rules: recs
      .filter((r) => r.fields["Status"] !== "Verworfen")
      .map((r) => ({
        id: r.fields["Rule ID"] ?? "",
        regel: r.fields["Regel"] ?? "",
        bereich: r.fields["Bereich"] ?? "Allgemein",
        status: r.fields["Status"] ?? "Vorschlag",
        quelle: r.fields["Quelle"] ?? "",
      })),
  });
}

// Bekannte Feedback-Tags (Select-Optionen der Reviews-Tabelle), damit selbst
// angelegte Freitext-Tags auf allen Geraeten als Chips erscheinen.
async function skFailtags() {
  try {
    const r = await fetch(`https://api.airtable.com/v0/meta/bases/${SK.base}/tables`, {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
    });
    if (r.ok) {
      const b = await r.json();
      const tbl = (b.tables ?? []).find((t: any) => t.id === SK.reviews);
      const fld = tbl?.fields?.find((x: any) => x.name === "Feedback Tags");
      return json({ source: "meta", tags: (fld?.options?.choices ?? []).map((c: any) => c.name) });
    }
  } catch (_e) { /* Fallback unten */ }
  const revs = await atAll(SK.base, SK.reviews, "fields[]=Feedback%20Tags");
  const tags: string[] = [];
  for (const r of revs) for (const t of r.fields["Feedback Tags"] ?? []) if (!tags.includes(t)) tags.push(t);
  return json({ source: "reviews", tags });
}

// Diagnose: prueft den Airtable-Zugriff (PAT!) und liefert Queue-Staende.
async function skProbe() {
  const t0 = Date.now();
  const count = async (formula: string, view = "") =>
    (await atAll(
      SK.base, SK.artworks,
      `${view ? `view=${view}&` : ""}filterByFormula=${encodeURIComponent(formula)}&fields[]=${encodeURIComponent(SK.f.autoId)}`,
    )).length;
  const [qV, qM, conflicts] = await Promise.all([
    count(`AND({${SK.f.image}}!='', {${skVoteField("Vuven")}}='')`, SK.view),
    count(`AND({${SK.f.image}}!='', {${skVoteField("Max")}}='')`, SK.view),
    count(`{${SK.f.result}}='Konflikt'`),
  ]);
  const revs = await atAll(SK.base, SK.reviews, "fields[]=Reviewer");
  const rules = await atAll(SK.base, SK.rules, "fields[]=Rule%20ID");
  return json({
    airtableOk: true,
    ms: Date.now() - t0,
    queue: { Vuven: qV, Max: qM },
    conflicts,
    reviews: revs.length,
    rules: rules.length,
  });
}

// ---------- Router ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const route = new URL(req.url).pathname.split("/").filter(Boolean).pop();
  if (!REVIEW_KEY || req.headers.get("x-review-key") !== REVIEW_KEY) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!AIRTABLE_PAT) {
    return json({ error: "Secret fehlt: AIRTABLE_PAT nicht gesetzt." }, 500);
  }
  try {
    // Sonderformat sketches: eigener Datenfluss ohne Figma, siehe SK-Block.
    if (new URL(req.url).searchParams.get("format") === "sketches") {
      if (route === "queue") return await skQueue(req);
      if (route === "review" && req.method === "POST") return await skReview(req);
      if (route === "unreview" && req.method === "POST") return await skUnreview(req);
      if (route === "conflicts") return await skConflicts();
      if (route === "resolve" && req.method === "POST") return await skResolve(req);
      if (route === "rules") return await skRules();
      if (route === "failtags") return await skFailtags();
      if (route === "probe") return await skProbe();
      return json({ error: `Route /${route} gibt es fuer format=sketches nicht (kein Figma-Sync).` }, 400);
    }
    if (route === "sync" && req.method === "POST") return await sync(req);
    if (route === "probe") return await probe(req);
    if (route === "layout") return await layout(req);
    if (route === "render") return await render(req);
    if (route === "vocab") return req.method === "POST" ? await addVocab(req) : await vocab();
    if (route === "assign" && req.method === "POST") return await assign(req);
    if (route === "queue") return await queue(req);
    if (route === "review" && req.method === "POST") return await review(req);
    if (route === "unreview" && req.method === "POST") return await unreview(req);
    if (route === "rules") return await rules();
    if (route === "failtags") return await failtags(req);
    if (route === "baseline" && req.method === "POST") return await baseline(req);
    if (route === "rollup") return await rollup();
    return json({ error: "unknown route", route }, 404);
  } catch (e) {
    console.log(`[error] ${String(e)}`);
    return json({ error: String(e) }, 500);
  }
});
