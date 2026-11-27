import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'br.com.conquistapark.comandas',
  appName: 'Comandas Conquista Park',
  webDir: 'dist',
  android: { allowMixedContent: false },
  plugins: {
    // as chamadas pro sistema saem pelo Android (não pelo navegador do app): sem CORS e sem
    // cabeçalho Origin, que o porteiro de /api/comandas aceita (`mutacaoDeOutroSite`)
    CapacitorHttp: { enabled: true },
  },
}

export default config
