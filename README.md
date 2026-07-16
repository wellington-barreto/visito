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

## RSS do Node vs. memória do container (o Chromium está mesmo liberando memória?)

O `process.memoryUsage().rss` mede **só o processo Node.js**. Os processos
do Chromium que o Puppeteer abre rodam **separados**, no sistema
operacional - entao um grafico baseado so no RSS do Node pode parecer
"normal" mesmo que o Chromium esteja vazando memoria (nao fechando
direito).

Por isso o dashboard agora mostra duas linhas:
- **RSS do Node** (linha solida teal) - so o processo do servidor
- **Memória do container** (linha tracejada amber) - Node + Chromium +
  qualquer outro processo, lida direto do cgroup do Linux (mais precisa
  que `os.totalmem()/freemem()`, que em muitos containers Docker reporta
  a memoria do host inteiro em vez do container)

Alem disso, tem um card **"Processos Chromium vivos"**: conta agora mesmo
quantos processos com "chromium"/"chrome" no nome estao rodando (lendo
`/proc` diretamente, sem precisar instalar `ps`). Se esse numero fica
maior que 0 com `browsersAtivos: 0` na fila, e sinal de que algum browser
nao fechou direito - o card fica vermelho automaticamente nesse caso.

Nota: em ambientes compartilhados (fora do container limpo do Railway)
esse contador pode pegar falsos positivos de outros processos que tenham
"chrome" no nome do comando - no container do Railway, rodando so a sua
aplicacao, isso nao deve acontecer.

## Protegendo /webhook/visito com chave fixa

Diferente da chave diaria do dashboard, aqui e uma chave **fixa** (nao
muda sozinha) - a mesma que voce configura no n8n pra sempre.

1. No Railway, defina `WEBHOOK_API_KEY` com um valor longo e aleatorio
   (ex: gere um com `openssl rand -hex 32` ou similar).
2. No node **HTTP Request** do n8n, adiciona um header:
   - Nome: `x-api-key`
   - Valor: o mesmo que voce colocou em `WEBHOOK_API_KEY`

   (tambem aceita `Authorization: Bearer SEU_VALOR`, se preferir esse
   formato)

Sem o header correto, o `/webhook/visito` responde `401` e nem chega a
abrir o Puppeteer. Se `WEBHOOK_API_KEY` nao estiver configurado, a rota
fica bloqueada por padrao (erro `503`) - comportamento seguro por padrao.

## Protegendo /dashboard e /metrics com api key

Como essas rotas mostram dados reais (URLs acessadas, trackIds, uso de
memoria), elas exigem uma chave de acesso que **muda todo dia sozinha**.

1. Configure no Railway a variavel `DASHBOARD_API_SECRET` com um segredo
   seu (ex: `goldmine2026x7`).
2. A chave valida no dia segue o formato `SEU_SEGREDO-AAAAMMDD`.
   Exemplo: com o segredo acima, em 16/07/2026 a chave e
   `goldmine2026x7-20260716`.
3. Acesse assim:
   ```
   https://SEU-APP.up.railway.app/dashboard?key=goldmine2026x7-20260716
   ```

O `/metrics` (usado pelo dashboard por baixo dos panos) aceita a chave
tanto por `?key=...` quanto pelo header `x-api-key`.

O `/health` continua **sem** proteção de proposito: ele so retorna numeros
genericos (nada sensivel) e normalmente e usado pelo proprio Railway para
verificar automaticamente se o servico esta de pe - se ele exigisse chave,
o Railway poderia achar o serviço "unhealthy" e ficar reiniciando.

Se `DASHBOARD_API_SECRET` nao estiver configurado, essas rotas ficam
bloqueadas por padrao (retornam erro `503` pedindo pra configurar a
variavel) - ou seja, o comportamento seguro por padrao e "fechado", nao
"aberto".

## Dashboard de monitoramento

Alem do `/health`, o servico expoe um painel visual em:

```
https://SEU-APP.up.railway.app/dashboard
```

Ele atualiza sozinho a cada 3 segundos e mostra:
- Uso de memoria (RSS) atual e um grafico dos ultimos ~10 minutos
- Quantos browsers estao ativos vs. na fila, e o limite configurado
- Uptime do processo
- Uma tabela com as ultimas 10 requisicoes: horario, trackId, URL, duracao e status (ok/erro)

Os dados desse painel vem do endpoint `GET /metrics` (JSON puro, caso queira
consumir de outro lugar). Tudo fica guardado em memoria RAM do processo -
**zera a cada redeploy/restart**, nao e um historico permanente.

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
