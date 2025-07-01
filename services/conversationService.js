import { v4 as uuid } from "uuid";

const TTL = Number(process.env.CHAT_TTL_MIN || 60) * 60_000;
/*  chatId → { messages: [{role,content,timestamp?}], expires }  */
const store = new Map();

/* ────────────────────────────────────────────────
   Crea conversación y registra TTL
───────────────────────────────────────────────────*/
export function newChat() {
  const id = uuid();
  store.set(id, { messages: [], expires: Date.now() + TTL });
  return id;
}

/* ────────────────────────────────────────────────
   Devuelve todo el historial (o null si expiró)
───────────────────────────────────────────────────*/
export function getHistory(id) {
  const entry = store.get(id);
  if (!entry) return null;

  /* purga si caducó */
  if (Date.now() > entry.expires) {
    store.delete(id);
    return null;
  }
  return entry.messages;
}

/* ────────────────────────────────────────────────
   Últimos N mensajes (por defecto 8) para “contexto”
───────────────────────────────────────────────────*/
export function getTail(id, max = 8) {
  const msgs = getHistory(id) ?? [];
  return msgs.slice(-max);
}

/* ────────────────────────────────────────────────
   Añade turno (user o assistant) y renueva TTL
───────────────────────────────────────────────────*/
export function appendMessage(id, message) {
  const entry = store.get(id);
  if (!entry) return;
  entry.messages.push({
    ...message,
    timestamp: message.timestamp ?? Date.now(),
  });
  entry.expires = Date.now() + TTL;
}

/* helper específico para assistant */
export function appendAssistant(id, content) {
  appendMessage(id, { role: "assistant", content });
}
