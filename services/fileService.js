/* ----------------------------------------------------------------------
   Servicio SharePoint: Word .doc | .docx | Excel .xls | .xlsx
---------------------------------------------------------------------- */

import axios   from "axios";
import qs      from "qs";
import mammoth from "mammoth";
import xlsx    from "xlsx";
import WordExtractor from "word-extractor";
import officeParser  from "officeparser";
import fs   from "fs/promises";
import os   from "os";
import path from "path";

/* =========  ENV & AUTH  ============================================== */
const {
  AZURE_TENANT_ID,
  AZURE_CLIENT_ID,
  AZURE_CLIENT_SECRET,
  SITE_ID,
  DRIVE_ID,
  SHAREPOINT_ROOT_PATH = "Prueba API",
  GRAPH_SCOPE = "https://graph.microsoft.com/.default",
} = process.env;

let cache = { token: null, exp: 0 };

async function token() {
  const now = Date.now() / 1000;
  if (cache.token && cache.exp - 60 > now) return cache.token;

  const { data } = await axios.post(
    `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`,
    qs.stringify({
      grant_type:    "client_credentials",
      client_id:     AZURE_CLIENT_ID,
      client_secret: AZURE_CLIENT_SECRET,
      scope:         GRAPH_SCOPE,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  cache = { token: data.access_token, exp: now + data.expires_in };
  return cache.token;
}
const authHeaders = async () => ({ Authorization: `Bearer ${await token()}` });

/* =========  HELPERS  ================================================== */
const FILE_REGEX = /\.(docx?|xlsx?)$/i;
const buildPath  = (arr) => arr.map(encodeURIComponent).join("/");

const normalize = (txt) => {
  if (txt == null) return "";
  if (typeof txt === "string") return txt;
  if (Buffer.isBuffer(txt))     return txt.toString("utf8");
  if (Array.isArray(txt))       return txt.join("\n");
  if (typeof txt === "object")  return JSON.stringify(txt);
  return String(txt);
};

/* =========  LISTADO RECURSIVO  ======================================= */
async function listChildren(folder = "") {
  const url = folder
    ? `https://graph.microsoft.com/v1.0/sites/${SITE_ID}` +
      `/drives/${DRIVE_ID}/root:/${buildPath(folder.split("/"))}:/children`
    : `https://graph.microsoft.com/v1.0/sites/${SITE_ID}` +
      `/drives/${DRIVE_ID}/root/children`;

  const { data } = await axios.get(url, { headers: await authHeaders() });
  return data.value;
}

async function walk(base = "") {
  const items = await listChildren(base);
  let out     = [];

  for (const it of items) {
    if (it.folder) {
      out = out.concat(await walk(base ? `${base}/${it.name}` : it.name));
    } else if (it.file && FILE_REGEX.test(it.name)) {
      out.push({
        id:   it.id,
        name: it.name,
        path: base ? `${base}/${it.name}` : it.name,
      });
    }
  }
  return out;
}

export const listAllFiles = () => walk(SHAREPOINT_ROOT_PATH.trim());

/* =========  DESCARGA + PARSEO  ======================================= */
export async function readFileContent(file) {
  if (!FILE_REGEX.test(file.name))
    throw new Error(`Extensión no soportada: ${file.name}`);

  /* ----- descarga ----- */
  const { data: buf } = await axios.get(
    `https://graph.microsoft.com/v1.0/sites/${SITE_ID}` +
    `/drives/${DRIVE_ID}/items/${file.id}/content`,
    { headers: await authHeaders(), responseType: "arraybuffer" }
  );

  /* ---------- .docx ---------- */
  if (/\.docx$/i.test(file.name)) {
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value.trim();
  }

  /* ---------- .doc ---------- */
  if (/\.doc$/i.test(file.name)) {
    const tmpDir  = await fs.mkdtemp(path.join(os.tmpdir(), "doc-"));
    const tmpPath = path.join(tmpDir, `${Date.now()}.doc`);
    await fs.writeFile(tmpPath, buf);

    try {
      /* 1) word-extractor */
      try {
        const doc    = await new WordExtractor().extract(tmpPath);
        const body   = normalize(doc.getBody()).trim();
        if (body) return body;
      } catch {/* ignore & fallback */}

      /* 2) officeparser */
      return await new Promise((res, rej) =>
        officeParser.parseOffice(tmpPath, (err, text) =>
          err ? rej(err) : res(normalize(text).trim())
        )
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  /* ---------- Excel ---------- */
  const wb   = xlsx.read(buf, { type: "buffer" });
  const book = {};

  wb.SheetNames.forEach((sheet) => {
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[sheet], {
      header: 1,
      defval: "",
      raw: false,
    });
    book[sheet] = rows.map((arr) =>
      arr.reduce((o, v, i) => {
        o[xlsx.utils.encode_col(i)] = v;
        return o;
      }, {})
    );
  });
  return book;
}
