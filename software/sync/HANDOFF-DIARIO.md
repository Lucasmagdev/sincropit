# Handoff — ligar os ensaios do PIT ao app do Diário

Para o workspace do **Diariosgeoteste** (`hlzndrceaglkwavskqhs`).

> **Status: implantado.** As seções 3–4 descreviam uma recomendação; já foi
> executada. O pipeline de ingestão do PIT roda **dentro deste mesmo projeto
> Supabase**, em schema `pit`. Não existe mais projeto separado em uso — o
> `fpit-sync` antigo (`mphomlxniavqmvxhacii`) fica só como histórico até
> alguém decidir migrar ou não os 161 ensaios que ficaram lá (ver seção 9).

Objetivo: quando o técnico for preencher um diário de PIT, as estacas já
aparecerem preenchidas a partir dos ensaios que o próprio equipamento gravou,
em vez de serem digitadas na mão.

---

## 1. O que já existe, AQUI, neste projeto

Schema **`pit`**, dentro do `Diariosgeoteste`, no ar e testado ponta a ponta
com o `.exe` real enviando arquivo de verdade:

| peça | estado |
|---|---|
| `pit.equipamentos`, `pit.ensaios`, `pit.ensaio_parametros`, `pit.eventos_envio` | criadas, RLS ligado **e forçado**, zero políticas |
| `pit.ensaios_para_diario` (view) | 1 ensaio por linha, já com a última configuração — ver seção 6 |
| bucket `ensaios` | privado (`public=false`) — **não confundir com `asset-files`/`portal-docs`/etc, que são públicos** |
| Edge Function `ingerir` | ativa, `verify_jwt=false` (auth própria por token de equipamento) |
| cliente `SincronPIT.exe` | roda no PIT-Q (Win10 LTSB 1607, sem admin) |

Verificado: conteúdo na nuvem idêntico byte a byte ao original; no envio
online ainda há dedup por `sha256` (não por nome). Na exportação para pendrive,
arquivos de nomes diferentes são preservados mesmo quando têm o mesmo
conteúdo, para o painel decidir depois se representam duplicidade. Hash
adulterado é recusado com 422; token inválido, `machine_id` divergente,
extensão e tamanho fora do permitido continuam barrados.

**Como consultar `pit.*` daqui pra frente** (importante — é diferente de
`public`):

- Supabase JS: `supabase.schema('pit').from('ensaios_para_diario').select(...)`
  — **só funciona com `service_role`**, nunca no cliente/browser (RLS forçado
  bloqueia `anon`/`authenticated` de propósito; ver seção 7).
- PostgREST cru: precisa do header `Accept-Profile: pit` (leitura) ou
  `Content-Profile: pit` (escrita). Sem isso cai em `public` e dá
  `relation does not exist`.
- **Pegadinha que já mordeu uma vez**: schema criado por script **não herda**
  os grants automáticos que `public` tem de fábrica no Supabase. Depois de
  criar `pit`, a Edge Function voltava `permission denied for schema pit`
  mesmo com a chave certa — faltava `grant usage on schema pit to
  service_role` explícito. Já corrigido aqui
  (`supabase-diario/migrations/0002_grants_service_role.sql`), mas se algum
  dia criarem outro schema neste projeto, é o mesmo detalhe pra lembrar.
- `pit` já está na lista de schemas expostos do PostgREST
  (Project Settings → API), acrescentado de forma aditiva — `public` e
  `graphql_public` continuam do jeito que estavam.

**Ressalva importante:** o PIT-Q **não tem internet hoje**. O `SincronPIT`
detecta e cai para exportação em pendrive. Enquanto o Wi-Fi não sair, os
ensaios chegam por pendrive, não pela função. O desenho abaixo vale nos dois
casos — só muda quem escreve na tabela.

---

## 2. O que descobri no Diário

O destino **já existe**:

```
work_diaries_pit        : id, diary_id, equipamento, ocorrencias,
                          total_estacas, equipamento_id
work_diaries_pit_piles  : id, pit_id, ordem, estaca_nome, estaca_tipo,
                          diametro_cm, profundidade_m, arrasamento_m,
                          comprimento_util_m
obras                   : id, obra_code, name, client_id, ...
equipamentos            : id, tipo, nome, ativo
```

Ou seja, não é preciso inventar modelo novo. É preciso **alimentar** o que já
está lá.

---

## 3. Por que um projeto só (decisão já tomada)

Motivo, registrado pra quem chegar depois entender o porquê: Postgres não faz
join entre projetos Supabase distintos. O casamento ensaio↔obra precisa
acontecer em SQL, contra `obras` e `work_diaries_pit`, que vivem aqui — daí
não fazer sentido manter isso em projeto separado.

Schema separado (`pit`, não `public`) porque **há colisão de nome**: o Diário
já tem uma tabela `public.equipamentos` (cadastro de equipamento da empresa),
e o PIT precisa da própria — credencial de aparelho que envia arquivo. São
coisas diferentes com o mesmo nome óbvio; schema isolado resolve de vez.

---

## 4. O que foi aplicado (arquivos reais, não pseudocódigo)

```
software/sync/supabase-diario/migrations/0001_schema_pit.sql
  → schema pit, as 4 tabelas + view ensaios_para_diario, RLS forçado,
    zero políticas, bucket privado 'ensaios', funções
    pit.criar_equipamento / pit.revogar_equipamento

software/sync/supabase-diario/migrations/0002_grants_service_role.sql
  → GRANT USAGE necessário (schema custom não herda os grants de public)

software/sync/supabase-diario/functions/ingerir/index.ts
  → mesma função do fpit-sync, com Accept-Profile/Content-Profile: pit
    em toda chamada REST
```

**Ainda não criada — é o próximo passo de verdade, não meu**, porque depende
de decisão de produto (que tela, que fluxo de confirmação):

```sql
-- A ponte que falta: de que OBRA é cada pasta do PIT-Q.
--
-- Isto NÃO pode ser adivinhado por semelhança de texto (ver seção 5).
-- É uma linha preenchida uma vez por obra, por gente.
create table pit.pasta_obra (
  pasta_origem  text primary key,          -- exatamente como vem do PIT-Q
  obra_id       uuid not null references public.obras(id),
  confirmado_por uuid references public.profiles(id),
  confirmado_em timestamptz not null default now()
);
```

---

## 5. O problema difícil: casar ensaio com obra

Cada ensaio chega com estes campos utilizáveis:

| campo | exemplo real do PIT-Q | serve para |
|---|---|---|
| `nome_original` | `E15.PTE` | nome da estaca |
| `pasta_origem` | `AG 21.08` | **a obra — mas é texto livre** |
| `criado_no_equipamento` | `2026-08-21 14:31` | data do ensaio |
| `machine_id` | `pit-4959cf` | qual PIT-Q |

`pasta_origem` é **o que o operador digitou no equipamento**. Exemplos
verdadeiros, tirados da sonda no PIT-Q real:

```
AG 21.08
BRZ EMPRENDIMENTOS -POUSO ALEGRE -MG 13-04-23
 Hotel Village do Lago          <- começa com espaço
ELASTRI 07__10_2025
18-01-2023                      <- só a data, sem nome de obra
```

Tem erro de digitação, espaço no começo, data misturada com nome, e pasta que
não nomeia obra nenhuma. **Não tente casar isso com `obras.name` por
semelhança de string.** Num diário que vira laudo, atribuir um ensaio à obra
errada é pior do que não preencher nada: o campo vazio o técnico percebe, o
campo errado ele assina.

Fluxo correto: a primeira vez que uma `pasta_origem` desconhecida aparece, a
interface pergunta "esses 546 ensaios são de qual obra?" e grava em
`pit.pasta_obra`. Da segunda em diante é automático.

---

## 6. O que dá para preencher automaticamente

O `.PTE` não é opaco — o formato foi decifrado e está documentado em
`reverse-engineering/formato-pte.md`. Campos extraíveis: `WS` (velocidade de
onda), `LE` (comprimento), `MD`, `MA`, `FS` (taxa de amostragem), `T1`, número
de batidas, canais.

Mapeamento direto para `work_diaries_pit_piles`:

| coluna do Diário | vem de | observação |
|---|---|---|
| `estaca_nome` | tag `0303` (bate com o nome do arquivo) | conferir: nem sempre é o nome da estaca no projeto |
| `estaca_tipo` | **tag `0304`** | `"HC"` (hélice contínua), `"RAIZ"` — ver ressalva de layout abaixo |
| `profundidade_m` | campo `LE` (tag `0404`) | **é o que o operador digitou no equipamento**, não uma medição. Sugestão, não verdade |
| `diametro_cm` | derivado da **área de seção** (tag `0413`) | ver fórmula abaixo |
| `arrasamento_m` | campo `L1` — **tag ainda não identificada**, ver seção 6.1 | |
| `comprimento_util_m` | não está no `.PTE` | manual |
| `total_estacas` (em `work_diaries_pit`) | contagem de ensaios distintos da obra naquela data | |

O parser já entrega isso pronto: `extrairDadosEstaca()` em
`software/src/lib/pte.ts` devolve `{ nome, tipo, areaSecaoM2, diametroCm,
operadorEData, empresa }`, travado por teste contra os 17 arquivos reais.

**Ressalva do campo de tipo (`0304`):** o layout muda entre versões do PIT-W.
Nos arquivos B135 é um buffer de 280 caracteres com o valor repetido nas
posições 0 e 218, o resto preenchido com espaços; nos PF/ENCONTRO é um campo
curto. A regra que funciona nos dois é pegar o primeiro trecho não vazio — é o
que `extrairDadosEstaca` faz. O segundo slot dos arquivos antigos continua sem
explicação: nos exemplos disponíveis ele repete o primeiro, então não há como
distinguir os dois. Se um dia aparecer arquivo onde eles diferem, revisar.

A área de seção está no campo `0413`, confirmado em três obras diferentes:

```
0.19635 m² = π·0.25²  ->  diâmetro 50 cm
0.28274 m² = π·0.30²  ->  diâmetro 60 cm
0.15904 m² = π·0.225² ->  diâmetro 45 cm

diametro_cm = 2 * sqrt(area / pi) * 100
```

### 6.1 O `L1` (arrasamento) — tag `0419`, identificada por eliminação

Como foi achada, porque a força da evidência importa para decidir se pode
preencher formulário com isso:

Sobravam 14 campos numéricos sem significado confirmado (`0408`–`040c`,
`0410`, `0411`, `0416`–`041a`, `041c`, `041d`). Em **49 arquivos `.PTE` reais
de quatro obras**, todos os 14 valem zero — ninguém tinha preenchido
arrasamento naqueles ensaios, então não havia sinal para correlacionar.

Foi então gravado um ensaio **de propósito com L1 preenchido**
(`testendiario/E15.PTE`). Nele, **exatamente um** dos 14 saiu do zero:

```
0419 = 2      (os outros 13 continuam zero; nos 49 arquivos anteriores, 0419 = 0)
```

Hit único e limpo. `extrairDadosEstaca()` já devolve `arrasamentoM`, e há
teste que falha se `0419` aparecer preenchido em qualquer outro arquivo — ou
seja, se a identificação estiver errada, a suíte avisa.

**Confirmado com três valores.** O mesmo ensaio foi regravado mudando o L1, e
`0419` acompanhou os três:

```
cabeçalho 0: 0419 = 2      MD = 2   FS =  66000
cabeçalho 1: 0419 = 10     MD = 4   FS = 134000
cabeçalho 2: 0419 = 0.7    MD = 4   FS = 134000
```

Não é coincidência com `MD` (que vale 2 e 4 nos mesmos cabeçalhos). Pode
preencher formulário com isso.

**Mas atenção: `L1` é por BATIDA, não do arquivo.** Um `.PTE` pode ter golpes
com arrasamentos diferentes, como o exemplo acima. Ao preencher o diário, use
o valor da batida que está sendo considerada — `extrairDadosEstaca` aceita o
cabeçalho da batida como segundo argumento. Mostrar sempre o da primeira daria
um número que o operador pode não ter usado.

Isso vale para os outros parâmetros também: no mesmo arquivo, `FS` vai de
66000 para 134000 entre batidas. Ler tudo do primeiro bloco era um bug do
Fpit, já corrigido — desenhava a segunda batida com a ponta a 42,64 m em vez
de 21,00 m (**103% de erro**). Se o Diário for calcular qualquer coisa a
partir do sinal, use `extrairParametrosDaBatida`.

`comprimento_util_m` **não está no `.PTE`** — continua manual. Não derive,
não estime: num diário que vira laudo, número errado é pior que campo vazio.

### 6.2 Normalizar o tipo antes de gravar

O operador digitou `"hc"` num ensaio e `"HC"` nos outros. Sem normalizar, o
diário passa a listar **dois tipos de estaca onde existe um só**, e o técnico
escolhe entre duas linhas idênticas. `extrairDadosEstaca` já devolve `tipo`
em maiúsculas — é código, não texto livre; caixa não carrega significado aqui.
Se o Diário tiver tabela própria de tipos de estaca, mapeie `HC` → hélice
contínua, `RAIZ` → raiz, e trate código desconhecido como "confirmar", nunca
inventando entrada nova em silêncio.

### O parser já existe

`software/src/lib/pte.ts` neste repositório: TypeScript, sem dependência
externa, roda em Deno (Edge Function) ou no browser. Coberto por suíte de
regressão contra 17 arquivos reais de 3 obras. **Reaproveite; não reescreva.**

Onde parsear é escolha de vocês:

- **na ingestão**, gravando os campos extraídos numa tabela `pit.ensaio_dados`
  — melhor, porque o Diário passa a ler dado estruturado em vez de blob;
- **na hora de preencher**, baixando o arquivo e parseando no cliente — mais
  simples, mais lento, e repete trabalho a cada abertura.

Regra, se for parsear na ingestão: **falha de parse não pode recusar o
upload.** O arquivo é o entregável; o metadado é bônus. Grava o arquivo,
registra o erro de extração, segue.

---

## 7. Restrições de segurança que não podem ser afrouxadas

Vieram do desenho original e valem igual depois da mudança:

- `SUPABASE_SERVICE_ROLE_KEY` **nunca** no equipamento nem no cliente. Só nas
  variáveis da Edge Function.
- Token **por equipamento**, guardado como SHA-256, revogável
  (`revogar_equipamento`). O token em claro existe uma vez só, na criação.
- Bucket privado. Download por **URL assinada de vida curta**, nunca link
  permanente.
- O servidor **recalcula** o `sha256` dos bytes recebidos. O hash que o
  cliente manda é conferido, não aceito.
- Extensão, tamanho e identidade do equipamento validados no servidor.
  `machine_id` tem que bater com o dono do token.
- Dedup por **conteúdo**, nunca por nome de arquivo.
- O nome do arquivo não entra no caminho do Storage (path traversal e
  caractere estranho vindo do campo).
- O ensaio original no PIT-Q nunca é alterado, movido nem apagado.

As tabelas de `pit` têm **zero políticas** de RLS — nada é legível por
`anon`/`authenticated`, nem mesmo estando o usuário logado. Isso é
proposital: leitura acontece só pelo **backend** (service_role), nunca
direto do browser. Se algum dia for preciso ler `pit.*` do lado do cliente,
escreva a política conscientemente, seguindo o mesmo critério de acesso que
já governa `obras` e `work_diaries`. Não copie "permitir tudo para
authenticated" para destravar rapidamente: `obras` tem coluna `confidential`,
e ensaio de PIT é medição de fundação de cliente.

---

## 8. Ordem sugerida daqui pra frente

1. ~~Decidir a topologia~~ — feito, schema `pit` neste projeto.
2. ~~Aplicar o DDL; bucket; publicar `ingerir`~~ — feito.
3. ~~Emitir token; trocar `config.txt` do PIT-Q~~ — feito.
4. Decidir se os 161 ensaios do `fpit-sync` antigo migram pra cá (seção 9).
5. Tela de vínculo de pasta → obra (`pit.pasta_obra` — ainda não criada).
6. Extração de metadados já acontece sozinha na ingestão (seção 6); o que
   falta é o **formulário consumir** isso.
7. No formulário do diário de PIT: "há N ensaios desta obra nesta data —
   importar?", pré-preenchendo `estaca_nome`, `diametro_cm`, `profundidade_m`,
   `arrasamento_m` e deixando o técnico confirmar.

O passo 7 é o que o usuário pediu desde o início. Os anteriores existem para
que ele seja confiável.

---

## 9. Estado atual, para conferência

```
Diariosgeoteste (hlzndrceaglkwavskqhs) — schema pit
  pit.equipamentos : pit-4959cf (PIT-Q Gontijo)
  pit.ensaios      : 0 (limpo após os testes de integração)
  bucket ensaios   : público=false
  função ingerir   : v1, ACTIVE

endpoint: https://hlzndrceaglkwavskqhs.supabase.co/functions/v1/ingerir
```

```
fpit-sync (mphomlxniavqmvxhacii) — projeto antigo, ainda existe, parado
  public.ensaios   : 161 ensaios reais do pit-4959cf, sincronizados antes
                      da migração para cá
  bucket ensaios   : os arquivos correspondentes, intactos

  Decisão pendente: migrar esses 161 pra dentro de `pit.*` (baixar de lá,
  subir aqui, copiar as linhas), ou deixar como estão e só o que sincronizar
  a partir de agora entra no `pit`. Ninguém decidiu ainda — não presuma.
```

Teste de ligação, sem instalar nada (o token fica com quem administra):

```powershell
$bytes = [System.IO.File]::ReadAllBytes($arq)
Invoke-RestMethod -Uri $url -Method Post -Body $bytes -Headers @{
  "Authorization"="Bearer $token"; "X-Machine-Id"="pit-4959cf"
  "X-Nome-Original"=(Split-Path $arq -Leaf)
  "Content-Type"="application/octet-stream" }
```

201 na primeira vez, 200 com `duplicado:true` na segunda.

Pra ler pelo lado do backend, lembre do `Accept-Profile: pit` (seção 1):

```powershell
Invoke-RestMethod -Uri "https://hlzndrceaglkwavskqhs.supabase.co/rest/v1/ensaios_para_diario?select=*&limit=5" `
  -Headers @{ apikey=$serviceRoleKey; Authorization="Bearer $serviceRoleKey"; "accept-profile"="pit" }
```

Ou pelo próprio cliente já compilado:

```
SincronPIT.exe --enviar "C:\caminho\E15.PTE"
```
