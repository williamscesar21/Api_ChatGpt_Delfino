/**
 * Construye el array de `messages` para la API Chat de OpenAI.
 *
 * @param {string} userQuestion                       Pregunta del usuario (último turno)
 * @param {Record<string,string|object>} fileContents Mapa { nombreArchivo: texto │ jsonString }
 * @param {import("openai").ChatCompletionMessageParam[]} [history]  Historial reciente
 * @param {object} [options]
 * @param {number} [options.maxCharsPerFile=8_000]    Límite de caracteres por archivo
 * @param {number} [options.maxHistory=8]             Nº máximo de mensajes previos
 * @returns {import("openai").ChatCompletionMessageParam[]}
 */
export function buildMessages(
  userQuestion,
  fileContents,
  history = [],
  options = {}
) {
  const MAX_CHARS = options.maxCharsPerFile ?? 8_000; // ≈ 2 000 tokens
  const MAX_HIST  = options.maxHistory     ?? 8;

  /* ────────────── Prompt de sistema ────────────── */
  const systemPrompt = `
Eres **DelfinoBot**, el asistente virtual oficial de *Delfino Tours II*.

🎯 Misión  
Responde con información clara y precisa sobre rutas, horarios, tarifas,
servicios a bordo, políticas de reserva y demás datos presentes en la
documentación interna.

📚 Fuentes autorizadas  
Solo puedes usar la información que se te proporcione en los documentos
indexados. No inventes datos ni recurras a conocimiento externo.

💬 Estilo  
• Lenguaje cordial y profesional.  
• Frases breves y fáciles de leer.  
• Ofrece pasos siguientes cuando proceda.

🚫 Fuera de alcance  
Si la respuesta **no** está en los documentos, di exactamente:  
Lo siento, no dispongo de esa información.

📄 Formato  
No incluyas enlaces externos ni referencias académicas; solo el contenido
útil para el viajero.
`.trim();

  /* ────────────── Documentos relevantes ────────────── */
  const docMessages = Object.entries(fileContents).map(([name, content]) => ({
    role: "system",
    content:
      `Contenido del archivo «${name}»:\n` +
      (typeof content === "string"
        ? content.slice(0, MAX_CHARS)
        : JSON.stringify(content).slice(0, MAX_CHARS)),
  }));

  /* ────────────── Historial previo (máx MAX_HIST) ────────────── */
  const tail = history.slice(-MAX_HIST);

  /* ────────────── Mensajes finales ────────────── */
  return [
    { role: "system", content: systemPrompt },
    ...docMessages,
    ...tail,
    { role: "user", content: userQuestion },
  ];
}
