//services/conversationService.js

import { v4 as uuid } from 'uuid';

const TTL = Number(process.env.CHAT_TTL_MIN || 60) * 60_000;
const store = new Map();   // chatId => { messages: [], expires: Date }

export function newChat() {
  const id = uuid();
  store.set(id, { messages: [], expires: Date.now() + TTL });
  return id;
}

export function getHistory(id) {
  const entry = store.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    store.delete(id);
    return null;
  }
  return entry.messages;
}

export function appendMessage(id, message) {
  const entry = store.get(id);
  if (!entry) return;
  entry.messages.push(message);
  entry.expires = Date.now() + TTL; // renueva TTL
}

export function appendAssistant(id, answer) {
  appendMessage(id, { role: 'assistant', content: answer });
}

// services/conversationService.js
export function getTail(id, max = 8) {
  const msgs = getHistory(id) ?? [];
  return msgs.slice(-max);           // los últimos 'max' mensajes
}
