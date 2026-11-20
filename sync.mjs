// Synchro Wobee -> pub.json (lecture seule). Lancé par .github/workflows/sync.yml
// Identifiants du compte robot dans les secrets GitHub : WOBEE_LOGIN, WOBEE_PASSWORD
import fs from "node:fs";

const API = "https://prod-api.wobee.fr/graphql";
const HEAD = {
  "content-type": "application/json",
  tenant: "madeca.wobee.fr",
  site: "4b022902-d9c4-4337-854c-de55b5ed73a0",
  "x-wobee-auth": "1",
  origin: "https://madeca.wobee.fr",
  referer: "https://madeca.wobee.fr/",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  "apollo-require-preflight": "true",
};

// Racines à parcourir : Bibliothèque TEST + Bibliothèque actuelle
const ROOT_TEST = "8d526d1d-4bc0-4771-8885-1f87dcb7b478"; // Bibliothèque Formations

let token = null;
async function gql(op, query, variables) {
  const headers = { ...HEAD };
  if (token) headers.authorization = "Bearer " + token;
  const r = await fetch(API, { method: "POST", headers, body: JSON.stringify({ operationName: op, query, variables }) });
  const j = await r.json();
  if (j.errors) throw new Error(op + " : " + JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

const SIGNIN = `mutation Signin($login: String!, $password: String!) { Signin(login: $login, password: $password) { accessToken } }`;
const LIST = `query GetCategoryAndPostAppList($categoryParentUid: String!) { GetCategoryAndPostAppList(categoryParentUid: $categoryParentUid) { categories { totalCount data { uid } } posts { totalCount data { id uid status author { firstname lastname } publicationDate reactions postContents { language title shortValue } } } } }`;

// Catégories de la Bibliothèque : retrouvées à chaque passage en comparant leurs noms à l'arborescence de index.html
const html = fs.readFileSync("index.html", "utf8");
const CAT = { B: { _root: ROOT_TEST } };
const UID2CODE = {};
const CATS_Q = `query GetCategoryAndPostAppList($categoryParentUid: String!) { GetCategoryAndPostAppList(categoryParentUid: $categoryParentUid) { categories { data { uid translations { locale fields } } } } }`;
async function catMap() {
  const kids = async (uid) => (await gql("GetCategoryAndPostAppList", CATS_Q, { categoryParentUid: uid })).GetCategoryAndPostAppList.categories.data.map((c) => ({ uid: c.uid, n: norm(((c.translations.find((t) => t.locale === "fr") || {}).fields || {}).label || "").trim() }));
  async function walk(nodes, uid) {
    const ks = await kids(uid);
    for (const n of nodes) {
      if (Array.isArray(n)) continue;
      const k = ks.find((x) => x.n === norm(n.n).trim());
      if (!k) { console.warn("Catégorie introuvable : " + n.c + " " + n.n); continue; }
      CAT.B[n.c] = k.uid; UID2CODE[k.uid] = n.c;
      if (n.k && n.k.some((x) => !Array.isArray(x))) await walk(n.k, k.uid);
    }
  }
  await walk(TREE, ROOT_TEST);
}

// Rattachements manuels à un sujet précis (uid du post -> code sujet)
const OVR = fs.existsSync("refs.json") ? JSON.parse(fs.readFileSync("refs.json", "utf8")) : {};

const short = (a) => (a ? `${a.firstname || ""} ${(a.lastname || "").slice(0, 1)}.`.trim() : "");
const fr = (p) => p.postContents.find((c) => c.language === "fr") || p.postContents[0] || {};
const ddmmyyyy = (iso) => { const d = new Date(iso); return [d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCFullYear()].map((n, i) => String(n).padStart(i < 2 ? 2 : 4, "0")).join("/"); };

async function crawl(root) {
  const out = [];
  const queue = [[root, null]];
  const seen = new Set();
  while (queue.length) {
    const [uid, parentCode] = queue.shift();
    if (seen.has(uid)) continue;
    seen.add(uid);
    const code = UID2CODE[uid] || parentCode;
    const d = (await gql("GetCategoryAndPostAppList", LIST, { categoryParentUid: uid })).GetCategoryAndPostAppList;
    if (d.posts.totalCount > d.posts.data.length) console.warn(`Catégorie ${uid} : ${d.posts.totalCount} posts, ${d.posts.data.length} lus`);
    for (const c of d.categories.data) queue.push([c.uid, code]);
    if (!code) continue;
    for (const p of d.posts.data) {
      if (p.status !== "published") continue;
      const c = fr(p);
      out.push({
        t: c.title || "(sans titre)",
        ref: OVR[p.uid] || code,
        a: short(p.author),
        d: ddmmyyyy(p.publicationDate),
        r: (c.shortValue || "").slice(0, 300),
        id: p.uid,
        kind: "F",
        lk: (p.reactions && p.reactions.Like) || 0,
        cm: (p.reactions && p.reactions.Comment) || 0,
        iso: p.publicationDate,
      });
    }
  }
  return out;
}

// --- Apprendre et transmettre : likes/commentaires des pistes + "Je prends" dans les commentaires ---
const ROOT_A = "ab68ee5c-4047-4ff7-9928-19608ad16a0f";
const COMMENTS = `query GetCommentAppList($destinationId: Int!, $destinationType: CommentDestinationType!, $limit: Int!, $offset: Int!) { GetCommentAppList(destinationId: $destinationId, destinationType: $destinationType, limit: $limit, offset: $offset) { totalCount data { id value user { firstname lastname } } } }`;
const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/<[^>]+>/g, " ");
const TAKE = /\bje (la |le |l'|l )?(prends|prend|m'en occupe|m en occupe|m'y colle)\b/;
const DROP = /\bje (la |le |l'|l )?(lache|libere|rends|laisse|abandonne)\b/;
async function crawlA() {
  const stats = {}, takes = {};
  const queue = [ROOT_A], seen = new Set();
  while (queue.length) {
    const uid = queue.shift();
    if (seen.has(uid)) continue;
    seen.add(uid);
    const d = (await gql("GetCategoryAndPostAppList", LIST, { categoryParentUid: uid })).GetCategoryAndPostAppList;
    for (const c of d.categories.data) queue.push(c.uid);
    for (const p of d.posts.data) {
      const lk = (p.reactions && p.reactions.Like) || 0, cm = (p.reactions && p.reactions.Comment) || 0;
      stats[p.uid] = { lk, cm };
      if (!cm) continue;
      const list = (await gql("GetCommentAppList", COMMENTS, { destinationId: p.id, destinationType: "Post", limit: 100, offset: 0 })).GetCommentAppList.data;
      let who = null;
      for (const c of [...list].sort((a, b) => a.id - b.id)) {
        const v = " " + norm(c.value) + " ";
        if (TAKE.test(v)) who = short(c.user);
        else if (DROP.test(v) && who === short(c.user)) who = null;
      }
      if (who) takes[p.uid] = { n: who };
    }
  }
  return { stats, takes };
}

// --- Tableau "Dépôt des ressources" : statut des tickets ---
const BOARD = "07b46184-7db5-44a0-8cd2-3559a0e984cd";
const BOARD_Q = `query GetBoardApp($boardUid: String!) { GetBoardApp(boardUid: $boardUid) { columns { uid translations { locale fields } } } }`;
const TICKETS_Q = `query GetBoardTicketAppList($boardUid: String!) { GetBoardTicketAppList(boardUid: $boardUid) { ticketList { uid boardColumnUid isArchived internalTicket { title } responsibles { firstname lastname } author { firstname lastname } } } }`;
async function readBoard() {
  const cols = {};
  for (const c of (await gql("GetBoardApp", BOARD_Q, { boardUid: BOARD })).GetBoardApp.columns) {
    const t = c.translations.find((x) => x.locale === "fr") || c.translations[0] || { fields: {} };
    cols[c.uid] = t.fields.label || t.fields.name || "";
  }
  const out = [];
  for (const t of (await gql("GetBoardTicketAppList", TICKETS_Q, { boardUid: BOARD })).GetBoardTicketAppList.ticketList) {
    if (t.isArchived || !t.internalTicket) continue;
    const resp = (t.responsibles && t.responsibles[0]) || t.author;
    out.push({ t: t.internalTicket.title, c: cols[t.boardColumnUid] || "", r: short(resp) });
  }
  return out;
}


// --- Brouillons automatiques : ticket « Ressource validée » -> actu en attente de validation ---
const STATE = fs.existsSync("drafts.json") ? JSON.parse(fs.readFileSync("drafts.json", "utf8")) : {};
for (const v of Object.values(STATE)) if (v.post && v.code) OVR[v.post] = v.code;
const TREE = JSON.parse(html.slice(html.indexOf("const TREE=") + 11, html.indexOf(";\nconst PUB=")));
const TOP = {}, BYNAME = {};
(function w(n, sc) { if (Array.isArray(n)) { TOP[n[0]] = { t: n[1], sc, lv: n[2], ty: n[3] }; BYNAME[norm(n[1]).replace(/\s+/g, " ").trim()] = n[0]; return; } (n.k || []).forEach((k) => w(k, n.c)); })({ k: TREE });
const APPR_URL = "https://madeca.wobee.fr/app/content/ec9e3565-bd32-499e-a881-3d33d3ac4399";
const TFULL_Q = `query GetBoardTicketAppList($boardUid: String!) { GetBoardTicketAppList(boardUid: $boardUid) { ticketList { uid boardColumnUid isArchived description internalTicket { title } attachments { uid name mimeType } responsibles { uid } author { uid } } } }`;
const TCOM_Q = `query GetTicketCommentAppList($ticketUid: String!) { GetTicketCommentAppList(ticketUid: $ticketUid) { attachments { uid name mimeType } } }`;
const TCOM_ADD = `mutation CreateTicketCommentApp($ticketUid: String!, $value: String!, $filesToUpload: [Upload!]!) { CreateTicketCommentApp(ticketUid: $ticketUid, value: $value, filesToUpload: $filesToUpload) { id } }`;
const CREATE_POST = `mutation CreatePostConfig($authorUid: String!, $publicationDate: DateTime!, $status: PostStatusType!, $categoriesUid: [String!]!, $postContents: [PostContentConfigInput!]!, $sendNotification: Boolean!, $hideDuringPreboarding: Boolean!, $criteriaSelections: [CriteriaSelectionInput!]!) { CreatePostConfig(authorUid: $authorUid, publicationDate: $publicationDate, status: $status, categoriesUid: $categoriesUid, postContents: $postContents, sendNotification: $sendNotification, hideDuringPreboarding: $hideDuringPreboarding, criteriaSelections: $criteriaSelections) { uid } }`;
const LVN = { F: "Fondamentaux", A: "Avancé", E: "Expert" };
async function makeDrafts() {
  let cols = {}, list = [];
  try {
    for (const c of (await gql("GetBoardApp", BOARD_Q, { boardUid: BOARD })).GetBoardApp.columns) { const t = c.translations.find((x) => x.locale === "fr") || c.translations[0] || { fields: {} }; cols[c.uid] = t.fields.label || ""; }
    list = (await gql("GetBoardTicketAppList", TFULL_Q, { boardUid: BOARD })).GetBoardTicketAppList.ticketList;
  } catch (e) { console.warn("Brouillons : " + e.message); return; }
  let n = 0;
  for (const t of list) {
    const col = norm(cols[t.boardColumnUid] || "");
    if (t.isArchived || !t.internalTicket || STATE[t.uid] || !col.includes("ressource validee")) continue;
    const raw = t.internalTicket.title.replace(/^\s*(je prends|depot|dépôt|proposition)\s*:\s*/i, "");
    const m = raw.match(/\(([A-Z]{2,3}-[A-Z0-9-]+)\)\s*$/);
    const title = raw.replace(/\s*\([A-Z]{2,3}-[A-Z0-9-]+\)\s*$/, "").trim();
    const code = (m && TOP[m[1]] ? m[1] : null) || BYNAME[norm(title).replace(/\s+/g, " ").trim()] || null;
    const top = code ? TOP[code] : null;
    const catUid = (top && (CAT.B[top.sc] || CAT.B[top.sc.split("-").slice(0, 2).join("-")])) || CAT.B._root;
    const files = [...(t.attachments || [])];
    try { for (const c of (await gql("GetTicketCommentAppList", TCOM_Q, { ticketUid: t.uid })).GetTicketCommentAppList) files.push(...(c.attachments || [])); } catch (e) {}
    const id = () => Math.random().toString(36).slice(2, 12);
    const desc = String(t.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const blocks = [{ id: id(), type: "paragraph", data: { text: `<a href="${APPR_URL}">← Retour à la carte des sujets</a>` } }];
    if (top) blocks.push({ id: id(), type: "paragraph", data: { text: `<b>${escH(top.ty)}</b> · ${LVN[top.lv] || ""}` } });
    if (desc) blocks.push({ id: id(), type: "paragraph", data: { text: escH(desc).slice(0, 1500) } });
    for (const f of files) { const file = { title: f.name, url: `https://prod-api.wobee.fr/uploaded-file/${f.uid}` }; blocks.push({ id: id(), type: "attaches", data: { file, title: f.name } }); if (/pdf/i.test((f.mimeType || "") + f.name)) blocks.push({ id: id(), type: "attaches_pdf", data: { file, title: f.name } }); }
    blocks.push({ id: id(), type: "alert", data: { type: "primary", align: "left", message: "N'hésite pas à laisser un commentaire pour dire ce que tu en penses !" } });
    const author = (t.responsibles && t.responsibles[0]) || t.author;
    const vars = { authorUid: author.uid, publicationDate: "2020-01-15T09:00:00.000Z", status: "pending_review", categoriesUid: [catUid], postContents: [{ language: "fr", title, shortValue: desc.slice(0, 200) || (top ? `${top.ty} · ${LVN[top.lv] || ""}` : "Nouvelle formation"), value: JSON.stringify({ time: Date.now(), blocks, version: "2.31.6" }) }], sendNotification: false, hideDuringPreboarding: false, criteriaSelections: [] };
    try {
      let r;
      try { r = (await gql("CreatePostConfig", CREATE_POST, vars)).CreatePostConfig; }
      catch (e) { vars.status = "draft"; r = (await gql("CreatePostConfig", CREATE_POST, vars)).CreatePostConfig; }
      STATE[t.uid] = { post: r.uid, code, status: vars.status, at: new Date().toISOString() };
      if (code) OVR[r.uid] = code;
      try { await gql("CreateTicketCommentApp", TCOM_ADD, { ticketUid: t.uid, value: "L'actu de cette formation a été préparée automatiquement. Elle attend maintenant d'être relue et publiée.", filesToUpload: [] }); } catch (e) {}
      n++; console.log(`Brouillon créé (${vars.status}) : ${title}`);
    } catch (e) { console.warn(`Brouillon ${title} : ${e.message}`); }
  }
  if (n) fs.writeFileSync("drafts.json", JSON.stringify(STATE, null, 1));
}

// --- Contenu des formations pour le panneau d'aperçu (lu une fois par formation, puis gardé en cache) ---
const CONTENT = `query GetPostApp($postUid: String!, $language: String!) { GetPostApp(postUid: $postUid, language: $language) { postContents { language title value } } }`;
const escH = (t) => String(t || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// garde seulement gras / italique / souligné / retours à la ligne
const inline = (t) => escH(String(t || "").replace(/<br\s*\/?>/gi, "\n").replace(/<(\/?)(b|strong|i|em|u)(\s[^>]*)?>/gi, "\u0001$1$2\u0002").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"))
  .replace(/\u0001(\/?)(b|strong|i|em|u)\u0002/gi, (m, c, t) => `<${c}${{ strong: "b", em: "i" }[t.toLowerCase()] || t.toLowerCase()}>`).replace(/\n/g, "<br>");
const FILES = new Set();
function blocksToHtml(value) {
  let doc; try { doc = typeof value === "string" ? JSON.parse(value) : value; } catch (e) { return ""; }
  const out = [];
  const items = (l) => (l || []).map((it) => `<li>${inline(typeof it === "string" ? it : it.content || it.text || "")}${it && it.items && it.items.length ? `<ul>${items(it.items)}</ul>` : ""}</li>`).join("");
  for (const b of (doc && doc.blocks) || []) {
    const d = b.data || {};
    if (b.type === "paragraph") { const h = inline(d.text); if (h.replace(/<[^>]+>/g, "").trim()) out.push(`<p>${h}</p>`); }
    else if (b.type === "header") out.push(`<h4>${inline(d.text)}</h4>`);
    else if (b.type === "list") out.push(d.style === "ordered" ? `<ol>${items(d.items)}</ol>` : `<ul>${items(d.items)}</ul>`);
    else if (b.type === "delimiter") out.push("<hr>");
    else if (b.type === "alert") out.push(`<div class="pv-alert">${inline(d.message)}</div>`);
    else if (b.type === "quote") out.push(`<blockquote>${inline(d.text)}</blockquote>`);
    else if (/attach|pdf|file/i.test(b.type)) {
      const u = (d.file && d.file.url) || "", fid = (u.match(/uploaded-file\/([0-9a-f-]{36})/) || [])[1];
      const isPdf = b.type === "attaches_pdf" || /\.pdf$/i.test((d.file && (d.file.title || d.file.name)) || d.title || "");
      if (fid && isPdf) FILES.add(fid);
      out.push(`<div class="pv-file" data-file${fid && isPdf ? ` data-fid="${fid}"` : ""}>📄 ${escH((d.file && d.file.title) || d.title || "Support")}</div>`);
    }
    else if (/image|video|embed/i.test(b.type)) out.push(`<div class="pv-file" data-file>🖼️ ${escH(d.caption ? String(d.caption).replace(/<[^>]*>/g, "") : "Média à voir dans Wobee")}</div>`);
  }
  return out.join("");
}

const login = process.env.WOBEE_LOGIN, password = process.env.WOBEE_PASSWORD;
if (!login || !password) { console.log("Secrets WOBEE_LOGIN / WOBEE_PASSWORD pas encore renseignés : synchro sautée"); process.exit(0); }
token = (await gql("Signin", SIGNIN, { login, password })).Signin.accessToken;

await catMap();
await makeDrafts();
const all = await crawl(ROOT_TEST);
const byId = new Map(all.map((p) => [p.id, p]));
const posts = [...byId.values()].sort((a, b) => (a.iso < b.iso ? 1 : -1)).map(({ iso, ...p }) => p);
const prevAll = fs.existsSync("pub.json") ? JSON.parse(fs.readFileSync("pub.json", "utf8")) : null;
const cache = new Map(((prevAll && prevAll.posts) || []).filter((p) => p.h != null).map((p) => [p.id, p]));
for (const p of posts) {
  const c = cache.get(p.id);
  if (c && c.hv === 2 && c.t === p.t && c.r === p.r) { p.h = c.h; p.hv = 2; for (const m of (c.h || "").matchAll(/data-fid="([0-9a-f-]{36})"/g)) FILES.add(m[1]); continue; }
  try {
    const d = (await gql("GetPostApp", CONTENT, { postUid: p.id, language: "fr" })).GetPostApp;
    const fr = (d.postContents || []).find((x) => x.language === "fr" && x.value) || (d.postContents || []).find((x) => x.value) || {};
    p.h = blocksToHtml(fr.value).slice(0, 60000);
    p.hv = 2;
  } catch (e) { console.warn("Contenu " + p.id + " : " + e.message); }
}

// --- PDF chiffrés pour l'aperçu (clé PREVIEW_KEY, la même que dans l'adresse de l'iframe Wobee) ---
const PKEY = process.env.PREVIEW_KEY;
if (PKEY) {
  const { webcrypto } = await import("node:crypto");
  const raw = Buffer.from(PKEY.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const key = await webcrypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  fs.mkdirSync("previews", { recursive: true });
  for (const fid of FILES) {
    const dest = `previews/${fid}.bin`;
    if (fs.existsSync(dest)) continue;
    try {
      const r = await fetch(`https://prod-api.wobee.fr/uploaded-file/${fid}`, { headers: { ...HEAD, authorization: "Bearer " + token } });
      if (!r.ok) { console.warn(`PDF ${fid} : HTTP ${r.status}`); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 40e6) { console.warn(`PDF ${fid} trop gros (${buf.length})`); continue; }
      const iv = webcrypto.getRandomValues(new Uint8Array(12));
      const ct = Buffer.from(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, buf));
      fs.writeFileSync(dest, Buffer.concat([Buffer.from(iv), ct]));
      console.log(`PDF chiffré : ${fid} (${Math.round(buf.length / 1024)} Ko)`);
    } catch (e) { console.warn(`PDF ${fid} : ${e.message}`); }
  }
} else console.log("PREVIEW_KEY absente : pas d'aperçu PDF");

let A = { stats: {}, takes: {} }, tickets = [];
try { tickets = await readBoard(); } catch (e) { console.warn("Tableau : " + e.message); }

const body = { posts, stats: A.stats, takes: A.takes, tickets, cats: CAT.B };
const prev = fs.existsSync("pub.json") ? JSON.parse(fs.readFileSync("pub.json", "utf8")) : null;
if (prev) { const { updated, ...rest } = prev; if (JSON.stringify(rest) === JSON.stringify(body)) { console.log(`Rien de nouveau (${posts.length} formations, ${Object.keys(A.takes).length} pistes prises, ${tickets.length} tickets)`); process.exit(0); } }
fs.writeFileSync("pub.json", JSON.stringify({ updated: new Date().toISOString(), ...body }, null, 1));
console.log(`pub.json mis à jour : ${posts.length} formations, ${Object.keys(A.stats).length} pistes lues, ${Object.keys(A.takes).length} prises, ${tickets.length} tickets`);
