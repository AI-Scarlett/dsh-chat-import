import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)

test('manifest, scheduler, snapshots and settings entry declare the rc.8 contract', async () => {
  const [manifestText, tools, syncLoop, client, readme, readmeZh] = await Promise.all([
    readFile(new URL('package.json', root), 'utf8'),
    readFile(new URL('lib/tools.mjs', root), 'utf8'),
    readFile(new URL('lib/sync-loop.mjs', root), 'utf8'),
    readFile(new URL('lib/client.js', root), 'utf8'),
    readFile(new URL('README.md', root), 'utf8'),
    readFile(new URL('README.zh-CN.md', root), 'utf8'),
  ])
  const manifest = JSON.parse(manifestText)
  assert.equal(manifest.version, '0.4.0')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-tools'], '>=0.1.0-rc.8 <0.2.0')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-client-runtime'], '>=0.1.0-rc.8 <0.2.0')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-client-ui-settings'], '>=0.1.0-rc.8 <0.2.0')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-client-locale'], '>=0.1.0-rc.8 <0.2.0')
  assert.match(tools, /requires >=0\.1\.0-rc\.8 <0\.2\.0/)
  assert.match(syncLoop, /sp\.listSnapshots\(\)/)
  assert.match(client, /name: "settings\.section",[\s\S]*id: "chat-import",[\s\S]*order: 60/)
  assert.doesNotMatch(client, /sidebar\.footer\.action/)
  assert.doesNotMatch(client, /cordisBadgeVisible|MutationObserver|data-cordis-badge/)
  assert.match(readme, /dsh-tools >=0\.1\.0-rc\.8 <0\.2\.0/)
  assert.match(readmeZh, /dsh-tools >=0\.1\.0-rc\.8 <0\.2\.0/)
})
