// controllers/chatController.js
import fs from 'fs/promises';
import { listAllFiles } from '../services/fileService.js';
import { askOpenAI } from '../services/openaiService.js';
import { createEmbedding, similaritySearch } from '../services/embeddingsService.js';
import { cache, buildCacheKey } from '../services/cacheService.js';
import { newChat, getHistory, appendMessage, appendAssistant } from '../services/conversationService.js';

const VECTORSTORE_PATH = process.env.VECTORSTORE_PATH || './vectorstore/index.json';
const TOP_K  = Number(process.env.TOP_K)  || 5;
const MIN_SIM = Number(process.env.MIN_SIM || 0.15);

/* ───────────── 1. iniciar conversación ───────────── */
export function startChat(_req, res) {
  const chatId = newChat();
  res.json({ chatId });
}

/* ───────────── 2. chat principal ───────────── */
export async function chatWithFiles(req, res, next) {
  try {
    const { messages, fileNames, chatId } = req.body;

    /* validar pregunta */
    const userQuestion = messages?.[messages.length - 1]?.content?.trim();
    if (!userQuestion) {
      return res.status(400).json({ error: 'Falta la pregunta' });
    }

    /* unir historial almacenado + mensaje nuevo */
    const history = chatId ? getHistory(chatId) ?? [] : [];
    const fullHistory = [...history, ...messages];      // normalmente messages = [{role:'user',...}]

    /* archivos a usar */
    const filesToUse = Array.isArray(fileNames) && fileNames.length
      ? fileNames : await listAllFiles();

    /* cache por chat + archivos */
    const cacheKey = buildCacheKey(userQuestion, [...filesToUse, chatId || 'nochat']);
    if (cache.has(cacheKey)) {
      const cached = cache.get(cacheKey);
      if (chatId) appendAssistant(chatId, cached);
      return res.json({ answer: cached, cached: true, chatId });
    }

    /* vectorstore */
    const vectorstore = JSON.parse(await fs.readFile(VECTORSTORE_PATH, 'utf8'))
      .filter(v => filesToUse.includes(v.file));

    /* similitud */
    const queryEmb = await createEmbedding(userQuestion);
    const hits = similaritySearch(queryEmb, vectorstore, TOP_K, MIN_SIM);

    const context = hits.map(h =>
      `Archivo: ${h.file} · Chunk ${h.chunk}\n${h.text}`
    ).join('\n---\n') || '(sin fragmentos relevantes)';

    /* prompt */
    const systemBase = `
Eres **DelfinoBot**, el asistente virtual oficial de *Delfino Tours II*.
Responde con la información contenida en el contexto.
Si el cliente pregunta quién eres, responde:
«Soy DelfinoBot, el asistente virtual oficial de Delfino Tours II».`.trim();

    const promptMessages = [
      { role: 'system', content: systemBase },
      { role: 'system', content: `Contexto:\n${context}` },
      ...fullHistory      // historial completo
    ];

    const answer = await askOpenAI(promptMessages);

    /* actualizar estado */
    if (chatId) {
      appendMessage(chatId, { role: 'user', content: userQuestion });
      appendAssistant(chatId, answer);
    }

    cache.set(cacheKey, answer);

    res.json({
      answer,
      chatId,
      hits: hits.map(h => ({
        file: h.file, chunk: h.chunk, similarity: Number(h.similarity.toFixed(3))
      }))
    });
  } catch (err) { next(err); }
}
