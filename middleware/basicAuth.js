// middleware/basicAuth.js
import { Buffer } from 'node:buffer';

/**
 * Middleware de autenticación HTTP Basic.
 * - Lee AUTH_USER y AUTH_PASS del .env
 * - Responde 401 si la cabecera Authorization no está presente o es inválida.
 */
export function basicAuth(req, res, next) {
  const header = req.headers.authorization || '';

  if (!header.startsWith('Basic ')) {
    return unauthorized(res);
  }

  // "Basic base64(user:pass)"  ->  "user:pass"
  const base64Credentials = header.split(' ')[1];
  const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
  const [user, pass] = credentials.split(':');

  if (
    user === process.env.AUTH_USER &&
    pass === process.env.AUTH_PASS
  ) {
    return next();                       // ✔️  Credenciales correctas
  }

  return unauthorized(res);
}

function unauthorized(res) {
  res.set('WWW-Authenticate', 'Basic realm="FileChatBot"'); // obliga al navegador a pedir login
  return res.status(401).json({ error: 'Credenciales inválidas' });
}
