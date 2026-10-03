// Verification only: resolve optional DSH peers from an existing host install.
// Production profiles already resolve these packages through their node_modules.
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const runtime = process.env.SUPERLCM_DSH_RUNTIME || join(homedir(), '.npm-global/lib/node_modules/@deepseek-ai/dsh/package.json')
const host = createRequire(runtime)
export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context) }
  catch (error) {
    if (!specifier.startsWith('@deepseek-ai/')) throw error
    return { url: pathToFileURL(host.resolve(specifier)).href, shortCircuit: true }
  }
}
