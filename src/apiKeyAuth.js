/**
 * Protecao simples baseada em uma chave que muda todo dia:
 *   chave valida = `${DASHBOARD_API_SECRET}-${AAAAMMDD}`
 *
 * Exemplo: se DASHBOARD_API_SECRET=goldmine2026, a chave valida em
 * 16/07/2026 e "goldmine2026-20260716".
 *
 * Isso NAO e seguranca de nivel bancario (a chave de hoje da pra
 * descobrir se alguem souber o segredo base + a data, que e publica).
 * Mas ja impede acesso casual de quem so encontrar a URL, e a chave
 * expira sozinha todo dia sem voce precisar trocar nada manualmente.
 *
 * Aceita a chave via:
 *   - query string:  ?key=goldmine2026-20260716
 *   - header:        x-api-key: goldmine2026-20260716
 */

const crypto = require('crypto');

/**
 * Protecao por chave FIXA, para o /webhook/visito.
 * Diferente da chave diaria do dashboard: aqui e um valor unico que
 * voce define no Railway (WEBHOOK_API_KEY) e usa sempre o mesmo, tanto
 * no n8n quanto em qualquer outro lugar que chame o webhook.
 *
 * Aceita a chave via:
 *   - header: x-api-key: SEU_VALOR
 *   - ou header: authorization: Bearer SEU_VALOR
 */
function safeCompare(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) {
    // ainda assim roda um compare pra nao vazar timing pelo tamanho
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireFixedApiKey(req, res, next) {
  const expected = process.env.WEBHOOK_API_KEY;

  if (!expected) {
    return res.status(503).json({
      error: true,
      message: 'WEBHOOK_API_KEY nao configurado no servidor. Defina essa variavel de ambiente para liberar o acesso a esta rota.',
    });
  }

  const authHeader = req.headers['authorization'] || '';
  const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const providedKey = req.headers['x-api-key'] || bearerKey;

  if (providedKey && safeCompare(providedKey, expected)) {
    return next();
  }

  return res.status(401).json({
    error: true,
    message: 'Chave de acesso invalida ou ausente. Envie o header x-api-key.',
  });
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatYYYYMMDD(date) {
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}`;
}

// Gera as chaves validas de ontem/hoje/amanha (em UTC) para nao dar
// problema perto da virada da meia-noite dependendo do fuso de quem acessa.
function getValidKeys(secret) {
  const now = new Date();
  return [-1, 0, 1].map((offsetDays) => {
    const d = new Date(now.getTime() + offsetDays * 24 * 60 * 60 * 1000);
    return `${secret}-${formatYYYYMMDD(d)}`;
  });
}

function requireApiKey(req, res, next) {
  const secret = process.env.DASHBOARD_API_SECRET;

  if (!secret) {
    return res.status(503).json({
      error: true,
      message:
        'DASHBOARD_API_SECRET nao configurado no servidor. Defina essa variavel de ambiente para liberar o acesso a esta rota.',
    });
  }

  const providedKey = req.query.key || req.headers['x-api-key'];
  const validKeys = getValidKeys(secret);

  if (providedKey && validKeys.includes(providedKey)) {
    return next();
  }

  return res.status(401).json({
    error: true,
    message: 'Chave de acesso invalida ou ausente. Adicione ?key=SEU_SEGREDO-AAAAMMDD na URL.',
  });
}

module.exports = { requireApiKey, requireFixedApiKey, getValidKeys, formatYYYYMMDD };
