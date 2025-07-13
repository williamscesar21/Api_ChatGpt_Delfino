import axios from "axios";
import qs from "qs";
import mammoth from "mammoth";
import WordExtractor from "word-extractor";
import officeParser from "officeparser";
import fs from "fs/promises";
import os from "os";
import path from "path";
import ExcelJS from "exceljs";

// ========== ENV & AUTH ==========
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
async function getToken() {
  const now = Date.now() / 1000;
  if (cache.token && cache.exp - 60 > now) return cache.token;
  const url = `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`;
  const body = qs.stringify({
    grant_type:    "client_credentials",
    client_id:     AZURE_CLIENT_ID,
    client_secret: AZURE_CLIENT_SECRET,
    scope:         GRAPH_SCOPE,
  });
  const { data } = await axios.post(url, body, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  cache = { token: data.access_token, exp: now + data.expires_in };
  return cache.token;
}
async function authHeaders() {
  const token = await getToken();
  return { Authorization: `Bearer ${token}` };
}

// ========== FILE LISTING ==========
const FILE_REGEX = /\.(docx?|xlsx?)$/i;
function buildPath(segs) {
  return segs.map(encodeURIComponent).join("/");
}
async function listChildren(folder = "") {
  const headers = await authHeaders();
  const url = folder
    ? `https://graph.microsoft.com/v1.0/sites/${SITE_ID}` +
      `/drives/${DRIVE_ID}/root:/${buildPath(folder.split("/"))}:/children`
    : `https://graph.microsoft.com/v1.0/sites/${SITE_ID}` +
      `/drives/${DRIVE_ID}/root/children`;
  const { data } = await axios.get(url, { headers });
  return data.value;
}
async function walk(base = "") {
  const items = await listChildren(base);
  let out = [];
  for (const it of items) {
    if (it.folder) {
      const next = base ? `${base}/${it.name}` : it.name;
      out = out.concat(await walk(next));
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
/** Lista todos los Word/Excel bajo la carpeta raíz */
export function listAllFiles() {
  return walk(SHAREPOINT_ROOT_PATH.trim());
}

// ========== UTILS ========== 
const normalize = (v) => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  if (Array.isArray(v)) return v.join("\n");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

// ========== READ & PARSE ==========
/**
 * Devuelve:
 *  - String para .docx/.doc
 *  - ExcelJS WorkbookReader para .xlsx
 */
export async function readFileContent(file) {
  if (!FILE_REGEX.test(file.name)) {
    throw new Error(`Extensión no soportada: ${file.name}`);
  }
  const url =
    `https://graph.microsoft.com/v1.0/sites/${SITE_ID}` +
    `/drives/${DRIVE_ID}/items/${file.id}/content`;

  // --- DOCX
  if (/\.docx$/i.test(file.name)) {
    const { data: buf } = await axios.get(url, {
      headers: await authHeaders(),
      responseType: "arraybuffer",
    });
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value.trim();
  }

  // --- DOC
  if (/\.doc$/i.test(file.name)) {
    const { data: buf } = await axios.get(url, {
      headers: await authHeaders(),
      responseType: "arraybuffer",
    });
    const tmpDir  = await fs.mkdtemp(path.join(os.tmpdir(), "doc-"));
    const tmpPath = path.join(tmpDir, `${Date.now()}.doc`);
    await fs.writeFile(tmpPath, buf);
    try {
      // WordExtractor
      try {
        const doc = await new WordExtractor().extract(tmpPath);
        const txt = normalize(doc.getBody()).trim();
        if (txt) return txt;
      } catch {}
      // fallback officeParser
      return await new Promise((res, rej) =>
        officeParser.parseOffice(tmpPath, (err, t) =>
          err ? rej(err) : res(normalize(t).trim())
        )
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  // --- XLSX (streaming)
  if (/\.xlsx?$/i.test(file.name)) {
    const resp = await axios.get(url, {
      headers: await authHeaders(),
      responseType: "stream",
    });
    // WorkbookReader es un async iterable
    return new ExcelJS.stream.xlsx.WorkbookReader(resp.data);
  }

  throw new Error("Formato no soportado");
}

/**
 * Convierte cualquier contenido soportado a string:
 * - Word → string
 * - Excel → bloque TSV
 */
export async function getFileText(file) {
  const content = await readFileContent(file);

  if (typeof content === "string") {
    return content;
  }

  // streaming WorkbookReader → TSV
  const lines = [];
  for await (const worksheet of content) {
    lines.push(`>>> Hoja: ${worksheet.name}`);
    let headerEmitted = false;
    for await (const row of worksheet) {
      if (!headerEmitted) {
        const cols = row.values.slice(1).map(() => "");
        lines.push(cols.map((_, i) => `Col${i+1}`).join("\t"));
        headerEmitted = true;
      }
      const cells = row.values.slice(1).map((c) => String(c ?? ""));
      lines.push(cells.join("\t"));
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}
