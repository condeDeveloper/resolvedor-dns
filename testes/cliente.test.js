import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { promises as dns } from 'node:dns';
import { createServer } from 'node:net';
import { after, describe, it } from 'node:test';

import { lerMensagem, montarResposta } from '../src/mensagem.js';
import { ErroDeConsulta, consultar, perguntarTcp, perguntarUdp, resolver } from '../src/cliente.js';
import { descrever, lerArgumentos, linhaDe, principal } from '../src/cli.js';

const fechaveis = [];

/**
 * Um servidor DNS de mentira em UDP.
 *
 * Testar contra a internet de verdade deixa a suíte lenta e dependente de
 * rede; aqui o servidor é local e responde o que o teste mandar — inclusive
 * respostas erradas de propósito.
 */
function servidorFalso(responder) {
  return new Promise((cumprir) => {
    const soquete = createSocket('udp4');

    fechaveis.push(() => new Promise((pronto) => soquete.close(pronto)));

    soquete.on('message', (pacote, origem) => {
      const pergunta = lerMensagem(pacote);
      const resposta = responder(pergunta, pacote);

      if (resposta === null) return; // silêncio de propósito

      soquete.send(resposta, origem.port, origem.address);
    });

    soquete.bind(0, '127.0.0.1', () => cumprir({ soquete, porta: soquete.address().port }));
  });
}

/** O mesmo, em TCP, com o prefixo de 2 bytes. */
function servidorFalsoTcp(responder) {
  return new Promise((cumprir) => {
    const servidor = createServer((conexao) => {
      let acumulado = Buffer.alloc(0);

      conexao.on('data', (pedaco) => {
        acumulado = Buffer.concat([acumulado, pedaco]);

        if (acumulado.length < 2) return;

        const tamanho = acumulado.readUInt16BE(0);

        if (acumulado.length < 2 + tamanho) return;

        const resposta = responder(lerMensagem(acumulado.subarray(2, 2 + tamanho)));
        const prefixo = Buffer.alloc(2);

        prefixo.writeUInt16BE(resposta.length, 0);
        conexao.end(Buffer.concat([prefixo, resposta]));
      });
    });

    fechaveis.push(() => new Promise((pronto) => servidor.close(pronto)));

    servidor.listen(0, '127.0.0.1', () => cumprir({ servidor, porta: servidor.address().port }));
  });
}

/** Resposta padrão: um registro A. */
function respostaSimples(pergunta, valor = '203.0.113.10', trocas = {}) {
  return montarResposta({
    id: trocas.id ?? pergunta.id,
    pergunta: pergunta.perguntas[0],
    respostas: [{ nome: pergunta.perguntas[0].nome, tipo: 'A', ttl: 60, valor }],
    ...trocas,
  });
}

/** Há rede? Um teste de internet só faz sentido se houver. */
async function temRede() {
  try {
    await dns.resolve4('one.one.one.one');
    return true;
  } catch {
    return false;
  }
}

const SEM_REDE = (await temRede()) ? false : 'sem acesso à internet';

after(async () => {
  for (const fechar of fechaveis) await fechar();
});

describe('consulta contra um servidor local', () => {
  it('a resposta volta interpretada', async () => {
    const { porta } = await servidorFalso((pergunta) => respostaSimples(pergunta));

    const { valores } = await resolver('exemplo.com', 'A', { servidor: '127.0.0.1', porta });

    assert.deepEqual(valores, ['203.0.113.10']);
  });

  it('o nome que não existe vira erro com código próprio', async () => {
    const { porta } = await servidorFalso((pergunta) =>
      montarResposta({ id: pergunta.id, pergunta: pergunta.perguntas[0], rcode: 3 }),
    );

    const erro = await resolver('nao.existe', 'A', { servidor: '127.0.0.1', porta }).catch((e) => e);

    assert.ok(erro instanceof ErroDeConsulta);
    assert.equal(erro.codigo, 'inexistente');
    assert.match(erro.message, /nome não existe/);
  });

  it('resposta com id errado é ignorada, e a consulta expira', async () => {
    // É a defesa contra um pacote forjado chegando antes do verdadeiro.
    const { porta } = await servidorFalso((pergunta) => respostaSimples(pergunta, '1.1.1.1', { id: (pergunta.id + 1) & 0xffff }));

    const erro = await perguntarUdp('exemplo.com', 'A', { servidor: '127.0.0.1', porta, prazo: 300 }).catch((e) => e);

    assert.equal(erro.codigo, 'prazo');
  });

  it('resposta com outra pergunta dentro também é ignorada', async () => {
    const { porta } = await servidorFalso((pergunta) =>
      montarResposta({
        id: pergunta.id,
        pergunta: { nome: 'outro.com', tipo: 'A' },
        respostas: [{ nome: 'outro.com', tipo: 'A', valor: '1.1.1.1' }],
      }),
    );

    const erro = await perguntarUdp('exemplo.com', 'A', { servidor: '127.0.0.1', porta, prazo: 300 }).catch((e) => e);

    assert.equal(erro.codigo, 'prazo');
  });

  it('servidor calado estoura o prazo em vez de pendurar', async () => {
    const { porta } = await servidorFalso(() => null);

    const erro = await perguntarUdp('exemplo.com', 'A', { servidor: '127.0.0.1', porta, prazo: 200 }).catch((e) => e);

    assert.equal(erro.codigo, 'prazo');
    assert.match(erro.message, /não respondeu em 200 ms/);
  });

  it('consultar tenta o segundo servidor quando o primeiro cala', async () => {
    // Um pacote perdido em UDP não avisa ninguém; desistir na primeira
    // tentativa transforma perda de pacote em "domínio não existe".
    const mudo = await servidorFalso(() => null);
    const bom = await servidorFalso((pergunta) => respostaSimples(pergunta, '198.51.100.7'));

    const resposta = await consultar('exemplo.com', 'A', {
      servidores: ['127.0.0.1'],
      porta: mudo.porta,
      prazo: 150,
      tentativas: 1,
    }).catch(() => null);

    assert.equal(resposta, null);

    const segunda = await consultar('exemplo.com', 'A', { servidor: '127.0.0.1', porta: bom.porta, prazo: 500 });

    assert.equal(segunda.respostas[0].valor, '198.51.100.7');
  });

  it('a resposta truncada faz voltar para TCP', async () => {
    // O bit TC existe porque a resposta não coube no limite do UDP.
    const tcp = await servidorFalsoTcp((pergunta) => respostaSimples(pergunta, '192.0.2.99'));

    const udp = await servidorFalso((pergunta) => {
      const pacote = respostaSimples(pergunta);

      pacote.writeUInt16BE(pacote.readUInt16BE(2) | 0x0200, 2); // liga o TC

      return pacote;
    });

    const truncada = await perguntarUdp('exemplo.com', 'A', { servidor: '127.0.0.1', porta: udp.porta });

    assert.equal(truncada.truncada, true);

    const porTcp = await perguntarTcp('exemplo.com', 'A', { servidor: '127.0.0.1', porta: tcp.porta });

    assert.equal(porTcp.viaTcp, true);
    assert.equal(porTcp.respostas[0].valor, '192.0.2.99');
  });

  it('tipo desconhecido é recusado antes de sair pela rede', async () => {
    await assert.rejects(() => consultar('exemplo.com', 'XPTO'), /Tipo desconhecido/);
  });

  it('a cadeia de CNAME é devolvida quando não há o tipo pedido', async () => {
    const { porta } = await servidorFalso((pergunta) =>
      montarResposta({
        id: pergunta.id,
        pergunta: pergunta.perguntas[0],
        respostas: [{ nome: 'exemplo.com', tipo: 'CNAME', valor: 'destino.exemplo.com' }],
      }),
    );

    const { valores, cadeia } = await resolver('exemplo.com', 'A', { servidor: '127.0.0.1', porta });

    assert.deepEqual(valores, []);
    assert.deepEqual(cadeia, ['destino.exemplo.com']);
  });
});

describe('contra a internet de verdade', () => {
  it('o A de one.one.one.one bate com o do node:dns', { skip: SEM_REDE }, async () => {
    // O `node:dns` usa o resolvedor do sistema; se os dois chegam no mesmo
    // endereço, a montagem e a leitura da mensagem estão certas de ponta a
    // ponta — contra um servidor que não é meu.
    const { valores } = await resolver('one.one.one.one', 'A', { prazo: 5000 });
    const doSistema = await dns.resolve4('one.one.one.one');

    assert.ok(valores.length > 0, 'nenhum registro A voltou');
    assert.deepEqual([...valores].sort(), [...doSistema].sort());
  });

  it('um domínio com MX responde com prioridade e servidor', { skip: SEM_REDE }, async () => {
    const { valores } = await resolver('cloudflare.com', 'MX', { prazo: 5000 });

    assert.ok(valores.length > 0);
    assert.ok(Number.isInteger(valores[0].prioridade));
    assert.match(valores[0].servidor, /\./);
  });

  it('o AAAA volta como IPv6 abreviado', { skip: SEM_REDE }, async () => {
    const { valores } = await resolver('one.one.one.one', 'AAAA', { prazo: 5000 });

    assert.ok(valores.length > 0);
    assert.match(valores[0], /^[0-9a-f:]+$/);
  });
});

describe('linha de comando', () => {
  /** Roda a CLI com um consultador de mentira. */
  async function rodar(argumentos, perguntar) {
    const linhas = [];
    const codigo = await principal(argumentos, (l) => linhas.push(String(l)), perguntar);

    return { codigo, saida: linhas.join('\n') };
  }

  const respostaDeMentira = (extras = {}) => ({
    id: 1,
    rcode: 0,
    resposta: true,
    truncada: false,
    autoritativa: false,
    bytes: 50,
    perguntas: [{ nome: 'exemplo.com', tipo: 'A' }],
    respostas: [{ nome: 'exemplo.com', tipo: 'A', ttl: 300, valor: '203.0.113.10' }],
    autoridades: [],
    extras: [],
    ...extras,
  });

  it('lê os argumentos', () => {
    const opcoes = lerArgumentos(['exemplo.com', 'mx', '-s', '9.9.9.9', '-p', '5353', '-t', '900', '--tcp', '-r']);

    assert.equal(opcoes.nome, 'exemplo.com');
    assert.equal(opcoes.tipo, 'MX');
    assert.equal(opcoes.servidor, '9.9.9.9');
    assert.equal(opcoes.porta, 5353);
    assert.equal(opcoes.prazo, 900);
    assert.equal(opcoes.tcp, true);
    assert.equal(opcoes.cru, true);
  });

  it('recusa tipo, porta e prazo inválidos', () => {
    assert.throws(() => lerArgumentos(['a.com', 'xpto']), /Tipo desconhecido/);
    assert.throws(() => lerArgumentos(['a.com', '-p', '0']), /entre 1 e 65535/);
    assert.throws(() => lerArgumentos(['a.com', '-t', '0']), /precisa ser positivo/);
    assert.throws(() => lerArgumentos(['--inventada']), /desconhecida/);
    assert.throws(() => lerArgumentos(['a.com', '-s']), /Faltou o valor/);
  });

  it('mostra o registro numa linha', async () => {
    const { codigo, saida } = await rodar(['exemplo.com'], async () => respostaDeMentira());

    assert.equal(codigo, 0);
    assert.match(saida, /exemplo\.com\s+300\s+A\s+203\.0\.113\.10/);
  });

  it('o modo cru mostra as bandeiras e as seções', async () => {
    const { saida } = await rodar(['exemplo.com', '-r'], async () => respostaDeMentira());

    assert.match(saida, /;; id 1 {2}rcode 0 \(sem erro\)/);
    assert.match(saida, /;; pergunta/);
    assert.match(saida, /;; resposta/);
  });

  it('nome que não existe sai com 1', async () => {
    const { codigo, saida } = await rodar(['nao.existe'], async () => respostaDeMentira({ rcode: 3, respostas: [] }));

    assert.equal(codigo, 1);
    assert.match(saida, /nome não existe/);
  });

  it('a consulta reversa monta o in-addr.arpa', async () => {
    let pedido = null;

    await rodar(['192.0.2.1', '-x'], async (nome, tipo) => {
      pedido = { nome, tipo };

      return respostaDeMentira({ respostas: [] });
    });

    assert.deepEqual(pedido, { nome: '1.2.0.192.in-addr.arpa', tipo: 'PTR' });
  });

  it('IP inválido no reverso sai com 2', async () => {
    assert.equal((await rodar(['nao-e-ip', '-x'], async () => respostaDeMentira())).codigo, 2);
  });

  it('erro de rede sai com 1 e mostra o código', async () => {
    const { codigo, saida } = await rodar(['exemplo.com'], async () => {
      throw new ErroDeConsulta('ninguém respondeu.', 'prazo');
    });

    assert.equal(codigo, 1);
    assert.match(saida, /\[prazo\]/);
  });

  it('sem nome mostra a ajuda e sai com 2; --ajuda sai com 0', async () => {
    assert.equal((await rodar([], async () => {})).codigo, 2);
    assert.equal((await rodar(['--ajuda'], async () => {})).codigo, 0);
  });

  it('resposta sem registro nenhum é dita com todas as letras', async () => {
    const { codigo, saida } = await rodar(['exemplo.com'], async () => respostaDeMentira({ respostas: [] }));

    assert.equal(codigo, 0);
    assert.match(saida, /nenhum registro A/);
  });

  it('MX e SRV saem com os campos juntos na linha', () => {
    assert.match(
      linhaDe({ nome: 'a.com', ttl: 300, tipo: 'MX', valor: { prioridade: 10, servidor: 'mail.a.com' } }),
      /10 mail\.a\.com$/,
    );
  });

  it('descrever sem seções devolve texto vazio', () => {
    assert.equal(descrever(respostaDeMentira({ respostas: [] })), '');
  });
});
