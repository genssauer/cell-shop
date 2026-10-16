# CaseCellShop — desafio backend

Serviço HTTP pequeno para catálogo, checkout idempotente e processamento assíncrono de faturamento. A solução usa Node.js 24, TypeScript strict, Fastify 5 e SQLite. A organização é por domínio/caso de uso (`catalog`, `checkout`, `orders`, `billing`) e infraestrutura compartilhada; não há uma camada genérica de repositórios nem modelagem DDD tática sem necessidade.

> **Repositório público:** pendente de publicação. O projeto local está na branch `001-backend-challenge`.

## Arquitetura

```text
HTTP/Fastify
  ├── catalog: cache de preço (30 s) + saldo atual do SQLite
  ├── checkout: valida preço, normaliza itens, reserva estoque e cria pedido
  ├── orders: consulta estado público do pedido
  └── billing: worker persistente + adaptador ERP simulado

SQLite: pedidos + itens + reservas + tarefa de faturamento na mesma transação
Observabilidade: Pino + Prometheus + OpenTelemetry/Jaeger local
```

O SQLite é a fonte local para estoque, pedidos e tarefas. O catálogo simulado mantém preço em cache por 30 segundos, mas consulta a disponibilidade no banco em cada resposta. No checkout, `BEGIN IMMEDIATE` e uma atualização condicional garantem que duas compras não reservem a mesma última unidade. A transação grava pedido, itens, reservas e tarefa antes do `202`; o ERP nunca é chamado dentro da transação.

O worker executa no mesmo processo e usa uma tabela persistida como fila/outbox local. Falha transitória tem retry com backoff de 1, 2 e 4 segundos; falha definitiva vai para `DEAD_LETTER` e libera a reserva; resultado incerto permanece `PROCESSING`, mantém a reserva e é consultado durante reconciliação. A chave idempotente do ERP é o `orderId`. Os traces W3C são persistidos na tarefa para ligar checkout ao worker.

## Decisões e trade-offs

- **Um serviço e um banco local:** reduzem setup e deixam a consistência do desafio demonstrável. SQLite e worker no processo não são a topologia de produção para alta disponibilidade ou múltiplas réplicas.
- **Cache local de 30 segundos com singleflight:** reduz chamadas repetidas à fonte e evita stampede dentro do processo. Uma implantação horizontal exigiria cache compartilhado, política de invalidação e jitter/refresh-ahead.
- **Sem preço vencido como atual:** se a fonte falha após expirar o snapshot, catálogo/checkout falham de forma segura. A regra comercial pode permitir stale-while-revalidate apenas com preço explicitamente marcado e autorização.
- **SQLite condicional e reservas:** garantem concorrência no banco escolhido. Um banco gerenciado e fila durável seriam próximos passos quando escala e disponibilidade justificarem o custo.
- **ERP e falhas controláveis são simulados:** não existe chamada a serviço real nem credencial de integração.
- **Sem autenticação ou pagamento real:** fora do escopo do teste.

A visão de evolução para 30–90 dias e a análise das alternativas estão em [`docs/challenge-answers.md`](docs/challenge-answers.md). Indicadores, PromQL, alertas e procedimentos ficam em [`docs/operations.md`](docs/operations.md). O uso de IA está descrito em [`PROMPTS.md`](PROMPTS.md).

## Requisitos e execução

- Node.js 24 LTS e npm.
- Docker Compose opcional para Prometheus e Jaeger.

```sh
npm ci
npm run build
npm start
```

A API escuta em `http://localhost:3000` e cria `var/app.sqlite` com dados locais de demonstração. Para desenvolvimento com reload, use `npm run dev`. Para reiniciar a demonstração do zero, pare o processo e remova `var/app.sqlite` antes de iniciar novamente.

```sh
npm test
npm run openapi:export
```

A suíte cobre cache/TTL, indisponibilidade, idempotência, rollback, concorrência pela última unidade, status público e transições do worker. O schema de rotas é a fonte da validação e do contrato; a exportação atualiza [`specs/001-backend-challenge/contracts/openapi.yaml`](specs/001-backend-challenge/contracts/openapi.yaml).

## API local

| Método | Rota | Uso |
| --- | --- | --- |
| `GET` | `/products` | Catálogo, preço e saldo disponível atualizado. |
| `POST` | `/checkout` | Aceita pedido usando `Idempotency-Key` e responde `202`. |
| `GET` | `/orders/{orderId}/status` | Retorna somente `PROCESSING`, `COMPLETED` ou `FAILED`. |
| `GET` | `/health/live` | Confirma que o processo está respondendo. |
| `GET` | `/health/ready` | Verifica acesso ao SQLite. |
| `GET` | `/metrics` | Métricas Prometheus. |
| `GET` | `/docs` | Swagger UI. |

Exemplo de checkout:

```sh
curl -i http://localhost:3000/checkout \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-order-001' \
  -d '{"items":[{"sku":"SKU-001","quantity":1}]}'
```

Resposta típica:

```json
{
  "orderId": "<uuid>",
  "status": "PROCESSING",
  "statusUrl": "/orders/<uuid>/status"
}
```

O worker pode terminar rapidamente; por isso, a primeira consulta de estado pode já retornar `COMPLETED`. Repetir a mesma chave com o mesmo conteúdo normalizado retorna o pedido existente. Reutilizar a chave com outro conteúdo retorna `409`; estoque insuficiente também retorna `409`.

## Exemplo operacional

```sh
docker compose up -d prometheus jaeger
OTEL_ENABLED=true npm run dev
```

- API: `http://localhost:3000`
- Swagger: `http://localhost:3000/docs`
- Métricas: `http://localhost:3000/metrics`
- Prometheus: `http://localhost:9090`
- Jaeger: `http://localhost:16686`

Envie um checkout e siga o trace no Jaeger do request até `billing.process_order`. Em caso de falha, procure `orderId` nos logs, consulte `/orders/{orderId}/status`, confira `billing_tasks` e `reservations` no SQLite e valide `billing_oldest_task_age_seconds`. Resultado ERP incerto não deve ser reenviado manualmente sem reconciliação; o worker consulta a mesma chave idempotente.

O passo a passo detalhado está em [`specs/001-backend-challenge/quickstart.md`](specs/001-backend-challenge/quickstart.md).

O quickstart foi validado com um SQLite novo: `GET /products` retornou `200`, o checkout retornou `202`, o pedido chegou a `COMPLETED` e `/docs` retornou `200`.
