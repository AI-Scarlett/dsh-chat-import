import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)

test('manifest and scheduler guard declare the rc.8 contract', async () => {
  const [manifestText, tools, readme, readmeZh] = await Promise.all([
    readFile(new URL('package.json', root), 'utf8'),
    readFile(new URL('lib/tools.mjs', root), 'utf8'),
    readFile(new URL('README.md', root), 'utf8'),
    readFile(new URL('README.zh-CN.md', root), 'utf8'),
  ])
  const manifest = JSON.parse(manifestText)
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-tools'], '>=0.1.0-rc.8 <0.2.0')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-client-locale'], '>=0.1.0-rc.8 <0.2.0')
  assert.match(tools, /requires >=0\.1\.0-rc\.8 <0\.2\.0/)
  assert.match(readme, /dsh-tools >=0\.1\.0-rc\.8 <0\.2\.0/)
  assert.match(readmeZh, /dsh-tools >=0\.1\.0-rc\.8 <0\.2\.0/)
})
