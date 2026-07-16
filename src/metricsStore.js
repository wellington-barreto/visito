const { countChromiumProcesses, getContainerMemoryMB } = require('./processScan');

/**
 * Guarda em memoria (RAM do processo, nao e persistido em disco):
 * - as ultimas N requisicoes feitas ao /webhook/visito (duracao, status, etc)
 * - amostras periodicas de uso de memoria do processo E do container
 * - contagem de processos chromium vivos (detecta vazamento de verdade)
 *
 * Serve só para alimentar o /metrics e o /dashboard. Reinicia zerado
 * toda vez que o servico reinicia (redeploy, crash, etc) - e um
 * historico de curto prazo, nao um sistema de observabilidade completo.
 */
class MetricsStore {
  constructor({ maxRequests = 10, maxMemorySamples = 120 } = {}) {
    this.maxRequests = maxRequests;
    this.maxMemorySamples = maxMemorySamples;
    this.requests = []; // mais recente primeiro
    this.memorySamples = []; // mais antiga primeiro (ordem cronologica, bom pra grafico)
  }

  recordRequest({ trackId, url, startedAt, durationMs, success, errorMessage, browsersAtivos, naFila }) {
    this.requests.unshift({
      trackId: trackId || null,
      url: url || null,
      startedAt,
      durationMs,
      success,
      errorMessage: errorMessage || null,
      browsersAtivos,
      naFila,
    });
    if (this.requests.length > this.maxRequests) {
      this.requests.length = this.maxRequests;
    }
  }

  async sampleMemory() {
    const mem = process.memoryUsage();
    const container = await getContainerMemoryMB();
    const { count: chromiumProcessCount } = await countChromiumProcesses();

    this.memorySamples.push({
      t: Date.now(),
      rssMB: round1(mem.rss / 1024 / 1024),
      heapUsedMB: round1(mem.heapUsed / 1024 / 1024),
      containerUsedMB: container.usedMB,
      chromiumProcessCount,
    });
    if (this.memorySamples.length > this.maxMemorySamples) {
      this.memorySamples.shift();
    }
  }

  async getSnapshot({ active, pending, concurrencyLimit }) {
    const mem = process.memoryUsage();
    const container = await getContainerMemoryMB();
    const { count: chromiumProcessCount } = await countChromiumProcesses();

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      queue: {
        browsersAtivos: active,
        naFila: pending,
        limiteConcorrencia: concurrencyLimit,
      },
      memoriaAtualMB: {
        // rss do processo Node em si (NAO inclui os processos do Chromium,
        // que rodam separados no sistema operacional)
        rss: round1(mem.rss / 1024 / 1024),
        heapUsed: round1(mem.heapUsed / 1024 / 1024),
        heapTotal: round1(mem.heapTotal / 1024 / 1024),
        external: round1(mem.external / 1024 / 1024),
        // memoria de TODO o container (Node + Chromium + tudo mais), lida
        // direto do cgroup - esse e o numero que reflete se tem algo vazando
        containerUsada: container.usedMB,
        containerLimite: container.limitMB,
        fonte: container.source,
      },
      chromiumProcessCount, // se isso nao voltar a 0 com browsersAtivos=0, e vazamento
      uptimeSegundos: Math.round(process.uptime()),
      memoryHistory: this.memorySamples,
      recentRequests: this.requests,
    };
  }
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

module.exports = MetricsStore;
