// scripts/indexFiles.js
import fsSync from "fs";
import fs from "fs/promises";
import path from "path";
import ExcelJS from "exceljs";
import { encoding_for_model } from "tiktoken";
import { listAllFiles, readFileContent } from "../services/fileService.js";
import { createEmbedding } from "../services/embeddingsService.js";

const VECTORSTORE_PATH = process.env.VECTORSTORE_PATH || "./vectorstore/index.json";
const MAX_TOKENS_EMB   = +process.env.MAX_TOKENS_EMB || 8192;
const BATCH_ROWS       = +process.env.BATCH_ROWS_PER_CHUNK || 200;

// Inicializamos el encoder
const enc = encoding_for_model(process.env.EMBEDDING_MODEL || "text-embedding-3-large");
const countTokens = (str) => enc.encode(str).length;

/**
 * Generador que trocea un WorkbookReader de ExcelJS *en streaming*.
 * Cada yield tiene { text, idx }.
 */
async function* chunkExcelStream(reader) {
  let idxGlobal = 0;

  // Para cada hoja (streaming)
  for await (const worksheetReader of reader) {
    let chunk = `Hoja: ${worksheetReader.name}\n`;
    let rowCount = 0;

    // Para cada fila
    for await (const row of worksheetReader) {
      // row.values es array; el primer elemento suele ser `undefined`
      for (let col = 1; col < row.values.length; col++) {
        const raw = row.values[col];
        const txt = String(raw ?? "").trim();
        if (!txt || txt.length > 200) continue;

        const line = `Fila ${row.number} Col ${col}: ${txt}\n`;

        // Si excede tokens, extraemos el chunk actual
        if (countTokens(chunk + line) > MAX_TOKENS_EMB) {
          yield { text: chunk, idx: idxGlobal++ };
          chunk = `Hoja: ${worksheetReader.name} (cont.)\n`;
          rowCount = 0;
        }

        chunk += line;
        rowCount++;

        // Cada BATCH_ROWS también forzamos un yield
        if (rowCount >= BATCH_ROWS) {
          yield { text: chunk, idx: idxGlobal++ };
          chunk = `Hoja: ${worksheetReader.name} (cont.)\n`;
          rowCount = 0;
        }
      }
    }

    // Lo que quede al final de la hoja
    if (chunk.trim()) {
      yield { text: chunk, idx: idxGlobal++ };
    }
  }
}

;(async () => {
  // 1) Prepara carpeta
  await fs.mkdir(path.dirname(VECTORSTORE_PATH), { recursive: true });

  // 2) Stream de salida
  const writer = fsSync.createWriteStream(VECTORSTORE_PATH, { encoding: "utf8" });
  writer.write("[\n");
  let first = true;

  // 3) Procesa cada archivo de SharePoint
  for (const file of await listAllFiles()) {
    console.log(`🗄  Procesando: ${file.path}`);

    try {
      const content = await readFileContent(file);

      // 3a) Si es texto plano
      if (typeof content === "string") {
        // Aquí podrías trocear más fino si quisieras; por simplicidad
        const [embedding] = await createEmbedding([content]);
        const rec = {
          fileId:   file.id,
          path:     file.path,
          chunk:    0,
          text:     content,
          embedding
        };
        const json = JSON.stringify(rec, null, 2);
        writer.write(first ? json : ",\n" + json);
        first = false;
        console.log(`   ✅  ${file.name} [0]`);
      }
      // 3b) Si es workbook (sólo .xlsx)
      else {
        // Creamos un stream lector de ExcelJS
        const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(
          // ExcelJS espera un archivo o un ReadStream,
          // así que primero lo guardamos a disco temporal:
          await (async () => {
            const tmp = path.join(path.dirname(VECTORSTORE_PATH), "tmp", `${file.id}.xlsx`);
            await fs.mkdir(path.dirname(tmp), { recursive: true });
            await fs.writeFile(tmp, Buffer.from(await readFileContent(file).then(() => content)));
            return tmp;
          })()
        );

        for await (const { text, idx } of chunkExcelStream(workbookReader)) {
          const [embedding] = await createEmbedding([text]);
          const rec = {
            fileId:   file.id,
            path:     file.path,
            chunk:    idx,
            text,
            embedding
          };
          const json = JSON.stringify(rec, null, 2);
          writer.write(first ? json : ",\n" + json);
          first = false;
          console.log(`   ✅  ${file.name} [${idx}]`);
        }
      }
    } catch (err) {
      console.error(`   ❌  ${file.name}: ${err.message}`);
    }
  }

  // 4) Cierra el array JSON y stream
  writer.write("\n]\n");
  writer.end(() => {
    console.log(`🗂  Vectorstore guardado en ${VECTORSTORE_PATH}`);
  });
})();
