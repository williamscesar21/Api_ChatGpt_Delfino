import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Corrige la ortografía de la pregunta y la devuelve limpia.
 * Usa un modelo "economy" para minimizar coste.
 */
export async function fixSpelling(question) {
  const prompt = `
Corrige la ortografía y separa correctamente las palabras
sin cambiar el idioma ni agregar información:
"${question}"`.trim();

  const { choices } = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    temperature: 0,
    messages: [{ role: 'user', content: prompt }]
  });

  return choices[0].message.content.trim();
}
