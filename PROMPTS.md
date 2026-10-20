# PROMPTS.md

## Sequência de prompts

Abaixo está uma reconstrução de como eu conduziria o desenvolvimento no Codex CLI: cada pedido parte da etapa anterior, define decisões e limita o trabalho seguinte.

### 1. Entender o desafio e definir critérios

> Estou começando o desafio Senior Backend. Minha leitura é que preciso resolver três problemas: a vitrine depende demais do ERP, o checkout pode vender a mesma unidade mais de uma vez e o faturamento lento prende a resposta ao cliente.

> Confira essa interpretação contra o enunciado e o repositório. Liste requisitos funcionais, restrições e critérios de aceite. Para cada problema, explique causa raiz e impacto para cliente, negócio e operação, e compare duas ou três alternativas considerando custo, complexidade, latência, consistência e operação. Não altere arquivos nesta etapa.

### 2. Fechar o MVP e a arquitetura

> Com base nessa análise, proponha um MVP pequeno para catálogo, checkout e consulta de status do pedido. Quero um único serviço. Explique DDD de forma simples e aplique só os conceitos que ajudam a separar catálogo, checkout, pedidos e faturamento. Defina as regras de preço, estoque, reserva e faturamento. Evite microserviços, repositórios genéricos e abstrações sem necessidade. Deixe autenticação, pagamento real, front-end, deploy e integração real com ERP fora do escopo. Mostre os trade-offs e recomende uma estrutura.

### 3. Escolher as bibliotecas e planejar

> A stack definida para este protótipo é Node.js 24, TypeScript strict, Fastify 5 e better-sqlite3. A validação das rotas usa schemas JSON do Fastify e o contrato OpenAPI usa @fastify/swagger e @fastify/swagger-ui. Métricas usam @prometheus-io/client e traces usam OpenTelemetry. O ERP e a origem do catálogo serão simulados. Não adicione Redis nem broker agora.

> Estou no modo Plan. Divida a implementação em etapas pequenas. Para cada etapa, indique módulos afetados, critérios de aceite, riscos e comandos de validação. Explique o que a solução local demonstra e o que seria diferente em produção. Aguarde minha revisão do plano antes de editar arquivos.

### 4. Construir a base e persistência

> Revisei o plano. Comece pela estrutura do serviço e persistência. Organize módulos por catálogo, checkout, pedidos, faturamento e infraestrutura. Configure SQLite com foreign keys, WAL e busy timeout. Guarde dinheiro em centavos inteiros, timestamps em UTC e use SQL parametrizado. Mantenha handlers HTTP finos e regras nos casos de uso. Inclua schema e dados de demonstração. Faça só esta etapa; ao terminar, resuma as alterações e rode os comandos de validação previstos.

### 5. Implementar catálogo e checkout

> A base está pronta. Implemente agora GET /products com cache-aside local, TTL de 30 segundos e singleflight para agrupar refreshes concorrentes. Combine preço do snapshot com disponibilidade atual do SQLite. Se o preço estiver vencido e a origem falhar, não retorne o valor antigo como atual.

> Depois implemente POST /checkout com Idempotency-Key. Normalize os itens e calcule hash do pedido: repetição da mesma chave e conteúdo retorna o pedido existente; mesma chave com conteúdo diferente retorna 409. Reserve estoque por atualização condicional em transação curta. Grave pedido, itens, reservas e tarefa de faturamento na mesma transação. Responda 202 sem esperar pelo ERP. Cubra os critérios desta etapa com testes.

### 6. Implementar faturamento assíncrono

> Agora implemente o worker de faturamento. Ele deve buscar tarefas persistidas depois do commit, usar orderId como chave idempotente no ERP simulado e aplicar retries limitados com backoff nas falhas transitórias. Registre falha definitiva em estado equivalente a DLQ. Em resultado incerto, consulte o ERP antes de repetir e mantenha pedido e reserva em processamento até resolver. Confirme a reserva no sucesso e libere-a uma única vez após falha definitiva. Exponha no status público somente PROCESSING, COMPLETED e FAILED. Inclua recuperação de tarefas após reinício e teste as transições.

### 7. Fechar contrato e observabilidade

> Com os fluxos implementados, documente GET /products, POST /checkout e GET /orders/{orderId}/status com schemas, estados e erros. Configure logs JSON com Pino e redaction de segredos; inclua requestId, traceId e orderId quando disponíveis. Exponha métricas para cache, frescor de preço, checkout, reservas, fila e ERP. Use labels de baixa cardinalidade, sem IDs. Configure OpenTelemetry do request ao worker e persista traceparent e tracestate na tarefa. Prepare Prometheus e Jaeger para execução local. Proponha SLIs, SLOs iniciais, alertas, dashboard e runbook. Atualize a documentação sem apresentar serviços de produção como implementados.

### 8. Revisar e registrar o uso de IA

> Faça a revisão final contra os critérios de aceite. Rode build e testes, corrija falhas e confira o fluxo de catálogo, checkout, consulta de status e retomada de tarefa. Verifique disputa pela última unidade, repetição idempotente, falha transitória, falha definitiva e resultado incerto. Confira OpenAPI, README e respostas conceituais. Registre em PROMPTS.md uma sequência representativa dos prompts usados e uma revisão crítica: o que a IA ajudou a produzir, o que foi conferido e quais decisões são minhas. Não diga que um comando ou teste foi executado se não foi.

## Nota

O registro demonstra uma forma de orientar o Codex CLI com contexto, decisões, limites e critérios verificáveis, em vez de delegar a implementação em um único pedido.
