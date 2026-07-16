/**
 * Fila de concorrencia bem simples: garante que no maximo N tarefas
 * (no nosso caso, N browsers do Puppeteer) rodem ao mesmo tempo.
 * O resto fica esperando na fila ate uma vaga abrir.
 *
 * Nao usei a lib "p-queue" de proposito: as versoes atuais dela sao
 * ESM-only e complicam a integracao com require(). Essa implementacao
 * cobre exatamente o que precisamos aqui.
 */
class ConcurrencyQueue {
  /**
   * @param {object} opts
   * @param {number} opts.concurrency - quantas tarefas rodam em paralelo
   * @param {number} opts.maxQueueSize - quantas tarefas podem esperar na fila
   *   antes de comecar a rejeitar novos pedidos (protege contra fila infinita
   *   consumindo memoria se o trafego disparar)
   */
  constructor({ concurrency = 2, maxQueueSize = 20 } = {}) {
    this.concurrency = concurrency;
    this.maxQueueSize = maxQueueSize;
    this.running = 0;
    this.queue = [];
  }

  get active() {
    return this.running;
  }

  get pending() {
    return this.queue.length;
  }

  /**
   * Adiciona uma tarefa (funcao que retorna uma Promise) na fila.
   * Resolve/rejeita quando a tarefa efetivamente rodar.
   */
  add(taskFn) {
    return new Promise((resolve, reject) => {
      if (this.queue.length >= this.maxQueueSize) {
        reject(
          new Error(
            `QUEUE_FULL: ja existem ${this.queue.length} requests aguardando vaga. Tente novamente em instantes.`
          )
        );
        return;
      }

      this.queue.push({ taskFn, resolve, reject });
      this._processNext();
    });
  }

  _processNext() {
    if (this.running >= this.concurrency) return;

    const item = this.queue.shift();
    if (!item) return;

    this.running++;
    item
      .taskFn()
      .then(item.resolve, item.reject)
      .finally(() => {
        this.running--;
        this._processNext();
      });
  }
}

module.exports = ConcurrencyQueue;
