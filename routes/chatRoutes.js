// chatRoutes.js - Versión actualizada
// Cambios principales:
// - Forzado modelo a "gpt-5-chat-latest" en llamadas a askOpenAI y askOpenAIStream.
// - TOP_K fijo a 10 (configurable via env o constante).
// - Cortado context a máximo ~48k chars (aprox 12k tokens); si excede, truncar y log warning.
// - Manejo de errores: check !res.headersSent antes de responder en catch para evitar ERR_HTTP_HEADERS_SENT.
// - Logs mejorados: tamaño de contexto, hits encontrados.
// - Constantes configurables: TOP_K, MIN_SIM, MAX_CONTEXT_CHARS, KEEPALIVE_MS.
// - Importado tiktoken para conteo preciso de tokens en context (si excede, truncar basado en chars como aproximación segura).

import { Router } from 'express';
import fs from 'fs/promises';
import { createEmbedding, similaritySearch } from '../services/embeddingsService.js';
import { askOpenAI, askOpenAIStream } from '../services/openaiService.js';
import { newChat } from '../services/conversationService.js'; // Importar newChat
import { encoding_for_model, get_encoding } from "tiktoken";

const router = Router();
const VECTORSTORE_PATH = process.env.VECTORSTORE_PATH || './vectorstore/index.json';

// Constantes configurables
const TOP_K = Number(process.env.TOP_K || 10); // Limitado a 10 más relevantes
const MIN_SIM = Number(process.env.MIN_SIM || 0.3);
const KEEPALIVE_MS = 15_000;
const MAX_CONTEXT_CHARS = 48000; // ~12k tokens (aprox 4 chars/token)

// Tiktoken para conteo aproximado (usamos chars para truncar por simplicidad y eficiencia)
let enc;
try {
  enc = get_encoding("cl100k_base"); // Fallback genérico
} catch {
  console.error("No se pudo inicializar el encoder de tokens para chat.");
}

/* ───────────── POST /api/chat/start ─────────────
   Inicia una nueva conversación y devuelve un chatId
*/
router.post('/chat/start', (req, res) => {
  try {
    const chatId = newChat();
    console.log('🆕 Nueva conversación iniciada:', chatId);
    res.json({ chatId });
  } catch (err) {
    console.error('❌ Error en /api/chat/start:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Error al iniciar la conversación' });
  }
});

/* ───────────── POST /api/chat ─────────────
   body: {
     message: string,      // Pregunta del usuario
     stream?: boolean,     // Opcional: usar streaming (default: false)
     fileName?: string     // Opcional: nombre del archivo para filtrar
   }
   Responde con la información del contexto en Markdown, citando textualmente si se especifica fileName
*/
router.post('/chat', async (req, res) => {
  try {
    const { message, stream = false, fileName } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({ error: 'Falta la pregunta' });
    }
    console.log('📝 Pregunta recibida:', message);
    if (fileName) console.log('📂 Archivo solicitado:', fileName);

    let vectorstore;
    try {
      vectorstore = JSON.parse(await fs.readFile(VECTORSTORE_PATH, 'utf8'));
      console.log('📊 Vector store cargado:', vectorstore.length, 'entradas');
    } catch (err) {
      console.error('❌ Error al cargar vectorstore:', err.message);
      return res.status(500).json({ error: 'No se pudo cargar el vector store' });
    }

    if (!vectorstore.length) {
      console.warn('⚠️ Vector store vacío');
      const answer = 'No tengo información suficiente en los documentos para responder esa pregunta.';
      return res.json({ answer, hits: [] });
    }

    // Filtrar vector store si se especifica un archivo
    let filteredVectorstore = vectorstore;
    if (fileName) {
      filteredVectorstore = vectorstore.filter(v => v.path === fileName);
      console.log('📊 Vector store filtrado:', filteredVectorstore.length, 'entradas para', fileName);
      if (!filteredVectorstore.length) {
        const answer = `No se encontraron documentos con el nombre "${fileName}".`;
        return res.json({ answer, hits: [] });
      }
    }

    const queryEmb = await createEmbedding(message);
    console.log('📏 Query embedding length:', queryEmb.length);
    const hits = similaritySearch(queryEmb, filteredVectorstore, TOP_K, MIN_SIM);
    console.log('🔍 Resultados de búsqueda:', hits.length, hits.map(h => ({
      path: h.path,
      chunk: h.chunk,
      similarity: Number(h.similarity.toFixed(3))
    })));

    let context = hits.length
      ? hits.map(h => `Archivo: ${h.path} · Chunk ${h.chunk}\n${h.text}`).join('\n---\n')
      : '(sin fragmentos relevantes)';
    
    // Truncar context si excede MAX_CONTEXT_CHARS
    if (context.length > MAX_CONTEXT_CHARS) {
      console.warn(`⚠️ Contexto truncado: de ${context.length} a ${MAX_CONTEXT_CHARS} chars.`);
      context = context.slice(0, MAX_CONTEXT_CHARS) + '... [truncado]';
    }
    console.log('📝 Longitud del contexto:', context.length, 'caracteres');

    // Prompt estricto para citar textualmente cuando se especifica un archivo
    const systemPrompt = fileName
      ? `
        Eres **DelfinoBot**, el asistente virtual oficial de *Delfino Tours II*.
        Responde ÚNICAMENTE citando textualmente el contenido del contexto proporcionado, sin resumir, parafrasear ni interpretar, solo traducido al español o en su defecto al idioma en el que te indiquen.
        Si el contexto no contiene información relevante, di: "No se encontró información relevante en el documento ${fileName}."
        Responde SIEMPRE en Markdown claro y conciso y con la referencia al archivo.
        Si el cliente pregunta quién eres, responde:
        «Soy DelfinoBot, el asistente virtual oficial de Delfino Tours II».`.trim()
      : `
        Eres **DelfinoBot**, el asistente virtual oficial de *Delfino Tours II*.
        Responde ÚNICAMENTE con la información contenida en el contexto proporcionado.
        Si el contexto no contiene información relevante, di: "No tengo información suficiente en los documentos para responder esa pregunta."
        Responde SIEMPRE en Markdown claro y conciso y con la referencia al archivo.
        Si el cliente pregunta quién eres, responde:
        «Soy DelfinoBot, el asistente virtual oficial de Delfino Tours II».`.trim();

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'system', content: `Contexto:\n${context}` },
      { role: 'user', content: message }
    ];

    const model = 'gpt-5-chat-latest'; // Forzado a GPT-5 chat

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      if (res.flushHeaders) res.flushHeaders();

      const ping = setInterval(() => res.write(':\n\n'), KEEPALIVE_MS);
      let answer = '';

      try {
        for await (const chunk of askOpenAIStream(messages, { model })) { // Pasar modelo
          const delta = chunk.choices?.[0]?.delta?.content;
          if (!delta) continue;
          answer += delta;
          res.write(`data:${delta}\n\n`);
        }
      } finally {
        clearInterval(ping);
        res.end();
      }

      return;
    }

    const answer = await askOpenAI(messages, { model }); // Pasar modelo
    res.json({
      answer,
      hits: hits.map(h => ({
        file: h.path,
        chunk: h.chunk,
        similarity: Number(h.similarity.toFixed(3))
      }))
    });
  } catch (err) {
    console.error('❌ Error en /api/chat:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;