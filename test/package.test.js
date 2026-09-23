import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname,join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root=dirname(dirname(fileURLToPath(import.meta.url)))
test('standalone package contains Claude adapter without DSH runtime dependency',()=>{const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));assert.equal(pkg.name,'superlcm-mcp');assert.equal(pkg.bin.superlcm,'./src/cli.js');assert.equal(pkg.bin['superlcm-claude'],'./src/cli.js');assert.equal(pkg.dependencies,undefined);assert.equal(pkg.dsh,undefined);assert.ok(pkg.files.includes('src/'))})

test('summarizer never reads Claude Code global API key',()=>{const cli=readFileSync(join(root,'src/cli.js'),'utf8');assert.match(cli,/process\.env\.SUPERLCM_ANTHROPIC_API_KEY/);assert.doesNotMatch(cli,/process\.env\.ANTHROPIC_API_KEY\b/)})
