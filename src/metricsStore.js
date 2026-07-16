/**
 * Guarda em memoria (RAM do processo, nao e persistido em disco):
 * - as ultimas N requisicoes feitas ao /webhook/visito (duracao, status, etc)
 * - amostras periodicas de uso de memoria do processo
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

  sampleMemory() {
    const mem = process.memoryUsage();
    this.memorySamples.push({
      t: Date.now(),
      rssMB: round1(mem.rss / 1024 / 1024),
      heapUsedMB: round1(mem.heapUsed / 1024 / 1024),
    });
    if (this.memorySamples.length > this.maxMemorySamples) {
      this.memorySamples.shift();
    }
  }

  getSnapshot({ active, pending, concurrencyLimit }) {
    const mem = process.memoryUsage();
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      queue: {
        browsersAtivos: active,
        naFila: pending,
        limiteConcorrencia: concurrencyLimit,
      },
      memoriaAtualMB: {
        rss: round1(mem.rss / 1024 / 1024),
        heapUsed: round1(mem.heapUsed / 1024 / 1024),
        heapTotal: round1(mem.heapTotal / 1024 / 1024),
        external: round1(mem.external / 1024 / 1024),
      },
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
