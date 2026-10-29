-- ============================================================================
-- Fpit Sync — acesso de leitura para o administrativo
--
-- Até aqui NINGUÉM lia nada: RLS ligado e forçado, zero políticas, bucket
-- privado. Só a Edge Function (com service_role) enxergava. Esta migração
-- abre uma porta, e abre estreita:
--
--   - SOMENTE LEITURA. Nenhuma política de insert, update ou delete.
--   - SOMENTE para e-mail cadastrado. Estar logado não basta.
--   - SOMENTE as duas tabelas de ensaio. `equipamentos` continua sem política
--     nenhuma — ela guarda o hash do token dos aparelhos, e não existe motivo
--     para o administrativo chegar perto disso. `eventos_envio` idem.
--   - O bucket continua privado. O download sai por URL assinada de vida
--     curta, emitida na hora.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Quem pode ver
--
-- Lista explícita. Preferida a "todo usuário autenticado" porque o projeto
-- pode ganhar outros usuários por outros motivos, e o acesso ao acervo de
-- ensaios de cliente não deve vir de brinde junto.
-- ---------------------------------------------------------------------------
create table if not exists public.usuarios_autorizados (
  email      text primary key,
  nome       text,
  criado_em  timestamptz not null default now()
);

alter table public.usuarios_autorizados enable row level security;
alter table public.usuarios_autorizados force row level security;
-- Sem política: a tabela não é legível por ninguém pela API. Só a função
-- abaixo consulta, e ela é security definer.

create or replace function public.eh_autorizado()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.usuarios_autorizados u
     where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke all on function public.eh_autorizado() from public;
grant execute on function public.eh_autorizado() to authenticated;

-- ---------------------------------------------------------------------------
-- Leitura dos ensaios
-- ---------------------------------------------------------------------------
drop policy if exists "autorizados leem ensaios" on public.ensaios;
create policy "autorizados leem ensaios"
  on public.ensaios for select
  to authenticated
  using (public.eh_autorizado());

drop policy if exists "autorizados leem parametros" on public.ensaio_parametros;
create policy "autorizados leem parametros"
  on public.ensaio_parametros for select
  to authenticated
  using (public.eh_autorizado());

-- ---------------------------------------------------------------------------
-- A view precisa rodar com os direitos de QUEM CHAMA
--
-- Por padrão uma view executa com os direitos do dono, o que faria ela
-- ignorar o RLS das tabelas de baixo e entregar tudo a qualquer um. Sem esta
-- linha, as políticas acima seriam decorativas.
-- ---------------------------------------------------------------------------
alter view public.ensaios_para_diario set (security_invoker = true);
grant select on public.ensaios_para_diario to authenticated;

-- ---------------------------------------------------------------------------
-- Leitura do arquivo no Storage
--
-- Permite gerar URL assinada. O bucket segue privado: sem assinatura válida,
-- o objeto não abre.
-- ---------------------------------------------------------------------------
drop policy if exists "autorizados baixam ensaios" on storage.objects;
create policy "autorizados baixam ensaios"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'ensaios' and public.eh_autorizado());
