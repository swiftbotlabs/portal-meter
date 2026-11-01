// Read-only probe of the Portaldot V3 testnet: re-checks every fact in docs/PORTALDOT_V3_NOTES.md.
// usage: node scripts/probe.mjs [--asset 7777]
// No key needed; nothing is signed or sent.
import { ApiPromise, HttpProvider } from '@polkadot/api';
import { encodeAddress } from '@polkadot/util-crypto';
import { twinAccountId, h160OfAccount } from './lib/addr.mjs';
import { NETWORK, precompileAddress } from '../src/config.mjs';

const args = process.argv.slice(2);
const assetId = Number(args[args.indexOf('--asset') + 1] || 7777);

async function evm(method, params = []) {
  const r = await fetch(NETWORK.evmRpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

const out = {};
const api = await ApiPromise.create({ provider: new HttpProvider(NETWORK.substrateHttp), noInitWarn: true });
try {
  out.chain = (await api.rpc.system.chain()).toString();
  out.genesis = api.genesisHash.toHex();
  out.runtime = `${api.runtimeVersion.specName} ${api.runtimeVersion.specVersion.toNumber()}`;
  out.evmChainId = parseInt(await evm('eth_chainId'), 16);
  out.evmClient = await evm('web3_clientVersion');
  out.contracts = {
    apiVersion: api.consts.contracts.apiVersion.toNumber(),
    depositPerByte: api.consts.contracts.depositPerByte.toString(),
    depositPerItem: api.consts.contracts.depositPerItem.toString(),
  };
  out.revive = {
    allowEVMBytecode: api.consts.revive.allowEVMBytecode.toHuman(),
    autoMap: api.consts.revive.autoMap.toHuman(),
    nativeToEthRatio: api.consts.revive.nativeToEthRatio.toString(),
    depositPerByte: api.consts.revive.depositPerByte.toString(),
  };
  // address mapping, both directions, against the runtime's own answer
  const h160 = '0x77df5A7c0375bE0A492C109CcaFB96551fa8Ca5C';
  const twin = encodeAddress(twinAccountId(h160), 42);
  out.mapEvmToSub = { h160, ours: twin, runtime: (await api.call.reviveApi.accountId(h160)).toString() };
  const sub = '5ETkpnDAeRU46becz38vSSP42vWoBnzZ2e4FFRbG6W3hVBdC';
  out.mapSubToEvm = { sub, ours: h160OfAccount(sub), runtime: (await api.call.reviveApi.address(sub)).toHex() };
  // pallet-assets ERC-20 precompile
  const pc = precompileAddress(assetId);
  const md = await api.query.assets.metadata(assetId);
  out.precompile = {
    assetId,
    address: pc,
    symbol: md.symbol.toUtf8(),
    totalSupplyViaEvm: BigInt(await evm('eth_call', [{ to: pc, data: '0x18160ddd' }, 'latest'])).toString(),
    totalSupplyViaSubstrate: ((await api.query.assets.asset(assetId)).unwrapOr(null)?.supply ?? '').toString(),
  };
  // runtime pallets address (EVM -> Substrate call path)
  out.runtimePalletsAddress = (await api.call.reviveApi.runtimePalletsAddress()).toHex();
  const remark = api.tx.system.remark('0x70').method.toHex();
  out.ethToPalletEstimate = await evm('eth_estimateGas', [{ from: h160, to: out.runtimePalletsAddress, data: remark }]);
  out.gasPrice = parseInt(await evm('eth_gasPrice'), 16);
} finally {
  await api.disconnect();
}
console.log(JSON.stringify(out, null, 2));
