// Stay Cold · Creative Review v3 — Figma Board -> Airtable
// Auth: eigener Header x-review-key (deshalb verify_jwt=false).
//
// ROUTEN
//   POST /sync     Board ziehen, nach Board-Struktur (Sections/Frames/Groups) gruppieren,
//                  lose Bilder raeumlich clustern, Assets anlegen (?limit=N, ?gap=N)
//   GET  /probe    Diagnose: Figma-Fetch messen (?depth=N)
//   GET  /layout   Diagnose: Bounding-Boxes der Bilder in der Spalte
//   GET  /vocab    Models / Expressions / Depictions
//   POST /vocab    neuen Vokabular-Eintrag anlegen  {kind,name,category?}
//   POST /assign   Cluster zuordnen                 {cluster,model,expression,depiction}
//   GET  /queue    offene Assets fuer die App
//   POST /review   ein Einzelbild-Review
//   POST /unreview Review zuruecknehmen {reviewId, recordId?}
//   GET  /rules    Creative-Regeln (Fest + Vorschlag)
//   POST /baseline aktuellen Board-Stand einfrieren (wird vom Sync uebersprungen)
//   GET  /rollup   Trefferquoten pro Entitaet

const FIGMA_FILE = "pPSeVQKzDjuHv3Gf8wDp3u";
const COLUMN = "scenes for approval";
const BASE = "appKktIMvTU1AqOEN";
const T = {
  models: "tblRUZ99u9ApeOdMu",
  expressions: "tbl1RQkCERHpz8Nug",
  depictions: "tbly4pX6YMtAfHYyz",
  assets: "tbl2rpHgH2D0hebQ4",
  reviews: "tbltxjO4jLxWbqTRy",
  regeln: "tblZIQ6vTEQGwD2fn",
};

// Neuer Token nach Rate-Limit-Sperre des ersten; II hat Vorrang.
const FIGMA_TOKEN = Deno.env.get("FIGMA_TOKEN_II") ?? Deno.env.get("FIGMA_TOKEN") ?? "";
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
async function at(path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(`https://api.airtable.com/v0/${BASE}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${AIRTABLE_PAT}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const b = await r.json();
  if (!r.ok) throw new Error(`Airtable ${r.status}: ${JSON.stringify(b)}`);
  return b;
}
async function atAll(table: string, params = ""): Promise<any[]> {
  const out: any[] = [];
  let offset = "";
  do {
    const q = new URLSearchParams(params);
    if (offset) q.set("offset", offset);
    const p = await at(`${table}?${q}`);
    out.push(...p.records);
    offset = p.offset ?? "";
  } while (offset);
  return out;
}
async function atCreate(table: string, rows: any[]): Promise<any[]> {
  const made: any[] = [];
  for (let i = 0; i < rows.length; i += 10) {
    const r = await at(table, {
      method: "POST",
      body: JSON.stringify({ records: rows.slice(i, i + 10), typecast: true }),
    });
    made.push(...r.records);
  }
  return made;
}
async function atPatch(table: string, rows: any[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < rows.length; i += 10) {
    const r = await at(table, {
      method: "PATCH",
      body: JSON.stringify({ records: rows.slice(i, i + 10), typecast: true }),
    });
    n += r.records.length;
  }
  return n;
}

// ---------- Postgres (Baseline-Speicher via PostgREST) ----------
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

// ---------- Figma ----------
async function figma(path: string): Promise<any> {
  const r = await fetch(`https://api.figma.com/v1/${path}`, { headers: { "X-Figma-Token": FIGMA_TOKEN } });
  const b = await r.json();
  if (!r.ok) throw new Error(`Figma ${r.status}: ${JSON.stringify(b)}`);
  return b;
}

type N = { id: string; x: number; y: number; w: number; h: number; name: string; section?: string | null };

function walk(node: any, texts: any[], imgs: N[], section: string | null = null) {
  const bb = node?.absoluteBoundingBox;
  if (node?.type === "TEXT" && bb) texts.push({ t: String(node.characters ?? ""), x: bb.x, y: bb.y });
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

// Gemeinsame Vorstufe: Board holen, Spalte finden, Bilder filtern.
async function boardColumn() {
  const file = await figma(`files/${FIGMA_FILE}`);
  const texts: any[] = [], imgs: N[] = [];
  walk(file.document, texts, imgs);
  const head = texts.find((t) => t.t.trim().toLowerCase().includes(COLUMN));
  if (!head) return { error: json({ error: `Spalte "${COLUMN}" nicht im Board gefunden.` }, 404) };
  const rights = texts.filter((t) => t.x > head.x + 20).map((t) => t.x);
  const xMax = rights.length ? Math.min(...rights) - 40 : Infinity;
  const inCol = imgs.filter((n) => {
    const cx = n.x + n.w / 2;
    return cx > head.x - 120 && cx < xMax && n.y > head.y;
  });
  if (!inCol.length) return { error: json({ error: "Keine Bilder in der Spalte gefunden." }, 404) };
  return { inCol, texts: texts.length, imgs: imgs.length };
}

// ---------- Diagnose ----------
async function probe(req: Request) {
  const url = new URL(req.url);
  const depth = url.searchParams.get("depth");
  const t0 = Date.now();
  const file = await figma(`files/${FIGMA_FILE}${depth ? `?depth=${depth}` : ""}`);
  const fetchMs = Date.now() - t0;
  const texts: any[] = [], imgs: N[] = [];
  walk(file.document, texts, imgs);
  let nodes = 0;
  const count = (n: any) => { nodes++; for (const c of n?.children ?? []) count(c); };
  count(file.document);
  const head = texts.find((t) => t.t.trim().toLowerCase().includes(COLUMN));
  return json({
    depth: depth ?? "full",
    fetchMs,
    approxKB: Math.round(JSON.stringify(file).length / 1024),
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

async function layout() {
  const col = await boardColumn();
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

  mark("figma file fetch start");
  const col = await boardColumn();
  if ("error" in col) return col.error;
  const inCol = col.inCol!;
  mark(`walked: ${col.texts} texts, ${col.imgs} images, ${inCol.length} in column`);

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

  const existing = await atAll(T.assets, "fields[]=Figma Node ID&fields[]=Asset ID");
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
            "Asset ID": `AST-${String(++seq).padStart(4, "0")}`,
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

  const made = await atCreate(T.assets, payload);
  mark(`airtable created: ${made.length}`);
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
    const recs = await atAll(KIND[k].t);
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
  const recs = await atAll(k.t, `fields[]=${encodeURIComponent(ID_FIELD[b.kind])}`);
  const seq = recs.reduce((m, r) => {
    const n = parseInt(String(r.fields[ID_FIELD[b.kind]] ?? "").split("-")[1] ?? "0", 10);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0) + 1;
  const id = `${k.p}-${String(seq).padStart(2, "0")}`;
  const fields: any = { [ID_FIELD[b.kind]]: id, [k.label]: b.name, Urteil: "In Pruefung" };
  if (b.category) fields["Kategorie"] = b.category;
  await atCreate(k.t, [{ fields }]);
  return json({ id, name: b.name });
}

// ---------- Zuordnung pro Cluster ----------
async function assign(req: Request) {
  const b = await req.json();
  if (!b.cluster) return json({ error: "cluster fehlt" }, 400);
  const recs = await atAll(T.assets, "filterByFormula=" + encodeURIComponent(`{Cluster}="${b.cluster}"`));
  if (!recs.length) return json({ error: `Cluster ${b.cluster} hat keine Assets.` }, 404);
  const fields: any = {};
  if (b.model) fields["Model ID"] = b.model;
  if (b.expression) fields["Expression ID"] = b.expression;
  if (b.depiction) fields["Depiction ID"] = b.depiction;
  if (b.produkt) fields["Produkt"] = b.produkt;
  if (b.colorway) fields["Colorway"] = b.colorway;
  const n = await atPatch(T.assets, recs.map((r) => ({ id: r.id, fields })));
  return json({ cluster: b.cluster, updated: n });
}

// ---------- Queue ----------
// Mit ?reviewer=Name liefert die Queue alle Assets, die DIESE Person noch nicht
// bewertet hat (Decision und Shadows laufen parallel auf dieselben Assets).
// Ohne reviewer: altes Verhalten (Status Queued).
async function queue(req?: Request) {
  const reviewer = req ? new URL(req.url).searchParams.get("reviewer") : null;
  let recs;
  if (reviewer) {
    const all = await atAll(T.assets, "sort[0][field]=Asset ID&sort[0][direction]=asc");
    const revs = await atAll(
      T.reviews,
      "filterByFormula=" + encodeURIComponent(`{Reviewer}="${reviewer}"`) + "&fields[]=Asset ID",
    );
    const done = new Set(revs.map((r) => r.fields["Asset ID"]).filter(Boolean));
    recs = all.filter((r) => !done.has(r.fields["Asset ID"]));
  } else {
    recs = await atAll(
      T.assets,
      "filterByFormula=" + encodeURIComponent(`{Status}="Queued"`) +
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
const AXIS: Record<string, string> = {
  Ausdruck: "Fail Ausdruck",
  Model: "Fail Model",
  Produktdarstellung: "Fail Produktdarstellung",
};

async function review(req: Request) {
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
    Ausdruck: passt ? "Passt" : b.axis === "Ausdruck" ? "Off" : "Passt",
    Model: passt ? "Passt" : b.axis === "Model" ? "Off" : "Passt",
    Produktdarstellung: passt ? "Passt" : b.axis === "Produktdarstellung" ? "Off" : "Passt",
    Kommentar: b.comment ?? "",
    Sekunden: b.seconds ?? null,
    Session: b.session ?? "",
    "Reviewed at": new Date().toISOString(),
  };
  if (!passt && b.axis && AXIS[b.axis]) fields[AXIS[b.axis]] = b.tags ?? [];

  const rec = await atCreate(T.reviews, [{ fields }]);

  // Nur Decision schreibt den Asset-Status fort. Shadow aendert nichts.
  if (b.role === "Decision") {
    await atPatch(T.assets, [{ id: b.recordId, fields: { Status: passt ? "Passt" : "Abweichung" } }]);
  }

  // Positiver Decision-Kommentar (Max) => automatisch als Regel-Vorschlag
  // in die Regeln-Tabelle. Max bestaetigt/verwirft dort (Status).
  let ruleId: string | null = null;
  if (b.role === "Decision" && passt && (b.comment ?? "").trim().length > 3) {
    try {
      const regeln = await atAll(T.regeln, "fields[]=Regel ID");
      const seq = regeln.reduce((m, r) => {
        const n = parseInt(String(r.fields["Regel ID"] ?? "").split("-")[1] ?? "0", 10);
        return Number.isFinite(n) && n > m ? n : m;
      }, 0) + 1;
      ruleId = `REG-${String(seq).padStart(2, "0")}`;
      await atCreate(T.regeln, [{ fields: {
        "Regel ID": ruleId,
        Regel: String(b.comment).trim(),
        Achse: "Allgemein",
        Status: "Vorschlag",
        Quelle: `Review ${b.assetId} · ${b.reviewer}`,
        Erstellt: new Date().toISOString(),
      } }]);
    } catch (e) {
      console.log(`[rules] Vorschlag fehlgeschlagen: ${String(e)}`);
      ruleId = null;
    }
  }
  return json({ ok: true, reviewId: rec[0].id, ...(ruleId ? { ruleProposal: ruleId } : {}) });
}

// ---------- Baseline ----------
// Friert den aktuellen Board-Stand ein: alle Bilder in der Spalte, die noch
// nicht als Asset importiert sind, werden kuenftig vom Sync uebersprungen.
async function baseline() {
  const col = await boardColumn();
  if ("error" in col) return col.error;
  const existing = await atAll(T.assets, "fields[]=Figma Node ID");
  const imported = new Set(existing.map((r) => r.fields["Figma Node ID"]).filter(Boolean));
  const toSkip = col.inCol!.filter((n) => !imported.has(n.id)).map((n) => ({ node_id: n.id }));
  for (let i = 0; i < toSkip.length; i += 500) {
    await pg("sync_baseline", { method: "POST", body: JSON.stringify(toSkip.slice(i, i + 500)) });
  }
  return json({ baselined: toSkip.length, importiert: imported.size, boardGesamt: col.inCol!.length });
}

// ---------- Regeln ----------
async function rules() {
  const recs = await atAll(T.regeln, "sort[0][field]=Regel ID&sort[0][direction]=asc");
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
// Nimmt ein Review zurueck (App-Funktion "Letztes zuruecknehmen").
// Bei Decision-Reviews wird der Asset-Status wieder auf Queued gesetzt.
async function unreview(req: Request) {
  const b = await req.json();
  if (!b.reviewId) return json({ error: "reviewId fehlt" }, 400);
  const rec = await at(`${T.reviews}/${b.reviewId}`);
  await at(`${T.reviews}/${b.reviewId}`, { method: "DELETE" });
  if (rec?.fields?.["Rolle"] === "Decision" && b.recordId) {
    await atPatch(T.assets, [{ id: b.recordId, fields: { Status: "Queued" } }]);
  }
  return json({ ok: true });
}

// ---------- Rollup ----------
async function rollup() {
  const revs = await atAll(T.reviews);
  const assets = await atAll(T.assets, "fields[]=Asset ID&fields[]=Model ID&fields[]=Expression ID&fields[]=Depiction ID");
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

// ---------- Router ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const route = new URL(req.url).pathname.split("/").filter(Boolean).pop();
  if (!REVIEW_KEY || req.headers.get("x-review-key") !== REVIEW_KEY) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!FIGMA_TOKEN || !AIRTABLE_PAT) {
    return json({ error: "Secrets fehlen: FIGMA_TOKEN und/oder AIRTABLE_PAT nicht gesetzt." }, 500);
  }
  try {
    if (route === "sync" && req.method === "POST") return await sync(req);
    if (route === "probe") return await probe(req);
    if (route === "layout") return await layout();
    if (route === "render") return await render(req);
    if (route === "vocab") return req.method === "POST" ? await addVocab(req) : await vocab();
    if (route === "assign" && req.method === "POST") return await assign(req);
    if (route === "queue") return await queue(req);
    if (route === "review" && req.method === "POST") return await review(req);
    if (route === "unreview" && req.method === "POST") return await unreview(req);
    if (route === "rules") return await rules();
    if (route === "baseline" && req.method === "POST") return await baseline();
    if (route === "rollup") return await rollup();
    return json({ error: "unknown route", route }, 404);
  } catch (e) {
    console.log(`[error] ${String(e)}`);
    return json({ error: String(e) }, 500);
  }
});
