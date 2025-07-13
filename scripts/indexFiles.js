// scripts/indexFiles.js
import fs      from "fs";
import fsPromises from "fs/promises";
import path    from "path";
import { encoding_for_model }   from "tiktoken";
import { listAllFiles, readFileContent } from "../services/fileService.js";
import { createEmbedding }      from "../services/embeddingsService.js";

const VECTORSTORE_PATH = process.env.VECTORSTORE_PATH || "./vectorstore/index.json";
const MAX_TOKENS_EMB   = 8192;
const BATCH_ROWS       = +process.env.BATCH_ROWS_PER_CHUNK || 200;

const enc = encoding_for_model(process.env.EMBEDDING_MODEL || "text-embedding-3-large");
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

/** Chunk para texto plano */
function chunkText(str) {
  return splitToFit(str);
}

/**
 * Chunk para Excel: recibe un objeto { sheetName: RowObject[] }
 * y recorre cada celda, generando líneas "Fila X Col Y: valor"
 */
function chunkExcel(book) {
  const out = [];
  const fits = (t) => countTokens(t) <= MAX_TOKENS_EMB;

  for (const [sheet, rows] of Object.entries(book)) {
    let chunk = `Hoja: ${sheet}\n`;
    let added = 0;

    // recorremos filas de abajo a arriba
    for (let r = rows.length - 1; r >= 0; r--) {
      const row = rows[r];
      // cada fila es un objeto { A:val, B:val, ... }
      for (const [col, raw] of Object.entries(row)) {
        const value = String(raw ?? "").trim();
        if (!value || value.length > 200) continue;
        const line = `Fila ${r + 1} Col ${col}: ${value}\n`;

        // si supera tokens, emite chunk actual
        if (!fits(chunk + line)) {
          out.push(chunk);
          chunk = `Hoja: ${sheet} (cont.)\n`;
        }
        chunk += line;
        added++;

        // cada BATCH_ROWS filas, emite también
        if (added % BATCH_ROWS === 0 && chunk.trim()) {
          out.push(chunk);
          chunk = `Hoja: ${sheet} (cont.)\n`;
        }
      }
    }
    // emite resto final de la hoja
    if (chunk.trim()) out.push(chunk);
  }

  // re-split si alguno sigue muy grande
  return out.flatMap(splitToFit);
}

;(async () => {
  // crea carpeta si hace falta
  await fsPromises.mkdir(path.dirname(VECTORSTORE_PATH), { recursive: true });

  // crea stream de escritura
  const writer = fs.createWriteStream(VECTORSTORE_PATH, { encoding: "utf8" });
  writer.write("[\n");
  let firstRecord = true;

  for (const file of await listAllFiles()) {
    console.log(`🗄  Procesando: ${file.path}`);
    try {
      const raw = await readFileContent(file);
      // el contenido puede ser string (Word) o un objeto (Excel)
      const chunks = typeof raw === "string" ? chunkText(raw) : chunkExcel(raw);

      for (let i = 0; i < chunks.length; i++) {
        const text = chunks[i];
        // obtenemos el embedding en batch de uno
        const [embedding] = await createEmbedding([text]);
        const record = {
          fileId: file.id,
          path: file.path,
          chunk: i,
          text,
          embedding,
        };
        const json = JSON.stringify(record, null, 2);
        writer.write(firstRecord ? json : ",\n" + json);
        firstRecord = false;
        console.log(`   ✅  ${file.name} [${i}]`);
      }
    } catch (err) {
      console.error(`   ❌  ${file.name}: ${err.message}`);
    }
  }

  writer.write("\n]\n");
  writer.end(() => {
    console.log(`🗂  Vectorstore guardado en ${VECTORSTORE_PATH}`);
  });
})();
