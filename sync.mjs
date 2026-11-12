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
const LIST = `query GetCategoryAndPostAppList($categoryParentUid: String!) { GetCategoryAndPostAppList(categoryParentUid: $categoryParentUid) { categories { totalCount data { uid } } posts { totalCount data { uid status author { firstname lastname } publicationDate reactions postContents { language title shortValue } } } } }`;

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

const login = process.env.WOBEE_LOGIN, password = process.env.WOBEE_PASSWORD;
if (!login || !password) { console.log("Secrets WOBEE_LOGIN / WOBEE_PASSWORD pas encore renseignés : synchro sautée"); process.exit(0); }
token = (await gql("Signin", SIGNIN, { login, password })).Signin.accessToken;

const all = [...(await crawl(ROOT_TEST)), ...(await crawl(ROOT_REAL))];
const byId = new Map(all.map((p) => [p.id, p]));
const posts = [...byId.values()].sort((a, b) => (a.iso < b.iso ? 1 : -1)).map(({ iso, ...p }) => p);

const prev = fs.existsSync("pub.json") ? JSON.parse(fs.readFileSync("pub.json", "utf8")) : null;
if (prev && JSON.stringify(prev.posts) === JSON.stringify(posts)) { console.log(`Rien de nouveau (${posts.length} formations)`); process.exit(0); }
fs.writeFileSync("pub.json", JSON.stringify({ updated: new Date().toISOString(), posts }, null, 1));
console.log(`pub.json mis à jour : ${posts.length} formations`);
