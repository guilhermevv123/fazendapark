// As mesmas cores e fontes do site (`../tailwind.config.js`); só muda onde procurar as classes.
import site from '../tailwind.config.js'

export default {
  ...site,
  content: [
    './index.html',
    './src/**/*.{vue,ts}',
    '../app/components/comanda/**/*.vue',
    '../app/components/{CampoMoeda,ModalLateral,LeitorCamera}.vue',
    '../app/composables/comanda*.ts',
  ],
}
