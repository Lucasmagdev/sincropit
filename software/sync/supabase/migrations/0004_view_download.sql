-- ============================================================================
-- Acrescenta à view os dois campos que faltavam para o download funcionar:
-- `storage_path` (endereço do arquivo, para assinar a URL) e `bytes` (tamanho
-- mostrado na lista).
--
-- `security_invoker` é reafirmado de propósito: sem ele a view rodaria com os
-- direitos do dono e entregaria tudo ignorando o RLS das tabelas de baixo.
-- ============================================================================
-- `create or replace` não reordena nem renomeia coluna de view — recusa com
-- 42P16. Derrubar e recriar é o caminho; a view não guarda dado, então não há
-- nada a perder.
drop view if exists public.ensaios_para_diario;

create view public.ensaios_para_diario as
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
from public.ensaios e
left join lateral (
  select * from public.ensaio_parametros q
   where q.ensaio_id = e.id
   order by q.ordem desc
   limit 1
) p on true;

alter view public.ensaios_para_diario set (security_invoker = true);
grant select on public.ensaios_para_diario to authenticated;

comment on view public.ensaios_para_diario is
  'Um ensaio por linha, já com a última configuração. Os campos "sugerido" são o que o operador digitou no equipamento, não medição — o formulário deve permitir correção.';
