# Fpit Sync — lado servidor

## Ambiente em produção (já no ar)

| item | valor |
|---|---|
| projeto | `fpit-sync` |
| ref | `mphomlxniavqmvxhacii` |
| região | `sa-east-1` (São Paulo) |
| endpoint | `https://mphomlxniavqmvxhacii.supabase.co/functions/v1/ingerir` |
| equipamentos | `pit-4959cf` (PIT-Q Gontijo), `pit-teste-local` (bancada) |

Tokens não estão aqui e nunca estarão. Ficam com quem administra; para emitir
outro, use `criar_equipamento`.

> **Storage precisou de restart.** No projeto recém-criado o serviço de
> Storage ficou `UNHEALTHY` com `TenantNotFound` por ~15 min e não se
> resolveu sozinho; um `POST /v1/projects/{ref}/restart` provisionou o
> tenant. Se levantar outro ambiente e o bucket não puder ser criado, é isso.


Vale igual para o cliente em Node ou em PowerShell: o equipamento só fala
HTTP com a Edge Function `ingerir`. A escolha de tecnologia do PIT-Q não
muda nada aqui.

## Arquivos

| arquivo | o que é |
|---|---|
| `migrations/0001_esquema.sql` | tabelas, RLS, bucket, funções de cadastro/revogação |
| `functions/ingerir/index.ts` | a única porta de entrada; valida e grava |

## Modelo de segurança

O que o PIT-Q recebe é **um token por equipamento**, e nada mais.

- `SUPABASE_SERVICE_ROLE_KEY` fica só nas variáveis da Edge Function. Nunca
  no executável, nunca no `.ps1`, nunca no disco do PIT-Q.
- O token é guardado **como SHA-256**. Vazou o banco, não vazou credencial.
- O token em claro aparece **uma única vez**, no retorno de
  `criar_equipamento`. Não é recuperável — se perder, emite outro.
- Revogação sem perder histórico: `revogar_equipamento('pit-...')`.
- RLS ligado em todas as tabelas, **sem política nenhuma** para `anon` /
  `authenticated`. O padrão do RLS é negar; só `service_role` passa, e ele
  existe apenas dentro da função. `force row level security` fecha também o
  caminho por dono da tabela.
- Bucket `ensaios` com `public = false`. Leitura sai por URL assinada de vida
  curta, emitida sob demanda — nunca link permanente.
- O servidor **recalcula o SHA-256** dos bytes recebidos. O hash que o cliente
  manda é conferido, não aceito. Identidade do ensaio = hash do que chegou.
- Extensão, tamanho e identidade do equipamento validados no servidor.
  `machine_id` tem que bater com o dono do token.
- Teto de 500 envios aceitos por hora por equipamento.
- Nome do arquivo **não entra no caminho do Storage** (evita path traversal e
  caractere estranho vindo do campo). O caminho é
  `<machine_id>/<data>/<sha256><ext>`.

## Subir

```bash
supabase link --project-ref <ref>
supabase db push
supabase functions deploy ingerir
```

A função herda `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` do projeto; não
precisa configurar segredo à mão.

## Cadastrar um equipamento

No SQL Editor, uma vez por PIT-Q. O `machine_id` é o que o sincronizador
gerou na primeira execução (`%APPDATA%\FpitSync\config.json`):

```sql
select * from public.criar_equipamento('pit-<uuid>', 'PIT-Q Gontijo');
```

Retorna `token_em_claro`. **Copie agora** — não dá pra ver de novo.

## Testar sem o sincronizador

Prova que a porta funciona antes de existir cliente. Roda em qualquer
Windows, sem instalar nada:

```powershell
$url   = "https://<ref>.supabase.co/functions/v1/ingerir"
$token = "<token_em_claro>"
$arq   = "C:\caminho\B135-EA.PTE"

$bytes = [System.IO.File]::ReadAllBytes($arq)
$sha   = (Get-FileHash $arq -Algorithm SHA256).Hash.ToLower()

Invoke-RestMethod -Uri $url -Method Post -Body $bytes -Headers @{
  "Authorization"   = "Bearer $token"
  "X-Machine-Id"    = "pit-<uuid>"
  "X-Nome-Original" = (Split-Path $arq -Leaf)
  "X-Sha256"        = $sha
  "Content-Type"    = "application/octet-stream"
}
```

Esperado: `201` na primeira vez, `200` com `duplicado: true` na segunda.
Se der `200 duplicado` de cara, esse conteúdo já subiu antes — é a
deduplicação por conteúdo funcionando, não erro.

## Códigos de resposta — e o que o cliente faz com cada um

A separação importa: rejeição definitiva reenviada em laço infinito seria o
pior comportamento possível na obra.

| código | significa | cliente |
|---|---|---|
| 201 | gravado | marca enviado |
| 200 `duplicado` | esse conteúdo já existe | marca enviado, **não** reenvia |
| 401 | token inválido/revogado, ou `machine_id` não bate | para e avisa; reenviar não resolve |
| 413 | tamanho fora do limite | erro permanente |
| 415 | extensão não permitida | erro permanente |
| 422 | hash não confere — chegou corrompido | reenvia (pode ser transporte) |
| 429 | teto por hora | backoff longo |
| 5xx | falha do servidor | reenvia com backoff exponencial |

## Auditoria

`eventos_envio` grava **tentativa**, não só sucesso. Sem isso, um equipamento
que falha em silêncio há duas semanas é indistinguível de um que não fez
ensaio nenhum — e essa diferença é justamente o que interessa saber.

```sql
-- saúde por equipamento
select e.apelido, e.machine_id, e.ultimo_contato,
       count(*) filter (where ev.resultado = 'aceito')     as aceitos,
       count(*) filter (where ev.resultado like 'rejeit%') as rejeitados,
       max(ev.ocorrido_em)                                 as ultima_tentativa
  from public.equipamentos e
  left join public.eventos_envio ev on ev.equipamento_id = e.id
 group by e.id order by e.ultimo_contato desc nulls last;
```

## Pendente

- Política de RLS para leitura pelo painel — entra quando o painel existir,
  explícita. Hoje ninguém lê além da função.
- Emissão de URL assinada para download (função `baixar`).
- Retenção/expurgo do bucket: não definido. Decidir antes de acumular obra.
