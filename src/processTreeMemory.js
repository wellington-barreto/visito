const fs = require('fs');

/**
 * Mede quanta memoria RAM uma arvore de processos especifica esta usando
 * AGORA, lendo /proc diretamente (sem "ps", sem dependencias externas).
 *
 * Serve para medir o consumo de UM browser do Puppeteer especificamente -
 * diferente da memoria total do container, que fica poluida se tiver mais
 * de uma navegacao rodando ao mesmo tempo (com MAX_CONCURRENT_BROWSERS > 1).
 *
 * Um browser Chromium e naturalmente MULTI-PROCESSO: o processo principal
 * (que o puppeteer.launch() retorna) spawna processos filhos (renderer,
 * GPU, zygote, etc). Por isso aqui a gente soma o RSS do processo raiz +
 * TODOS os descendentes dele, senao o numero fica bem menor que o real.
 */

async function readProcStatus(pid) {
  const content = await fs.promises.readFile(`/proc/${pid}/status`, 'utf8');
  const ppidMatch = content.match(/^PPid:\s*(\d+)/m);
  const rssMatch = content.match(/^VmRSS:\s*(\d+)\s*kB/m);
  return {
    ppid: ppidMatch ? Number(ppidMatch[1]) : null,
    rssKB: rssMatch ? Number(rssMatch[1]) : 0,
  };
}

async function getAllProcesses() {
  let pidDirs;
  try {
    pidDirs = await fs.promises.readdir('/proc');
  } catch (err) {
    return [];
  }

  const pids = pidDirs.filter((p) => /^\d+$/.test(p)).map(Number);
  const results = await Promise.all(
    pids.map(async (pid) => {
      try {
        const info = await readProcStatus(pid);
        return { pid, ...info };
      } catch (err) {
        return null; // processo pode ter morrido entre o readdir e o readFile
      }
    })
  );
  return results.filter(Boolean);
}

/**
 * Soma o RSS (em MB) do processo `rootPid` + todos os processos
 * descendentes dele (filhos, netos, etc).
 */
async function getProcessTreeRssMB(rootPid) {
  if (!rootPid) return 0;

  const all = await getAllProcesses();
  const byPid = new Map(all.map((p) => [p.pid, p]));
  const childrenByPpid = new Map();
  for (const p of all) {
    if (!childrenByPpid.has(p.ppid)) childrenByPpid.set(p.ppid, []);
    childrenByPpid.get(p.ppid).push(p);
  }

  const visited = new Set();
  const stack = [rootPid];
  let totalKB = 0;

  while (stack.length) {
    const pid = stack.pop();
    if (visited.has(pid)) continue;
    visited.add(pid);

    const proc = byPid.get(pid);
    if (proc) totalKB += proc.rssKB;

    for (const child of childrenByPpid.get(pid) || []) {
      stack.push(child.pid);
    }
  }

  return round1(totalKB / 1024);
}

/**
 * Cria um "rastreador de pico": vai amostrando a memoria da arvore de
 * processos em intervalos regulares e guarda o maior valor visto, ate
 * ser parado com .stop(). Uso tipico: iniciar logo apos abrir o browser,
 * parar antes de fechar, e ler .peakMB para saber o consumo maximo real
 * daquela execucao (navegadores costumam pesar mais durante a navegacao
 * do que no momento exato em que voce tira uma unica foto da memoria).
 */
function createPeakMemoryTracker(rootPid, intervalMs = 750) {
  let peakMB = 0;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const mb = await getProcessTreeRssMB(rootPid);
      if (mb > peakMB) peakMB = mb;
    } catch (err) {
      // nao deixa uma falha de leitura de /proc derrubar a navegacao
    }
  };

  tick(); // primeira amostra imediata
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await tick(); // uma ultima amostra antes de fechar o browser
      return peakMB;
    },
    get peakMB() {
      return peakMB;
    },
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

module.exports = { getProcessTreeRssMB, createPeakMemoryTracker };
