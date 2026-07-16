require('dotenv').config();
const express = require('express');
const { scrapeVisit } = require('./src/scrapeVisit');
const ConcurrencyQueue = require('./src/concurrencyQueue');

const app = express();
app.use(express.json());

// ----------------------------------------------------
// Limite de quantos browsers do Puppeteer rodam ao mesmo tempo.
// Ajuste MAX_CONCURRENT_BROWSERS de acordo com a memoria da sua
// instancia no Railway. Cada Chromium headless costuma consumir
// entre 150-300MB, entao numa instancia de 512MB-1GB, 2 e um
// ponto de partida seguro; va subindo aos poucos e observando o
// grafico de memoria no Railway.
// ----------------------------------------------------
const MAX_CONCURRENT_BROWSERS = Number(process.env.MAX_CONCURRENT_BROWSERS || 2);
const MAX_QUEUE_SIZE = Number(process.env.MAX_QUEUE_SIZE || 20);

const browserQueue = new ConcurrencyQueue({
  concurrency: MAX_CONCURRENT_BROWSERS,
  maxQueueSize: MAX_QUEUE_SIZE,
});

// Healthcheck (util pro Railway saber que o servico ta de pe, e pra voce
// acompanhar quantos browsers estao rodando/aguardando)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    browsersAtivos: browserQueue.active,
    naFila: browserQueue.pending,
    limiteConcorrencia: MAX_CONCURRENT_BROWSERS,
  });
});

// Mesmo path que voce ja usa no n8n (webhookUrl: /webhook/visito)
app.post('/webhook/visito', async (req, res) => {
  const startedAt = Date.now();
  try {
    const result = await browserQueue.add(() => scrapeVisit(req.body));
    console.log(
      `[visito] OK trackId=${result.trackId} em ${Date.now() - startedAt}ms ` +
        `(ativos=${browserQueue.active}, fila=${browserQueue.pending})`
    );
    // mantem o mesmo formato de array que o n8n retornava
    res.json([result]);
  } catch (err) {
    const isQueueFull = err.message && err.message.startsWith('QUEUE_FULL');
    console.error(`[visito] ERRO${isQueueFull ? ' (fila cheia)' : ''}:`, err.message);
    res.status(isQueueFull ? 503 : 500).json({
      error: true,
      message: err.message,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
