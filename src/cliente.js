/**
 * O cliente.
 *
 * DNS clássico anda em UDP, sem conexão: o pacote sai e a resposta chega — ou
 * não chega, e ninguém avisa. Três consequências que este arquivo trata:
 *
 * 1. **Precisa de prazo e de repetição.** Não há "conexão caiu"; há silêncio.
 * 2. **Precisa conferir quem respondeu.** Sem conexão, qualquer máquina pode
 *    mandar um pacote fingindo ser o servidor. O `ID`, a porta de origem, o
 *    endereço e a pergunta ecoada são as quatro conferências que separam um
 *    resolvedor de um alvo fácil de envenenamento de cache.
 * 3. **Resposta grande pede TCP.** Quando não cabe no limite do UDP, o
 *    servidor liga o bit `TC` e quem perguntou precisa refazer por TCP — com
 *    um prefixo de 2 bytes com o tamanho, que o UDP não tem.
 */

import { createSocket } from 'node:dgram';
import { connect } from 'node:net';

import { ErroDeMensagem, normalizar } from './nomes.js';
import { RCODE, TIPOS, idAleatorio, lerMensagem, montarPergunta, respondeA } from './mensagem.js';

/** Servidores públicos, para quando nenhum for informado. */
export const PADRAO = ['1.1.1.1', '8.8.8.8'];

/** A consulta falhou. */
export class ErroDeConsulta extends Error {
  constructor(mensagem, codigo = 'falha') {
    super(mensagem);
    this.name = 'ErroDeConsulta';
    this.codigo = codigo;
  }
}

/**
 * Pergunta por UDP.
 *
 * @param {string} nome
 * @param {string} tipo
 * @param {{servidor?: string, porta?: number, prazo?: number, tentativas?: number, id?: number}} opcoes
 */
export function perguntarUdp(nome, tipo = 'A', opcoes = {}) {
  const servidor = opcoes.servidor ?? PADRAO[0];
  const porta = opcoes.porta ?? 53;
  const prazo = opcoes.prazo ?? 3000;
  const id = opcoes.id ?? idAleatorio();

  return new Promise((cumprir, rejeitar) => {
    const soquete = createSocket(servidor.includes(':') ? 'udp6' : 'udp4');
    const pergunta = montarPergunta(nome, tipo, { id });

    let terminou = false;

    const fim = (erro, valor) => {
      if (terminou) return;

      terminou = true;
      clearTimeout(relogio);
      soquete.close();

      if (erro) rejeitar(erro);
      else cumprir(valor);
    };

    const relogio = setTimeout(
      () => fim(new ErroDeConsulta(`${servidor} não respondeu em ${prazo} ms.`, 'prazo')),
      prazo,
    );

    soquete.on('error', (erro) => fim(erro));

    soquete.on('message', (pacote, origem) => {
      // Quem responde tem que ser quem foi perguntado. Sem isso, qualquer
      // máquina na rede pode mandar uma resposta forjada antes da verdadeira.
      if (origem.address !== servidor || origem.port !== porta) return;

      let lida;

      try {
        lida = lerMensagem(pacote);
      } catch (erro) {
        fim(erro);
        return;
      }

      // E o ID e a pergunta ecoada têm que bater; um pacote solto não serve.
      if (!respondeA(lida, { id, nome, tipo })) return;

      fim(null, { ...lida, bytes: pacote.length, servidor });
    });

    soquete.send(pergunta, porta, servidor, (erro) => {
      if (erro) fim(erro);
    });
  });
}

/**
 * Pergunta por TCP.
 *
 * A diferença no fio é um prefixo de 2 bytes com o tamanho da mensagem —
 * necessário porque TCP é um fluxo de bytes e não tem a noção de "um pacote".
 */
export function perguntarTcp(nome, tipo = 'A', opcoes = {}) {
  const servidor = opcoes.servidor ?? PADRAO[0];
  const porta = opcoes.porta ?? 53;
  const prazo = opcoes.prazo ?? 5000;
  const id = opcoes.id ?? idAleatorio();

  return new Promise((cumprir, rejeitar) => {
    const pergunta = montarPergunta(nome, tipo, { id });
    const prefixo = Buffer.alloc(2);

    prefixo.writeUInt16BE(pergunta.length, 0);

    const soquete = connect({ host: servidor, port: porta });

    let acumulado = Buffer.alloc(0);
    let terminou = false;

    const fim = (erro, valor) => {
      if (terminou) return;

      terminou = true;
      clearTimeout(relogio);
      soquete.destroy();

      if (erro) rejeitar(erro);
      else cumprir(valor);
    };

    const relogio = setTimeout(
      () => fim(new ErroDeConsulta(`${servidor} não respondeu em ${prazo} ms (TCP).`, 'prazo')),
      prazo,
    );

    soquete.on('error', (erro) => fim(erro));
    soquete.on('close', () => fim(new ErroDeConsulta('O servidor fechou antes de responder.', 'fechado')));

    soquete.on('connect', () => soquete.write(Buffer.concat([prefixo, pergunta])));

    soquete.on('data', (pedaco) => {
      acumulado = Buffer.concat([acumulado, pedaco]);

      if (acumulado.length < 2) return;

      const tamanho = acumulado.readUInt16BE(0);

      if (acumulado.length < 2 + tamanho) return;

      const pacote = acumulado.subarray(2, 2 + tamanho);

      try {
        fim(null, { ...lerMensagem(pacote), bytes: pacote.length, servidor, viaTcp: true });
      } catch (erro) {
        fim(erro);
      }
    });
  });
}

/**
 * Pergunta com repetição, troca de servidor e volta para TCP quando trunca.
 *
 * É o que um resolvedor de verdade faz: um pacote perdido em UDP não avisa
 * ninguém, então desistir na primeira tentativa transforma perda de pacote em
 * "domínio não existe".
 */
export async function consultar(nome, tipo = 'A', opcoes = {}) {
  const servidores = opcoes.servidores ?? (opcoes.servidor ? [opcoes.servidor] : PADRAO);
  const tentativas = opcoes.tentativas ?? 2;

  if (!(tipo in TIPOS)) throw new ErroDeConsulta(`Tipo desconhecido: ${tipo}.`, 'tipo');

  let ultimo = null;

  for (let volta = 0; volta < tentativas; volta += 1) {
    for (const servidor of servidores) {
      try {
        const resposta = await perguntarUdp(nome, tipo, { ...opcoes, servidor });

        if (resposta.truncada && opcoes.tcp !== false) {
          return await perguntarTcp(nome, tipo, { ...opcoes, servidor });
        }

        return resposta;
      } catch (erro) {
        ultimo = erro;
      }
    }
  }

  throw ultimo ?? new ErroDeConsulta('Nenhum servidor respondeu.', 'prazo');
}

/** Consulta e devolve só os valores do tipo pedido. */
export async function resolver(nome, tipo = 'A', opcoes = {}) {
  const resposta = await consultar(nome, tipo, opcoes);

  if (resposta.rcode !== 0) {
    throw new ErroDeConsulta(
      `O servidor respondeu ${RCODE[resposta.rcode] ?? `rcode ${resposta.rcode}`} para ${nome}.`,
      resposta.rcode === 3 ? 'inexistente' : 'servidor',
    );
  }

  // Um CNAME no meio do caminho é normal: a resposta traz a cadeia inteira, e
  // o que interessa são os registros do tipo pedido no fim dela.
  const doTipo = resposta.respostas.filter((r) => r.tipo === tipo);

  if (doTipo.length === 0 && resposta.respostas.length > 0) {
    const cadeia = resposta.respostas.filter((r) => r.tipo === 'CNAME').map((r) => r.valor);

    if (cadeia.length > 0) return { valores: [], cadeia, resposta };
  }

  return { valores: doTipo.map((r) => r.valor), cadeia: [], resposta };
}

/** Monta o nome reverso de um IPv4: 1.2.3.4 → 4.3.2.1.in-addr.arpa. */
export function nomeReverso(ip) {
  const partes = normalizar(ip).split('.');

  if (partes.length !== 4 || partes.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) {
    throw new ErroDeMensagem(`Não é um IPv4: ${ip}`);
  }

  return `${[...partes].reverse().join('.')}.in-addr.arpa`;
}
