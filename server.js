require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { scrapeVisit } = require('./src/scrapeVisit');
const ConcurrencyQueue = require('./src/concurrencyQueue');
const MetricsStore = require('./src/metricsStore');
const { requireApiKey, requireFixedApiKey } = require('./src/apiKeyAuth');

const app = express();
app.use(cors()); // libera chamadas via fetch do navegador (qualquer origem)
app.use(express.json());

// ----------------------------------------------------
// Rede de seguranca: se o Puppeteer (ou qualquer outra coisa) lançar um
// erro fora de um try/catch normal, o Node por padrao mata o processo
// inteiro - derrubando TODOS os requests em andamento, nao so o que deu
// problema. Isso e provavelmente parte do motivo dos crashes no n8n.
// Aqui a gente so loga e mantem o servidor de pe.
// ----------------------------------------------------
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] Erro nao tratado (servidor continua rodando):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] Erro nao tratado (servidor continua rodando):', err);
});

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

// Guarda historico curto (em RAM) das ultimas requisicoes + amostras de memoria,
// usado pelo /metrics e pelo /dashboard
const metricsStore = new MetricsStore({ maxRequests: 10, maxMemorySamples: 120 });
const MEMORY_SAMPLE_INTERVAL_MS = 5000; // uma amostra a cada 5s (~10min de historico com 120 pontos)
const memorySamplingTimer = setInterval(() => metricsStore.sampleMemory(), MEMORY_SAMPLE_INTERVAL_MS);
memorySamplingTimer.unref(); // nao impede o processo de encerrar normalmente
metricsStore.sampleMemory(); // primeira amostra imediata, sem esperar o primeiro intervalo

// O dashboard e servido SOMENTE pela rota protegida abaixo (nao usamos
// express.static aqui de proposito: se o HTML ficasse acessivel direto
// em /dashboard.html, isso pularia a checagem de api key).

// Healthcheck simples e rapido (bom pro Railway usar como healthcheck de verdade)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    browsersAtivos: browserQueue.active,
    naFila: browserQueue.pending,
    limiteConcorrencia: MAX_CONCURRENT_BROWSERS,
  });
});

// Metricas detalhadas: memoria atual + historico + ultimas requisicoes.
// PROTEGIDO por api key: expoe URLs acessadas e trackIds, entao nao fica publico.
app.get('/metrics', requireApiKey, (req, res) => {
  res.json(
    metricsStore.getSnapshot({
      active: browserQueue.active,
      pending: browserQueue.pending,
      concurrencyLimit: MAX_CONCURRENT_BROWSERS,
    })
  );
});

// Dashboard visual. PROTEGIDO pela mesma api key do /metrics
// (ex: https://SEU-APP.up.railway.app/dashboard?key=SEU_SEGREDO-AAAAMMDD)
app.get('/dashboard', requireApiKey, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Mesmo path que voce ja usa no n8n (webhookUrl: /webhook/visito)
// PROTEGIDO por chave fixa (WEBHOOK_API_KEY) - so quem manda o header
// x-api-key correto consegue executar o Puppeteer.
app.post('/webhook/visito', requireFixedApiKey, async (req, res) => {
  const startedAt = Date.now();
  try {
    const result = await browserQueue.add(() => scrapeVisit(req.body));
    const durationMs = Date.now() - startedAt;
    console.log(
      `[visito] OK trackId=${result.trackId} em ${durationMs}ms ` +
        `(ativos=${browserQueue.active}, fila=${browserQueue.pending})`
    );
    metricsStore.recordRequest({
      trackId: result.trackId,
      url: req.body?.url,
      startedAt,
      durationMs,
      success: true,
      browsersAtivos: browserQueue.active,
      naFila: browserQueue.pending,
    });
    // mantem o mesmo formato de array que o n8n retornava
    res.json([result]);
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const isQueueFull = err.message && err.message.startsWith('QUEUE_FULL');
    console.error(`[visito] ERRO${isQueueFull ? ' (fila cheia)' : ''}:`, err.message);
    metricsStore.recordRequest({
      trackId: req.body?.trackId,
      url: req.body?.url,
      startedAt,
      durationMs,
      success: false,
      errorMessage: err.message,
      browsersAtivos: browserQueue.active,
      naFila: browserQueue.pending,
    });
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
