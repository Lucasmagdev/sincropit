# Formato .PTE — engenharia reversa (achados)

## Equipamento identificado

**Pile Dynamics, Inc. (PDI)** — modelo PIT-QV ou PIT-QFV, software **PIT-W**.
Confirmado por: layout do print de tela idêntico ao dos manuais oficiais PDI
(painel MA/MD/LE/WS/LO/HI/PV/T1, marcadores T1/Toe), specs batendo (ADC 24-bit,
"signal amplification capability, variable over time"), e nomenclatura dos
parâmetros (MA = Magnification Factor, MD = Magnification Delay) confirmada
contra manual técnico de interpretação de terceiros (Hingorani, "Interpretation
of Low-Strain Pile Integrity Test Results", IGS).

Análise feita em cima de 7 arquivos reais (`samples/*.PTE`) via `parse-pte.js`, sem
nenhuma lib de terceiros nem acesso a código-fonte do software original — só hexdump
e inferência.

## Estrutura geral

Sequência de registros TLV: `[tag: u16 LE][len: u16 LE][payload]`

- Família de tags `0x0102`, `0x0202`, `0x0303` etc (segundo byte baixo, ~grupos 0-3):
  **texto**. `len` = número de caracteres, payload = `len*2` bytes UTF16LE.
- Família de tags `0x04xx`, `0x05xx`, `0x06xx`: **numérico**. `len` = número de bytes
  do payload: `4`→int32, `8`→float64, `16`→bloco de 8×uint16 (parece timestamp).

## Cabeçalho geral (uma vez por arquivo, ~1224 bytes)

Campos identificados com confiança:

| tag | valor exemplo (B135-EA) | provável significado |
|---|---|---|
| 0102 | "2020.10.0.4" | versão do software/firmware |
| 0103 | "PITE" | identificador do formato/equipamento |
| 0202 | "Alves Riheiro 16.07.2026" | operador + data do ensaio |
| 0203 | "GEOTESTE TESTES GEOTECNICOS LTDA" | empresa/cliente |
| 0303 | "B135-EA" | nome da estaca/ensaio (bate com nome do arquivo) |
| 0403 | 4000 | **WS — velocidade de onda (m/s)** |
| 0404 | 9.5 | **LE — comprimento da estaca (m)** |
| 0405 | 2 | **MD — Magnification Delay (m)** — onde a amplificação começa |
| 0407 | 10 | **MA — Magnification Factor** |
| 0414 | 50000 | **taxa de amostragem (Hz)** — varia por ensaio, não é fixa (ver abaixo) |
| 0415 | 2.9802322387695313e-7 | = 5 / 2²⁴ → **resolução de ADC de 24 bits, faixa 5V** — fixo em todos os arquivos vistos (16 até agora) |
| 0413 | 0.19635 | **área da seção transversal (m²)** — confirmado em **três obras**, com três diâmetros comerciais diferentes: 0.19635=π×0.25² (d=0.50m) no B135; 0.28274=π×0.30² (d=0.60m) nos PF; 0.15904=π×0.225² (d=0.45m) no ENCONTRO. Bate exato nos três (erro 0). Hipótese bem estabelecida. |
| 0412 | 0.0009071847400000001 | constante fixa, idêntica em todos os 16 arquivos vistos (2 obras diferentes) — significado ainda desconhecido |
| 041b | 23.56311957693693 | constante fixa, idêntica em todos os 16 arquivos vistos, **mesmo com área/diâmetro diferentes** — não é derivado da geometria da estaca, deve ser constante de equipamento/firmware |

**Correção**: 040e **não é gravidade**. Nos 7 arquivos B135/B136 valia sempre 9.8
(parecia bater com gravidade por coincidência), mas nos 9 arquivos de outra obra
(prefixo PF) vale sempre **20** — não é 9.8 nem fisicamente compatível com
gravidade. É configuração específica do projeto/sessão, significado ainda não
confirmado (não é LO nem HI — sabemos pela tela real do B135-EA que LO=0.00 e
HI=0.0, então 040e=9.8 não pode ser nenhum dos dois nesse arquivo).

Campos ainda sem significado confirmado: 0104, 0406, 040d, 040e, 040f, e os
"zeros" (0408-040c, 0410-041a, que devem incluir LO/HI/PV). Precisam ser
cruzados com a tela real do equipamento pra confirmar.

### Sessão de testes adicionais — cruzamento dos campos não identificados

Rodei o parser nos 16 arquivos (7 B135/B136 + 9 PF) extraindo especificamente
0104, 0406, 040d, 040f, 0412, 041b lado a lado:

| tag | valor | conclusão |
|---|---|---|
| 0104 | sempre 2 (16/16 arquivos) | constante universal — provável versão de sub-formato/nº de algo fixo do firmware, não identificado |
| 040d | sempre 2 (16/16 arquivos) | idem, constante universal |
| 040f | 8 em B135/B136, 4 nos PF | muda por obra/projeto (igual 040e) — configuração de sessão, não de equipamento |
| 0406 | 3 em B135/B136; 3 ou 4 nos PF (varia dentro da mesma obra) | **hipótese testada e refutada**: achei que fosse "nº de blocos com sinal real no grupo de 4" (bateria com PF02=4 blocos reais ↔ 0406=4), mas PF43 e PF45 têm 0406=4 com só 3 blocos reais no arquivo — não bate. Sem explicação confirmada ainda. |
| 0412 | 0.00090718474 (16/16) | valor bate com **907.18474 kg = 1 short ton (US) em kg**, escalado ×10⁻⁶ (ou, equivalentemente, 2 lb em toneladas métricas) — mas não achei onde essa constante entraria fisicamente no pipeline de sinal. Pode ser resquício de alguma conversão de unidade de força/peso não usada no processamento que fazemos. Não confirmado, só documentado o match numérico. |
| 041b | 23.56311957693693 (16/16) | testei contra π (7.5π=23.5619, 0.05% de diferença — perto mas não exato), contra 907.18474/38.5, sqrt/quadrado, gravidade — nenhuma combinação bateu exata. Constante de equipamento/firmware sem explicação numérica encontrada. |

**Novo achado nesta sessão — campos por-bloco 0505/0506** (não documentados antes,
aparecem no cabeçalho de cada bloco junto com T1=0504):

- `0505` (float64): em vários blocos vale **exatamente 8388607.0 = 2²³−1** (o
  valor máximo de um inteiro con sinal de 24 bits) — forte indício de campo
  relacionado ao **fundo de escala do ADC de 24 bits** (0415 já confirma ADC
  24-bit/5V). Quando não é exatamente 2²³−1, fica perto (ex: 8381113,
  8386433 — 99.9% do fundo de escala).
- Testei correlacionar 0505 com o valor máximo absoluto das amostras float64
  do próprio bloco (esperando achar "pico bruto do golpe") — **não bate**:
  em `B135-ED.PTE` bloco 4 (batida fraca, amostra máx ~1.7e9, a menor das 4
  batidas do arquivo) 0505 = 8388607 (fundo de escala cheio!), enquanto o
  bloco 0 (amostra máx ~1.07e10, maior que o bloco 4) tem 0505 = 5594180
  (bem abaixo do fundo de escala). Ou seja, 0505 **não é function simples do
  pico do array de amostras que lemos** — pode ser sobre outro canal/estágio
  do pipeline interno do equipamento (ex: pico do ADC bruto antes de algum
  processamento/ganho que já não está mais refletido no array float64
  salvo), ou até um indicador de overload/clip de um instante específico,
  não do bloco todo. Fica documentado como pista aberta, não confirmado.
- `0506` (float64, ordem de 1e-10 a 1e-9): varia bastante entre blocos/arquivos,
  sem relação óbvia encontrada com 0505, com o pico de velocidade calculado,
  nem com a razão de calibração ~1e-13 buscada na seção de calibração
  absoluta. Não identificado.

> **Atualização**: as duas hipóteses acima (0505 = saturação/overload, 0506 =
> fator de escala por batida) foram testadas com rigor depois e **as duas
> foram refutadas** — ver a seção "0505 e 0506 — testados a fundo (resultado
> NEGATIVO)" no fim deste arquivo. Não repita esses testes.

**Mapeamento LO/HI/PV — bloqueado por falta de dado**: os campos zerados
(0408-040c, 0410-041a) são candidatos a LO/HI/PV, mas em **todos os 16
arquivos que temos, esses campos são sempre zero** (LO=HI=PV=0 em toda
sessão de campo capturada) — não há como saber qual posição corresponde a
qual rótulo sem pelo menos um ensaio real onde o operador tenha ligado um
desses filtros (valor não-zero) pra comparar contra a tela. Precisa de mais
um arquivo de exemplo com LO/HI/PV ≠ 0, ou confirmação direta do manual/dev
da PDI.

### Trailer do arquivo — resolvido (não existe)

Item antigo "trailer final não decodificado" verificado nos 16 arquivos: o
parser (`parse-pte.js`) já consome o arquivo inteiro até o fim — o último
"bloco" de cada arquivo é um cabeçalho TLV que termina em amostras vazias
(sampleCount=0), e isso coincide exatamente com `buf.length`. `trailerLen=0`
em todos os 16 arquivos testados. Não existe trailer/checksum separado —
o que parecia trailer antes era essa última entrada TLV vazia sendo mal
interpretada.

### Timestamp — resolvido (era struct `SYSTEMTIME` do Windows)

A "discrepância a resolver" (texto dizia "16.07.2026", timestamp binário
parecia indicar dia/mês trocado) tinha uma causa simples: o campo de 16
bytes (8 × uint16) **é a struct `SYSTEMTIME` do Win32** — `{wYear, wMonth,
wDayOfWeek, wDay, wHour, wMinute, wSecond, wMilliseconds}`. A leitura antiga
assumia que o 3º campo era "o dia", mas o 3º campo é **dia da semana**
(0=domingo...6=sábado) e o dia do mês é o **4º campo**.

Conferido em B135-EA: `[2026, 7, 4, 16, 14, 16, 1, 451]` →
ano=2026, mês=7, diaSemana=4 (quinta), dia=16, hora=14, min=16, seg=1,
ms=451. **16/07/2026 é quinta-feira de verdade** (confirmado via
`new Date(2026,6,16)`), e dia=16/mês=7 bate exato com o texto "16.07.2026"
do campo 0202. Não havia discrepância nenhuma — só um índice mal lido.
Aplica-se aos 3 timestamps por bloco (0204, 0205 no cabeçalho geral, 0503
no cabeçalho por-bloco).

### Comparação entre os 7 arquivos (achado importante)

Rodei o parser nos 7 arquivos e comparei o cabeçalho lado a lado. Resultado:

- **Praticamente todo campo numérico é idêntico entre os 7 arquivos** — inclusive
  entre B135 e B136, que são **estacas diferentes**. 0403, 0406, 0407, 040d, 040e,
  040f, 0412, 0413, 0414, 0415, 041b: sempre o mesmo valor.
  - Conclusão: esses campos **não são geometria/dado específico da estaca** — são
    configuração do equipamento/projeto (aplicada a toda a sessão de ensaio), não
    algo lido/calculado por estaca. Isso descarta a hipótese de 0403 ser
    "comprimento da estaca" (senão B135 e B136 teriam comprimentos diferentes).
  - Único campo com pequena variação: 0404 (9.5 em EA/R1/R2, 9.52 em EC/ED/EE/B136-EA)
    — depois confirmado que é LE (comprimento), varia mesmo pouco entre estacas
    próximas na mesma obra.
  - **Atualizado com os 9 arquivos PF (outra obra)**: essa "config fixa" não é
    universal — é fixa **dentro do mesmo projeto/obra**, mas muda **entre
    projetos**. 040e (9.8→20), 040f (8→4), 0406 (varia mesmo dentro do PF: 3 ou 4)
    mudam de uma obra pra outra. Só 0412, 0413(quando mesmo diâmetro), 0415, 041b
    parecem realmente universais (constantes de equipamento/firmware, não de
    projeto). WS (velocidade de onda) permaneceu 4000 nas duas obras — pode ser
    coincidência (concreto parecido) ou ainda ser um default raramente mudado.
- Os únicos campos que **de fato variam por arquivo**: 0202/0204/0205 (timestamp) e
  0303 (nome da estaca/ensaio, igual ao nome do arquivo).
- **Timestamps formam uma sequência**: EA→EC→ED→EE→R1→R2→B136-EA, todos dentro de
  ~14 segundos um do outro (16:14:16 até 16:14:30) — consistente com múltiplas
  estacas/tentativas testadas em sequência na mesma sessão de campo.
- **Discrepância a resolver**: o texto do campo 0202 diz "16.07.2026", mas o
  timestamp binário (campo 0204/0205) indica dia/mês = 4/7 (ou 7/4, ordem ainda não
  confirmada) — não bate com 16/07. Hipóteses: erro de digitação do operador no
  campo de texto, ou o campo de texto registra outra coisa (ex: data de
  emissão/exportação) diferente do timestamp real da captura. Precisa conferir
  contra o relatório oficial do equipamento.

### CONFIRMADO contra a tela real do equipamento (B135-EA)

O usuário forneceu print da tela do software original pra B135-EA, com o painel de
parâmetros do ensaio. Bate direto com os campos do header:

| campo na tela | valor na tela | tag .PTE | valor no arquivo | status |
|---|---|---|---|---|
| WS (wave speed) | 4000 | 0403 | 4000 | **confirmado** |
| LE (length) | 9.50 | 0404 | 9.5 | **confirmado** — não é config fixa, é dado real da estaca (corrige nota acima: só pareceu fixo porque estacas próximas tinham comprimento parecido) |
| MD | 2.00 | 0405 | 2 | **confirmado** (significado exato de "MD" ainda não sei) |
| MA | 10.00 | 0407 | 10 | **confirmado** (significado exato de "MA" ainda não sei) |
| T1 | 50 | 0504/0604 (por bloco) | 50 | **confirmado** — provável nº de amostras de pré-trigger |

Também confirmado pela tela:
- **Eixo Y do gráfico real = velocidade (cm/s)**, não aceleração crua. O software
  integra o sinal do acelerômetro antes de plotar (legenda "Vel" no gráfico).
- **Eixo X do gráfico real = metros ao longo da estaca** (0 a ~9m = LE), não
  tempo/índice de amostra — convertido usando a velocidade de onda (WS): distância
  = tempo × WS / 2 (ida e volta), técnica padrão de PIT.
- Forma do sinal: subida rápida até pico (~0.27 cm/s perto de 1m), vale até
  ~-0.15 cm/s, e uma segunda subida perto de 9m marcada como "Toe" (reflexo na
  ponta da estaca) — sinal físico plausível e completo.

**Implicação pro parser**: a extração atual (bloco 0, float64 cru) ainda está em
unidade não-calibrada e no domínio de índice de amostra, não em cm/s × metros.
Próximo passo de verificação: integrar o sinal cru (assumindo que é aceleração) e
converter o eixo usando WS=4000 e a taxa de amostragem (50kHz) pra ver se a curva
resultante bate com esse gráfico de referência.

## Blocos de amostras — a parte importante

Depois do cabeçalho geral, o arquivo é dividido em **blocos repetidos**, cada bloco =
um mini-cabeçalho TLV (contém timestamp, índice, contador) + exatamente **1024
amostras float64 LE**.

Descoberta chave: **os blocos vêm em grupos de 4**. Dentro de cada grupo de 4:

- O **1º bloco do grupo** tem sinal real: 1024 amostras todas finitas, com
  amplitude grande (ordem de 10⁵–10¹⁰, provavelmente unidade bruta/não calibrada
  ainda, ou contagem crua do ADC × algum fator).
- Os **outros 3 blocos do grupo** são essencialmente vazios: maioria zero, com
  alguns `NaN` espalhados (~3-7% das amostras) — parecem canais reservados/não
  conectados no equipamento usado nesses ensaios.

Cada grupo de 4 blocos = **uma "batida" do martelo** (um golpe/repique). Contagem de
grupos por arquivo:

| arquivo | tamanho | grupos (batidas) |
|---|---|---|
| B135-EA.PTE | 136358 | 4 |
| B135-EC.PTE | 102324 | 3 |
| B136-EA.PTE | 136358 | 4 (a confirmar) |

Isso bate com a prática real: no ensaio o operador dá várias batidas na mesma
estaca e o software grava todas pra escolher a melhor depois.

## Validado em mais 9 arquivos reais (outra obra, prefixo "PF", equipamentos 1-4)

Rodei o parser/pipeline em 9 arquivos `.PTE` de outra obra (piles ~19-20m,
bem maiores que os 9.5m do B135/B136) — parser funcionou sem erro em todos,
sem precisar mudar nada no código. Revelou duas coisas que achávamos fixas
mas não são:

- **Taxa de amostragem (FS) varia por ensaio**: 132000-141000 Hz nesses
  arquivos (não os 50000 Hz fixos do B135/B136). Parece se ajustar ao
  comprimento da estaca (estacas maiores → taxa menor, pra caber a janela
  de captura no mesmo nº de amostras). Também notei que **FS = T1 × 1000**
  em todos os 9 arquivos — relação exata, provavelmente porque o
  pré-trigger é sempre "1ms de amostras", seja qual for a taxa.
- **Amostras por bloco também varia**: 2048 nesses arquivos (não 1024 fixo).
  Confirma que o parser já lê isso dinamicamente do próprio header — não
  precisou de nenhum ajuste de código.

**Achado que revisa uma suposição anterior**: no `PF02.PTE`, os **4 blocos
do primeiro grupo têm sinal real** (todos com amostras finitas, amplitude
grande) — não só o 1º como em todos os exemplos B135/B136 vistos até agora.
Ou seja, a regra "1 bloco real + 3 vazios por grupo de 4" **não é
universal** — depende de quantos canais físicos estavam conectados naquele
ensaio específico. Nos B135/B136 só 1 acelerômetro estava plugado; aqui
parece que os 4 slots eram canais realmente usados.

~~**Limitação atual do software**: como o app só expõe o 1º bloco de cada
grupo de 4 como "batida" (via `blowIndex*4`), arquivos como o PF02 escondem
os outros 3 blocos com dado real.~~ **CORRIGIDO** — o app agora detecta
canais com sensor (`availableChannels()`) e mostra um seletor de canal na
barra lateral quando a batida tem mais de um. Ver seção "os '3 blocos
vazios' às vezes NÃO são vazios" acima.

## O que falta confirmar

1. ~~Por que 4 blocos por batida, e por que só o 1º tem dado real~~
   **RESOLVIDO** — ver seção "os '3 blocos vazios' às vezes NÃO são vazios"
   acima. Confirmado por medição: são 4 slots de canal; os não usados contêm
   lixo (denormais + NaN), e quando um 2º sensor está plugado o slot traz
   medição real do mesmo golpe (correlação 0.91-0.99 com o principal).
2. Significado exato de cada campo numérico do cabeçalho geral (id 2 a 29) — cruzar
   com o relatório/tela do equipamento real.
3. Se a amplitude do bloco real já é a aceleração em alguma unidade, ou se precisa
   de fator de escala (usar os campos 040e=9.8 e 0415=resolução do ADC pra
   calibrar).
4. O trailer final do arquivo (poucos bytes, ainda não decodificado — não parece
   TLV, talvez checksum).

## RESOLVIDO — os "3 blocos vazios" às vezes NÃO são vazios (2º sensor)

A pergunta aberta "por que 4 blocos por batida, e por que só o 1º tem dado
real" está respondida, com medição. Rodando o parser real do app contra os 7
arquivos `samples/*.PTE` (suíte `software/test/regression.mjs`), os blocos
secundários caem em **duas categorias claramente distintas**:

| categoria | assinatura numérica | interpretação |
|---|---|---|
| canal desconectado | `\|max\| ≈ 3.26e-311` (**denormais**, não zeros) + 1-10% de NaN | lixo de memória não inicializada — sensor ausente |
| canal com sensor | **zero NaN**, 1024 amostras não-nulas, desvio padrão 1e5–1e6 | medição real |

Nota: a documentação antiga dizia que os canais vazios eram "maioria zero" —
não é o caso. São **denormais da ordem de 1e-311** (efetivamente zero pra
qualquer conta, mas bit-pattern de lixo, não zero limpo). Só importa pra quem
for escrever um detector: testar `== 0` não pega esses.

**Prova de que o canal secundário é o mesmo golpe** (não ruído): nos casos
encontrados, o pico do canal secundário cai **no mesmo índice de amostra** do
canal principal (116 vs 117, 113 vs 113, 56 vs 56) e a correlação de Pearson
entre os dois é **0.91 a 0.99**. Ou seja, é o mesmo impacto registrado por um
segundo sensor (prática padrão em PIT: 2 acelerômetros em lados opostos da
estaca pra cancelar efeito de flexão).

Ocorrências nos 7 arquivos: `B135-EE` (canal 2 na batida 0, canal 3 na
batida 1), `B135-R2` (canal 3 na batida 0), `B136-EA` (canal 3 na batida 1).
A razão de amplitude principal/secundário **não é constante** (1620, 5005,
6526) — consistente com sensores em posições/ganhos diferentes, não com uma
cópia reescalada do mesmo canal.

Um quarto caso (`B136-EA` batida 1 canal 3) tem correlação **-0.42** e pico em
índice diferente — não se encaixa no padrão. Pode ser outro tipo de canal ou
dado parcial; fica em aberto, mas não invalida os outros três.

### Ampliado para as outras obras (PF/ENCONTRO) — e o quadro muda

A análise acima usou só os 7 arquivos B135/B136, onde existem 4 canais extras.
Rodando o mesmo levantamento nos 10 arquivos das outras obras, que somam **28
canais extras**, aparecem duas diferenças importantes:

| obra | canais extras | razão principal/secundário | correlação com o principal |
|---|---|---|---|
| B135/B136 | 4 | **1620x a 25623x** | 0.91 a 0.99 (menos 1 caso: −0.42) |
| PF/ENCONTRO | 28 | **0.1x a 5.4x** | 0.99 a −0.48 (bem variável) |

1. **A razão de amplitude não generaliza.** Nos PF/ENCONTRO os canais extras
   têm a MESMA ordem de grandeza do principal — compatível com vários
   acelerômetros de ganho parecido, arranjo comum em estacas maiores (essas
   têm ~20m contra 9.5m das B135). A leitura "canal secundário é muito mais
   fraco" vale só para o arranjo usado no B135.

2. **Nem todo canal extra é o mesmo evento.** Vários têm correlação perto de
   zero ou negativa (PF02 ch1 = −0.08, PF19 ch1/ch2 ≈ −0.28, PF59 ch1 =
   −0.05, PF60 ch2 = −0.48, ENCONTRO b1 ch2 = −0.03), com o pico em índice de
   amostra bem diferente do principal. Não dá pra afirmar que todo slot
   ocupado é "o mesmo golpe visto de outro ponto".

**Consequência prática pro software**: não assumir comparabilidade entre
canais. É por isso que o app mantém canal secundário sempre em unidade
relativa e não sobrepõe curvas de canais diferentes no mesmo eixo.

**Impacto no software (corrigido)**: o app expunha só o bloco `blowIndex*4`,
ou seja, **descartava silenciosamente essa medição real**. Agora
`availableChannels()` detecta os canais com sensor e `processBlow()` aceita
`{ channel }`; a UI mostra um seletor de canal quando a batida tem mais de um.

## Achado novo — como o parser separa header de dados (sem campo explícito)

Descoberto construindo um gerador de `.PTE` sintético (`software/pte_writer.py`,
`software/electron/main.ts`) do zero pra testar o app sem hardware. O formato
**não tem nenhum marcador explícito de "fim do header, começo das amostras"**
— o parser (`parseTlvRun`) simplesmente continua interpretando bytes como
registros TLV até encontrar um padrão de bytes que não bate com nenhuma forma
válida (nem texto, nem numérico) — só aí ele para e assume que dali em diante
são amostras.

Isso funciona nos arquivos reais porque amostras de acelerômetro real quase
nunca têm bit-pattern "redondo" o suficiente pra acidentalmente parecer um
registro TLV válido. Mas ao **escrever** um `.PTE` (gerador sintético, ou
qualquer pipeline que converta captura crua em `.PTE`), isso vira uma pegadinha
séria: **qualquer amostra cujos 32 bits baixos da mantissa IEEE754 fiquem
zerados é lida como um registro TLV válido de tamanho zero** (`tag=0, len=0`),
fazendo o parser "vazar" do header pra dentro dos dados de amostra e corromper
a leitura do arquivo inteiro (contagem de blocos errada, sinal deslocado).

Isso não é só o caso óbvio de `0.0` exato — **qualquer valor inteiro "limpo"**
(ex: uma contagem crua de ADC, que é sempre um inteiro) tem os 32 bits baixos
da mantissa zerados por construção (não usa a mantissa toda pra representar um
número pequeno), então sofre da mesma colisão. Confirmado testando com 2000
amostras inteiras aleatórias — 100% delas corrompiam o parse até aplicar a
correção.

**Correção que funciona**: aplicar um jitter multiplicativo minúsculo em toda
amostra antes de gravar (`v * (1 ± 1e-6)`, com caso especial pra `v === 0`).
Isso preserva o valor fisicamente (erro relativo ~1 ppm, imperceptível no
gráfico) mas garante que os bytes IEEE754 nunca fiquem "redondos" o bastante
pra colidir com o parser. Implementado em `pte_writer.py` (`_perturb`) e
`main.ts` (`perturb`) — qualquer gerador novo de `.PTE` precisa da mesma regra.

## Ferramenta

`reverse-engineering/parse-pte.js` — parser Node que faz tudo isso automaticamente
e exporta `samples/<arquivo>.samples.csv` (colunas: bloco, índice, valor).

```
node reverse-engineering/parse-pte.js samples/B135-EA.PTE
```

## 0505 e 0506 — testados a fundo (resultado NEGATIVO, documentado pra não repetir)

Duas hipóteses atraentes sobre esses campos por-bloco foram testadas contra os
26 golpes dos 7 arquivos B135/B136. **As duas caem.**

### 0505 não é indicador de saturação

`0505` vale **exatamente 8388607 = 2²³−1** (fundo de escala do ADC de 24 bits)
em 5 dos 26 golpes. A leitura óbvia seria "clipping/overload". Não é:

- Os golpes com 0505 no fundo de escala têm amplitude **média 3x MENOR**
  (9.1e9) que os demais (2.9e10). Saturação daria o contrário.
- Nenhum golpe tem amostras acumuladas no extremo da faixa (o padrão de um
  sinal clipado) — no máximo 1 ou 2 amostras tocam o máximo, que é só o pico
  natural.
- Correlação 0505 × amplitude = **0.27** (fraca).

Observação lateral: **4 dos 5** golpes com 0505 no fundo de escala são
exatamente as batidas fracas já identificadas por outro caminho (B135-ED b1,
B135-R1 b1 e b3, B135-R2 b0). Compatível com "ganho automático no máximo
porque o sinal é fraco", mas o 5º caso (B135-EC b2) é um golpe forte, então
nem essa regra fecha. Segue não identificado.

### 0506 não é fator de calibração/ganho por batida

`0506` (ordem de 1e-10 a 1e-9) tem correlação **−0.75** com a amplitude do
sinal: golpe fraco → 0506 ~20x maior. Isso parece exatamente um fator de
compensação de ganho, e resolveria a calibração absoluta usando um campo que
já está no arquivo. Reforçando a impressão: multiplicar o pico por 0506 traz
as batidas fracas pra dentro da faixa das fortes.

**Mas o teste decisivo refuta.** Se 0506 fosse fator de calibração, aplicá-lo
tornaria os golpes fortes MAIS consistentes entre si. Medido nos 22 golpes
fortes:

| | dispersão | razão máx/mín |
|---|---|---|
| pico sem 0506 | **31.4%** | 3.60x |
| pico × 0506 | **70.2%** | 21.91x |

Aplicar 0506 **mais que dobra** a dispersão. É o oposto do que um fator de
calibração faria. Descartado.

### Efeito colateral útil: confirma que as batidas fracas são fracas mesmo

O mesmo teste mostra que os golpes fracos têm amplitude crua **19x menor** que
a média dos fortes, e que essa diferença **não** é artefato de ganho (senão
0506 a compensaria de forma consistente, o que não acontece). Ou seja: são
golpes de martelo genuinamente mais fracos — batidas de teste do operador —
e o aviso que o app mostra pra elas está bem fundamentado.

## Revisão dos campos com o 17º arquivo (3ª obra)

A tabela de campos não identificados foi refeita agora com **três obras**
(B135/B136, PF e ENCONTRO — esta última não existia na análise anterior):

| tag | B135/B136 | PF | ENCONTRO | conclusão |
|---|---|---|---|---|
| 0104 | 2 | 2 | 2 | constante universal |
| 040d | 2 | 2 | 2 | constante universal |
| 0412 | 0.00090718474 | idem | idem | constante universal |
| 041b | 23.56311957693693 | idem | idem | constante universal |
| 0415 | 5/2²⁴ | idem | idem | constante universal (resolução do ADC) |
| 0403 (WS) | 4000 | 4000 | 4000 | mesmo valor nas 3 obras |
| 0413 (área) | 0.19635 | 0.28274 | **0.15904** | **confirmado** — ver abaixo |
| 040e | 9.8 | 20 | 20 | fixo por obra |
| 040f | 8 | 4 | 4 | fixo por obra |
| 0407 (MA) | 10 | 20 | 20 | fixo por obra |
| 0406 | 3 | 3 ou 4 | 3 | varia dentro da obra |
| 0405 (MD) | 2 | 2 a 4.066 | 2 | varia dentro da obra |

**Ganho principal: 0413 = área da seção confirmado numa terceira obra.**
`0.15904 = π × 0.225²` exatamente (erro 0), ou seja **d = 0.45 m** — bitola
comercial padrão, assim como os 0.50 m e 0.60 m das outras duas. Três obras,
três diâmetros diferentes, três acertos exatos. Pode ser tratado como
resolvido.

**Observação sobre 040e (não conclusiva)**: nesta amostra 040e acompanha
`0407` (MA) — 9.8 com MA=10, e 20 com MA=20 nas duas outras obras. É
sugestivo, mas **não** é igualdade (9.8 ≠ 10), então não dá pra afirmar que
seja o mesmo parâmetro. Fica registrado como pista, não como conclusão. Com
mais obras dá pra decidir: se 040e for sempre "MA menos alguma coisa", ou
sempre igual a MA quando MA é 20, a relação aparece.

**Sem novidade em 0104, 040d, 0412 e 041b** — seguem constantes em todos os
17 arquivos de 3 obras, o que reforça serem constantes de firmware, não
configuração. Continuam sem significado identificado.
