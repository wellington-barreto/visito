const fs = require('fs');
const os = require('os');

/**
 * Conta quantos processos Chromium estao rodando AGORA no container,
 * lendo /proc diretamente (funciona em qualquer Linux, sem precisar
 * instalar "ps" ou qualquer pacote extra).
 *
 * Isso e o jeito mais direto de responder "o Puppeteer esta mesmo
 * fechando os browsers?" - se esse numero fica alto/crescendo mesmo
 * com browsersAtivos=0 na fila, e sinal de processos orfaos (zumbis)
 * que nao foram encerrados corretamente.
 */
async function countChromiumProcesses() {
  let pids;
  try {
    pids = await fs.promises.readdir('/proc');
  } catch (err) {
    // /proc nao disponivel (ex: rodando fora de Linux) - nao quebra o resto do /metrics
    return { count: null, error: 'proc_indisponivel' };
  }

  const numericPids = pids.filter((p) => /^\d+$/.test(p));
  let count = 0;

  await Promise.all(
    numericPids.map(async (pid) => {
      try {
        const cmdline = await fs.promises.readFile(`/proc/${pid}/cmdline`, 'utf8');
        if (cmdline.includes('chromium') || cmdline.includes('chrome')) {
          count++;
        }
      } catch (err) {
        // processo pode ter morrido entre o readdir e o readFile - ignora
      }
    })
  );

  return { count, error: null };
}

/**
 * Le o uso REAL de memoria do container direto do cgroup do Linux.
 * Isso e bem mais preciso que os.totalmem()/os.freemem(), que em muitos
 * containers Docker reportam a memoria do HOST inteiro (nao do container
 * com limite aplicado) - o que faria o numero parecer sempre folgado
 * mesmo perto de estourar de verdade.
 *
 * Tenta cgroup v2 primeiro, depois v1, e cai pro os.totalmem/freemem
 * como ultimo recurso se nenhum dos dois existir (ex: rodando fora de
 * Linux/Docker, como no seu proprio Mac/Windows local).
 */
async function readNum(path) {
  const raw = (await fs.promises.readFile(path, 'utf8')).trim();
  if (raw === 'max') return null; // cgroup v2 usa "max" quando nao ha limite definido
  return Number(raw);
}

async function getContainerMemoryMB() {
  // cgroup v2
  try {
    const usedBytes = await readNum('/sys/fs/cgroup/memory.current');
    const limitBytes = await readNum('/sys/fs/cgroup/memory.max');
    return {
      usedMB: round1(usedBytes / 1024 / 1024),
      limitMB: limitBytes ? round1(limitBytes / 1024 / 1024) : null,
      source: 'cgroup_v2',
    };
  } catch (err) {
    // segue tentando v1
  }

  // cgroup v1
  try {
    const usedBytes = await readNum('/sys/fs/cgroup/memory/memory.usage_in_bytes');
    const limitBytesRaw = await readNum('/sys/fs/cgroup/memory/memory.limit_in_bytes');
    // cgroup v1 sem limite definido costuma retornar um numero gigante (proximo do max de int64)
    const limitBytes = limitBytesRaw && limitBytesRaw < 1e15 ? limitBytesRaw : null;
    return {
      usedMB: round1(usedBytes / 1024 / 1024),
      limitMB: limitBytes ? round1(limitBytes / 1024 / 1024) : null,
      source: 'cgroup_v1',
    };
  } catch (err) {
    // segue pro fallback
  }

  // fallback: memoria do host (menos preciso dentro de um container, mas
  // melhor que nada se cgroup nao estiver acessivel)
  return {
    usedMB: round1((os.totalmem() - os.freemem()) / 1024 / 1024),
    limitMB: round1(os.totalmem() / 1024 / 1024),
    source: 'os_fallback',
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

module.exports = { countChromiumProcesses, getContainerMemoryMB };
