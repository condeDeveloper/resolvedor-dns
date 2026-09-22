import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ErroDeMensagem,
  MARCA_DE_PONTEIRO,
  escreverNome,
  escreverNomeComprimido,
  lerNome,
  normalizar,
} from '../src/nomes.js';
import {
  CABECALHO,
  TIPOS,
  formatarIpv6,
  lerCabecalho,
  lerMensagem,
  montarPergunta,
  montarResposta,
  respondeA,
} from '../src/mensagem.js';
import { nomeReverso } from '../src/cliente.js';

describe('nomes no fio', () => {
  it('viram rótulos com o tamanho na frente e um zero no fim', () => {
    // O zero é a raiz: o ponto que ninguém escreve mas está sempre lá.
    assert.deepEqual([...escreverNome('www.exemplo.com')], [
      3, 119, 119, 119,
      7, 101, 120, 101, 109, 112, 108, 111,
      3, 99, 111, 109,
      0,
    ]);
  });

  it('a raiz é um byte zero', () => {
    assert.deepEqual([...escreverNome('')], [0]);
    assert.deepEqual([...escreverNome('.')], [0]);
  });

  it('vai e volta', () => {
    for (const nome of ['a', 'exemplo.com', 'www.exemplo.com.br', 'a.b.c.d.e.f']) {
      assert.equal(lerNome(escreverNome(nome), 0).nome, normalizar(nome));
    }
  });

  it('o ponto do fim e as maiúsculas não mudam nada', () => {
    assert.deepEqual(escreverNome('Exemplo.COM.'), escreverNome('exemplo.com'));
  });

  it('rótulo acima de 63 bytes e nome acima de 255 são recusados', () => {
    assert.throws(() => escreverNome(`${'a'.repeat(64)}.com`), /limite é 63/);
    assert.throws(() => escreverNome(Array.from({ length: 10 }, () => 'a'.repeat(50)).join('.')), /limite é 255/);
  });

  it('rótulo vazio no meio é recusado', () => {
    assert.throws(() => escreverNome('a..b'), /rótulo vazio/);
  });
});

describe('compressão por ponteiro', () => {
  it('o ponteiro tem os dois bits altos ligados e 14 de deslocamento', () => {
    const mensagem = Buffer.concat([
      Buffer.alloc(12), // um cabeçalho qualquer
      escreverNome('exemplo.com'), // em 12
      Buffer.from([0xc0, 12]), // ponteiro para 12
    ]);

    const direto = lerNome(mensagem, 12);
    const viaPonteiro = lerNome(mensagem, 12 + direto.consumido);

    assert.equal(direto.nome, 'exemplo.com');
    assert.equal(viaPonteiro.nome, 'exemplo.com');
    assert.equal(viaPonteiro.consumido, 2);
  });

  it('o consumido é o do lugar original, não o do destino', () => {
    // Ao seguir um ponteiro a leitura continua longe, mas quem chamou avança
    // só os 2 bytes do ponteiro. Confundir os dois desalinha a mensagem toda.
    const mensagem = Buffer.concat([escreverNome('muito.longo.exemplo.com'), Buffer.from([0xc0, 0])]);
    const { consumido } = lerNome(mensagem, mensagem.length - 2);

    assert.equal(consumido, 2);
  });

  it('o sufixo comum é comprimido na escrita', () => {
    const vistos = new Map();
    const primeiro = escreverNomeComprimido('www.exemplo.com', 12, vistos);
    const segundo = escreverNomeComprimido('mail.exemplo.com', 12 + primeiro.length, vistos);

    // "mail" cru (5 bytes) + ponteiro para "exemplo.com" (2 bytes).
    assert.equal(segundo.length, 7);
    assert.equal(segundo[5] & MARCA_DE_PONTEIRO, MARCA_DE_PONTEIRO);
  });

  it('o mesmo nome duas vezes vira ponteiro puro', () => {
    const vistos = new Map();

    escreverNomeComprimido('exemplo.com', 12, vistos);

    assert.equal(escreverNomeComprimido('exemplo.com', 40, vistos).length, 2);
  });

  it('ponteiro em laço é recusado em vez de travar o processo', () => {
    // Uma resposta maliciosa de 20 bytes prenderia o processo para sempre.
    const mensagem = Buffer.from([0xc0, 2, 0xc0, 0]);

    assert.throws(() => lerNome(mensagem, 2), ErroDeMensagem);
  });

  it('ponteiro que aponta para si mesmo é recusado', () => {
    assert.throws(() => lerNome(Buffer.from([0xc0, 0]), 0), /para frente/);
  });

  it('ponteiro para frente é recusado', () => {
    const mensagem = Buffer.concat([Buffer.from([0xc0, 10]), Buffer.alloc(20)]);

    assert.throws(() => lerNome(mensagem, 0), /para frente/);
  });

  it('nome truncado é recusado', () => {
    assert.throws(() => lerNome(Buffer.from([5, 97, 98]), 0), /passa do fim/);
    assert.throws(() => lerNome(Buffer.from([3, 97, 98, 99]), 0), /acabou/);
    assert.throws(() => lerNome(Buffer.from([0xc0]), 0), /truncado/);
  });

  it('bits reservados ligados são recusados', () => {
    // 0x80 e 0x40 sozinhos não são ponteiro nem tamanho válido.
    assert.throws(() => lerNome(Buffer.from([0x80, 0]), 0), /bits reservados/);
  });
});

describe('a pergunta', () => {
  it('tem 12 bytes de cabeçalho, o nome e mais 4', () => {
    const pergunta = montarPergunta('exemplo.com', 'A', { id: 0x1234 });

    assert.equal(pergunta.length, CABECALHO + escreverNome('exemplo.com').length + 4);
    assert.equal(pergunta.readUInt16BE(0), 0x1234);
  });

  it('pede recursão por padrão', () => {
    const lida = lerCabecalho(montarPergunta('exemplo.com'));

    assert.equal(lida.recursaoPedida, true);
    assert.equal(lida.resposta, false);
    assert.equal(lida.contagens.perguntas, 1);
  });

  it('dá para desligar a recursão', () => {
    assert.equal(lerCabecalho(montarPergunta('a.com', 'A', { recursao: false })).recursaoPedida, false);
  });

  it('o tipo pedido aparece na mensagem lida', () => {
    const lida = lerMensagem(montarPergunta('exemplo.com', 'MX'));

    assert.equal(lida.perguntas[0].nome, 'exemplo.com');
    assert.equal(lida.perguntas[0].tipo, 'MX');
  });

  it('tipo desconhecido é recusado', () => {
    assert.throws(() => montarPergunta('a.com', 'XPTO'), /Tipo de registro desconhecido/);
  });

  it('mensagem menor que o cabeçalho é recusada', () => {
    assert.throws(() => lerCabecalho(Buffer.alloc(5)), /o cabeçalho sozinho tem 12/);
  });
});

describe('a resposta', () => {
  it('registro A vira texto pontilhado', () => {
    const pacote = montarResposta({
      id: 1,
      pergunta: { nome: 'exemplo.com', tipo: 'A' },
      respostas: [{ nome: 'exemplo.com', tipo: 'A', ttl: 300, valor: '93.184.216.34' }],
    });

    const lida = lerMensagem(pacote);

    assert.equal(lida.respostas[0].valor, '93.184.216.34');
    assert.equal(lida.respostas[0].ttl, 300);
    assert.equal(lida.resposta, true);
  });

  it('CNAME, NS e PTR viram nomes', () => {
    for (const tipo of ['CNAME', 'NS', 'PTR']) {
      const pacote = montarResposta({
        id: 1,
        pergunta: { nome: 'a.com', tipo },
        respostas: [{ tipo, valor: 'destino.exemplo.com' }],
      });

      assert.equal(lerMensagem(pacote).respostas[0].valor, 'destino.exemplo.com');
    }
  });

  it('MX traz prioridade e servidor', () => {
    const pacote = montarResposta({
      id: 1,
      pergunta: { nome: 'a.com', tipo: 'MX' },
      respostas: [{ tipo: 'MX', valor: { prioridade: 10, servidor: 'mail.a.com' } }],
    });

    assert.deepEqual(lerMensagem(pacote).respostas[0].valor, { prioridade: 10, servidor: 'mail.a.com' });
  });

  it('TXT acima de 255 bytes vem partido e é remontado', () => {
    // Um texto grande não cabe num pedaço só; juntar tudo é o certo.
    const texto = 'x'.repeat(400);
    const pacote = montarResposta({
      id: 1,
      pergunta: { nome: 'a.com', tipo: 'TXT' },
      respostas: [{ tipo: 'TXT', valor: texto }],
    });

    assert.equal(lerMensagem(pacote).respostas[0].valor, texto);
  });

  it('o registro A com tamanho errado é recusado', () => {
    const pacote = montarResposta({
      id: 1,
      pergunta: { nome: 'a.com', tipo: 'A' },
      respostas: [{ tipo: 'A', valor: Buffer.from([1, 2, 3]) }],
    });

    assert.throws(() => lerMensagem(pacote), /deveria ter 4/);
  });

  it('o rcode vem traduzido', () => {
    const pacote = montarResposta({ id: 1, pergunta: { nome: 'nao.existe', tipo: 'A' }, rcode: 3 });

    assert.equal(lerMensagem(pacote).rcode, 3);
  });

  it('resposta truncada no meio de um registro é recusada', () => {
    const pacote = montarResposta({
      id: 1,
      pergunta: { nome: 'a.com', tipo: 'A' },
      respostas: [{ tipo: 'A', valor: '1.2.3.4' }],
    });

    assert.throws(() => lerMensagem(pacote.subarray(0, pacote.length - 2)), ErroDeMensagem);
  });
});

describe('conferir se a resposta é desta pergunta', () => {
  const pergunta = { id: 0xabcd, nome: 'exemplo.com', tipo: 'A' };

  const respostaDe = (trocas = {}) =>
    lerMensagem(
      montarResposta({
        id: trocas.id ?? pergunta.id,
        pergunta: { nome: trocas.nome ?? pergunta.nome, tipo: trocas.tipo ?? pergunta.tipo },
        respostas: [{ tipo: 'A', valor: '1.2.3.4' }],
      }),
    );

  it('aceita a resposta certa', () => {
    assert.equal(respondeA(respostaDe(), pergunta), true);
  });

  it('recusa id diferente', () => {
    // Sem isso, qualquer pacote solto que chegue na porta é aceito.
    assert.equal(respondeA(respostaDe({ id: 1 }), pergunta), false);
  });

  it('recusa nome e tipo diferentes', () => {
    assert.equal(respondeA(respostaDe({ nome: 'outro.com' }), pergunta), false);
    assert.equal(respondeA(respostaDe({ tipo: 'MX' }), pergunta), false);
  });

  it('recusa uma pergunta que chegou como se fosse resposta', () => {
    assert.equal(respondeA(lerMensagem(montarPergunta('exemplo.com', 'A', { id: pergunta.id })), pergunta), false);
  });

  it('o ponto do fim não atrapalha', () => {
    assert.equal(respondeA(respostaDe({ nome: 'exemplo.com.' }), pergunta), true);
  });
});

describe('IPv6', () => {
  it('abrevia a maior sequência de zeros', () => {
    const bytes = Buffer.alloc(16);

    bytes.writeUInt16BE(0x2001, 0);
    bytes.writeUInt16BE(0x0db8, 2);
    bytes.writeUInt16BE(0x0001, 14);

    assert.equal(formatarIpv6(bytes), '2001:db8::1');
  });

  it('só abrevia sequência de dois ou mais grupos', () => {
    // Abreviar qualquer uma geraria endereços diferentes para o mesmo valor.
    const bytes = Buffer.alloc(16);

    for (let i = 0; i < 8; i += 1) bytes.writeUInt16BE(i === 3 ? 0 : 1, i * 2);

    assert.equal(formatarIpv6(bytes), '1:1:1:0:1:1:1:1');
  });

  it('o endereço todo zero vira ::', () => {
    assert.equal(formatarIpv6(Buffer.alloc(16)), '::');
  });

  it('sem zeros nenhum grupo some', () => {
    const bytes = Buffer.alloc(16, 0x11);

    assert.equal(formatarIpv6(bytes), '1111:1111:1111:1111:1111:1111:1111:1111');
  });
});

describe('consulta reversa', () => {
  it('inverte os octetos e acrescenta in-addr.arpa', () => {
    assert.equal(nomeReverso('192.0.2.1'), '1.2.0.192.in-addr.arpa');
  });

  it('recusa o que não é IPv4', () => {
    assert.throws(() => nomeReverso('exemplo.com'), /Não é um IPv4/);
    assert.throws(() => nomeReverso('300.1.1.1'), /Não é um IPv4/);
    assert.throws(() => nomeReverso('1.2.3'), ErroDeMensagem);
  });
});

describe('os tipos conhecidos', () => {
  it('têm os números do padrão', () => {
    assert.equal(TIPOS.A, 1);
    assert.equal(TIPOS.CNAME, 5);
    assert.equal(TIPOS.MX, 15);
    assert.equal(TIPOS.TXT, 16);
    assert.equal(TIPOS.AAAA, 28);
  });
});
