# resolvedor-dns

Um resolvedor DNS escrito do zero sobre `node:dgram`, seguindo a RFC 1035:
montagem e leitura da mensagem, ponteiros de compressão, UDP com repetição e
volta para TCP quando a resposta não cabe. **Zero dependências.**

```bash
$ cavar one.one.one.one
one.one.one.one               80394  A      1.1.1.1
one.one.one.one               80394  A      1.0.0.1

$ cavar cloudflare.com mx
cloudflare.com                  953  MX     5 mxa-canary.global.inbound.cf-emailsecurity.net
cloudflare.com                  953  MX     10 mxa.global.inbound.cf-emailsecurity.net

$ cavar -x 1.1.1.1
1.1.1.1.in-addr.arpa            875  PTR    one.one.one.one

$ cavar github.com -r
;; id 21864  rcode 0 (sem erro)  44 bytes
;; pergunta
;   github.com  A
;; resposta
github.com                       16  A      4.228.31.150

$ cavar nao-existe-mesmo-12345.com
nao-existe-mesmo-12345.com: nome não existe
```

## Por que existe

DNS é a coisa que todo mundo usa mil vezes por dia e quase ninguém abriu. O
protocolo tem **doze bytes de cabeçalho** e cabe numa tarde — e três das suas
decisões explicam comportamentos que a gente aceita sem pensar.

### 1. Nomes não viajam com pontos

`www.exemplo.com` vai no fio assim:

```
3 w w w  7 e x e m p l o  3 c o m  0
```

Cada rótulo com o tamanho na frente, e um zero no fim. Esse zero é a **raiz** —
o ponto final que ninguém escreve em `www.exemplo.com.` mas que está sempre
lá. É por isso que existe a distinção entre nome absoluto e relativo, e por
isso que um rótulo cabe em 63 bytes e o nome inteiro em 255.

### 2. A compressão por ponteiro, e por que ela complica tudo

Uma resposta repete o mesmo domínio várias vezes: na pergunta, em cada
registro, em cada servidor autoritativo. Em 1987, com o pacote limitado a 512
bytes, isso importava muito. A solução foi deixar um rótulo **apontar para um
deslocamento anterior da mensagem**:

```
11xxxxxx xxxxxxxx    ← os dois bits altos marcam ponteiro,
                        os 14 restantes são o deslocamento
```

Duas consequências:

- **Não dá para ler um nome sem ter a mensagem inteira em mãos.** É por isso
  que a função de leitura aqui recebe a mensagem e um deslocamento, nunca só
  os bytes do campo.
- **Ponteiro pode virar laço.** Uma resposta maliciosa de 20 bytes com um
  ponteiro que aponta para si mesmo prende o processo para sempre. Este
  projeto recusa ponteiro para frente e ponteiro já visitado.

Há uma sutileza fácil de errar: ao seguir um ponteiro, a leitura continua
longe, mas **quem chamou consumiu só os 2 bytes do ponteiro**. Confundir os
dois desalinha o resto da mensagem inteira.

### 3. UDP não avisa quando dá errado

DNS clássico anda em UDP, sem conexão. O pacote sai e a resposta chega — ou
não chega, e ninguém avisa. Daí saem três exigências:

- **Prazo e repetição.** Não existe "conexão caiu": existe silêncio. Desistir
  na primeira tentativa transforma perda de pacote em "domínio não existe".
- **Conferir quem respondeu.** Sem conexão, qualquer máquina pode mandar um
  pacote fingindo ser o servidor. São quatro conferências — endereço, porta,
  `ID` e a pergunta ecoada — e elas são o que separa um resolvedor de um alvo
  fácil de envenenamento de cache. Dois testes aqui mandam resposta com ID
  errado e com pergunta errada, e exigem que sejam ignoradas.
- **Resposta grande pede TCP.** Quando não cabe, o servidor liga o bit `TC` e
  quem perguntou refaz por TCP — onde a mensagem ganha um prefixo de 2 bytes
  com o tamanho, porque TCP é um fluxo e não tem noção de "um pacote".

## A API

```js
import { resolver, consultar, montarPergunta, lerMensagem } from 'resolvedor-dns';

const { valores } = await resolver('exemplo.com', 'A');
// ['93.184.216.34']

const { valores: mx } = await resolver('exemplo.com', 'MX');
// [{ prioridade: 10, servidor: 'mail.exemplo.com' }]

// A mensagem inteira, seção por seção:
const resposta = await consultar('exemplo.com', 'A', {
  servidores: ['1.1.1.1', '8.8.8.8'],
  prazo: 3000,
  tentativas: 2,
});

// Ou só os bytes, sem rede nenhuma:
lerMensagem(montarPergunta('exemplo.com', 'MX'));
```

Tipos: `A`, `AAAA`, `CNAME`, `MX`, `TXT`, `NS`, `PTR`, `SOA`, `SRV`, `ANY`.

Quando a resposta traz só CNAME e nenhum registro do tipo pedido, `resolver`
devolve a `cadeia` em vez de uma lista vazia sem explicação.

## Linha de comando

```
cavar <nome> [tipo]     consulta (tipo padrão: A)
cavar -x <ip>           consulta reversa
cavar <nome> -r         mostra a mensagem crua, seção por seção

-s, --servidor <ip>   padrão 1.1.1.1 e 8.8.8.8
-p, --porta <n>       padrão 53
-t, --prazo <ms>      padrão 3000
--tcp                 força TCP
```

Código de saída `1` quando o nome não resolve, `2` em erro de uso.

## Estrutura

```
src/nomes.js     rótulos, compressão e a defesa contra ponteiro em laço
src/mensagem.js  cabeçalho, seções e a leitura de cada tipo de registro
src/cliente.js   UDP com repetição, conferência da resposta e volta para TCP
src/cli.js       no espírito do dig
```

## Rodando

```bash
npm test
```

64 testes. A maior parte roda contra um **servidor DNS de mentira local** —
que responde o que o teste mandar, inclusive resposta com ID trocado, com
outra pergunta dentro, e silêncio absoluto. Três testes falam com a internet
de verdade e comparam o resultado com o do `node:dns`: se os dois chegam no
mesmo endereço, a montagem e a leitura estão certas de ponta a ponta contra um
servidor que não é meu. Sem rede, esses três se anunciam como pulados.

Node 20 ou mais novo.

## Limites conhecidos

- **Não é um resolvedor recursivo.** Ele pergunta a um servidor que faz
  recursão (1.1.1.1, 8.8.8.8); não percorre a árvore a partir dos servidores
  raiz.
- **Sem cache.** Cada consulta vai pela rede, mesmo repetida. O TTL vem na
  resposta e é devolvido, mas nada o usa.
- **Sem DNSSEC.** Não valida assinatura nenhuma. Conferir `ID`, porta e
  pergunta dificulta a forja, mas não é a garantia criptográfica que o DNSSEC
  dá.
- **Sem EDNS(0)**, então sem pacote UDP acima de 512 bytes: resposta grande
  sempre passa por TCP.
- **Sem DoH nem DoT.** A consulta anda em claro, como o DNS clássico.
- Não monta resposta para servir DNS de verdade — `montarResposta` existe para
  os testes e para quem quiser experimentar.
- `SOA` e `SRV` são lidos, mas não há como montá-los.

## Licença

MIT.
