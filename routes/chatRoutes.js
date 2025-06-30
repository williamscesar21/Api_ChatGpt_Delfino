import { Router } from "express";
import crypto     from "node:crypto";

import { createEmbedding, similaritySearch } from "../services/embeddingsService.js";
import { getRows }           from "../services/vectorStoreService.js";
import { buildMessages }     from "../utils/buildPrompt.js";
import { askOpenAI }         from "../services/openaiService.js";
import { fixSpelling }       from "../services/spellService.js";
import { buildCacheKey, cache } from "../services/cacheService.js";
import {
  appendMessage,
  appendAssistant,
  getTail                    // ← NUEVO: recupera últimos N mensajes
} from "../services/conversationService.js";

const router = Router();
const TOP_K      = Number(process.env.TOP_K || 6);
const MAX_TAIL   = Number(process.env.MAX_TAIL || 8);   // mensajes previos a enviar

/* ──────────────────────────────────────────────
   POST /api/chat/start   →  { chatId }
───────────────────────────────────────────────*/
router.post("/chat/start", (_req, res) => {
  const chatId = crypto.randomUUID();
  res.json({ chatId });
});

/* ──────────────────────────────────────────────
   POST /api/chat  →  { answer }
   body: { chatId, message, selectedIds?: string[] }
───────────────────────────────────────────────*/
router.post("/chat", async (req, res) => {
  try {
    const { chatId, message, selectedIds = [] } = req.body;
    if (!message?.trim())
      return res.status(400).json({ error: "Empty message" });

    /* 1️⃣   autocorrección ligera */
    const fixed = await fixSpelling(message);

    /* 2️⃣   cache lookup */
    const key = buildCacheKey(fixed, selectedIds);
    if (cache.has(key)) {
      const cached = cache.get(key);
      appendAssistant(chatId, cached);
      return res.json({ answer: cached, cached: true });
    }

    /* 3️⃣   embedding + búsqueda vectorial */
    const qEmb = await createEmbedding(fixed);
    const pool = getRows().filter(
      (r) => !selectedIds.length || selectedIds.includes(r.fileId)
    );
    const hits = similaritySearch(qEmb, pool, TOP_K);

    /* 4️⃣   contexto por archivo */
    const ctxMap = {};
    hits.forEach((h) => {
      ctxMap[h.path] = (ctxMap[h.path] || "") + "\n" + h.text;
    });

    /* 5️⃣   historial reciente */
    const history = getTail(chatId, MAX_TAIL);   // [{role,content}…]

    /* 6️⃣   prompt + llamada a OpenAI */
    const messages = buildMessages(fixed, ctxMap, history);
    const answer   = await askOpenAI(messages);

    /* 7️⃣   guardar en conversación + cache */
    appendMessage(chatId, { role: "user", content: fixed });
    appendAssistant(chatId, answer);
    cache.set(key, answer);

    res.json({ answer });
  } catch (err) {
    console.error("POST /chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
