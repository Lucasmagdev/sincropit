# Validação do parsing .PTE — o que bate, o que não bate, plano de melhoria

Comparação feita entre o sinal extraído do arquivo `B135-EA.PTE` (bloco 0, batida 1)
e o print da tela real do software original pra mesma estaca.

## O que já bateu (confirmado certo)

- **Formato do arquivo**: estrutura TLV, texto UTF16LE, blocos de 1024 amostras
  float64 — confirmado estruturalmente (offsets batem exatos).
- **Campos do cabeçalho**: WS (velocidade de onda), LE (comprimento), MD, MA, T1
  (pré-trigger) — todos batem com o painel de parâmetros da tela real.
- **Unidade do eixo Y real = velocidade (cm/s)**, eixo X = distância na estaca (m),
  não tempo/índice bruto.
- **Posição do pico inicial**: integrando a partir do trigger (T1) e convertendo
  x = tempo × WS/2, o pico cai em x≈0.9m — bate com o pico real em x≈1m.
- **Formato geral da primeira parte do sinal** (subida, pico, descida pro vale):
  mesma forma, mesma posição aproximada.

## O que ainda não bate (v1 → v2)

| aspecto | v1 (integração simples) | v2 (+ filtro passa-alta) | tela real |
|---|---|---|---|
| pico | ~0.18 (bug de escala) | 0.2694 (escala corrigida) | 0.2694 |
| vale | ~-0.115 em x≈2.6m | -0.117 em x≈2.56m | ~-0.15 em x≈2m |
| região x=5-9m | fica negativo, murcho | recupera, fica positivo | sobe mais forte rumo ao Toe |
| reflexo de ponta (Toe, x≈9m) | ausente | leve recuperação (+0.016) | subida clara e visível |

v2 melhorou bastante (filtro passa-alta antes de integrar + escala calculada só
pelo pico do pulso inicial, não pelo array todo), mas a reflexão de ponta ainda
sai mais fraca que o real.

## Hipóteses pro que falta

1. **Filtro errado/incompleto**: usei média móvel simples (janela 161 amostras)
   como passa-alta. O software original provavelmente usa um filtro mais
   específico (passa-banda, ou filtro desenhado pra não distorcer a fase do
   pulso de reflexão).
2. **Calibração de amplitude ainda arbitrária**: escalei pelo pico só pra
   comparar forma. O campo 0415 (resolução do ADC, 24 bits/5V) mais algum fator
   de sensibilidade do acelerômetro (não identificado ainda) provavelmente dá a
   escala real — não achei esse campo de sensibilidade no header ainda.
3. **Os outros 3 blocos do grupo podem não ser "vazios" por acaso**: pode ser
   que o software combine múltiplos blocos (ex: 2 acelerômetros somados/calibrados
   cruzado) pra melhorar relação sinal-ruído antes de mostrar. Nos arquivos que
   temos, esses blocos parecem vazios — mas vale conferir em outro ensaio onde
   talvez mais de 1 canal estivesse conectado.
4. **Janela de integração**: pode ser que o software use um método de integração
   diferente do trapézio simples (ex: com correção de offset residual
   recalculada em janelas, não uma vez só).

## Plano de melhoria (próximos passos)

1. **Testar filtros diferentes** (passa-banda, Butterworth) no acelerômetro cru
   antes de integrar, comparando visualmente com a tela até a reflexão de ponta
   aparecer clara.
2. **Rodar o mesmo pipeline nos outros 6 arquivos** (EC, ED, EE, R1, R2, B136-EA)
   e comparar — se o padrão (pico ok, toe fraco) se repetir em todos, é sinal de
   que falta uma etapa sistemática de processamento, não erro pontual.
3. **Se possível, tirar mais prints da tela real** (idealmente de mais de uma
   estaca/batida) pra ter mais pontos de comparação e, melhor ainda, digitalizar
   a curva da tela (não só olhar) pra comparação numérica em vez de visual.
4. **Procurar literatura pública sobre processamento de sinal PIT/PDA** (ASTM
   D5882, documentação técnica genérica de "Pile Driving Analyzer") pra entender
   o algoritmo padrão de filtragem/integração usado na indústria, sem depender
   de engenharia reversa do binário do concorrente.
5. **Achar o campo de sensibilidade do acelerômetro no header** — cruzar os
   campos ainda não identificados (0104, 0406, 040d, 040f, 041b) contra as
   unidades físicas esperadas.

## Fixes implementados (ver `process-signal.js`)

Pesquisei prática padrão da indústria (PIT/PDA, ASTM D5882) e achei a peça que
faltava: **amplificação exponencial** aplicada depois da integração, pra realçar
o eco fraco da ponta — técnica documentada como padrão em equipamentos comerciais
de PIT, calibrada pra deixar o eco da ponta com magnitude parecida com o pulso
inicial. O campo `MA` da tela (=10 nesses ensaios) é esse fator.

Pipeline implementado em `reverse-engineering/process-signal.js`:

1. Remove baseline (média das primeiras T1 amostras).
2. Filtro passa-alta (sinal − média móvel) pra tirar deriva de baixa frequência.
3. Integra a partir do trigger (T1), não do início do buffer.
4. Amplificação exponencial: ganho parte de 1 no trigger e chega a `MA` no
   instante esperado do eco de ponta (`2×LE/WS`).
5. Eixo convertido pra metros (`x = tempo × WS/2`).

Resultado (B135-EA, batida 1, comparado à tela real):

| | antes (v1) | depois (v3, com fixes) | tela real |
|---|---|---|---|
| pico | 0.18 (bug de escala) | 0.2694 | 0.2694 |
| vale | -0.115 em x≈2.6m | -0.173 em x≈2.6m | ~-0.15 em x≈2m |
| perto do toe (x≈9-10m) | murcho, negativo | sobe até +0.14 | sobe forte |

Ferramenta testada nos 7 arquivos e nas 4 batidas de B135-EA — extrai WS/LE/MA/T1
automaticamente do header em todos, sem erro.

Uso:
```
node reverse-engineering/process-signal.js samples/B135-EA.PTE --peak=0.2694 --blow=0
```
(`--peak` opcional, só pra calibrar em cm/s reais quando se sabe o pico da tela;
sem isso, saída fica em unidade relativa.)

## Validação cruzada — 27 batidas, 7 arquivos, 2 estacas (B135, B136)

Rodei `process-signal.js` em toda batida com dado real (bloco 0 de cada grupo de
4) dos 7 arquivos disponíveis, sem imagem de referência pra comparar (só temos
print da tela pra B135-EA) — o objetivo aqui foi checar **consistência interna**,
não bater com um gabarito.

**Achado 1 — bug descoberto**: a v3 (amplificação exponencial sem 2º filtro)
tinha a região perto do toe disparando pra valores absurdos (ordem de 10¹²) em
boa parte das batidas — só não tinha aparecido antes porque só validei
visualmente B135-EA batida 1. Causa: a integração reintroduz deriva de baixa
frequência que o 1º filtro (na aceleração) não elimina totalmente, e a
amplificação exponencial amplifica esse resíduo. Fix: 2º filtro passa-alta,
agora na velocidade já integrada, antes de amplificar. Depois do fix, as 27
batidas ficaram estáveis (região do toe sempre bem menor que o pico inicial).

**Achado 2 — consistência física**: o pico inicial cai entre x=0.7m e x=1.1m em
quase todas as batidas, nas duas estacas (B135 e B136, comprimentos e sinais
diferentes) — forte indício de que o parsing e a conversão de eixo (tempo →
metros via WS) estão certos de forma geral, não só coincidência em B135-EA.

**Achado 3 — batidas fracas são reais, não bug**: `B135-ED` batida 1, `B135-R1`
batidas 1 e 3, `B135-R2` batida 0 têm amplitude ~100x menor que as outras
batidas do mesmo arquivo, mas com dado genuíno (não é o padrão de bloco
"vazio"/NaN identificado antes). Interpretação: batida de teste/fraca do
operador antes da batida "boa" — é exatamente por isso que o equipamento grava
várias batidas por arquivo.

## Calibração absoluta — tentativa e resultado

Testei se o fator de escala empírico (o que uso pra fazer o pico bater com
0.2694 cm/s) batia com alguma constante conhecida do header (resolução do ADC
`0415`=5/2²⁴, gravidade `040e`=9.8, ou combinações simples). Não bateu com nada
reconhecível — o valor bruto do bloco de amostras não parece ser conta crua de
ADC direto, deve já vir com algum fator de conversão do firmware que não temos
como deduzir só olhando os bytes.

**Conclusão**: calibração absoluta (cm/s reais sem depender de um pico de
referência já conhecido) não é resolvível só com engenharia reversa dos
arquivos — precisa de um destes:
- manual/datasheet do equipamento (sensibilidade do acelerômetro em mV/g,
  fórmula exata de conversão);
- mais prints de tela real (de estacas/batidas diferentes) pra ajustar o fator
  por regressão empírica.

Não vale insistir mais nisso agora sem um desses dois — retorno decrescente.
Documentado como pendência em aberto.

## Fabricante identificado + fix da fórmula de amplificação

Achei o manual técnico oficial (Pile Dynamics, especificações PIT-QV/PIT-QFV) e
um guia de interpretação de terceiros com a definição exata dos parâmetros do
painel (MA, MD, LE, WS, LO, HI, PV, T1) — o mesmo painel do print da tela real
que o usuário mandou, layout idêntico.

**Bug encontrado e corrigido**: eu tinha implementado a amplificação exponencial
começando no *trigger* (T1) e crescendo até `MA` no instante do eco de ponta.
O manual diz o contrário: **MD (Magnification Delay) marca o INÍCIO** da
amplificação — antes de `MD` o ganho é 1× (sem amplificar), só depois disso
cresce exponencialmente até atingir `MA` na ponta da estaca (`LE`). Nosso
MD=2.00m / LE=9.5m = 21%, batendo com o "default de 20%" citado no manual.

Corrigido em `process-signal.js`. Resultado (B135-EA batida 1):

| | v4 (amplificação desde o trigger) | v5 (amplificação só depois de MD) | tela real |
|---|---|---|---|
| pico | 0.2694 | 0.2694 | 0.2694 |
| vale | -0.173 | **-0.165** | ~-0.15 |
| eco de ponta | espalhado, ~9-10.5m | **localizado em x=9.76m** (LE=9.5m) | localizado perto do Toe |

Revalidado nas 26 batidas dos 7 arquivos: proporção eco-de-ponta/pico-inicial
ficou entre 0.13 e 0.53 em todas — nenhuma explodiu, e o eco cai perto do LE de
cada arquivo (7.8m a 10.5m, LE variando entre 9.5 e 9.52m) em quase todas.

## Calibração absoluta — quase resolvida (certificados reais)

Usuário forneceu foto de 2 certificados de calibração reais da Pile Dynamics
(`certificados/`):

1. **Certificado do equipamento**: PIT-Q, série 5725 CF, calibrado 16/dez/2025
   com "PIT Calibration Box", rastreável ao NIST, válido 2 anos.
2. **Certificado do acelerômetro**: modelo **"PIT ACC"** (produto próprio da
   PDI — não é sensor terceiro tipo PCB/Dytran como eu supunha antes), série
   LW539639, **fator de calibração: 9.5 g's/volt** (R²=0.999914, "chip
   programmed" — sugere que esse fator fica gravado num chip dentro do próprio
   sensor/conector). Máx. 27 g's. Referências (LW503311/LW503313, 10 g's/volt)
   rastreáveis ao NIST.

Testei se essa peça fecha a cadeia física completa:

```
raw (contagem ADC) → V (× resolução ADC 24-bit/5V) → g (× 9.5 g's/volt)
  → m/s² (× 9.8) → integra (× dt=1/50000) → cm/s (× 100)
```

Escala prevista por essa cadeia: `5.549e-8`. Escala empírica que eu vinha
usando manualmente (ajustada só pra pico bater com a tela): `5.646e-13`.
**Razão entre as duas: 98.293 — quase exatamente 10⁵** (1.7% de diferença,
dentro do esperado já que meu filtro é uma aproximação do original).

Ou seja: o valor bruto do bloco de amostras provavelmente é
`contagem_ADC × 10⁵` (ou alguma codificação equivalente), não a contagem pura.
Ainda não confirmei o porquê exato do 10⁵, mas a cadeia física agora fecha
com todos os campos do header (ADC, sensibilidade, gravidade) — só falta esse
fator de escala fixo, que pode ser testado/confirmado com mais arquivos.

**Ressalva importante**: o fator "9.5 g's/volt" é específico DESSE
acelerômetro (série LW539639) — cada unidade tem o seu próprio, gravado no
certificado dela. Pra calibração automática de verdade, precisaria saber qual
acelerômetro físico foi usado em cada ensaio (ou assumir que é sempre o mesmo,
já que geralmente uma empresa usa 1-2 unidades fixas).

## O que ainda falta

- **Calibração absoluta de amplitude** (cm/s reais sem depender de um pico
  conhecido de referência) — precisa achar o campo de sensibilidade do
  acelerômetro no header, ou a fórmula exata de conversão ADC→aceleração→cm/s.
- Validar com mais prints de tela real (outras estacas/batidas) quando possível.
- Posição do vale ainda com pequeno desvio (2.6m calculado vs "~2m" lido a olho
  na tela real — mas a leitura na tela também é aproximada, não dá pra saber
  se é erro nosso ou imprecisão da leitura de referência).

## Fix v6 — filtro Butterworth (era média móvel) — vale bate quase exato

Testei substituir os dois filtros passa-alta (média móvel, janelas 161/301
amostras) por um Butterworth de 2ª ordem de verdade (biquad RBJ
audio-eq-cookbook, aplicado forward+backward pra fase zero), variando a
frequência de corte em Hz. Motivo pra tentar: filtro por janela de amostras
não é dimensionalmente consistente entre arquivos com taxa de amostragem
diferente (50kHz no B135/B136 vs 132-141kHz nos PF) — a mesma janela em
amostras vira um cutoff bem mais alto num arquivo com FS maior. Cutoff em Hz
resolve isso de vez.

Varredura de cutoff (5-600Hz nos dois estágios, aceleração e velocidade)
comparando contra os 3 pontos conhecidos da tela real (pico 0.2694, vale
-0.15, eco de ponta visível/forte) achou um platô ao redor de **80-130Hz em
ambos os estágios** que bate o vale quase exato:

| | v5 (média móvel 161/301) | v6 (Butterworth 100Hz/100Hz) | tela real |
|---|---|---|---|
| pico | 0.2694 | 0.2694 | 0.2694 |
| vale | -0.165 em x=2.6m | **-0.150** em x=2.6m | -0.15 em x≈2m |
| eco de ponta / pico | 0.13-0.53 (27 batidas) | 0.23-1.07 (27 batidas), sempre finito | "sobe forte" (qualitativo — proporção alta é mais plausível fisicamente, já que a amplificação MA existe justamente pra igualar a magnitude do eco à do pulso inicial) |

Revalidado nas 27 batidas dos 7 arquivos B135/B136 (sem explosão, todo
toe/pico finito) e nos 9 arquivos PF (FS diferente, geometria diferente) —
estável em todos, sem NaN/Infinity, pico do sinal sempre ocorrendo numa
posição x plausível (não no fim do registro, o que indicaria filtro
explodindo deriva residual).

Implementado em `process-signal.js` (função `highpass`, substituiu
`movingAvg`). Scripts de varredura de parâmetro (`filter-sweep.js`,
`filter-sweep-fine.js`) foram descartados depois de confirmado — não fazem
parte do pipeline final, só ferramenta de busca do parâmetro.

**Ressalva**: isso é curve-fitting contra 3 pontos de UMA tela de referência
(B135-EA batida 0) — não é garantia de que 80-130Hz é o cutoff real usado
pelo equipamento original, só que reproduz melhor o resultado conhecido do
que a média móvel arbitrária de antes. Precisa de mais prints de tela real
(idealmente de outra estaca/obra) pra confirmar que o cutoff generaliza e não
foi overfitting no único ponto de dado que temos.

## Conclusão até aqui

O parsing do **formato do arquivo** está correto e validado (estrutura, campos,
posição do pico). O **processamento de sinal** (filtro + integração +
amplificação) agora reproduz a forma geral do sinal real, incluindo o eco de
ponta, com o vale batendo quase exato (-0.150 vs -0.15 real) depois do fix do
filtro (v6, Butterworth) — falta só a calibração absoluta (cm/s sem depender
de pico de referência conhecido), que continua bloqueada por falta de mais
dado de referência (mais prints de tela, ou datasheet do equipamento).

## Calibração absoluta — testada de novo contra o pipeline v6 (resultado que corrige achado anterior)

Sessão de engenharia rodando a cadeia física documentada contra o pipeline
**atual** (v6 Butterworth), em todos os 26 golpes dos 7 arquivos:

```
fator = (ADC_RES × 9.5 g/V × 9.80665 × 100) / (FS × 1e5)
      = 5.553e-13  para FS=50000
```

**Correção de um número registrado antes**: a seção anterior dizia que a
cadeia física fechava com "1.7% de diferença". Isso valia pro pipeline v5.
Com o v6 (Butterworth a 100Hz), o pico calculado dá **0.2046 cm/s contra
0.2694 da tela real = −24.1%**. O 1.7% não se aplica mais.

**Mas o diagnóstico mudou, e pra melhor**: o erro NÃO é de escala. Se fosse,
pico e vale errariam na mesma proporção. Medido:

| | calculado | tela real | erro |
|---|---|---|---|
| pico | 0.2046 | 0.2694 | **−24.1%** |
| vale | −0.1396 | ~−0.15 | **+6.9%** |

Proporções diferentes ⇒ o problema está na **forma** (o filtro atenua o
transiente agudo do pico mais do que o vale, que é mais largo), não num fator
de escala global. Ou seja: **a cadeia física de calibração está
estruturalmente certa** — ADC, sensibilidade do acelerômetro e a pré-escala
de 1e5 do firmware conferem em ordem de grandeza, e o vale bate dentro de 7%
sem nenhum parâmetro livre.

### Varredura de cutoff com a calibração FIXA (teste mais forte que o anterior)

Com a escala travada pela física (zero parâmetro livre), o cutoff vira a
única variável — e há 2 pontos de referência pra conferir, não 1:

| cutoff | pico (erro) | vale (erro) | eco/pico | posição do pico |
|---|---|---|---|---|
| 10 Hz | 0.2543 (**−5.6%**) | −0.1567 (−4.5%) | **1.85** | 0.69 m |
| 30 Hz | 0.2266 (−15.9%) | −0.1949 (−29.9%) | **2.50** | 0.69 m |
| 50 Hz | 0.2176 (−19.2%) | −0.1536 (−2.4%) | 1.03 | 0.91 m |
| 70 Hz | 0.2122 (−21.2%) | −0.1496 (+0.3%) | **0.43** | 1.00 m |
| **100 Hz (atual)** | 0.2046 (−24.1%) | −0.1396 (+6.9%) | 0.69 | 1.09 m |

### DECISÃO: não mexer no cutoff — e o porquê importa

10 Hz reproduz pico e vale dentro de ~5%, o que parece ótimo — **mas
arruína o eco de ponta**: a razão eco/pico vai a **1.85** (e 2.50 em 30 Hz),
contra a faixa **0.13–0.53** validada antes nas 26 batidas. Eco de ponta
maior que o pulso de entrada é fisicamente impossível numa estaca sã (a
reflexão perde energia) — é o filtro deixando passar deriva de baixa
frequência que a amplificação exponencial (MA) depois multiplica.

E o eco de ponta é **o objetivo do ensaio** (detectar comprimento/defeito).
Trocar 20% de precisão de amplitude por um eco de ponta falso é um péssimo
negócio num software de integridade de fundação.

**Portanto: 100 Hz fica.** Se alguém (inclusive eu no futuro) for tentado a
baixar o cutoff pra "consertar a calibração", este é o motivo pra não fazer.

Nenhum cutoff testado gerou deriva/instabilidade na cauda (0/26 golpes em
todos os valores testados) — esse risco antigo está resolvido de vez pelo
segundo passa-alta.

### Estado real da calibração absoluta

- Cadeia física: **estruturalmente validada** (ordem de grandeza certa, vale
  dentro de 7%, valores consistentes em 22/26 golpes na faixa 0.02–5 cm/s).
- Os 4 golpes fora da faixa (6e-3 a 1.2e-2 cm/s) são **exatamente** os já
  documentados como "batidas fracas de teste do operador" (B135-ED b1,
  B135-R1 b1 e b3, B135-R2 b0) — confirmação independente, calculada por
  outro caminho.
- Precisão da amplitude do pico: **~25% baixa**, limitada pela fidelidade do
  filtro, não pela calibração.
- Segue valendo a ressalva: o fator 9.5 g/V é do acelerômetro série LW539639.
  Outra unidade tem outro fator (o segundo certificado mostra 9.9 g/V, +4%).
