// services/embeddingsService.js
// Actualizaciones:
// - Confirmado límite de 300k tokens por request de OpenAI (de búsquedas recientes).
// - Ajustado MAX_TOKENS_PER_REQUEST a 300000.
// - Asegurado splitting secuencial de sub-batches en createEmbeddings usando tiktoken para conteo exacto.
// - Agregado try-catch por sub-batch para robustez (continuar si uno falla).
// - Logs minimizados para velocidad.

import OpenAI from 'openai';
import cosine from 'compute-cosine-similarity';
import { get_encoding } from "tiktoken";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL?.trim() || 'text-embedding-3-large';
const MAX_TOKENS_INPUT = 8192;
const CHAR_PER_TOKEN = 4;
const MAX_CHARS_INPUT = MAX_TOKENS_INPUT * CHAR_PER_TOKEN;
const MAX_TOKENS_PER_REQUEST = 300000;

const enc = get_encoding('cl100k_base');

function safeSlice(str) {
  let sliced = str;
  while (enc.encode(sliced).length > MAX_TOKENS_INPUT) {
    sliced = sliced.slice(0, -100); // Recortar gradualmente para precisión
  }
  return sliced;
}

function sameLength(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length;
}

export async function createEmbedding(text) {
  const input = safeSlice(text);
  try {
    const { data } = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input
    });
    return data[0].embedding;
  } catch (err) {
    console.error('❌ Error en createEmbedding:', err.message);
    throw err;
  }
}

export async function createEmbeddings(texts) {
  const inputs = texts.map(safeSlice);
  let allEmbeddings = [];

  let currentBatch = [];
  let currentTokens = 0;
  for (const input of inputs) {
    const tokens = enc.encode(input).length;
    if (currentTokens + tokens > MAX_TOKENS_PER_REQUEST) {
      // Procesar batch actual
      const embeddings = await processSubBatch(currentBatch);
      allEmbeddings = allEmbeddings.concat(embeddings);
      currentBatch = [input];
      currentTokens = tokens;
    } else {
      currentBatch.push(input);
      currentTokens += tokens;
    }
  }

  // Último batch
  if (currentBatch.length > 0) {
    const embeddings = await processSubBatch(currentBatch);
    allEmbeddings = allEmbeddings.concat(embeddings);
  }

  return allEmbeddings;
}

async function processSubBatch(subInputs) {
  try {
    const { data } = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: subInputs
    });
    return data.map(d => d.embedding);
  } catch (err) {
    console.error('❌ Error en sub-batch:', err.message);
    return new Array(subInputs.length).fill(null); // Retornar nulls para mantener índice
  }
}

export function similaritySearch(queryVec, vectorstore, topK = 5, minSim = 0.3) {
  const scored = vectorstore.flatMap(row => {
    if (!sameLength(queryVec, row.embedding)) return [];
    return [{ ...row, similarity: cosine(queryVec, row.embedding) }];
  });
  return scored
    .filter(row => row.similarity >= minSim)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}