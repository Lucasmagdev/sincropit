**Conjunto proposto para desenvolver um protótipo de PIT cabeado, sem solda:**

1. **Acelerômetro PCB 352C33:** mede a aceleração da estaca após a batida. Responde a vibrações de **0,5 Hz a 10 kHz**, com tolerância de ±5%, e mede acelerações de até **±50 g** (g é a aceleração da gravidade).
   Link: https://www.pcb.com/pt/produtos?m=352C33

2. **Cabo PCB 003C05:** liga o acelerômetro ao conversor. Tem **1,52 m**, com conectores **10-32 e BNC**, já montados.
   Link: https://www.pcb.com/pt/produtos?m=003c05

3. **Conversor USB PCB 485B39:** alimenta o acelerômetro e transforma seu sinal em dados para o computador. Captura até **48 mil amostras por segundo, com resolução de 24 bits**. É alimentado pelo USB.
   Link: https://www.pcb.com/pt/produtos?m=485B39

**Ligação:** acelerômetro → cabo → conversor USB → computador com Fpit.

**Diferença:** 10 kHz é a frequência da vibração que o sensor consegue acompanhar: 10 mil ciclos por segundo. As 48 mil amostras/s são os pontos que o conversor registra por segundo.

**Cotação no Brasil:** MTS Sistemas do Brasil — vendas@mtsbrasil.com.br — (11) 5501-5300. Solicitar também base/acoplamento para concreto e certificado de calibração. [Representante oficial](https://www.pcb.com/pt/sobre/contactar-nos/distribuidores-internacionais).

É uma proposta de protótipo: ainda exige integração ao Fpit e validação da medição frente ao PIT-Q. As especificações acima são dos modelos propostos; não representam requisitos mínimos universais de PIT.
