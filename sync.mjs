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
const ROOT_TEST = "8d526d1d-4bc0-4771-8885-1f87dcb7b478";
const ROOT_REAL = "f5499d84-198e-45e6-8aaf-97187e442b74";
// Catégories de la Bibliothèque actuelle -> métier de l'arborescence
const REAL_MAP = {
  "1d0bee34-4c5a-4ff2-9de0-73579679c4b0": "EI-MEC",
  "6baa8ec1-bfa6-4ba5-b47b-c591bed2c016": "EI-PRO",
};

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

// Codes des catégories TEST, lus dans index.html (const CAT={...})
const html = fs.readFileSync("index.html", "utf8");
const catJson = html.slice(html.indexOf("const CAT=") + 10, html.indexOf("}};", html.indexOf("const CAT=")) + 2);
const CAT = JSON.parse(catJson);
const UID2CODE = {};
for (const [code, uid] of Object.entries(CAT.B)) if (code !== "_root") UID2CODE[uid] = code;
Object.assign(UID2CODE, REAL_MAP);

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


// --- Contenu des formations pour le panneau d'aperçu (lu une fois par formation, puis gardé en cache) ---
const CONTENT = `query GetPostApp($postUid: String!, $language: String!) { GetPostApp(postUid: $postUid, language: $language) { postContents { language title value } } }`;
const escH = (t) => String(t || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// garde seulement gras / italique / souligné / retours à la ligne
const inline = (t) => escH(String(t || "").replace(/<br\s*\/?>/gi, "\n").replace(/<(\/?)(b|strong|i|em|u)(\s[^>]*)?>/gi, "\u0001$1$2\u0002").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"))
  .replace(/\u0001(\/?)(b|strong|i|em|u)\u0002/gi, (m, c, t) => `<${c}${{ strong: "b", em: "i" }[t.toLowerCase()] || t.toLowerCase()}>`).replace(/\n/g, "<br>");
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
    else if (/attach|pdf|file/i.test(b.type)) out.push(`<div class="pv-file" data-file>📄 ${escH((d.file && d.file.title) || d.title || "Support")}</div>`);
    else if (/image|video|embed/i.test(b.type)) out.push(`<div class="pv-file" data-file>🖼️ ${escH(d.caption ? String(d.caption).replace(/<[^>]*>/g, "") : "Média à voir dans Wobee")}</div>`);
  }
  return out.join("");
}

const login = process.env.WOBEE_LOGIN, password = process.env.WOBEE_PASSWORD;
if (!login || !password) { console.log("Secrets WOBEE_LOGIN / WOBEE_PASSWORD pas encore renseignés : synchro sautée"); process.exit(0); }
token = (await gql("Signin", SIGNIN, { login, password })).Signin.accessToken;

const all = [...(await crawl(ROOT_TEST)), ...(await crawl(ROOT_REAL))];
const byId = new Map(all.map((p) => [p.id, p]));
const posts = [...byId.values()].sort((a, b) => (a.iso < b.iso ? 1 : -1)).map(({ iso, ...p }) => p);
const prevAll = fs.existsSync("pub.json") ? JSON.parse(fs.readFileSync("pub.json", "utf8")) : null;
const cache = new Map(((prevAll && prevAll.posts) || []).filter((p) => p.h != null).map((p) => [p.id, p]));
for (const p of posts) {
  const c = cache.get(p.id);
  if (c && c.t === p.t && c.r === p.r) { p.h = c.h; continue; }
  try {
    const d = (await gql("GetPostApp", CONTENT, { postUid: p.id, language: "fr" })).GetPostApp;
    const fr = (d.postContents || []).find((x) => x.language === "fr" && x.value) || (d.postContents || []).find((x) => x.value) || {};
    p.h = blocksToHtml(fr.value).slice(0, 60000);
  } catch (e) { console.warn("Contenu " + p.id + " : " + e.message); }
}

let A = { stats: {}, takes: {} }, tickets = [];
try { A = await crawlA(); } catch (e) { console.warn("Apprendre : " + e.message); }
try { tickets = await readBoard(); } catch (e) { console.warn("Tableau : " + e.message); }

const body = { posts, stats: A.stats, takes: A.takes, tickets };
const prev = fs.existsSync("pub.json") ? JSON.parse(fs.readFileSync("pub.json", "utf8")) : null;
if (prev) { const { updated, ...rest } = prev; if (JSON.stringify(rest) === JSON.stringify(body)) { console.log(`Rien de nouveau (${posts.length} formations, ${Object.keys(A.takes).length} pistes prises, ${tickets.length} tickets)`); process.exit(0); } }
fs.writeFileSync("pub.json", JSON.stringify({ updated: new Date().toISOString(), ...body }, null, 1));
console.log(`pub.json mis à jour : ${posts.length} formations, ${Object.keys(A.stats).length} pistes lues, ${Object.keys(A.takes).length} prises, ${tickets.length} tickets`);
