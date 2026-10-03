// A native DSH model scope for compaction only. The conversation's provider
// registry and default model are unchanged, including in other launch modes.
import Llm from '@deepseek-ai/dsh-llm'
import * as pi from '@deepseek-ai/dsh-llm-pi-ai'
import * as deepseek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import * as account from '@deepseek-ai/dsh-llm-deepseek-account'
const adapters = { '@deepseek-ai/dsh-llm-pi-ai':pi, '@deepseek-ai/dsh-llm-deepseek-api-key':deepseek, '@deepseek-ai/dsh-llm-deepseek-account':account }
export function summaryContext(ctx,spec) {
  if (!spec) return null
  const plugin=adapters[spec.plugin]
  if (!plugin) throw Error('Unsupported native DSH summary adapter')
  // Reuse credentials/account services, but do not register the adapter's
  // settings or sign-in flows a second time on the conversation's UI.
  const scoped=ctx.isolate('llm').isolate('settings').isolate('authorization')
  // Adapter settings/listeners belong to a child fiber, never to the
  // compaction engine's fiber or the main conversation's model registry.
  let adapter
  const registry=scoped.plugin({name:'superlcm-summary-registry',apply(child){
    new Llm(child)
    adapter=child.plugin({name:'superlcm-summary-model',inject:plugin.inject,apply(modelCtx){plugin.apply(modelCtx,plugin.Config(spec.config||{}))}})
  }})
  return {ctx:registry.ctx,ready:registry.await().then(()=>adapter.await())}
}
