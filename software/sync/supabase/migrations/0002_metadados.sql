-- ============================================================================
-- Fpit Sync — metadados extraídos do .PTE
--
-- O arquivo deixa de ser um blob opaco: a Edge Function lê o cabeçalho e grava
-- os campos que o app do Diário precisa para pré-preencher o formulário
-- (tipo da estaca, diâmetro, comprimento, arrasamento).
--
-- Tudo aqui é o que o operador DIGITOU no equipamento, não medição. Serve como
-- sugestão em formulário; quem assina confirma.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Campos de arquivo — os que não mudam entre golpes
-- ---------------------------------------------------------------------------
alter table public.ensaios
  add column if not exists estaca_nome     text,
  add column if not exists estaca_tipo     text,   -- 0304, normalizado em maiúsculas
  add column if not exists area_secao_m2   numeric,-- 0413
  add column if not exists diametro_cm     numeric,-- derivado: 2·√(A/π)·100
  add column if not exists operador_data   text,   -- 0202
  add column if not exists empresa         text,   -- 0203
  add column if not exists n_blocos        integer,
  add column if not exists n_configuracoes integer,
  add column if not exists extraido_em     timestamptz,
  add column if not exists extracao_erro   text;

comment on column public.ensaios.estaca_tipo is
  'Tag 0304. Normalizado em MAIÚSCULAS: o equipamento não normaliza, e o mesmo operador digitou "hc" num ensaio e "HC" nos outros — sem isto o diário listaria dois tipos onde existe um.';

comment on column public.ensaios.diametro_cm is
  'Derivado da área de seção assumindo seção circular. Bate exato em quatro diâmetros comerciais (50, 60, 45, 40 cm). Estaca de seção não circular daria número sem sentido.';

comment on column public.ensaios.n_configuracoes is
  'Quantos cabeçalhos completos (com WS) o arquivo tem. NÃO é o mesmo que número de batidas: o parser conta batidas como blocos/4, e num arquivo real com 9 blocos isso dá 2 enquanto há 3 cabeçalhos. Os dois números divergem e nenhum dos dois foi confirmado como "número de golpes"; use este só para saber quantas configurações existem.';

comment on column public.ensaios.extracao_erro is
  'Preenchido quando a leitura do cabeçalho falhou. Falha de extração NUNCA recusa o upload: o arquivo é o entregável, o metadado é bônus.';

-- ---------------------------------------------------------------------------
-- Parâmetros POR CONFIGURAÇÃO
--
-- Existe porque os parâmetros não são do arquivo, são do golpe. Medido em
-- ensaio real: no mesmo arquivo, MD foi de 2 para 4, FS de 66000 para 134000 e
-- o arrasamento de 2 para 10 para 0.7.
--
-- Gravar só o primeiro daria ao diário um arrasamento que o operador pode não
-- ter usado. Para pré-preencher, use a ÚLTIMA linha (maior `ordem`) — é a
-- configuração com que o ensaio terminou.
-- ---------------------------------------------------------------------------
create table if not exists public.ensaio_parametros (
  ensaio_id           uuid not null references public.ensaios(id) on delete cascade,
  ordem               integer not null,          -- 0 = primeiro cabeçalho do arquivo
  velocidade_onda_ms  numeric,                   -- 0403 WS
  comprimento_le_m    numeric,                   -- 0404 LE
  md_m                numeric,                   -- 0405 Magnification Delay
  ma                  numeric,                   -- 0407 Magnification Factor
  taxa_amostragem_hz  numeric,                   -- 0414 FS
  arrasamento_m       numeric,                   -- 0419 L1
  primary key (ensaio_id, ordem)
);

create index if not exists idx_parametros_ensaio on public.ensaio_parametros (ensaio_id, ordem);

alter table public.ensaio_parametros enable row level security;
alter table public.ensaio_parametros force row level security;
-- Sem política, como as demais: só service_role passa.

-- ---------------------------------------------------------------------------
-- Visão de conveniência para o app do Diário
--
-- Entrega, por ensaio, os campos de arquivo mais a ÚLTIMA configuração — que é
-- a que interessa para pré-preencher. `comprimento_util_m` e `estaca_tipo` do
-- Diário continuam decisão de quem preenche; aqui só chega a sugestão.
-- ---------------------------------------------------------------------------
create or replace view public.ensaios_para_diario as
select
  e.id,
  e.equipamento_id,
  e.sha256,
  e.nome_original,
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

comment on view public.ensaios_para_diario is
  'Um ensaio por linha, já com a última configuração. Os campos "sugerido" são o que o operador digitou no equipamento, não medição — o formulário deve permitir correção.';
