
import axios from "axios";
import qs from "qs";
import mammoth from "mammoth";
import xlsx from "xlsx";
import WordExtractor from "word-extractor";
import officeParser from "officeparser";
import fs from "fs/promises";
import os from "os";
import path from "path";

// Force garbage collection if available
const gc = global.gc ? () => global.gc() : () => {};

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

/** Cache simple para OAuth token */
let cache = { token: null, exp: 0 };

async function getToken() {
  const now = Date.now() / 1000;
  if (cache.token && cache.exp - 60 > now) {
    return cache.token;
  }
  const url = `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`;
  const body = qs.stringify({
    grant_type: "client_credentials",
    client_id: AZURE_CLIENT_ID,
    client_secret: AZURE_CLIENT_SECRET,
    scope: GRAPH_SCOPE,
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

/* =========  FILE FILTER & PATH BUILD ================================= */
const FILE_REGEX = /\.(docx?|xlsx)$/i;
const buildPath = (segments) => segments.map(encodeURIComponent).join("/");

/* =========  LISTADO RECURSIVO  ======================================= */
async function listChildren(folder = "") {
  const headers = await authHeaders();
  const url = folder
    ? `https://graph.microsoft.com/v1.0/sites/${SITE_ID}/drives/${DRIVE_ID}/root:/${buildPath(folder.split("/"))}:/children`
    : `https://graph.microsoft.com/v1.0/sites/${SITE_ID}/drives/${DRIVE_ID}/root/children`;

  const { data } = await axios.get(url, { headers });
  return data.value; // Array<DriveItem>
}

async function walk(base = "") {
  const items = await listChildren(base);
  let files = [];
  for (const it of items) {
    if (it.folder) {
      const next = base ? `${base}/${it.name}` : it.name;
      files = files.concat(await walk(next));
    } else if (it.file && FILE_REGEX.test(it.name)) {
      files.push({
        id: it.id,
        name: it.name,
        path: base ? `${base}/${it.name}` : it.name,
        size: it.size, // Include file size
      });
    }
  }
  return files;
}

/** Devuelve lista de todos los archivos .doc/.docx/.xlsx bajo la carpeta raíz */
export async function listAllFiles() {
  const files = await walk(SHAREPOINT_ROOT_PATH.trim());
  console.log(`Found ${files.length} files.`);
  return files;
}

/* =========  UTILS DE NORMALIZACIÓN  ================================= */
const normalize = (txt) => {
  if (txt == null) return "";
  if (typeof txt === "string") return txt;
  if (Buffer.isBuffer(txt)) return txt.toString("utf8");
  if (Array.isArray(txt)) return txt.join("\n");
  if (typeof txt === "object") return JSON.stringify(txt);
  return String(txt);
};

/* =========  DESCARGA + PARSEO  ======================================= */
export async function readFileContent(file) {
  if (!FILE_REGEX.test(file.name)) {
    throw new Error(`Extensión no soportada: ${file.name}`);
  }

  // Skip files larger than 10MB
  if (file.size > 10 * 1024 * 1024) {
    throw new Error(`File too large: ${file.path} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
  }

  console.log(`Downloading ${file.path} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
  const { data: buffer } = await axios.get(
    `https://graph.microsoft.com/v1.0/sites/${SITE_ID}/drives/${DRIVE_ID}/items/${file.id}/content`,
    { headers: await authHeaders(), responseType: "arraybuffer" }
  );

  // DOCX → Mammoth
  if (/\.docx$/i.test(file.name)) {
    const { value } = await mammoth.extractRawText({ buffer });
    gc();
    return value.trim();
  }

  // DOC → WordExtractor, fallback a officeParser
  if (/\.doc$/i.test(file.name)) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-"));
    const tmpPath = path.join(tmpDir, `${Date.now()}.doc`);
    await fs.writeFile(tmpPath, buffer);

    try {
      // 1) WordExtractor
      try {
        const doc = await new WordExtractor().extract(tmpPath);
        const txt = normalize(doc.getBody()).trim();
        if (txt) return txt;
      } catch {
        // continúa a fallback
      }

      // 2) officeParser fallback
      return await new Promise((res, rej) =>
        officeParser.parseOffice(tmpPath, (err, text) =>
          err ? rej(err) : res(normalize(text).trim())
        )
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
      gc();
    }
  }

  // XLSX → Stream processing
  if (/\.xlsx$/i.test(file.name)) {
    const workbook = xlsx.read(buffer, { type: "buffer", cellDates: true, sparse: true });
    const sheets = {};
    workbook.SheetNames.forEach((name) => {
      const sheet = workbook.Sheets[name];
      const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
      console.log(`Sheet ${name} has ${rows.length} rows`);
      sheets[name] = rows.map((cells) =>
        cells.reduce((obj, v, i) => {
          obj[xlsx.utils.encode_col(i)] = v;
          return obj;
        }, {})
      );
    });
    gc();
    return sheets;
  }
}

/* =========  TEXTO PLANO UNIFICADO  ===================================== */
export async function getFileText(file) {
  const content = await readFileContent(file);

  // Word → ya es string
  if (typeof content === "string") {
    return content;
  }

  // Excel → TSV multi-hoja
  const lines = [];
  for (const [sheet, rows] of Object.entries(content)) {
    lines.push(`>>> Hoja: ${sheet}`);
    if (!rows.length) {
      lines.push("");
      continue;
    }
    const cols = Object.keys(rows[0]);
    lines.push(cols.join("\t"));
    rows.forEach((r) => {
      lines.push(cols.map((c) => r[c] ?? "").join("\t"));
    });
    lines.push("");
  }
  const result = lines.join("\n").trim();
  gc();
  return result;
}
