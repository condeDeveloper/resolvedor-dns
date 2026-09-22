/**
 * Nomes de domínio no fio.
 *
 * `www.exemplo.com` não viaja como texto com pontos. Viaja como uma sequência
 * de rótulos com o tamanho na frente:
 *
 *     3 w w w 7 e x e m p l o 3 c o m 0
 *
 * O zero final é a raiz — o ponto que ninguém escreve no fim de
 * `www.exemplo.com.` mas que está sempre lá.
 *
 * E aí vem a parte curiosa: a **compressão por ponteiro**. Uma resposta
 * repete o mesmo domínio muitas vezes (na pergunta, em cada resposta, em cada
 * servidor autoritativo). Em 1987, com pacotes limitados a 512 bytes, isso
 * importava muito. A solução foi permitir que um rótulo, em vez de conter
 * texto, aponte para um deslocamento anterior da mensagem:
 *
 *     11xxxxxx xxxxxxxx   →  os dois bits ligados marcam ponteiro,
 *                            os 14 restantes são o deslocamento
 *
 * É por isso que **não dá para ler um nome sem ter a mensagem inteira em
 * mãos**, e é por isso que um resolvedor precisa se defender de ponteiro que
 * aponta para si mesmo — senão uma resposta maliciosa de 20 bytes prende o
 * processo num laço infinito.
 */

/** Os dois bits altos ligados marcam um ponteiro. */
export const MARCA_DE_PONTEIRO = 0xc0;

/** Um rótulo cabe em 63 bytes; o nome inteiro, em 255. */
export const MAXIMO_DE_ROTULO = 63;
export const MAXIMO_DE_NOME = 255;

/** A mensagem não está no formato esperado. */
export class ErroDeMensagem extends Error {
  constructor(mensagem, deslocamento = null) {
    super(deslocamento === null ? mensagem : `${mensagem} (byte ${deslocamento})`);
    this.name = 'ErroDeMensagem';
    this.deslocamento = deslocamento;
  }
}

/** Normaliza: sem ponto no fim, em minúsculas. */
export function normalizar(nome) {
  return String(nome).replace(/\.$/, '').toLowerCase();
}

/** Escreve um nome no formato de rótulos. */
export function escreverNome(nome) {
  const limpo = normalizar(nome);

  if (limpo === '') return Buffer.from([0]);

  const partes = [];

  for (const rotulo of limpo.split('.')) {
    const bytes = Buffer.from(rotulo, 'utf8');

    if (bytes.length === 0) {
      throw new ErroDeMensagem(`O nome "${nome}" tem um rótulo vazio (dois pontos seguidos?).`);
    }

    if (bytes.length > MAXIMO_DE_ROTULO) {
      throw new ErroDeMensagem(`O rótulo "${rotulo}" tem ${bytes.length} bytes; o limite é ${MAXIMO_DE_ROTULO}.`);
    }

    partes.push(Buffer.from([bytes.length]), bytes);
  }

  partes.push(Buffer.from([0]));

  const inteiro = Buffer.concat(partes);

  if (inteiro.length > MAXIMO_DE_NOME) {
    throw new ErroDeMensagem(`O nome "${nome}" ocupa ${inteiro.length} bytes; o limite é ${MAXIMO_DE_NOME}.`);
  }

  return inteiro;
}

/**
 * Lê um nome, seguindo ponteiros de compressão.
 *
 * Devolve o nome e **quantos bytes foram consumidos no lugar original** — que
 * não é o mesmo que quantos bytes foram lidos: ao seguir um ponteiro, a
 * leitura continua longe, mas o cursor de quem chamou avança só os 2 bytes do
 * ponteiro.
 *
 * @param {Buffer} mensagem a mensagem inteira, porque o ponteiro precisa dela
 * @param {number} inicio
 */
export function lerNome(mensagem, inicio) {
  const rotulos = [];
  const visitados = new Set();

  let i = inicio;
  let consumido = null;

  for (;;) {
    if (i >= mensagem.length) throw new ErroDeMensagem('Nome truncado: a mensagem acabou', i);

    const tamanho = mensagem[i];

    if (tamanho === 0) {
      if (consumido === null) consumido = i + 1 - inicio;

      return { nome: rotulos.join('.'), consumido };
    }

    if ((tamanho & MARCA_DE_PONTEIRO) === MARCA_DE_PONTEIRO) {
      if (i + 1 >= mensagem.length) throw new ErroDeMensagem('Ponteiro truncado', i);

      const destino = ((tamanho & 0x3f) << 8) | mensagem[i + 1];

      // Depois do primeiro salto, o que a pessoa que chamou consumiu está
      // fixado: são os 2 bytes do ponteiro e mais nada.
      if (consumido === null) consumido = i + 2 - inicio;

      // Um ponteiro que aponta para frente ou para um lugar já visitado é a
      // receita do laço infinito. Uma resposta maliciosa de 20 bytes prenderia
      // o processo para sempre.
      if (destino >= i) throw new ErroDeMensagem(`Ponteiro para frente (${destino} >= ${i})`, i);

      if (visitados.has(destino)) throw new ErroDeMensagem(`Ponteiro em laço para ${destino}`, i);

      visitados.add(destino);
      i = destino;
      continue;
    }

    if ((tamanho & MARCA_DE_PONTEIRO) !== 0) {
      throw new ErroDeMensagem(`Rótulo com bits reservados ligados: 0x${tamanho.toString(16)}`, i);
    }

    if (i + 1 + tamanho > mensagem.length) throw new ErroDeMensagem('Rótulo passa do fim da mensagem', i);

    rotulos.push(mensagem.subarray(i + 1, i + 1 + tamanho).toString('utf8'));

    if (rotulos.join('.').length > MAXIMO_DE_NOME) {
      throw new ErroDeMensagem('Nome remontado passa de 255 bytes', i);
    }

    i += 1 + tamanho;
  }
}

/**
 * Escreve um nome usando compressão quando o sufixo já apareceu.
 *
 * @param {string} nome
 * @param {number} deslocamento onde este nome vai ficar na mensagem
 * @param {Map<string, number>} vistos sufixo → deslocamento onde ele começa
 */
export function escreverNomeComprimido(nome, deslocamento, vistos) {
  const limpo = normalizar(nome);

  if (limpo === '') return Buffer.from([0]);

  const rotulos = limpo.split('.');
  const partes = [];

  let atual = deslocamento;

  for (let i = 0; i < rotulos.length; i += 1) {
    const sufixo = rotulos.slice(i).join('.');
    const jaEscrito = vistos.get(sufixo);

    if (jaEscrito !== undefined && jaEscrito < MARCA_DE_PONTEIRO << 8) {
      const ponteiro = Buffer.alloc(2);

      ponteiro.writeUInt16BE(0xc000 | jaEscrito, 0);
      partes.push(ponteiro);

      return Buffer.concat(partes);
    }

    vistos.set(sufixo, atual);

    const bytes = Buffer.from(rotulos[i], 'utf8');

    partes.push(Buffer.from([bytes.length]), bytes);
    atual += 1 + bytes.length;
  }

  partes.push(Buffer.from([0]));

  return Buffer.concat(partes);
}
