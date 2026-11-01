// Test helpers: a throwaway anvil chain, freshly generated wallets funded with anvil_setBalance
// (no keys in the repository), and the compiled contracts from contracts/evm/out.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { Wallet, ContractFactory, JsonRpcProvider } from 'ethers';
import { PATHS } from '../src/config.mjs';
import { waitReceipt } from '../src/evm.mjs';

export function artifact(file, name) {
  const p = join(PATHS.root, 'contracts', 'evm', 'out', file, `${name}.json`);
  const a = JSON.parse(readFileSync(p, 'utf8'));
  return { abi: a.abi, bytecode: a.bytecode.object };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export async function startAnvil() {
  const port = await freePort();
  const bin = process.env.ANVIL_BIN || 'anvil';
  const proc = spawn(bin, ['--port', String(port), '--host', '127.0.0.1', '--silent', '--accounts', '0'], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  let chainId = null;
  for (let i = 0; i < 100 && chainId === null; i++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      chainId = Number(BigInt((await r.json()).result));
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  if (chainId === null) throw new Error(`anvil did not start (${bin})`);
  const provider = new JsonRpcProvider(url, chainId, { staticNetwork: true, batchMaxCount: 1, pollingInterval: 50, cacheTimeout: -1 });
  await provider.send('anvil_setAutomine', [true]);
  return {
    url, provider, chainId,
    async wallet() {
      const w = Wallet.createRandom().connect(provider);
      await provider.send('anvil_setBalance', [w.address, '0x56BC75E2D63100000']); // 100 ETH
      return w;
    },
    async warp(sec) {
      await provider.send('evm_increaseTime', [sec]);
      await provider.send('evm_mine', []);
    },
    stop() {
      proc.kill('SIGKILL');
      provider.destroy();
    },
  };
}

export async function deploy(wallet, file, name, args = []) {
  const { abi, bytecode } = artifact(file, name);
  const c = await new ContractFactory(abi, bytecode, wallet).deploy(...args);
  await waitReceipt(wallet.provider, c.deploymentTransaction().hash, { timeoutMs: 20_000 });
  return c;
}
