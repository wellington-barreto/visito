const puppeteer = require('puppeteer-core');
const { createPeakMemoryTracker } = require('./processTreeMemory');
const { attachNetworkTracker, round1 } = require('./networkTracker');

// ----------------------------------------------------
// Configuracoes vindas de variaveis de ambiente
// (nunca deixe usuario/senha do proxy hardcoded no codigo)
// ----------------------------------------------------
const PROXY_HOST = process.env.PROXY_HOST || 'gw.dataimpulse.com';
const PROXY_PORT = process.env.PROXY_PORT || '823';
const PROXY_USER = process.env.PROXY_USER;
const PROXY_PASS = process.env.PROXY_PASS;
const TRACK_API_BASE = process.env.TRACK_API_BASE || 'https://api.atomicatpages.site/webhook/get-track';
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 30000);
const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH;

if (!PROXY_USER || !PROXY_PASS) {
  console.warn('[AVISO] PROXY_USER / PROXY_PASS nao configurados nas variaveis de ambiente.');
}

// ----------------------------------------------------
// Sorteia um User-Agent realista (usado quando o body nao manda um)
// ----------------------------------------------------
function getRandomUserAgent() {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.85 Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 12; SM-A125F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Mobile Safari/537.36',
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

/**
 * Executa o fluxo completo: abre o browser, navega, opcionalmente clica no CTA
 * e retorna os dados coletados. Sempre fecha o browser no final (mesmo em erro),
 * que era a causa mais provavel dos crashes no n8n (browsers ficando abertos).
 *
 * @param {object} payload - body recebido no webhook (trackId, url, userAgent, cr, rg, ci)
 */
async function scrapeVisit(payload) {
  const {
    trackId,
    url: urlOri,
    userAgent: userAgentInput,
    cr = 'us',
    rg: st = '',
    ci = '',
  } = payload || {};

  if (!urlOri) {
    throw new Error('Parametro "url" e obrigatorio no body.');
  }

  const userAgent = userAgentInput || getRandomUserAgent();
  const proxyUserCity = `${PROXY_USER}__cr.${cr};state.${st}`;

  let browser;
  let page;
  let peakTracker;
  let peakMemoryMB = null;
  let networkTracker;
  let networkBytes = 0;
  let networkRequestCount = 0;

  try {
    // ----------------------------------------------------
    // Inicia o browser
    // ----------------------------------------------------
    browser = await puppeteer.launch({
      headless: true,
      executablePath: CHROMIUM_PATH, // definido no Dockerfile (/usr/bin/chromium)
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        `--proxy-server=http://${PROXY_HOST}:${PROXY_PORT}`,
        '--disable-gpu',
        '--disable-extensions',
        '--disable-dev-shm-usage',
        '--no-zygote',
      ],
    });

    // Comeca a medir o pico de memoria (Chromium principal + todos os
    // processos filhos dele: renderer, gpu, etc) desta navegacao
    // especifica, isolado de qualquer outro browser rodando em paralelo.
    peakTracker = createPeakMemoryTracker(browser.process()?.pid);

    page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    await page.setUserAgent(userAgent);

    // Comeca a somar os bytes reais trafegados (via CDP) por essa pagina,
    // do inicio ao fim da navegacao inteira - e o numero mais proximo do
    // que o proxy realmente cobra por trafego.
    networkTracker = await attachNetworkTracker(page);

    // Autenticacao do proxy
    await page.authenticate({
      username: proxyUserCity,
      password: PROXY_PASS,
    });

    // ----------------------------------------------------
    // 1) Geolocalizacao do IP usado (via ipwho.is)
    // ----------------------------------------------------
    await page.goto('https://ipwho.is/?fields=ip,city,region,country,org', {
      waitUntil: 'networkidle2',
    });
    const ipGeoText = await page.evaluate(() => document.body.innerText);
    const ipGeo = JSON.parse(ipGeoText);

    // ----------------------------------------------------
    // 2) Sorteia se vai simular "checkout" e busca dados de tracking
    // ----------------------------------------------------
    const checkout = Math.random() < 0.6;
    let clickCTA = false;
    let oriclick = null;
    let selectorCTA = null;

    if (checkout && trackId) {
      const trackApiUrl = `${TRACK_API_BASE}?trackid=${trackId}`;
      const response = await page.goto(trackApiUrl);
      const body = await response.json();
      oriclick = body?.data?.oriclick ?? null;
      selectorCTA = body?.data?.cta_selector ?? null;
    }

    // ----------------------------------------------------
    // 3) Acessa a URL de destino via proxy
    // ----------------------------------------------------
    const targetUrl = urlOri;
    await page.goto(targetUrl, { waitUntil: 'networkidle2' });

    let pageTitle = await page.title();
    let clickTime = null;

    if (selectorCTA && oriclick) {
      try {
        await page.waitForSelector(selectorCTA, { timeout: 2000 });
        await page.click(selectorCTA);
        clickTime = new Date().toISOString();
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
        await page.waitForFunction(() => document.readyState === 'complete');
        clickCTA = true;
      } catch (e) {
        console.log('Botao nao existe, nao cliquei.');
        clickCTA = false;
      }
    }

    pageTitle = await page.title();

    peakMemoryMB = peakTracker ? await peakTracker.stop() : null;

    if (networkTracker) {
      const totals = networkTracker.getTotals();
      networkBytes = totals.totalBytes;
      networkRequestCount = totals.requestCount;
      await networkTracker.detach();
    }

    return {
      data: {
        geo: ipGeo,
        proxyIp: ipGeo.ip,
        checkout,
        clickCTA,
        oriclick,
        pageTitle,
        accessedUrl: targetUrl,
        selectorCTA,
        userAgentUsed: userAgent,
        clickTime,
        peakMemoryMB, // maior uso de memoria (MB) do browser durante esta navegacao
        networkKB: round1(networkBytes / 1024), // trafego real (bytes via CDP) da navegacao inteira
        networkRequestCount, // quantas requisicoes de rede foram feitas
      },
      trackId,
      proxyUserCity,
    };
  } catch (err) {
    // mesmo em erro, guarda o pico de memoria e o trafego medidos ate aqui -
    // util pra saber se a falha teve relacao com consumo alto de recursos
    if (peakTracker) {
      peakMemoryMB = await peakTracker.stop().catch(() => null);
    }
    if (networkTracker) {
      networkBytes = networkTracker.getTotals().totalBytes;
      await networkTracker.detach().catch(() => {});
    }
    err.peakMemoryMB = peakMemoryMB;
    err.networkKB = round1(networkBytes / 1024);
    throw err;
  } finally {
    // Garante que a pagina e o browser SEMPRE fecham, mesmo se algo der erro
    // (isso e o que provavelmente estava causando os crashes por acumulo de
    // processos chromium zumbis no n8n).
    if (page && !page.isClosed()) {
      await page.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = { scrapeVisit, getRandomUserAgent };
