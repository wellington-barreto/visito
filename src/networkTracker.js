/**
 * Rastreia o trafego de rede REAL (bytes que passaram pelo proxy) de uma
 * pagina do Puppeteer, usando o Chrome DevTools Protocol (CDP) direto.
 *
 * Por que CDP e nao "somar content-length dos response.headers()":
 * content-length as vezes nao vem no header (respostas chunked), e nem
 * sempre reflete o tamanho real transferido (compressao gzip/br). O CDP
 * usa `encodedDataLength`, que e o numero de bytes que efetivamente
 * passaram pela rede - o mesmo tipo de numero que um proxy usa pra
 * cobrar por trafego.
 *
 * Conta TODAS as requisicoes feitas pela pagina durante a navegacao
 * inteira (HTML, CSS, JS, imagens, XHR, etc) - ou seja, reflete o
 * consumo real daquela execucao no proxy.
 */
async function attachNetworkTracker(page) {
  let totalBytes = 0;
  let requestCount = 0;

  const client = await page.createCDPSession();
  await client.send('Network.enable');

  client.on('Network.loadingFinished', (event) => {
    totalBytes += event.encodedDataLength || 0;
    requestCount += 1;
  });

  return {
    getTotals: () => ({ totalBytes, requestCount }),
    detach: async () => {
      try {
        await client.detach();
      } catch (err) {
        // pagina/browser pode ja ter fechado - tudo bem, so ignora
      }
    },
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

module.exports = { attachNetworkTracker, round1 };
