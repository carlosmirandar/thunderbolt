/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHash, createPrivateKey, randomUUID, sign, timingSafeEqual } from 'node:crypto'

/**
 * Disabled by default. The private key and operator token exist only in backend memory.
 * Never accept an origin, a commit, or a public key supplied by the requesting client.
 */
export type AttestationSettings = {
  agentAttestationEnabled: boolean
  agentAttestationPrivateKeyBase64: string
  agentAttestationOperatorToken: string
  agentAttestationDeploymentId: string
  agentAttestationBackendCommit: string
  agentAttestationOrigin: string
  agentSystemPrompt: string
  agentName: string
  agentModel: string
  agentMaxSteps: number
  agentMcpServers: string
}

export type RuntimeAttestationPayload = {
  schema_version: 1
  nonce: string
  audience: 'thunderbolt-bots.compare.stage1'
  origin: string
  issued_at_ms: number
  expires_at_ms: number
  backend_commit: string
  deployment_id: string
  boot_id: string
  agent_id: 'hosted-agent'
  agent_name: string
  model: string
  max_steps: 1
  mcp_servers: 0
  prompt_sha256: string
}

export type SignedRuntimeAttestation = { payload: RuntimeAttestationPayload; signature: string }
export type RuntimeAttestor = {
  readonly bootId: string
  readonly promptSha256: string
  authorized: (operatorToken: string | null) => boolean
  signChallenge: (nonce: string) => SignedRuntimeAttestation | null
}

const noncePattern = /^[a-f0-9]{32}$/
const commitPattern = /^[a-f0-9]{40}$/
const deploymentPattern = /^[A-Za-z0-9._-]{1,128}$/
const ttlMs = 15_000

/** This field order matches the pinned verifier in thunderbolt-bots, PR #8. */
export const canonicalRuntimeAttestation = (p: RuntimeAttestationPayload): string =>
  JSON.stringify({
    schema_version: p.schema_version,
    nonce: p.nonce,
    audience: p.audience,
    origin: p.origin,
    issued_at_ms: p.issued_at_ms,
    expires_at_ms: p.expires_at_ms,
    backend_commit: p.backend_commit,
    deployment_id: p.deployment_id,
    boot_id: p.boot_id,
    agent_id: p.agent_id,
    agent_name: p.agent_name,
    model: p.model,
    max_steps: p.max_steps,
    mcp_servers: p.mcp_servers,
    prompt_sha256: p.prompt_sha256,
  })

/**
 * Called in createHostedAgentRoutes: this same closure is used by identity and chat.
 * Backend config is captured once; later process.env changes cannot alter the reported hash.
 * A signature proves possession of the private key, NOT the provenance of a supplied commit.
 */
export const createAgentRuntimeAttestor = (
  settings: AttestationSettings,
  options: { now?: () => number; bootId?: string } = {},
): RuntimeAttestor | null => {
  if (!settings.agentAttestationEnabled) {
    return null
  }
  if (
    !settings.agentAttestationOperatorToken ||
    settings.agentAttestationOperatorToken.length < 32 ||
    settings.agentAttestationOperatorToken.length > 512
  ) {
    throw new Error('Agent attestation requires a strong operator token')
  }
  if (!commitPattern.test(settings.agentAttestationBackendCommit)) {
    throw new Error('Agent attestation requires a 40-character backend commit')
  }
  if (!deploymentPattern.test(settings.agentAttestationDeploymentId)) {
    throw new Error('Agent attestation requires a deployment identifier')
  }
  if (!settings.agentAttestationOrigin || !settings.agentAttestationOrigin.startsWith('https://')) {
    throw new Error('Agent attestation requires an HTTPS origin')
  }
  const parsedOrigin = new URL(settings.agentAttestationOrigin)
  if (parsedOrigin.origin !== settings.agentAttestationOrigin || parsedOrigin.username || parsedOrigin.password) {
    throw new Error('Agent attestation requires a bare HTTPS origin')
  }
  if (settings.agentMaxSteps !== 1 || settings.agentMcpServers.trim() !== '') {
    throw new Error('Agent attestation pilot only supports one step and no MCP servers')
  }
  if (
    !settings.agentName ||
    settings.agentName.length > 128 ||
    !settings.agentModel ||
    settings.agentModel.length > 256
  ) {
    throw new Error('Agent attestation requires a valid name and model')
  }
  let pem: string
  try {
    pem = Buffer.from(settings.agentAttestationPrivateKeyBase64, 'base64').toString('utf8')
  } catch {
    throw new Error('Agent attestation private key is malformed')
  }
  const privateKey = createPrivateKey(pem)
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Agent attestation requires an Ed25519 private key')
  }
  const bootId = options.bootId ?? randomUUID()
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(bootId)) {
    throw new Error('Agent attestation boot ID is invalid')
  }
  const now = options.now ?? Date.now
  const promptSha256 = createHash('sha256').update(settings.agentSystemPrompt, 'utf8').digest('hex')
  const expectedToken = Buffer.from(settings.agentAttestationOperatorToken, 'utf8')
  return {
    bootId,
    promptSha256,
    authorized: (operatorToken) => {
      if (!operatorToken) {
        return false
      }
      const provided = Buffer.from(operatorToken, 'utf8')
      return provided.length === expectedToken.length && timingSafeEqual(expectedToken, provided)
    },
    signChallenge: (nonce) => {
      if (!noncePattern.test(nonce)) {
        return null
      }
      const issued = now()
      if (!Number.isSafeInteger(issued) || issued < 0) {
        return null
      }
      const payload: RuntimeAttestationPayload = {
        schema_version: 1,
        nonce,
        audience: 'thunderbolt-bots.compare.stage1',
        origin: settings.agentAttestationOrigin,
        issued_at_ms: issued,
        expires_at_ms: issued + ttlMs,
        backend_commit: settings.agentAttestationBackendCommit,
        deployment_id: settings.agentAttestationDeploymentId,
        boot_id: bootId,
        agent_id: 'hosted-agent',
        agent_name: settings.agentName,
        model: settings.agentModel,
        max_steps: 1,
        mcp_servers: 0,
        prompt_sha256: promptSha256,
      }
      const signature = sign(null, Buffer.from(canonicalRuntimeAttestation(payload), 'utf8'), privateKey).toString(
        'base64url',
      )
      return { payload, signature }
    },
  }
}
