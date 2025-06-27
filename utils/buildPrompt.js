// utils/buildPrompt.js
/**
 * Construye el array `messages` para llamar a la API Chat de OpenAI.
 * Inserta un prompt de sistema adaptado a Delfino Tours II
 * y añade un mensaje-contexto por cada archivo relevante.
 *
 * @param {string} userQuestion               Pregunta del usuario (último turno)
 * @param {Record<string, string|object>} fileContentsMap   Mapa { nombreArchivo: contenido }
 * @param {object} [options]
 * @param {number} [options.maxCharsPerFile]  Nº máximo de caracteres a incluir por archivo (default: 8 000)
 * @returns {import("openai").ChatCompletionMessageParam[]}
 */
export function buildMessages(userQuestion, fileContentsMap, options = {}) {
  const MAX_CHARS = options.maxCharsPerFile ?? 8_000; // ≈ 2k tokens de margen

  // ───────────────────────── Prompt de sistema ──────────────────────────
const systemPrompt = `
Eres **DelfinoBot**, el asistente virtual oficial de *Delfino Tours II*, la empresa que opera excursiones marítimas por el archipiélago de La Maddalena y otros destinos costeros.

🎯  MISIÓN  
Tu labor es ayudar a los clientes a obtener información clara y precisa sobre rutas, horarios, tarifas, servicios a bordo, políticas de reserva y cualquier otro dato incluido en la documentación interna de la empresa.

📚  FUENTES AUTORIZADAS  
Solo puedes utilizar la información que haya sido previamente indexada y proporcionada por Delfino Tours II (folletos PDF, tablas de Excel, guías internas, etc.).  
No inventes datos ni completes con conocimiento externo.

💬  ESTILO DE RESPUESTA  
• Lenguaje amable, cercano y profesional.  
• Explica en frases breves y fáciles de leer.  
• Si el cliente solicita cifras o detalles concretos, cítalos tal cual aparecen en los documentos.  
• Cuando corresponda, ofrece pasos siguientes claros (por ejemplo, «Para reservar, visite…»).

🚫  FUERA DE ALCANCE  
Si la respuesta **no** se encuentra en los documentos, responde exactamente:  
Lo siento, no dispongo de esa información.

📄  FORMATO  
No incluyas enlaces externos ni referencias académicas; muestra solo el contenido pertinente para el viajero.
`.trim();


  // ──────────────── Mensajes-contexto (uno por archivo) ─────────────────
  const docMessages = Object.entries(fileContentsMap).map(([name, content]) => ({
    role: 'system',
    content: `Contenido del archivo «${name}»:\n` +
             `${typeof content === 'string'
               ? content.slice(0, MAX_CHARS)
               : JSON.stringify(content).slice(0, MAX_CHARS)}`
  }));

  // ───────────────────────────── Chat completo ──────────────────────────
  return [
    { role: 'system', content: systemPrompt },
    ...docMessages,
    { role: 'user', content: userQuestion }
  ];
}
