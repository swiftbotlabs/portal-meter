// Route table of the demo seller: two paid Portaldot data endpoints.
import { accountView, assetView, parseAccount, parseAssetId, BadInput } from './data.mjs';

function dec(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new BadInput('bad URL encoding');
  }
}

export function makeRoutes({ upstream, token, tokenSymbol, decimals, endpoints }) {
  const common = { token, tokenSymbol, decimals };
  return [
    {
      ...common,
      endpointId: endpoints.account.id,
      price: String(endpoints.account.price),
      pattern: /^\/v1\/account\/([^/]{1,64})$/,
      example: '/v1/account/{ss58-or-0x-address}',
      description: 'Cross-VM account view: Substrate balance and nonce, EVM balance, nonce and code, address mapping, native asset balances',
      validate: m => parseAccount(dec(m[1])),
      handler: m => accountView(upstream, dec(m[1])),
    },
    {
      ...common,
      endpointId: endpoints.asset.id,
      price: String(endpoints.asset.price),
      pattern: /^\/v1\/asset\/([0-9]{1,10})$/,
      example: '/v1/asset/{id}',
      description: 'Native asset: details, metadata, ERC-20 precompile address and a supply consistency check across both VMs',
      validate: m => parseAssetId(m[1]),
      handler: m => assetView(upstream, m[1]),
    },
  ];
}
