/**
 * Empacota os testes antes de rodá-los.
 *
 * O código-fonte é TypeScript com apelidos de caminho (`@shared/*`) e importa
 * `electron` no módulo de configurações. O `node --test` não resolve nem uma
 * coisa nem outra, então o esbuild faz as duas: transpila e troca `electron`
 * por um substituto de teste. O resultado é que a suíte roda em Node puro, em
 * menos de um segundo, sem precisar subir um Electron.
 */
import { build } from 'esbuild'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/*
 * Fora de node_modules de propósito: o `node --test` ignora tudo que estiver
 * lá dentro ao varrer um diretório, e a suíte simplesmente não seria
 * encontrada.
 */
const OUT = '.cache/tests'

const entries = readdirSync('tests')
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => join('tests', name))

if (entries.length === 0) {
  console.error('nenhum arquivo *.test.ts encontrado em tests/')
  process.exit(1)
}

rmSync(OUT, { recursive: true, force: true })

await build({
  entryPoints: entries,
  outdir: OUT,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'inline',
  logLevel: 'error',
  alias: {
    '@shared': './src/shared',
    // O único uso de `electron` fora do processo principal é `app.getPath`.
    electron: './tests/helpers/electron.ts'
  },
  // Pesado, nativo e irrelevante para a lógica testada aqui.
  external: ['tesseract.js']
})

console.log(`${entries.length} arquivo(s) de teste empacotado(s) em ${OUT}`)
