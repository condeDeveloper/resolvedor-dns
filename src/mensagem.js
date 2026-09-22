/**
 * A mensagem DNS (RFC 1035 §4).
 *
 * Doze bytes de cabeçalho e quatro seções. Tudo em big-endian, tudo com
 * tamanho fixo menos os nomes.
 *
 *     ID          16 bits — o mesmo na pergunta e na resposta
 *     QR OPCODE AA TC RD RA Z RCODE   — 16 bits de bandeiras
 *     QDCOUNT ANCOUNT NSCOUNT ARCOUNT — quantas entradas em cada seção
 *
 * O `ID` merece atenção: como o DNS clássico anda em UDP, sem conexão, é
 * **ele** que amarra a resposta à pergunta. Um resolvedor que não confere o
 * ID (e a porta, e a pergunta) aceita a primeira resposta que chegar de
 * qualquer um — que é a base do envenenamento de cache.
 */

import { ErroDeMensagem, escreverNome, escreverNomeComprimido, lerNome, normalizar } from './nomes.js';

/** Tipos de registro que este projeto entende. */
export const TIPOS = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  ANY: 255,
};

/** Nome a partir do número. */
export const NOMES_DE_TIPO = Object.fromEntries(Object.entries(TIPOS).map(([nome, n]) => [n, nome]));

/** Classe: na prática só existe a da internet. */
export const CLASSE_IN = 1;

/** Códigos de resposta do servidor. */
export const RCODE = {
  0: 'sem erro',
  1: 'pergunta malformada',
  2: 'falha no servidor',
  3: 'nome não existe',
  4: 'não implementado',
  5: 'recusado',
};

/** O cabeçalho tem sempre 12 bytes. */
export const CABECALHO = 12;

/** Monta o cabeçalho a partir das bandeiras. */
export function montarCabecalho({ id, resposta = false, opcode = 0, recursao = true, rcode = 0, contagens }) {
  const bytes = Buffer.alloc(CABECALHO);

  bytes.writeUInt16BE(id, 0);

  let bandeiras = 0;

  if (resposta) bandeiras |= 0x8000;

  bandeiras |= (opcode & 0xf) << 11;

  if (recursao) bandeiras |= 0x0100;

  bandeiras |= rcode & 0xf;

  bytes.writeUInt16BE(bandeiras, 2);
  bytes.writeUInt16BE(contagens.perguntas ?? 0, 4);
  bytes.writeUInt16BE(contagens.respostas ?? 0, 6);
  bytes.writeUInt16BE(contagens.autoridades ?? 0, 8);
  bytes.writeUInt16BE(contagens.extras ?? 0, 10);

  return bytes;
}

/** Lê o cabeçalho. */
export function lerCabecalho(mensagem) {
  if (mensagem.length < CABECALHO) {
    throw new ErroDeMensagem(`Mensagem com ${mensagem.length} bytes; o cabeçalho sozinho tem ${CABECALHO}`);
  }

  const bandeiras = mensagem.readUInt16BE(2);

  return {
    id: mensagem.readUInt16BE(0),
    resposta: (bandeiras & 0x8000) !== 0,
    opcode: (bandeiras >> 11) & 0xf,
    autoritativa: (bandeiras & 0x0400) !== 0,
    // `truncada` é o que manda o cliente refazer a pergunta por TCP: a
    // resposta não coube nos 512 bytes do UDP clássico.
    truncada: (bandeiras & 0x0200) !== 0,
    recursaoPedida: (bandeiras & 0x0100) !== 0,
    recursaoDisponivel: (bandeiras & 0x0080) !== 0,
    rcode: bandeiras & 0xf,
    contagens: {
      perguntas: mensagem.readUInt16BE(4),
      respostas: mensagem.readUInt16BE(6),
      autoridades: mensagem.readUInt16BE(8),
      extras: mensagem.readUInt16BE(10),
    },
  };
}

/** Monta uma pergunta completa. */
export function montarPergunta(nome, tipo = 'A', { id = idAleatorio(), recursao = true } = {}) {
  const numero = typeof tipo === 'number' ? tipo : TIPOS[tipo];

  if (numero === undefined) throw new ErroDeMensagem(`Tipo de registro desconhecido: ${tipo}`);

  const corpo = Buffer.alloc(4);

  corpo.writeUInt16BE(numero, 0);
  corpo.writeUInt16BE(CLASSE_IN, 2);

  return Buffer.concat([
    montarCabecalho({ id, recursao, contagens: { perguntas: 1 } }),
    escreverNome(nome),
    corpo,
  ]);
}

/** Um identificador de 16 bits. */
export function idAleatorio() {
  return Math.floor(Math.random() * 0x10000);
}

/** Lê a mensagem inteira. */
export function lerMensagem(mensagem) {
  const cabecalho = lerCabecalho(mensagem);

  let i = CABECALHO;

  const perguntas = [];

  for (let n = 0; n < cabecalho.contagens.perguntas; n += 1) {
    const { nome, consumido } = lerNome(mensagem, i);

    i += consumido;

    if (i + 4 > mensagem.length) throw new ErroDeMensagem('Pergunta truncada', i);

    perguntas.push({ nome, tipo: NOMES_DE_TIPO[mensagem.readUInt16BE(i)] ?? mensagem.readUInt16BE(i), classe: mensagem.readUInt16BE(i + 2) });
    i += 4;
  }

  const secao = (quantidade) => {
    const registros = [];

    for (let n = 0; n < quantidade; n += 1) {
      const { registro, proximo } = lerRegistro(mensagem, i);

      registros.push(registro);
      i = proximo;
    }

    return registros;
  };

  return {
    ...cabecalho,
    perguntas,
    respostas: secao(cabecalho.contagens.respostas),
    autoridades: secao(cabecalho.contagens.autoridades),
    extras: secao(cabecalho.contagens.extras),
  };
}

/** Lê um registro de recurso. */
export function lerRegistro(mensagem, inicio) {
  const { nome, consumido } = lerNome(mensagem, inicio);

  let i = inicio + consumido;

  if (i + 10 > mensagem.length) throw new ErroDeMensagem('Registro truncado no cabeçalho', i);

  const tipo = mensagem.readUInt16BE(i);
  const classe = mensagem.readUInt16BE(i + 2);
  const ttl = mensagem.readUInt32BE(i + 4);
  const tamanho = mensagem.readUInt16BE(i + 8);

  i += 10;

  if (i + tamanho > mensagem.length) throw new ErroDeMensagem(`Dados do registro passam do fim da mensagem`, i);

  const dados = mensagem.subarray(i, i + tamanho);

  return {
    registro: {
      nome,
      tipo: NOMES_DE_TIPO[tipo] ?? tipo,
      classe,
      ttl,
      dados,
      valor: interpretar(NOMES_DE_TIPO[tipo], dados, mensagem, i),
    },
    proximo: i + tamanho,
  };
}

/** Traduz os dados do registro conforme o tipo. */
export function interpretar(tipo, dados, mensagem, inicio) {
  if (tipo === 'A') {
    if (dados.length !== 4) throw new ErroDeMensagem(`Registro A com ${dados.length} bytes; deveria ter 4`);

    return [...dados].join('.');
  }

  if (tipo === 'AAAA') {
    if (dados.length !== 16) throw new ErroDeMensagem(`Registro AAAA com ${dados.length} bytes; deveria ter 16`);

    return formatarIpv6(dados);
  }

  if (tipo === 'CNAME' || tipo === 'NS' || tipo === 'PTR') {
    // O nome aqui dentro pode ser um ponteiro para outro lugar da mensagem —
    // por isso `interpretar` precisa da mensagem inteira, não só dos dados.
    return lerNome(mensagem, inicio).nome;
  }

  if (tipo === 'MX') {
    return { prioridade: dados.readUInt16BE(0), servidor: lerNome(mensagem, inicio + 2).nome };
  }

  if (tipo === 'TXT') {
    // TXT é uma lista de pedaços, cada um com o tamanho na frente: um texto
    // acima de 255 bytes vem partido, e juntar tudo é o comportamento certo.
    const pedacos = [];

    let i = 0;

    while (i < dados.length) {
      const tamanho = dados[i];

      pedacos.push(dados.subarray(i + 1, i + 1 + tamanho).toString('utf8'));
      i += 1 + tamanho;
    }

    return pedacos.join('');
  }

  if (tipo === 'SRV') {
    return {
      prioridade: dados.readUInt16BE(0),
      peso: dados.readUInt16BE(2),
      porta: dados.readUInt16BE(4),
      alvo: lerNome(mensagem, inicio + 6).nome,
    };
  }

  if (tipo === 'SOA') {
    const principal = lerNome(mensagem, inicio);
    const responsavel = lerNome(mensagem, inicio + principal.consumido);
    const resto = inicio + principal.consumido + responsavel.consumido;

    return {
      principal: principal.nome,
      responsavel: responsavel.nome,
      serie: mensagem.readUInt32BE(resto),
      atualizacao: mensagem.readUInt32BE(resto + 4),
      novaTentativa: mensagem.readUInt32BE(resto + 8),
      expiracao: mensagem.readUInt32BE(resto + 12),
      minimo: mensagem.readUInt32BE(resto + 16),
    };
  }

  return dados;
}

/**
 * Formata um IPv6 com a maior sequência de zeros abreviada.
 *
 * A regra do RFC 5952: abrevia só a **maior** sequência, e só quando ela tem
 * pelo menos dois grupos. Abreviar qualquer uma geraria endereços diferentes
 * para o mesmo valor, e comparação por texto pararia de funcionar.
 */
export function formatarIpv6(bytes) {
  const grupos = [];

  for (let i = 0; i < 16; i += 2) grupos.push(bytes.readUInt16BE(i));

  let melhorInicio = -1;
  let melhorTamanho = 0;
  let inicio = -1;

  for (let i = 0; i <= grupos.length; i += 1) {
    if (i < grupos.length && grupos[i] === 0) {
      if (inicio < 0) inicio = i;
      continue;
    }

    if (inicio >= 0 && i - inicio > melhorTamanho) {
      melhorInicio = inicio;
      melhorTamanho = i - inicio;
    }

    inicio = -1;
  }

  const texto = grupos.map((g) => g.toString(16));

  if (melhorTamanho < 2) return texto.join(':');

  return `${texto.slice(0, melhorInicio).join(':')}::${texto.slice(melhorInicio + melhorTamanho).join(':')}`;
}

/** Monta uma resposta — usado nos testes e por quem quiser servir DNS. */
export function montarResposta({ id, pergunta, respostas = [], rcode = 0, autoritativa = false }) {
  const vistos = new Map();
  const partes = [
    montarCabecalho({
      id,
      resposta: true,
      rcode,
      contagens: { perguntas: 1, respostas: respostas.length },
    }),
  ];

  let deslocamento = CABECALHO;

  const nomeDaPergunta = escreverNomeComprimido(pergunta.nome, deslocamento, vistos);

  partes.push(nomeDaPergunta);
  deslocamento += nomeDaPergunta.length;

  const cauda = Buffer.alloc(4);

  cauda.writeUInt16BE(TIPOS[pergunta.tipo] ?? pergunta.tipo, 0);
  cauda.writeUInt16BE(CLASSE_IN, 2);
  partes.push(cauda);
  deslocamento += 4;

  for (const registro of respostas) {
    const nome = escreverNomeComprimido(registro.nome ?? pergunta.nome, deslocamento, vistos);
    const dados = montarDados(registro);
    const meio = Buffer.alloc(10);

    meio.writeUInt16BE(TIPOS[registro.tipo] ?? registro.tipo, 0);
    meio.writeUInt16BE(CLASSE_IN, 2);
    meio.writeUInt32BE(registro.ttl ?? 300, 4);
    meio.writeUInt16BE(dados.length, 8);

    partes.push(nome, meio, dados);
    deslocamento += nome.length + 10 + dados.length;
  }

  void autoritativa;

  return Buffer.concat(partes);
}

/**
 * Monta os dados de um registro para a resposta.
 *
 * Bytes crus valem para qualquer tipo e vêm primeiro: é o que permite montar
 * um registro malformado de propósito para testar o leitor.
 */
export function montarDados(registro) {
  if (Buffer.isBuffer(registro.valor)) return registro.valor;

  if (registro.tipo === 'A') return Buffer.from(registro.valor.split('.').map(Number));

  if (registro.tipo === 'CNAME' || registro.tipo === 'NS' || registro.tipo === 'PTR') {
    return escreverNome(registro.valor);
  }

  if (registro.tipo === 'TXT') {
    const bytes = Buffer.from(registro.valor, 'utf8');
    const pedacos = [];

    for (let i = 0; i < bytes.length; i += 255) {
      const pedaco = bytes.subarray(i, i + 255);

      pedacos.push(Buffer.from([pedaco.length]), pedaco);
    }

    return Buffer.concat(pedacos.length > 0 ? pedacos : [Buffer.from([0])]);
  }

  if (registro.tipo === 'MX') {
    const prioridade = Buffer.alloc(2);

    prioridade.writeUInt16BE(registro.valor.prioridade, 0);

    return Buffer.concat([prioridade, escreverNome(registro.valor.servidor)]);
  }


  throw new ErroDeMensagem(`Não sei montar dados de ${registro.tipo}`);
}

/** Confere se a resposta é mesmo desta pergunta. */
export function respondeA(resposta, pergunta) {
  if (resposta.id !== pergunta.id) return false;
  if (!resposta.resposta) return false;

  const dele = resposta.perguntas[0];

  if (!dele) return false;

  return normalizar(dele.nome) === normalizar(pergunta.nome) && dele.tipo === pergunta.tipo;
}
