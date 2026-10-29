-- ============================================================================
-- Fpit Sync, dentro do projeto Diariosgeoteste — schema `pit`
--
-- Adaptação do schema já validado no projeto separado `fpit-sync`
-- (software/sync/supabase/migrations/0001_esquema.sql + 0002_metadados.sql),
-- movido para dentro do banco do Diário, em schema próprio.
--
-- POR QUE SCHEMA SEPARADO, NÃO `public`: o Diário já tem uma tabela
-- `public.equipamentos` (cadastro de equipamento da empresa) com significado
-- totalmente diferente da tabela de credencial de aparelho PIT que este
-- módulo precisa. `public.ensaios` também poderia colidir com nomenclatura
-- futura do Diário. Schema `pit` elimina os dois riscos de uma vez, e deixa
-- claro visualmente, em qualquer query, de onde vem cada tabela.
--
-- MODELO DE ACESSO — idêntico ao do projeto original, de propósito: RLS
-- ligado e FORÇADO em tudo, ZERO políticas para anon/authenticated. Só
-- service_role passa (a Edge Function `ingerir`, e o backend do Diário se
-- quiser ler direto). Não foi recriado aqui nenhum painel de leitura para
-- usuário final — isso foi tentado no projeto anterior e revertido a pedido
-- explícito; se for necessário no futuro, é uma decisão separada.
-- ============================================================================

create schema if not exists pit;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Equipamentos (um por PIT-Q) — NÃO é a mesma tabela que public.equipamentos
-- ---------------------------------------------------------------------------
create table if not exists pit.equipamentos (
  id              uuid primary key default gen_random_uuid(),
  machine_id      text not null unique,
  apelido         text,
  -- SHA-256 do token, em hex. O token em claro aparece UMA vez, na criação.
  token_sha256    text not null unique,
  ativo           boolean not null default true,
  revogado_em     timestamptz,
  limite_bytes    bigint not null default 8388608,
  criado_em       timestamptz not null default now(),
  ultimo_contato  timestamptz,
  ultimo_ip       inet
);

comment on table pit.equipamentos is
  'Credencial de aparelho PIT-Q. NÃO confundir com public.equipamentos (cadastro de equipamento da empresa) — são tabelas diferentes, de propósitos diferentes.';
comment on column pit.equipamentos.token_sha256 is
  'SHA-256 hex do token do equipamento. O token em claro nunca é armazenado.';

-- ---------------------------------------------------------------------------
-- Ensaios recebidos
-- ---------------------------------------------------------------------------
create table if not exists pit.ensaios (
  id                uuid primary key default gen_random_uuid(),
  equipamento_id    uuid not null references pit.equipamentos(id) on delete restrict,

  -- Deduplicação por CONTEÚDO. O nome do arquivo NÃO participa da identidade.
  sha256            text not null unique
                    check (sha256 ~ '^[0-9a-f]{64}$'),

  nome_original     text not null,
  extensao          text not null check (extensao in ('.pte', '.ptn', '.pt2')),
  bytes             bigint not null check (bytes > 0),
  storage_path      text not null,
  pasta_origem      text,

  criado_no_equipamento  timestamptz,
  detectado_em           timestamptz,
  recebido_em            timestamptz not null default now(),

  -- Campos extraídos do cabeçalho do .PTE — ver software/src/lib/pte.ts
  -- (extrairDadosEstaca). São o que o operador DIGITOU no equipamento, não
  -- medição; servem como sugestão de preenchimento, não como afirmação.
  estaca_nome     text,
  estaca_tipo     text,   -- tag 0304, normalizado em MAIÚSCULAS
  area_secao_m2   numeric,-- tag 0413
  diametro_cm     numeric,-- derivado: 2·√(A/π)·100
  operador_data   text,   -- tag 0202
  empresa         text,   -- tag 0203
  n_blocos        integer,
  n_configuracoes integer,
  extraido_em     timestamptz,
  extracao_erro   text
);

comment on column pit.ensaios.estaca_tipo is
  'Tag 0304. Normalizado em MAIÚSCULAS: o equipamento não normaliza sozinho — o mesmo operador já digitou "hc" num ensaio e "HC" em outro.';
comment on column pit.ensaios.diametro_cm is
  'Derivado da área de seção assumindo seção circular. Confirmado exato em quatro diâmetros comerciais (50, 60, 45, 40 cm).';
comment on column pit.ensaios.extracao_erro is
  'Preenchido quando a leitura do cabeçalho falhou. Falha de extração NUNCA recusa o upload: o arquivo é o entregável, o metadado é bônus.';

create index if not exists idx_ensaios_equipamento on pit.ensaios (equipamento_id, recebido_em desc);
create index if not exists idx_ensaios_recebido    on pit.ensaios (recebido_em desc);

-- ---------------------------------------------------------------------------
-- Trilha de auditoria — registra TENTATIVA, não só sucesso
-- ---------------------------------------------------------------------------
create table if not exists pit.eventos_envio (
  id              bigserial primary key,
  equipamento_id  uuid references pit.equipamentos(id) on delete set null,
  machine_id      text,
  resultado       text not null check (resultado in
                    ('aceito', 'duplicado', 'rejeitado_token', 'rejeitado_extensao',
                     'rejeitado_tamanho', 'rejeitado_hash', 'erro_interno')),
  detalhe         text,
  sha256          text,
  bytes           bigint,
  ip              inet,
  ocorrido_em     timestamptz not null default now()
);

create index if not exists idx_eventos_equipamento on pit.eventos_envio (equipamento_id, ocorrido_em desc);

-- ---------------------------------------------------------------------------
-- Parâmetros POR CONFIGURAÇÃO — os parâmetros são do GOLPE, não do arquivo.
--
-- Medido em ensaio real: no mesmo arquivo, MD foi de 2 para 4, FS de 66000
-- para 134000 e o arrasamento (L1) de 2 para 10 para 0.7 entre batidas.
-- Gravar só a primeira configuração daria ao diário um arrasamento que o
-- operador pode não ter usado — use a ÚLTIMA (maior `ordem`).
-- ---------------------------------------------------------------------------
create table if not exists pit.ensaio_parametros (
  ensaio_id           uuid not null references pit.ensaios(id) on delete cascade,
  ordem               integer not null,
  velocidade_onda_ms  numeric,  -- 0403 WS
  comprimento_le_m    numeric,  -- 0404 LE
  md_m                numeric,  -- 0405 Magnification Delay
  ma                  numeric,  -- 0407 Magnification Factor
  taxa_amostragem_hz  numeric,  -- 0414 FS
  arrasamento_m       numeric,  -- 0419 L1
  primary key (ensaio_id, ordem)
);

-- ---------------------------------------------------------------------------
-- RLS: liga em tudo, zero políticas. Só service_role passa.
-- ---------------------------------------------------------------------------
alter table pit.equipamentos     enable row level security;
alter table pit.ensaios          enable row level security;
alter table pit.eventos_envio    enable row level security;
alter table pit.ensaio_parametros enable row level security;

alter table pit.equipamentos     force row level security;
alter table pit.ensaios          force row level security;
alter table pit.eventos_envio    force row level security;
alter table pit.ensaio_parametros force row level security;

-- ---------------------------------------------------------------------------
-- Storage: bucket privado `ensaios`
--
-- Bucket é global ao projeto (Storage não tem "schema"); o nome já foi
-- conferido livre no Diariosgeoteste antes desta migração rodar.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ensaios', 'ensaios', false, 8388608, array['application/octet-stream'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- storage.objects já tem RLS ligado por padrão no Supabase; sem política
-- para este bucket, só service_role lê/escreve.

-- ---------------------------------------------------------------------------
-- Cadastro de equipamento
--
--   select * from pit.criar_equipamento('pit-<uuid do sync>', 'PIT-Q Gontijo');
--
-- Devolve o token em claro — única vez que ele existe fora da máquina.
-- ---------------------------------------------------------------------------
create or replace function pit.criar_equipamento(p_machine_id text, p_apelido text default null)
returns table (equipamento_id uuid, machine_id text, token_em_claro text)
language plpgsql
security definer
set search_path = pit, extensions
as $$
declare
  v_token text;
  v_hash  text;
  v_id    uuid;
begin
  v_token := encode(gen_random_bytes(32), 'hex');
  v_hash  := encode(digest(v_token, 'sha256'), 'hex');

  insert into pit.equipamentos (machine_id, apelido, token_sha256)
  values (p_machine_id, p_apelido, v_hash)
  returning id into v_id;

  return query select v_id, p_machine_id, v_token;
end;
$$;

revoke all on function pit.criar_equipamento(text, text) from public, anon, authenticated;

create or replace function pit.revogar_equipamento(p_machine_id text)
returns boolean
language sql
security definer
set search_path = pit
as $$
  update pit.equipamentos
     set ativo = false, revogado_em = now()
   where machine_id = p_machine_id
  returning true;
$$;

revoke all on function pit.revogar_equipamento(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- View de conveniência: um ensaio por linha, com a ÚLTIMA configuração.
--
-- Sem grant para authenticated/anon de propósito — mesmo padrão zero-acesso
-- do resto do schema. Quem for ler (backend do Diário) usa service_role, que
-- ignora RLS e não precisa de grant explícito.
-- ---------------------------------------------------------------------------
create or replace view pit.ensaios_para_diario as
select
  e.id,
  e.equipamento_id,
  e.sha256,
  e.nome_original,
  e.extensao,
  e.bytes,
  e.storage_path,
  e.pasta_origem,
  e.criado_no_equipamento,
  e.recebido_em,
  e.estaca_nome,
  e.estaca_tipo,
  e.diametro_cm,
  e.area_secao_m2,
  p.comprimento_le_m   as profundidade_sugerida_m,
  p.arrasamento_m      as arrasamento_sugerido_m,
  p.velocidade_onda_ms,
  p.taxa_amostragem_hz,
  e.n_configuracoes,
  e.extracao_erro
from pit.ensaios e
left join lateral (
  select * from pit.ensaio_parametros q
   where q.ensaio_id = e.id
   order by q.ordem desc
   limit 1
) p on true;

alter view pit.ensaios_para_diario set (security_invoker = true);

comment on view pit.ensaios_para_diario is
  'Um ensaio por linha, já com a última configuração. Campos "sugerido" são o que o operador digitou no equipamento, não medição.';
