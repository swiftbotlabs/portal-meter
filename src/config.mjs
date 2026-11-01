// Network constants and deployment lookup. Everything here is public.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const NETWORK = Object.freeze({
  name: 'PortaldotV3 Testnet',
  evmRpc: process.env.PM_EVM_RPC || 'https://test-evm-rpc-v3.portaldot.dev',
  substrateWs: process.env.PM_SUBSTRATE_WS || 'wss://test-node-v3.portaldot.dev',
  substrateHttp: process.env.PM_SUBSTRATE_HTTP || 'https://test-node-v3.portaldot.dev',
  chainId: 420420777,
  ss58Format: 42,
  nativeDecimals: 14,
  explorer: 'https://scanner-testnet-v3.portaldot.dev',
  console: 'https://node-console.portaldot.dev/?rpc=wss://test-node-v3.portaldot.dev',
  runtimePalletsAddress: '0x6d6f646c70792f70616464720000000000000000',
});

/** pallet-assets (instance 1) ERC-20 precompile address for a native asset id. */
export function precompileAddress(assetId) {
  if (!Number.isInteger(assetId) || assetId < 0 || assetId > 0xffffffff) throw new Error('asset id must be a u32');
  return '0x' + assetId.toString(16).padStart(8, '0') + '0'.repeat(24) + '00010000';
}

/** Reverse of precompileAddress; null when the address is not an assets precompile. */
export function assetIdOfPrecompile(address) {
  const a = String(address).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) return null;
  if (a.slice(10, 34) !== '0'.repeat(24) || a.slice(34) !== '00010000') return null;
  return parseInt(a.slice(2, 10), 16);
}

export function loadDeployment(path = process.env.PM_DEPLOYMENT || join(ROOT, 'deployments', 'testnet.json')) {
  if (!existsSync(path)) return null;
  const d = JSON.parse(readFileSync(path, 'utf8'));
  for (const k of ['settlement', 'token', 'chainId']) {
    if (!(k in d)) throw new Error(`deployment file ${path} is missing ${k}`);
  }
  return d;
}

export const PATHS = Object.freeze({
  root: ROOT,
  evmArtifact: join(ROOT, 'contracts', 'evm', 'out', 'MeterSettlement.sol', 'MeterSettlement.json'),
  inkBundle: join(ROOT, 'contracts', 'ink', 'meter_registry', 'meter_registry.contract'),
});
