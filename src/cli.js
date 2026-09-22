#!/usr/bin/env node
/**
 * A linha de comando, no espírito do `dig`.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RCODE, TIPOS } from './mensagem.js';
import { ErroDeConsulta, PADRAO, consultar, nomeReverso } from './cliente.js';

const AJUDA = `resolvedor-dns — DNS do zero, no espírito do dig

  cavar <nome> [tipo]        consulta (tipo padrão: A)
  cavar -x <ip>              consulta reversa
  cavar <nome> -r            mostra a mensagem crua, seção por seção

  -s, --servidor <ip>   padrão ${PADRAO.join(' e ')}
  -p, --porta <n>       padrão 53
  -t, --prazo <ms>      padrão 3000
  --tcp                 força TCP em vez de UDP
  -h, --ajuda

Tipos: ${Object.keys(TIPOS).join(', ')}`;

/** Lê os argumentos. */
export function lerArgumentos(argumentos) {
  const opcoes = {
    nome: null,
    tipo: 'A',
    servidor: null,
    porta: 53,
    prazo: 3000,
    reverso: false,
    cru: false,
    tcp: false,
    ajuda: false,
  };

  const soltos = [];

  for (let i = 0; i < argumentos.length; i += 1) {
    const arg = argumentos[i];
    const proximo = () => {
      const valor = argumentos[++i];

      if (valor === undefined) throw new Error(`Faltou o valor depois de ${arg}.`);

      return valor;
    };

    if (arg === '-h' || arg === '--ajuda') opcoes.ajuda = true;
    else if (arg === '-x') opcoes.reverso = true;
    else if (arg === '-r' || arg === '--cru') opcoes.cru = true;
    else if (arg === '--tcp') opcoes.tcp = true;
    else if (arg === '-s' || arg === '--servidor') opcoes.servidor = proximo();
    else if (arg === '-p' || arg === '--porta') {
      opcoes.porta = Number(proximo());

      if (!Number.isInteger(opcoes.porta) || opcoes.porta < 1 || opcoes.porta > 65535) {
        throw new Error('A porta precisa estar entre 1 e 65535.');
      }
    } else if (arg === '-t' || arg === '--prazo') {
      opcoes.prazo = Number(proximo());

      if (!Number.isFinite(opcoes.prazo) || opcoes.prazo <= 0) throw new Error('O prazo precisa ser positivo.');
    } else if (arg.startsWith('-')) {
      throw new Error(`Opção desconhecida: ${arg}.`);
    } else {
      soltos.push(arg);
    }
  }

  opcoes.nome = soltos[0] ?? null;

  if (soltos[1] !== undefined) {
    const tipo = soltos[1].toUpperCase();

    if (!(tipo in TIPOS)) throw new Error(`Tipo desconhecido: ${soltos[1]}. Conheço ${Object.keys(TIPOS).join(', ')}.`);

    opcoes.tipo = tipo;
  }

  return opcoes;
}

/** Um registro em uma linha, no estilo do dig. */
export function linhaDe(registro) {
  const valor =
    typeof registro.valor === 'object' && registro.valor !== null && !Buffer.isBuffer(registro.valor)
      ? Object.values(registro.valor).join(' ')
      : String(registro.valor);

  return `${registro.nome.padEnd(28)} ${String(registro.ttl).padStart(6)}  ${registro.tipo.padEnd(6)} ${valor}`;
}

/** A resposta inteira, seção por seção. */
export function descrever(resposta, { cru = false } = {}) {
  const linhas = [];

  if (cru) {
    linhas.push(
      `;; id ${resposta.id}  rcode ${resposta.rcode} (${RCODE[resposta.rcode] ?? '?'})  ` +
        `${resposta.autoritativa ? 'autoritativa ' : ''}${resposta.truncada ? 'truncada ' : ''}` +
        `${resposta.viaTcp ? 'via TCP ' : ''}${resposta.bytes} bytes`,
    );
    linhas.push(';; pergunta');

    for (const p of resposta.perguntas) linhas.push(`;   ${p.nome}  ${p.tipo}`);
  }

  const secoes = [
    ['resposta', resposta.respostas],
    ['autoridade', resposta.autoridades],
    ['extras', resposta.extras],
  ];

  for (const [nome, registros] of secoes) {
    if (registros.length === 0) continue;
    if (!cru && nome !== 'resposta') continue;

    if (cru) linhas.push(`;; ${nome}`);

    for (const registro of registros) linhas.push(linhaDe(registro));
  }

  return linhas.join('\n');
}

/** Roda um comando e devolve o código de saída. */
export async function principal(argumentos, escrever = console.log, perguntar = consultar) {
  let opcoes;

  try {
    opcoes = lerArgumentos(argumentos);
  } catch (erro) {
    escrever(erro.message);
    return 2;
  }

  if (opcoes.ajuda || opcoes.nome === null) {
    escrever(AJUDA);
    return opcoes.ajuda ? 0 : 2;
  }

  let nome = opcoes.nome;
  let tipo = opcoes.tipo;

  if (opcoes.reverso) {
    try {
      nome = nomeReverso(opcoes.nome);
      tipo = 'PTR';
    } catch (erro) {
      escrever(erro.message);
      return 2;
    }
  }

  try {
    const resposta = await perguntar(nome, tipo, {
      servidor: opcoes.servidor,
      porta: opcoes.porta,
      prazo: opcoes.prazo,
      tcp: opcoes.tcp,
    });

    if (resposta.rcode !== 0) {
      escrever(`${nome}: ${RCODE[resposta.rcode] ?? `rcode ${resposta.rcode}`}`);

      return resposta.rcode === 3 ? 1 : 1;
    }

    const texto = descrever(resposta, { cru: opcoes.cru });

    escrever(texto || `${nome}: nenhum registro ${tipo}`);

    return 0;
  } catch (erro) {
    escrever(erro instanceof ErroDeConsulta ? `${erro.message} [${erro.codigo}]` : erro.message);
    return 1;
  }
}

/* c8 ignore start */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  principal(process.argv.slice(2)).then((codigo) => {
    process.exitCode = codigo;
  });
}
/* c8 ignore stop */
