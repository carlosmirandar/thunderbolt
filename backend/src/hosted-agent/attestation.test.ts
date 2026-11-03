/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it } from 'bun:test'
import { canonicalRuntimeAttestation, createAgentRuntimeAttestor, type AttestationSettings } from './attestation'

const keys = generateKeyPairSync('ed25519')
const fakePrivateKeyBase64 = Buffer.from(keys.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64')
const token = 'operator-test-token-'.padEnd(40, 'x')
const settings = (overrides: Partial<AttestationSettings> = {}): AttestationSettings => ({
  agentAttestationEnabled: true,
  agentAttestationPrivateKeyBase64: fakePrivateKeyBase64,
  agentAttestationOperatorToken: token,
  agentAttestationDeploymentId: 'test-deployment',
  agentAttestationBackendCommit: 'eaa76696a42ef455dcf82ab76106b4a64550073f',
  agentAttestationOrigin: 'https://agent.example.invalid',
  agentSystemPrompt: 'Prueba: instrucciones del operador.',
  agentName: 'Asistente de Evento Demo',
  agentModel: 'accounts/fireworks/models/minimax-m3',
  agentMaxSteps: 1,
  agentMcpServers: '',
  ...overrides,
})

const fixedNow = 1_793_650_000_000

describe('attestation — disabled by default, no model, no network', () => {
  it('disabled means no signer and no route can be enabled by this module', () => {
    expect(createAgentRuntimeAttestor(settings({ agentAttestationEnabled: false }))).toBeNull()
  })
  it('signs a fresh challenge with an in-process prompt digest, no prompt disclosure', () => {
    const signer = createAgentRuntimeAttestor(settings(), { now: () => fixedNow })!
    expect(signer.authorized(token)).toBe(true)
    const proof = signer.signChallenge('a'.repeat(32))!
    expect(proof.payload.prompt_sha256).toBe(createHash('sha256').update(settings().agentSystemPrompt).digest('hex'))
    expect(proof.payload.issued_at_ms).toBe(fixedNow)
    expect(proof.payload.expires_at_ms - fixedNow).toBe(15_000)
    expect(proof.payload.boot_id).toBe(signer.bootId)
    expect(JSON.stringify(proof)).not.toContain(settings().agentSystemPrompt)
    expect(JSON.stringify(proof)).not.toContain(token)
    expect(JSON.stringify(proof)).not.toContain(fakePrivateKeyBase64)
    expect(verify(null, Buffer.from(canonicalRuntimeAttestation(proof.payload)), keys.publicKey, Buffer.from(proof.signature, 'base64url'))).toBe(true)
  })
  it('refuses invalid tokens and malformed challenges', () => {
    const signer = createAgentRuntimeAttestor(settings())!
    expect(signer.authorized(null)).toBe(false)
    expect(signer.authorized('not-the-token'.padEnd(40, 'x'))).toBe(false)
    expect(signer.signChallenge('A'.repeat(32))).toBeNull()
    expect(signer.signChallenge('a'.repeat(31))).toBeNull()
    expect(signer.signChallenge('a'.repeat(32) + 'x')).toBeNull()
  })
  it('refuses missing or weak secrets; fails closed at startup', () => {
    expect(() => createAgentRuntimeAttestor(settings({ agentAttestationOperatorToken: '' }))).toThrow()
    expect(() => createAgentRuntimeAttestor(settings({ agentAttestationOperatorToken: 'short' }))).toThrow()
    expect(() => createAgentRuntimeAttestor(settings({ agentAttestationPrivateKeyBase64: '' }))).toThrow()
  })
  it('requires fixed HTTPS origin, deployment, commit and pilot configuration', () => {
    expect(() => createAgentRuntimeAttestor(settings({ agentAttestationOrigin: 'http://agent.example.invalid' }))).toThrow()
    expect(() => createAgentRuntimeAttestor(settings({ agentAttestationOrigin: 'https://agent.example.invalid/path' }))).toThrow()
    expect(() => createAgentRuntimeAttestor(settings({ agentAttestationDeploymentId: '' }))).toThrow()
    expect(() => createAgentRuntimeAttestor(settings({ agentAttestationBackendCommit: 'not-a-sha' }))).toThrow()
    expect(() => createAgentRuntimeAttestor(settings({ agentMaxSteps: 2 }))).toThrow()
    expect(() => createAgentRuntimeAttestor(settings({ agentMcpServers: '[{}]' }))).toThrow()
  })
  it('does not reuse a boot identity when creating distinct route instances', () => {
    const a = createAgentRuntimeAttestor(settings())!
    const b = createAgentRuntimeAttestor(settings())!
    expect(a.bootId).not.toBe(b.bootId)
    expect(a.promptSha256).toBe(b.promptSha256)
  })
  it('changing the loaded operator prompt changes the signed digest', () => {
    const a = createAgentRuntimeAttestor(settings())!
    const b = createAgentRuntimeAttestor(settings({ agentSystemPrompt: 'Otro prompt' }))!
    expect(a.promptSha256).not.toBe(b.promptSha256)
  })
})
