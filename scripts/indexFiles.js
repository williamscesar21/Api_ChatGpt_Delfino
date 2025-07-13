import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { encoding_for_model } from "tiktoken";
import { listAllFiles, readFileContent } from "../services/fileService.js";
import { createEmbedding } from "../services/embeddingsService.js";

const VECTORSTORE_PATH = process.env.VECTORSTORE_PATH || "./vectorstore/index.json";
const MAX_TOKENS_EMB   = 8192;
const BATCH_ROWS       = +process.env.BATCH_ROWS_PER_CHUNK || 200;

const enc = encoding_for_model(
  process.env.EMBEDDING_MODEL || "text-embedding-3-large"
);
const countTokens = (str) => enc.encode(str).length;

/** Divide un texto en trozos que quepan en el límite de tokens */
function splitToFit(text) {
  const parts = [];
  const stack = [text];
  while (stack.length) {
    const chunk = stack.pop();
    if (countTokens(chunk) <= MAX_TOKENS_EMB) {
      parts.push(chunk);
    } else {
      const mid = Math.floor(chunk.length / 2);
      stack.push(chunk.slice(0, mid), chunk.slice(mid));
    }
  }
  return parts;
}

/** Trocea texto plano */
function chunkText(str) {
  return splitToFit(str);
}

/** Trocea el objeto Excel { sheet: RowObject[] } */
function chunkExcel(book) {
  const out = [];
  const fits = (t) => countTokens(t) <= MAX_TOKENS_EMB;

  for (const [sheet, rows] of Object.entries(book)) {
    let chunk = `Hoja: ${sheet}\n`;
    let added = 0;

    for (let r = rows.length - 1; r >= 0; r--) {
      const row = rows[r];
      for (const [col, raw] of Object.entries(row)) {
        const value = String(raw ?? "").trim();
        if (!value || value.length > 200) continue;
        const line = `Fila ${r + 1} Col ${col}: ${value}\n`;

        if (!fits(chunk + line)) {
          out.push(chunk);
          chunk = `Hoja: ${sheet} (cont.)\n`;
        }
        chunk += line;
        added++;

        if (added % BATCH_ROWS === 0 && chunk.trim()) {
          out.push(chunk);
          chunk = `Hoja: ${sheet} (cont.)\n`;
        }
      }
    }
    if (chunk.trim()) out.push(chunk);
  }

  return out.flatMap(splitToFit);
}

;(async () => {
  // Prepara carpeta de salida
  await fsPromises.mkdir(path.dirname(VECTORSTORE_PATH), { recursive: true });

  // Stream de escritura
  const writer = fs.createWriteStream(VECTORSTORE_PATH, { encoding: "utf8" });
  writer.write("[\n");
  let first = true;

  for (const file of await listAllFiles()) {
    console.log(`🗄  Procesando: ${file.path}`);
    try {
      const raw = await readFileContent(file);
      const chunks = typeof raw === "string" ? chunkText(raw) : chunkExcel(raw);

      for (let i = 0; i < chunks.length; i++) {
        const text = chunks[i];
        const [embedding] = await createEmbedding([text]);
        const record = {
          fileId: file.id,
          path: file.path,
          chunk: i,
          text,
          embedding,
        };
        const json = JSON.stringify(record, null, 2);
        writer.write(first ? json : ",\n" + json);
        first = false;
        console.log(`   ✅  ${file.name} [${i}]`);
      }
    } catch (err) {
      console.error(`   ❌  ${file.name}: ${err.message}`);
    }
  }

  // Cierra array JSON
  writer.write("\n]\n");
  writer.end(() => {
    console.log(`🗂  Vectorstore guardado en ${VECTORSTORE_PATH}`);

    // Medidas de uso de memoria
    const mem = process.memoryUsage();
    const toMB = (bytes) => (bytes / 1024 / 1024).toFixed(2);
    console.log("📊 Uso de memoria (MB):",
      `RSS=${toMB(mem.rss)}`,
      `HeapTotal=${toMB(mem.heapTotal)}`,
      `HeapUsed=${toMB(mem.heapUsed)}`,
      `External=${toMB(mem.external)}`
    );
  });
})();
