// services/fileService.js
import axios from 'axios';
import qs from 'qs';
import mammoth from 'mammoth';
import xlsx from 'xlsx';

/* =========  ENV  ======================================================= */
const {
  AZURE_TENANT_ID,
  AZURE_CLIENT_ID,
  AZURE_CLIENT_SECRET,
  SITE_ID,                     // ej. panamajourneys.sharepoint.com,xxxx,yyyy
  DRIVE_ID,                    // id del drive “Documents”
  SHAREPOINT_ROOT_PATH = 'Prueba API',   // ej. Prueba API   (sin slash inicial/final)
  GRAPH_SCOPE = 'https://graph.microsoft.com/.default'
} = process.env;

/* =========  AUTH  ====================================================== */
let cachedToken = { value: null, exp: 0 };

async function getAccessToken () {
  const now = Date.now() / 1000;
  if (cachedToken.value && cachedToken.exp - 60 > now) return cachedToken.value;

  const url = `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`;
  const body = qs.stringify({
    grant_type:     'client_credentials',
    client_id:      AZURE_CLIENT_ID,
    client_secret:  AZURE_CLIENT_SECRET,
    scope:          GRAPH_SCOPE
  });

  const { data } = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  cachedToken = { value: data.access_token, exp: now + data.expires_in };
  return cachedToken.value;
}

async function authHeaders () {
  const token = await getAccessToken();
  return { Authorization: `Bearer ${token}` };
}

/* =========  HELPERS  =================================================== */
const FILE_REGEX = /\.(docx?|xlsx?)$/i;

const buildPath = segments => segments.map(encodeURIComponent).join('/');

/* =========  FILE LISTING  ============================================= */

async function listChildren (folderPath = '') {
  const headers = await authHeaders();

  const url = folderPath
    ? `https://graph.microsoft.com/v1.0/sites/${SITE_ID}` +
      `/drives/${DRIVE_ID}/root:/${buildPath(folderPath.split('/'))}:/children`
    : `https://graph.microsoft.com/v1.0/sites/${SITE_ID}` +
      `/drives/${DRIVE_ID}/root/children`;

  const { data } = await axios.get(url, { headers });
  return data.value;              // array de DriveItems
}

async function collectFilesRecursively (basePath = '') {
  const items = await listChildren(basePath);
  let files = [];

  for (const item of items) {
    if (item.folder) {
      const nextPath = basePath ? `${basePath}/${item.name}` : item.name;
      files = files.concat(await collectFilesRecursively(nextPath));
    } else if (item.file && FILE_REGEX.test(item.name)) {
      files.push({
        id:     item.id,
        name:   item.name,
        path:   basePath ? `${basePath}/${item.name}` : item.name,
        webUrl: item.webUrl
      });
    }
    // lo demás se ignora (imágenes, pdf, etc.)
  }
  return files;
}

/**
 * Devuelve la lista completa de archivos Word/Excel bajo SHAREPOINT_ROOT_PATH
 * Cada elemento: { id, name, path, webUrl }
 */
export async function listAllFiles () {
  const root = SHAREPOINT_ROOT_PATH.trim();
  return await collectFilesRecursively(root);
}

/* =========  FILE DOWNLOAD  ============================================ */

export async function readFileContent (file) {
  if (!FILE_REGEX.test(file.name)) {
    throw new Error(`Extensión no soportada: ${file.name}`);
  }

  const headers   = await authHeaders();
  const url       =
    `https://graph.microsoft.com/v1.0/sites/${SITE_ID}` +
    `/drives/${DRIVE_ID}/items/${file.id}/content`;

  const { data: buffer } = await axios.get(url, {
    headers,
    responseType: 'arraybuffer'
  });

  /* ---------- Word (.doc / .docx) ---------------- */
  if (/\.docx?$/i.test(file.name)) {
    const { value } = await mammoth.extractRawText({ buffer });
    return value.trim();
  }

  /* ---------- Excel (.xls / .xlsx) --------------- */
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const sheets   = {};

  workbook.SheetNames.forEach(name => {
    sheets[name] = xlsx.utils.sheet_to_json(workbook.Sheets[name], {
      defval: ''
    });
  });
  return sheets;
}
