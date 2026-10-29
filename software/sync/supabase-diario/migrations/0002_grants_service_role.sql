-- ============================================================================
-- Concede a `service_role` o acesso ao schema `pit`.
--
-- Schema criado por script NÃO herda os grants automáticos que `public` tem
-- de fábrica no Supabase (lá, `service_role` já vem com USAGE + ALL nas
-- tabelas). Schema novo fica com permissão só pro dono (postgres) até isso
-- ser concedido explicitamente — foi por isso que a Edge Function voltou
-- "permission denied for schema pit" mesmo usando a chave certa.
--
-- Só `service_role` recebe. `anon`/`authenticated` continuam sem nada, o
-- que é o comportamento pretendido: RLS forçado + zero políticas já bloqueia
-- essas roles nas tabelas, mas sem USAGE no schema elas nem chegariam lá.
-- ============================================================================

grant usage on schema pit to service_role;

grant all on all tables    in schema pit to service_role;
grant all on all sequences in schema pit to service_role;
grant all on all functions in schema pit to service_role;

-- Cobre tabela/sequência/função que vier a ser criada depois nesta migração,
-- sem precisar lembrar de repetir o grant.
alter default privileges in schema pit grant all on tables    to service_role;
alter default privileges in schema pit grant all on sequences to service_role;
alter default privileges in schema pit grant all on functions to service_role;
