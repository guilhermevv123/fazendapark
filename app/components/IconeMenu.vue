<script setup lang="ts">
/**
 * Ícones do menu, inline. São SVG à mão de propósito: puxar uma biblioteca de
 * ícone inteira pra 12 desenhos custa mais que os 12 desenhos.
 */
defineProps<{ nome: string; tamanho?: number }>()

const caminhos: Record<string, string> = {
  dashboard: 'M3 17l5-6 4 4 5-8 4 5',
  ingresso: 'M4 8a2 2 0 012-2h12a2 2 0 012 2v1a2 2 0 000 4v1a2 2 0 01-2 2H6a2 2 0 01-2-2v-1a2 2 0 000-4V8z M12 6v12',
  vendas: 'M12 3v18 M8 7h5a3 3 0 010 6H9a3 3 0 000 6h6',
  relatorio: 'M12 3a9 9 0 109 9h-9V3z M14 3.5A9 9 0 0120.5 10H14V3.5z',
  validacao: 'M4 5h6v6H4V5z M14 5h6v6h-6V5z M4 15h6v4H4v-4z M14 15h2v2h-2v-2z M18 19h2',
  financeiro: 'M3 7a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7z M3 10h18 M7 15h4',
  config: 'M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V21a2 2 0 11-4 0v-.1A1.6 1.6 0 007.9 19l-.1.1A2 2 0 115 16.3l.1-.1a1.6 1.6 0 00-1.1-2.7H3a2 2 0 110-4h.1A1.6 1.6 0 005 6.9L4.9 6.8A2 2 0 117.7 4l.1.1a1.6 1.6 0 002.7-1.1V3a2 2 0 114 0v.1A1.6 1.6 0 0016.1 5l.1-.1A2 2 0 1119 7.7l-.1.1a1.6 1.6 0 001.1 2.7H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z',
  mapa: 'M5 19V9a2 2 0 012-2h10a2 2 0 012 2v10 M5 19h14 M8 19v-4h8v4 M9 7V5h6v2',
  // caixa registradora: corpo, teclado e a gaveta que é do que a tela trata
  bilheteria: 'M3 21h18 M4 21v-8a1 1 0 011-1h14a1 1 0 011 1v8 M7 12V8a1 1 0 011-1h6a1 1 0 011 1v4 M7 16h4 M16 4h4v3h-4z',
  suporte: 'M12 21a9 9 0 100-18 9 9 0 000 18z M9.1 9a3 3 0 015.8 1c0 2-3 3-3 3 M12 17h.01',
  voltar: 'M19 12H5 M12 19l-7-7 7-7',
  sair: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4 M16 17l5-5-5-5 M21 12H9',
  sino: 'M18 8a6 6 0 10-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M13.7 21a2 2 0 01-3.4 0',
  chat: 'M21 11.5a8.4 8.4 0 01-9 8.5 8.6 8.6 0 01-4-1L3 21l2-4.3A8.4 8.4 0 0112 3a8.4 8.4 0 019 8.5z',
  seta: 'M9 18l6-6-6-6',
  calendario: 'M8 3v4 M16 3v4 M4 9h16 M5 5h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z',
  carteira: 'M3 7a2 2 0 012-2h12a2 2 0 012 2v1h1a1 1 0 011 1v8a1 1 0 01-1 1H5a2 2 0 01-2-2V7z M17 12h.01',
  bilhetes: 'M3 9a2 2 0 012-2h14a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2V9z M8 7v10 M14 7v10',
  pedido: 'M6 2h9l5 5v13a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2z M15 2v5h5 M9 13h6 M9 17h4',
  media: 'M4 6h16 M4 12h16 M4 18h10',
  pessoas: 'M16 20v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2 M9 10a4 4 0 100-8 4 4 0 000 8 M22 20v-2a4 4 0 00-3-3.9',
  // prédio: a organização (a conta do parque), pra não repetir o desenho de "pessoas"
  organizacao: 'M4 21V5a1 1 0 011-1h9a1 1 0 011 1v16 M15 9h4a1 1 0 011 1v11 M3 21h18 M8 8h2 M8 12h2 M8 16h2',
  // crachá: a equipe (quem trabalha no painel), separada dos clientes
  cracha: 'M6 3h12a1 1 0 011 1v16a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z M12 12a2.5 2.5 0 100-5 2.5 2.5 0 000 5z M8 18a4 4 0 018 0',
  busca: 'M11 19a8 8 0 100-16 8 8 0 000 16z M21 21l-4.3-4.3',
  mais: 'M12 5v14 M5 12h14',
  fechar: 'M18 6L6 18 M6 6l12 12',
  check: 'M20 6L9 17l-5-5',
  lapis: 'M12 20h9 M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z',
  lixo: 'M3 6h18 M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2 M19 6l-1 14a1 1 0 01-1 1H7a1 1 0 01-1-1L5 6 M10 11v6 M14 11v6',
  baixo: 'M6 9l6 6 6-6',
  arrasta: 'M9 6h.01 M9 12h.01 M9 18h.01 M15 6h.01 M15 12h.01 M15 18h.01',
  exportar: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4 M7 10l5 5 5-5 M12 15V3',
  copia: 'M9 9a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2h-8a2 2 0 01-2-2V9z M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1',
  presente: 'M20 12v9H4v-9 M2 7h20v5H2V7z M12 21V7 M12 7H7.5a2.5 2.5 0 110-5C11 2 12 7 12 7z M12 7h4.5a2.5 2.5 0 100-5C13 2 12 7 12 7z',
  etiqueta: 'M20.6 13.4L12 22l-9-9V3h10l7.6 7.6a2 2 0 010 2.8z M7.5 7.5h.01',
}
</script>

<template>
  <svg :width="tamanho ?? 20" :height="tamanho ?? 20" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
       aria-hidden="true" class="shrink-0">
    <path v-for="(d, i) in (caminhos[nome] ?? '').split(' M').map((p, j) => (j ? 'M' + p : p))"
          :key="i" :d="d" />
  </svg>
</template>
