-- ============================================================================
-- Desfaz a 0003: o painel de download para o administrativo não era o pedido.
--
-- Volta ao estado anterior: RLS ligado e forçado, ZERO políticas em tudo. Só a
-- Edge Function `ingerir` (com service_role) escreve; ninguém lê pela API.
--
-- A 0004 fica: ela só acrescentou colunas à view, o que é inofensivo e útil
-- para quem for consumir isso pelo lado do Diário mais adiante.
-- ============================================================================

drop policy if exists "autorizados baixam ensaios" on storage.objects;
drop policy if exists "autorizados leem parametros" on public.ensaio_parametros;
drop policy if exists "autorizados leem ensaios"    on public.ensaios;

revoke select on public.ensaios_para_diario from authenticated;

drop function if exists public.eh_autorizado();
drop table if exists public.usuarios_autorizados;
