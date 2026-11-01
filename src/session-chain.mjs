// MeterSession on chain: ABI and small helpers. No Node.js-only imports: this also runs on the page and in the Worker.
import { Contract, Interface } from 'ethers';

export const SESSION_ABI = [
  'function open(uint32 endpointId, bytes32 nonce, address signer, uint96 amount, uint40 expiresAt) returns (bytes32)',
  'function topUp(bytes32 id, uint96 amount)',
  'function redeem(bytes32 id, uint96 cumulative, uint32 count, bytes32 head, bytes signature)',
  'function close(bytes32 id)',
  'function sessionIdFor(address payer, uint32 endpointId, bytes32 nonce) view returns (bytes32)',
  'function session(bytes32 id) view returns (address payer, uint32 endpointId, uint40 expiresAt, address signer, uint96 deposit, uint96 redeemed, uint32 count)',
  'function voucherDigest(bytes32 id, uint96 cumulative, uint32 count, bytes32 head) view returns (bytes32)',
  'function endpoints() view returns (address)',
  'function CLOSE_GRACE() view returns (uint32)',
  'event SessionOpened(bytes32 indexed session, uint32 indexed endpointId, address indexed payer, address signer, uint96 amount, uint40 expiresAt, bytes32 nonce)',
  'event SessionToppedUp(bytes32 indexed session, uint96 amount, uint96 deposit)',
  'event Redeemed(bytes32 indexed session, uint32 indexed endpointId, bytes32 head, uint96 cumulative, uint96 paid, uint32 count)',
  'event SessionClosed(bytes32 indexed session, address indexed payer, uint96 returned, bool byProvider)',
  'error UnknownEndpoint()', 'error EndpointInactive()', 'error ZeroAmount()', 'error ZeroAddress()', 'error BadExpiry()',
  'error SessionExists()', 'error NoSession()', 'error BadSignature()', 'error NotNewer()', 'error OverBudget()',
  'error NotAllowed()', 'error TooEarly()', 'error TokenCallFailed()',
];

export const sessionIface = new Interface(SESSION_ABI);

export function sessionContract(address, runner) {
  return new Contract(address, SESSION_ABI, runner);
}

const ZERO = '0x0000000000000000000000000000000000000000';

/** Decoded MeterSession.session(id), or null when the id was never opened. `closed` means it was, and has ended. */
export function decodeSession(result) {
  const [payer, endpointId, expiresAt, signer, deposit, redeemed, count] = result;
  if (payer === ZERO) return null;
  return {
    payer, endpointId: Number(endpointId), expiresAt: Number(expiresAt), signer,
    deposit: BigInt(deposit), redeemed: BigInt(redeemed), count: Number(count), closed: Number(expiresAt) === 0,
  };
}

export async function readSession(contract, id) {
  return decodeSession(await contract.session(id));
}

/** A session reader over any eth_call function, for runtimes without an ethers provider (the Worker). */
export function sessionReader(ethCall, address) {
  return async id => {
    const data = sessionIface.encodeFunctionData('session', [id]);
    return decodeSession(sessionIface.decodeFunctionResult('session', await ethCall({ to: address, data })));
  };
}

export function redeemCalldata(id, cumulative, count, head, signature) {
  return sessionIface.encodeFunctionData('redeem', [id, BigInt(cumulative), count, head, signature]);
}
