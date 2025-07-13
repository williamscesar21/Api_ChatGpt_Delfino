import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { encoding_for_model } from "tiktoken";
import { listAllFiles, readFileContent } from "../services/fileService.js";
import { createEmbedding } from "../services/embeddingsService.js";

const VECTORSTORE_PATH =
  process.env.VECTORSTORE_PATH || "./vectorstore/index.json";
const MAX_TOKENS_EMB = 8192;                   // límite de tokens
const BATCH_ROWS = +process.env.BATCH_ROWS_PER_CHUNK || 200;

const enc = encoding_for_model(
  process.env.EMBEDDING_MODEL || "text-embedding-3-large"
);
const countTokens = (str) => enc.encode(str).length;

// Divide un texto en trozos que quepan en el límite de tokens
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

(async () => {
  // 1) Prepara carpeta y stream de escritura
  await fsPromises.mkdir(path.dirname(VECTORSTORE_PATH), { recursive: true });
  const writer = fs.createWriteStream(VECTORSTORE_PATH, { encoding: "utf8" });
  writer.write("[\n");
  let firstRecord = true;

  // 2) Itera archivos
  for (const file of await listAllFiles()) {
    console.log(`🗄  Procesando: ${file.path}`);
    try {
      const raw = await readFileContent(file);

      // 3A) Texto plano
      if (typeof raw === "string") {
        const chunks = splitToFit(raw);
        for (const [i, text] of chunks.entries()) {
          const [embedding] = await createEmbedding([text]);
          const record = { fileId: file.id, path: file.path, chunk: i, text, embedding };
          const json = JSON.stringify(record, null, 2);
          writer.write(firstRecord ? json : ",\n" + json);
          firstRecord = false;
          console.log(`   ✅  ${file.name} [${i}]`);
        }
      }
      // 3B) Excel: recorre celda a celda y hace chunk dinámico
      else {
        const book = raw;
        for (const [sheetName, rows] of Object.entries(book)) {
          let chunkText = `Hoja: ${sheetName}\n`;
          let addedRows = 0;
          let chunkIndex = 0;

          // filas de abajo a arriba
          for (let r = rows.length - 1; r >= 0; r--) {
            const row = rows[r];
            for (const [col, rawCell] of Object.entries(row)) {
              const value = String(rawCell).trim();
              if (!value || value.length > 200) continue;
              const line = `Fila ${r + 1} Col ${col}: ${value}\n`;

              // si supera tokens, emite el chunk actual
              if (countTokens(chunkText + line) > MAX_TOKENS_EMB) {
                const [embedding] = await createEmbedding([chunkText]);
                const record = {
                  fileId: file.id,
                  path: file.path,
                  chunk: chunkIndex++,
                  text: chunkText,
                  embedding,
                };
                const json = JSON.stringify(record, null, 2);
                writer.write(firstRecord ? json : ",\n" + json);
                firstRecord = false;
                console.log(`   ✅  ${file.name} [${chunkIndex - 1}]`);
                chunkText = `Hoja: ${sheetName} (cont.)\n`;
                addedRows = 0;
              }

              chunkText += line;
              addedRows++;

              // cada BATCH_ROWS también emite
              if (addedRows >= BATCH_ROWS) {
                const [embedding] = await createEmbedding([chunkText]);
                const record = {
                  fileId: file.id,
                  path: file.path,
                  chunk: chunkIndex++,
                  text: chunkText,
                  embedding,
                };
                const json = JSON.stringify(record, null, 2);
                writer.write(firstRecord ? json : ",\n" + json);
                firstRecord = false;
                console.log(`   ✅  ${file.name} [${chunkIndex - 1}]`);
                chunkText = `Hoja: ${sheetName} (cont.)\n`;
                addedRows = 0;
              }
            }
          }

          // emite resto final de la hoja
          if (chunkText.trim()) {
            const [embedding] = await createEmbedding([chunkText]);
            const record = {
              fileId: file.id,
              path: file.path,
              chunk: chunkIndex++,
              text: chunkText,
              embedding,
            };
            const json = JSON.stringify(record, null, 2);
            writer.write(firstRecord ? json : ",\n" + json);
            firstRecord = false;
            console.log(`   ✅  ${file.name} [${chunkIndex - 1}]`);
          }
        }
      }
    } catch (err) {
      console.error(`   ❌  ${file.name}: ${err.message}`);
    }
  }

  // 4) Cierra el JSON y el stream
  writer.write("\n]\n");
  writer.end(() => console.log(`🗂  Vectorstore guardado en ${VECTORSTORE_PATH}`));
})();
