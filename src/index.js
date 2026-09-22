/**
 * resolvedor-dns — DNS do zero sobre node:dgram, pela RFC 1035.
 */

export {
  ErroDeMensagem,
  MARCA_DE_PONTEIRO,
  MAXIMO_DE_NOME,
  MAXIMO_DE_ROTULO,
  escreverNome,
  escreverNomeComprimido,
  lerNome,
  normalizar,
} from './nomes.js';

export {
  CABECALHO,
  CLASSE_IN,
  NOMES_DE_TIPO,
  RCODE,
  TIPOS,
  formatarIpv6,
  idAleatorio,
  interpretar,
  lerCabecalho,
  lerMensagem,
  lerRegistro,
  montarCabecalho,
  montarDados,
  montarPergunta,
  montarResposta,
  respondeA,
} from './mensagem.js';

export { ErroDeConsulta, PADRAO, consultar, nomeReverso, perguntarTcp, perguntarUdp, resolver } from './cliente.js';
