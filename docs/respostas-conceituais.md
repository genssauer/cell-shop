# Respostas conceituais — Desafio Backend

## 1. Diagnóstico e arquitetura

### Vitrine lenta

A causa é consultar o ERP em cada acesso. Isso acopla a latência e a disponibilidade da loja a um sistema compartilhado, além de gastar capacidade do ERP com leituras repetidas.

O cliente enfrenta demora ou erro; o negócio perde conversão; a operação tem dificuldade para localizar a origem da lentidão.

- **Cache local:** simples e rápido, mas cada réplica mantém sua cópia e a invalidação é limitada.
- **Redis:** compartilha cache entre réplicas e reduz chamadas ao ERP; adiciona infraestrutura e dependência operacional.
- **Read model da loja:** dá controle sobre consultas e capacidade, mas exige sincronização, monitoramento de atraso e reconciliação.

Neste projeto, uso cache local com TTL de 30 segundos e coalescência de refresh. Para produção, escolheria Redis ou read model após medir volume, número de réplicas e frescor aceito pelo negócio.

### Estoque inconsistente

Consultar saldo e gravar depois são operações separadas. Compras concorrentes podem aprovar a mesma unidade. Consultar o ERP no checkout ainda concentra contenção e deixa a loja sem controle transacional da reserva.

O cliente pode pagar por item indisponível; a empresa perde venda e confiança; a operação precisa reconciliar pedido, reserva e ERP.

- **Atualização condicional atômica:** valida e reserva em uma operação no banco autoritativo. É simples e eficiente, desde que todos os escritores sigam essa regra.
- **Lock pessimista:** impede disputa durante a transação, mas aumenta espera e risco de contenção.
- **Reserva com confirmação/liberação:** representa o fluxo assíncrono corretamente, mas exige estados, expiração e reconciliação.

A implementação usa transação curta e atualização condicional no banco da loja. A reserva só é confirmada após faturamento; falha definitiva a libera.

### Checkout dependente do ERP

Esperar o faturamento na requisição HTTP aumenta a latência. Um timeout também não diz se o ERP concluiu. Sem idempotência, uma repetição pode faturar duas vezes. Separar gravação do pedido e publicação da tarefa cria risco de pedido sem processamento ou mensagem sem pedido.

O cliente vê timeout e tenta novamente; a empresa pode duplicar faturamento ou deixar pedidos parados; a operação não tem trilha confiável de tentativas.

- **Chamada síncrona com timeout e idempotência:** mudança pequena, mas mantém latência acoplada e não resolve sozinha o resultado ambíguo.
- **Fila durável com outbox e workers:** desacopla a resposta, permite retry e escala independente; exige broker, monitoramento e idempotência.
- **Saga/workflow:** serve para processos longos com várias etapas e compensações; é complexidade desnecessária para este escopo.

### Evolução em 30–90 dias

Nos primeiros 30 dias, mediria volume, picos, latência e limites do ERP; definiria tolerância de frescor e identificadores de correlação. Entre 30 e 60 dias, manteria no banco da loja os dados de leitura e pedidos, sincronizados por eventos ou polling incremental. Gravaria pedido, reserva e outbox na mesma transação; publicaria a outbox em fila durável e escalaria workers com limites, retry e idempotência. Entre 60 e 90 dias, adicionaria reconciliação periódica com o ERP, testes de carga e falha, SLOs, alertas e runbooks. O ERP segue como autoridade das rotinas centrais; divergências são detectadas e reconciliadas.

## 2. Cache e frescor

Usaria cada camada para o dado adequado:

- **CDN/HTTP:** imagens e conteúdo público pouco variável.
- **Cache de aplicação ou Redis:** catálogo e preços sincronizados.
- **Banco da loja:** estoque, reservas e pedidos. O checkout nunca decide com saldo cacheado.

A leitura usa cache-aside: hit retorna o snapshot; miss ou expiração consulta a origem e atualiza o horário de sincronização. O TTL de 30 segundos limita a defasagem quando não há invalidação. Em produção, invalidaria por evento do ERP quando disponível, mantendo TTL e sincronização incremental como proteção contra evento perdido.

O protótipo agrupa refreshes concorrentes por processo. Com várias réplicas, usaria cache compartilhado e jitter no TTL; só adicionaria lock distribuído ou refresh-ahead se as métricas justificassem. Se a origem falhar e o preço estiver vencido, retorno indisponibilidade em vez de apresentar preço antigo como atual. Um fallback stale dependeria de regra explícita do negócio e revalidação no checkout.

Acompanharia taxa de hit, misses, erros e chamadas à origem; p50/p95/p99 de GET /products e duração do refresh; idade do snapshot e divergência de preço em relação ao ERP; custo e falhas da origem. Cache é ganho quando reduz latência e custo sem exceder o limite de frescor acordado. IDs de produto e SKU não devem ser labels de métricas.

## 3. Observabilidade

**Logs estruturados:** timestamp, nível, serviço, ambiente, requestId, traceId, rota/operação, resultado, status e duração. No processamento assíncrono, incluiria orderId, tentativa e estado, propagando a correlação do pedido. Não registraria credenciais, tokens nem dados pessoais desnecessários.

**Métricas:**

- Counters para resultado do cache, checkouts, reservas e chamadas/tentativas ao ERP.
- Gauges para profundidade e idade da tarefa mais antiga, idade do preço e dead letters.
- Histograms para latência HTTP por rota, refresh do catálogo e chamadas ao ERP.

Usaria apenas labels de baixa cardinalidade, como rota e resultado; nunca IDs de pedido, produto ou requisição.

**Traces:** em GET /products, mostraria cache, refresh da origem e leitura local. Em POST /checkout, mostraria idempotência, validação de preço, transação de pedido/reserva/tarefa e resposta 202. O worker continuaria a correlação salva na tarefa e registraria claim, chamada ao ERP, retry e conclusão.

**SLIs e operação:** acompanharia p95 de vitrine e checkout, taxa de 5xx, frescor do preço, idade da fila e sucesso do faturamento. Como metas iniciais, usaria p95 abaixo de 100 ms para vitrine em cache, p95 abaixo de 250 ms para checkout sem esperar o ERP, disponibilidade mensal de 99,5% e preço dentro do TTL de 30 segundos. Recalibraria com carga real. Erro de negócio, como estoque insuficiente, não conta como indisponibilidade.

O dashboard reuniria latência e erros por rota, cache e frescor, checkouts e reservas, fila, retries, ERP e dead letters. Alertaria sobre latência ou 5xx sustentados, preço vencido com falha de refresh, fila envelhecida e dead letters crescentes. O runbook verifica saúde, métricas e trace; identifica a dependência falha; consulta pedido, tarefa e reserva; preserva reserva em resultado incerto; e confirma recuperação pelos sinais observados. Datadog ou ferramentas equivalentes atendem ao mesmo modelo; o projeto usa OpenTelemetry e Prometheus.

## 4. Concorrência e idempotência

Uma leitura de saldo seguida por atualização permite que duas transações leiam a última unidade antes de qualquer gravação. A condição de disponibilidade e a reserva precisam ser atômicas no banco dono do estoque.

Escolho atualização condicional: incrementa reservado apenas se saldo disponível cobrir a quantidade; nenhuma linha alterada significa estoque insuficiente. Lock pessimista também resolve a disputa, mas aumenta contenção. Reserva com confirmação/liberação é necessária ao fluxo assíncrono, e sua criação ainda precisa ser atômica. Lock distribuído só se justifica quando escritores não podem ser coordenados pelo banco; lease e partições aumentam o risco e não substituem a validação final no banco.

O cliente envia Idempotency-Key. Persisto a chave com hash do pedido e restrição única: mesma chave e mesmo conteúdo retorna o pedido original; conteúdo diferente retorna 409. Uso orderId como chave estável nas chamadas ao ERP. Isso cobre duplo clique, retry HTTP, retry do worker e replay após reinício.

Validaria concorrência pela última unidade, replay simultâneo da mesma chave, conflito de payload, rollback integral, retry sem faturamento duplicado e estados de confirmação/liberação. A invariável é: 0 <= reservado <= estoque disponível total.

## 5. Mensageria, contrato e IA

Publicar antes de gravar o pedido pode criar mensagem sem pedido. Gravar e publicar em duas operações independentes pode deixar pedido sem mensagem. Em produção, gravaria pedido, reserva e outbox na mesma transação; um relay publicaria a outbox. Duplicatas ainda podem ocorrer se houver queda após publicar, então consumidor e ERP também precisam ser idempotentes.

Neste projeto, a tarefa de faturamento é persistida na mesma transação e consultada pelo worker no SQLite. Isso demonstra atomicidade sem broker; para múltiplas réplicas, migraria para fila durável e outbox.

Usaria timeout, retry limitado com backoff e jitter para falhas transitórias, chave idempotente estável e DLQ após esgotar tentativas. Em timeout ambíguo, consultaria o ERP pelo orderId e manteria pedido e reserva em processamento até confirmar o resultado ou reconciliar. Não repetiria faturamento às cegas.

O OpenAPI documentaria GET /products, POST /checkout com Idempotency-Key e resposta 202, GET /orders/{orderId}/status, estados e erros. Os testes cobririam contrato, transação, concorrência, idempotência, retry, DLQ, resultado incerto e retomada após reinício.

Usei IA para explorar alternativas e apoiar rascunhos. Revisei as propostas contra os requisitos, as invariantes e a implementação; as decisões e respostas são minhas. Os prompts reconstruídos, identificados como não literais, estão em PROMPTS.md.

