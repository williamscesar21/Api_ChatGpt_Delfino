// @ts-check

/**
 * @typedef {import("openai").ChatCompletionMessageParam} ChatCompletionMessageParam
 */

/**
 * Genera el array `messages` para la API Chat completions.
 * @param {string} userQuestion
 * @param {Record<string, string|object>} fileContents
 * @param {ChatCompletionMessageParam[]} [history]
 * @param {{ maxCharsPerFile?: number; maxHistory?: number }} [options]
 * @returns {ChatCompletionMessageParam[]}
 */
export function buildMessages(
  userQuestion,
  fileContents,
  history = [],
  options = {}
) {
  const MAX_CHARS = options.maxCharsPerFile ?? 8_000;
  const MAX_HIST  = options.maxHistory     ?? 8;

  /* prompt de sistema */
  const systemPrompt = `
Eres **DelfinoBot**, asistente virtual de *Delfino Tours II*.

• Usa únicamente los fragmentos entre «<<<Archivo|chunk:n>>> … <<<FIN>>>».
• Cuando cites, indica (Archivo.ext · chunk:n).
• Si no está en los documentos, responde exactamente:
  Lo siento, no dispongo de esa información.
• Responde SIEMPRE en Markdown claro y conciso y con la referencia al archivo.
Recuerda siempre revisar todos los archivos si no se especifica uno
Y cada vez que te pregunten por algun precio revisar el Tarifario.
`.trim();

  /* documentos troceados */
  let idx = 1;
  const docs = [];

  for (const [name, raw] of Object.entries(fileContents)) {
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    for (let i = 0; i < text.length; i += MAX_CHARS) {
      docs.push({
        role: "system",
        content: `<<<${name}|chunk:${idx}>>>\n${text.slice(i, i + MAX_CHARS)}\n<<<FIN>>>`,
      });
      idx += 1;
    }
  }

  const tail = history.slice(-MAX_HIST);

  return [
    { role: "system", content: systemPrompt },
    ...docs,
    ...tail,
    { role: "user", content: userQuestion },
  ];
}
