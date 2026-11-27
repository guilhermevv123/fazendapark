# App do tablet — Comandas (Android)

App dos funcionários: login com o e-mail e a senha do sistema e as telas Atender, Pagar e Contas de hoje.
As telas **não são copiadas**: vêm de `../app/components/comanda/*` (as mesmas do site), pelo apelido
`~` → `../app`. Mudou lá, muda aqui. O que é do Nuxt é suprido em `src/nuxt.ts`.

A página do navegador `/comanda/<código>` saiu: o funcionário só entra pelo app. O login é o do
sistema (o gerente cria em **Configurações → Equipe**) e quem usa as comandas, com que nível, sai de
**Comandas → Configurações → Equipe e regras**.

## Rodar no PC (navegador)
1. Site local na porta 3100 (`npx nuxt dev --port 3100` na pasta de cima, banco local ligado).
2. Aqui: `npm install` e `npm run dev` → http://127.0.0.1:3200 (o `/api` vai pro 3100).

## Gerar o APK
Precisa de JDK 21 e Android SDK (Android Studio).
- `npm run android` → build + `cap sync`; depois abrir `android/` no Android Studio, ou
- `npm run apk` → `android/app/build/outputs/apk/debug/app-debug.apk`.

O APK fala com `https://www.conquistapark.com.br` (ou `VITE_API_URL` no build). As chamadas saem pelo
Android (`CapacitorHttp`), sem CORS. As Comandas só funcionam no APK depois de publicadas no site.

O leitor de pulseira USB funciona como teclado: no tablet, liga por adaptador OTG.
