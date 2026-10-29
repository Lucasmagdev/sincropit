-- ============================================================================
-- Fpit Sync — esquema base
--
-- Modelo de acesso, em uma frase: NADA no banco é alcançável pelo cliente.
-- O equipamento fala só com a Edge Function; a Edge Function é a única coisa
-- que tem service_role. Por isso as tabelas ligam RLS e NÃO recebem política
-- alguma para anon/authenticated — o padrão de RLS é negar, e é o que
-- queremos. service_role ignora RLS, então a função continua funcionando.
--
-- A chave service_role NUNCA vai para o computador do PIT-Q. O que vai é um
-- token por equipamento, limitado e revogável, guardado aqui só como hash.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Equipamentos (um por PIT-Q)
-- ---------------------------------------------------------------------------
create table if not exists public.equipamentos (
  id              uuid primary key default gen_random_uuid(),

  -- id gerado pelo sincronizador na primeira execução. Não é hostname nem
  -- serial de hardware: hostname muda e serial expõe informação sem precisar.
  machine_id      text not null unique,

  -- Nome legível, preenchido por quem administra. Ex: "PIT-Q obra Gontijo".
  apelido         text,

  -- SHA-256 do token, em hex. O token em claro aparece UMA vez, na criação,
  -- e não é recuperável. Se vazar o banco, não vaza credencial utilizável.
  token_sha256    text not null unique,

  ativo           boolean not null default true,
  revogado_em     timestamptz,

  -- Teto de tamanho por arquivo, por equipamento. Ensaios reais vão de 17 KB
  -- a 700 KB; 8 MB dá folga enorme e ainda barra upload absurdo.
  limite_bytes    bigint not null default 8388608,

  criado_em       timestamptz not null default now(),
  ultimo_contato  timestamptz,
  ultimo_ip       inet
);

comment on column public.equipamentos.token_sha256 is
  'SHA-256 hex do token do equipamento. O token em claro nunca é armazenado.';

-- ---------------------------------------------------------------------------
-- Ensaios recebidos
-- ---------------------------------------------------------------------------
create table if not exists public.ensaios (
  id                uuid primary key default gen_random_uuid(),
  equipamento_id    uuid not null references public.equipamentos(id) on delete restrict,

  -- Deduplicação por CONTEÚDO. Único global de propósito: o mesmo ensaio
  -- copiado com outro nome, ou reenviado depois de uma queda, não vira
  -- registro novo. O nome do arquivo NÃO participa da identidade.
  sha256            text not null unique
                    check (sha256 ~ '^[0-9a-f]{64}$'),

  nome_original     text not null,
  extensao          text not null check (extensao in ('.pte', '.ptn', '.pt2')),
  bytes             bigint not null check (bytes > 0),

  -- Caminho no Storage. Endereçado por conteúdo: reenvio sobrescreve o mesmo
  -- objeto com bytes idênticos, o que é inofensivo.
  storage_path      text not null,

  -- Só o NOME da pasta de origem, nunca o caminho completo — não há motivo
  -- para o servidor saber a estrutura de diretórios do cliente.
  pasta_origem      text,

  criado_no_equipamento  timestamptz,   -- data do arquivo no disco do PIT-Q
  detectado_em           timestamptz,   -- quando o sync viu o arquivo
  recebido_em            timestamptz not null default now()
);

create index if not exists idx_ensaios_equipamento on public.ensaios (equipamento_id, recebido_em desc);
create index if not exists idx_ensaios_recebido    on public.ensaios (recebido_em desc);

-- ---------------------------------------------------------------------------
-- Trilha de auditoria
--
-- Registra tentativa, não só sucesso. Sem isso, um equipamento que falha em
-- silêncio há duas semanas é indistinguível de um que não fez ensaio nenhum —
-- e essa diferença é justamente o que interessa saber.
-- ---------------------------------------------------------------------------
create table if not exists public.eventos_envio (
  id              bigserial primary key,
  equipamento_id  uuid references public.equipamentos(id) on delete set null,
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

create index if not exists idx_eventos_equipamento on public.eventos_envio (equipamento_id, ocorrido_em desc);
create index if not exists idx_eventos_resultado   on public.eventos_envio (resultado, ocorrido_em desc);

-- ---------------------------------------------------------------------------
-- RLS: liga em tudo e não cria política nenhuma.
--
-- Sem política, anon e authenticated não leem nem escrevem nada. Só
-- service_role passa, e ele existe apenas dentro da Edge Function.
-- Quando houver painel de leitura, a política entra aqui, explícita.
-- ---------------------------------------------------------------------------
alter table public.equipamentos  enable row level security;
alter table public.ensaios       enable row level security;
alter table public.eventos_envio enable row level security;

-- Força RLS também para o dono da tabela, fechando o caminho de bypass por
-- ownership.
alter table public.equipamentos  force row level security;
alter table public.ensaios       force row level security;
alter table public.eventos_envio force row level security;

-- ---------------------------------------------------------------------------
-- Storage: bucket privado
--
-- public = false. O acesso a um ensaio sai por URL assinada de vida curta,
-- emitida sob demanda — nunca por link permanente.
-- ---------------------------------------------------------------------------
-- Num projeto recem-criado o servico de Storage ainda esta subindo e o schema
-- `storage` pode nao existir quando a migracao roda. Sem esta guarda, a
-- migracao inteira falha por causa do bucket — e as tabelas, que sao o que
-- importa, nem chegam a ser criadas.
do $$
begin
  if exists (select 1 from information_schema.tables
              where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('ensaios', 'ensaios', false, 8388608, array['application/octet-stream'])
    on conflict (id) do update
      set public = false,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  else
    raise notice 'schema storage ainda nao existe; crie o bucket ensaios pela API ou rode esta migracao de novo';
  end if;
end $$;

-- storage.objects já tem RLS ligado por padrão no Supabase. Não criamos
-- política para este bucket: só service_role escreve e lê.

-- ---------------------------------------------------------------------------
-- Cadastro de equipamento
--
-- Roda no SQL Editor, uma vez por PIT-Q. Devolve o token em claro — é a
-- única vez que ele existe fora da máquina. Copie e guarde; não dá pra
-- recuperar depois, só emitir outro.
--
--   select * from public.criar_equipamento('pit-<uuid do sync>', 'PIT-Q Gontijo');
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto;

create or replace function public.criar_equipamento(p_machine_id text, p_apelido text default null)
returns table (equipamento_id uuid, machine_id text, token_em_claro text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_token text;
  v_hash  text;
  v_id    uuid;
begin
  -- 32 bytes de aleatoriedade criptográfica, em hex.
  v_token := encode(gen_random_bytes(32), 'hex');
  v_hash  := encode(digest(v_token, 'sha256'), 'hex');

  insert into public.equipamentos (machine_id, apelido, token_sha256)
  values (p_machine_id, p_apelido, v_hash)
  returning id into v_id;

  return query select v_id, p_machine_id, v_token;
end;
$$;

revoke all on function public.criar_equipamento(text, text) from public, anon, authenticated;

-- Revogação: derruba o equipamento sem apagar histórico de ensaios.
create or replace function public.revogar_equipamento(p_machine_id text)
returns boolean
language sql
security definer
set search_path = public
as $$
  update public.equipamentos
     set ativo = false, revogado_em = now()
   where machine_id = p_machine_id
  returning true;
$$;

revoke all on function public.revogar_equipamento(text) from public, anon, authenticated;
