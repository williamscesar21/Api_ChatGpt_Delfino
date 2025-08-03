import fs from 'fs/promises';
import { listAllFiles } from '../services/fileService.js';
import { askOpenAI } from '../services/openaiService.js';
import { createEmbedding, similaritySearch } from '../services/embeddingsService.js';
import { cache, buildCacheKey } from '../services/cacheService.js';
import { newChat, getHistory, appendMessage, appendAssistant } from '../services/conversationService.js';

const VECTORSTORE_PATH = process.env.VECTORSTORE_PATH || './vectorstore/index.json';
const TOP_K = Number(process.env.TOP_K) || 5;
const MIN_SIM = Number(process.env.MIN_SIM || 0.7); // Umbral de similitud

/* ───────────── 1. Iniciar conversación ───────────── */
export function startChat(_req, res) {
  const chatId = newChat();
  res.json({ chatId });
}

/* ───────────── 2. Chat principal ───────────── */
export async function chatWithFiles(req, res, next) {
  try {
    const { messages, fileNames, chatId } = req.body;

    /* Validar pregunta */
    const userQuestion = messages?.[messages.length - 1]?.content?.trim();
    if (!userQuestion) {
      return res.status(400).json({ error: 'Falta la pregunta' });
    }

    /* Unir historial almacenado + mensaje nuevo */
    const history = chatId ? getHistory(chatId) ?? [] : [];
    const fullHistory = [...history, ...messages];
    console.log('📜 Historial completo:', fullHistory.length, 'mensajes');

    /* Cargar el vector store completo */
    let vectorstore;
    try {
      vectorstore = JSON.parse(await fs.readFile(VECTORSTORE_PATH, 'utf8'));
      console.log('📊 Vector store cargado:', vectorstore.length, 'entradas');
    } catch (err) {
      console.error('❌ Error al cargar vectorstore:', err.message);
      return res.status(500).json({ error: 'No se pudo cargar el vector store' });
    }

    /* Verificar si el vector store está vacío */
    if (!vectorstore.length) {
      console.warn('⚠️ Vector store vacío');
      const systemBase = `
        Eres **DelfinoBot**, el asistente virtual oficial de *Delfino Tours II*.
        No hay documentos disponibles para responder. Responde únicamente:
        "No tengo información suficiente en los documentos para responder esa pregunta."
        Si el cliente pregunta quién eres, responde:
        «Soy DelfinoBot, el asistente virtual oficial de Delfino Tours II».`.trim();

      const promptMessages = [
        { role: 'system', content: systemBase },
        ...fullHistory
      ];

      const answer = await askOpenAI(promptMessages);
      if (chatId) {
        appendMessage(chatId, { role: 'user', content: userQuestion });
        appendAssistant(chatId, answer);
      }
      return res.json({ answer, chatId, hits: [] });
    }

    /* Cache por pregunta + chatId (sin filtrar por archivos) */
    const cacheKey = buildCacheKey(userQuestion, [chatId || 'nochat']);
    if (cache.has(cacheKey)) {
      const cached = cache.get(cacheKey);
      if (chatId) appendAssistant(chatId, cached);
      return res.json({ answer: cached, cached: true, chatId, hits: [] });
    }

    /* Similitud: buscar en el vector store completo */
    const queryEmb = await createEmbedding(userQuestion);
    const hits = similaritySearch(queryEmb, vectorstore, TOP_K, MIN_SIM);
    console.log('🔍 Resultados de búsqueda:', hits.length, hits.map(h => ({
      path: h.path,
      chunk: h.chunk,
      similarity: Number(h.similarity.toFixed(3))
    })));

    /* Construir contexto con los fragmentos encontrados */
    const context = hits.length
      ? hits.map(h => `Archivo: ${h.path} · Chunk ${h.chunk}\n${h.text}`).join('\n---\n')
      : '(sin fragmentos relevantes)';
    console.log('📝 Longitud del contexto:', context.length, 'caracteres');

    /* Prompt */
    const systemBase = `
      Eres **DelfinoBot**, el asistente virtual oficial de *Delfino Tours II*.
      Responde ÚNICAMENTE con la información contenida en el contexto proporcionado.
      Si el contexto no contiene información relevante, di: "No tengo información suficiente en los documentos para responder esa pregunta."
      Si el cliente pregunta quién eres, responde:
      «Soy DelfinoBot, el asistente virtual oficial de Delfino Tours II».`.trim();

    const promptMessages = [
      { role: 'system', content: systemBase },
      { role: 'system', content: `Contexto:\n${context}` },
      ...fullHistory
    ];

    /* Obtener respuesta de OpenAI */
    const answer = await askOpenAI(promptMessages);

    /* Actualizar estado */
    if (chatId) {
      appendMessage(chatId, { role: 'user', content: userQuestion });
      appendAssistant(chatId, answer);
    }

    /* Guardar en cache */
    cache.set(cacheKey, answer);

    /* Respuesta al cliente */
    res.json({
      answer,
      chatId,
      hits: hits.map(h => ({
        file: h.path,
        chunk: h.chunk,
        similarity: Number(h.similarity.toFixed(3))
      }))
    });
  } catch (err) {
    console.error('❌ Error en chatWithFiles:', err.message);
    next(err);
  }
}