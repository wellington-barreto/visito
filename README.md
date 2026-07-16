# goldmineink-scraper

Servico Node.js que substitui o node de Puppeteer do n8n. Recebe um webhook,
abre uma pagina via proxy, navega, opcionalmente clica num CTA, e retorna
um JSON com os dados coletados.

## Rodando local

```bash
cp .env.example .env
# edite o .env e coloque PROXY_USER e PROXY_PASS de verdade
npm install
npm start
```

Teste:

```bash
curl -X POST http://localhost:3000/webhook/visito \
  -H "Content-Type: application/json" \
  -d '{
    "trackId": "810078df-43f6-4118-a35e-f02139fe50bf_trkw",
    "url": "https://exemplo.com",
    "userAgent": "Mozilla/5.0 ...",
    "cr": "us",
    "rg": "pennsylvania",
    "ci": "meadville"
  }'
```

## Deploy no Railway

1. Suba esta pasta para um repositorio no GitHub (ou use `railway up` direto
   pela CLI a partir desta pasta).
2. No Railway, crie um novo projeto a partir do repo. O Railway vai
   detectar o `Dockerfile` automaticamente e buildar a imagem com o
   Chromium ja instalado (por isso NAO precisa de nenhum buildpack extra).
3. Em **Variables**, configure:
   - `PROXY_HOST` (opcional, default `gw.dataimpulse.com`)
   - `PROXY_PORT` (opcional, default `823`)
   - `PROXY_USER` (obrigatorio)
   - `PROXY_PASS` (obrigatorio)
   - `TRACK_API_BASE` (opcional)
   - `NAV_TIMEOUT_MS` (opcional, default `30000`)
4. Deploy. O Railway injeta `PORT` automaticamente, o `server.js` ja le essa
   variavel.
5. Sua URL de webhook vai ficar algo como:
   `https://SEU-APP.up.railway.app/webhook/visito`

   Se voce quiser manter exatamente a mesma URL que ja usa hoje
   (`goldmineink.up.railway.app/webhook/visito`), so precisa apontar esse
   dominio/servico do Railway para este novo projeto.

## Por que isso deve parar de crashar

O node de Puppeteer do n8n tende a crashar por acumulo de processos
Chromium que nao fecham direito quando algo da erro no meio do fluxo
(timeout de selector, erro de proxy, etc). Aqui isso e resolvido com um
`try/finally`: nao importa o que aconteça durante a navegacao, o `page` e o
`browser` sempre sao fechados no final (veja `src/scrapeVisit.js`).

## Controle de concorrencia (limite de browsers em paralelo)

Cada Chromium headless costuma consumir uns 150-300MB de RAM. Se varios
requests chegarem ao mesmo tempo e cada um abrir seu proprio browser, a
instancia do Railway pode estourar memoria e derrubar o servico (bem
parecido com o que acontecia no n8n).

Para evitar isso, o `server.js` usa uma fila (`src/concurrencyQueue.js`,
sem dependencias externas) que limita quantos browsers rodam ao mesmo
tempo. O resto dos requests fica esperando vaga automaticamente.

Duas variaveis controlam isso:

- `MAX_CONCURRENT_BROWSERS` (default `2`): quantos Puppeteer abertos ao
  mesmo tempo. Comece com 2 e va subindo aos poucos observando o grafico
  de memoria da instancia no Railway.
- `MAX_QUEUE_SIZE` (default `20`): quantos requests podem esperar na fila
  antes do servico comecar a responder `503` (protege contra a fila
  crescer sem limite se o trafego disparar).

Voce pode acompanhar em tempo real quantos browsers estao ativos e quantos
estao esperando na fila no endpoint:

```bash
curl https://SEU-APP.up.railway.app/health
```

```json
{
  "status": "ok",
  "browsersAtivos": 2,
  "naFila": 5,
  "limiteConcorrencia": 2
}
```

Se o `naFila` estiver sempre alto, e sinal de que voce pode: (a) aumentar
`MAX_CONCURRENT_BROWSERS` se tiver memoria sobrando, ou (b) subir o plano
da instancia no Railway.

## Proximos passos possiveis (se o volume de requisicoes for alto)

- Reaproveitar um pool de browsers/pages ao inves de abrir/fechar um
  browser inteiro a cada request (mais rapido, mas mais complexo de fazer
  com troca de proxy por request).
- Rodar mais de uma instancia (replica) no Railway atras de um load
  balancer, cada uma com seu proprio `MAX_CONCURRENT_BROWSERS`.
- Aumentar o plano/memoria da instancia no Railway se cada request pesar
  muito.
