// fileService.js - Sin cambios adicionales, ya optimizado para bloques pequeños.

import axios from "axios";
import qs from "qs";
import mammoth from "mammoth";
import xlsx from "xlsx";
import WordExtractor from "word-extractor";
import officeParser from "officeparser";
import fs from "fs/promises";
import os from "os";
import path from "path";

const gc = global.gc ? () => global.gc() : () => {};

const {
  AZURE_TENANT_ID,
  AZURE_CLIENT_ID,
  AZURE_CLIENT_SECRET,
  SITE_ID,
  DRIVE_ID,
  SHAREPOINT_ROOT_PATH = "Prueba API",
  GRAPH_SCOPE = "https://graph.microsoft.com/.default",
  XLSX_ROWS_PER_BLOCK: XLSX_ROWS_PER_BLOCK_ENV
} = process.env;

const XLSX_ROWS_PER_BLOCK = Number(XLSX_ROWS_PER_BLOCK_ENV) > 0 ? Number(XLSX_ROWS_PER_BLOCK_ENV) : 200;

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

const FILE_REGEX = /\.(docx?|xlsx)$/i;
const buildPath = (segments) => segments.map(encodeURIComponent).join("/");

async function listChildren(folder = "") {
  const headers = await authHeaders();
  const url = folder
    ? `https://graph.microsoft.com/v1.0/sites/${SITE_ID}/drives/${DRIVE_ID}/root:/${buildPath(folder.split("/"))}:/children`
    : `https://graph.microsoft.com/v1.0/sites/${SITE_ID}/drives/${DRIVE_ID}/root/children`;

  const { data } = await axios.get(url, { headers });
  return data.value;
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
        size: it.size,
      });
    }
  }
  return files;
}

export async function listAllFiles() {
  const files = await walk(SHAREPOINT_ROOT_PATH.trim());
  console.log(`Found ${files.length} files.`);
  return files;
}

const normalize = (txt) => {
  if (txt == null) return "";
  if (typeof txt === "string") return txt;
  if (Buffer.isBuffer(txt)) return txt.toString("utf8");
  if (Array.isArray(txt)) return txt.join("\n");
  if (typeof txt === "object") return JSON.stringify(txt);
  return String(txt);
};

export async function readFileContent(file) {
  if (!FILE_REGEX.test(file.name)) {
    throw new Error(`Extensión no soportada: ${file.name}`);
  }

  if (file.size > 10 * 1024 * 1024) {
    throw new Error(`File too large: ${file.path} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
  }

  console.log(`Downloading ${file.path} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
  const { data: buffer } = await axios.get(
    `https://graph.microsoft.com/v1.0/sites/${SITE_ID}/drives/${DRIVE_ID}/items/${file.id}/content`,
    { headers: await authHeaders(), responseType: "arraybuffer" }
  );

  if (/\.docx$/i.test(file.name)) {
    const { value } = await mammoth.extractRawText({ buffer });
    gc();
    return value.trim();
  }

  if (/\.doc$/i.test(file.name)) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-"));
    const tmpPath = path.join(tmpDir, `${Date.now()}.doc`);
    await fs.writeFile(tmpPath, buffer);

    try {
      try {
        const doc = await new WordExtractor().extract(tmpPath);
        const txt = normalize(doc.getBody()).trim();
        if (txt) return txt;
      } catch {
      }

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

export async function getFileText(file, opts = {}) {
  const rowsPerBlock = Number(opts.rowsPerBlock) > 0 ? Number(opts.rowsPerBlock) : XLSX_ROWS_PER_BLOCK;

  let content;
  try {
    content = await readFileContent(file);
  } catch (err) {
    console.error(`   ⚠️ Error leyendo ${file.name}: ${err.message}`);
    return [""];
  }

  if (typeof content === "string") {
    return [content];
  }

  try {
    const blocks = [];
    for (const [sheet, rows] of Object.entries(content)) {
      const colSet = new Set();
      for (let k = 0; k < Math.min(rows.length, 1000); k++) {
        Object.keys(rows[k]).forEach((c) => colSet.add(c));
      }
      const cols = Array.from(colSet).sort((a, b) => {
        const toIndex = (col) =>
          col.split("").reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0);
        return toIndex(a) - toIndex(b);
      });

      let blockIndex = 0;
      let current = [`>>> Hoja: ${sheet}`, cols.join("\t")];
      let counter = 0;

      for (const r of rows) {
        current.push(cols.map((c) => (r[c] ?? "")).join("\t"));
        counter++;

        if (counter >= rowsPerBlock) {
          blocks.push(current.join("\n").trim());
          current = [];
          counter = 0;
          blockIndex++;
          if (gc) gc();
        }
      }

      if (current.length > 1) {
        blocks.push(current.join("\n").trim());
      }
    }
    if (gc) gc();
    return blocks.length ? blocks : [""];
  } catch (err) {
    console.error(`   ⚠️ Error convirtiendo ${file.name} a texto: ${err.message}`);
    return [""];
  }
}