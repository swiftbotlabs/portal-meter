// Substrate helpers for the deploy script: key file parsing, signed extrinsics with inclusion tracking.
import { readFileSync, statSync } from 'node:fs';

/** Parse KEY=VALUE lines of a 0600 env file. Values are returned, never printed. */
export function readKeyFile(path) {
  const st = statSync(path);
  if ((st.mode & 0o077) !== 0) throw new Error(`${path} must not be readable by group/others (chmod 600)`);
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return out;
}

function describeDispatchError(api, err) {
  if (err.isModule) {
    const d = api.registry.findMetaError(err.asModule);
    return `${d.section}.${d.name}`;
  }
  return err.toString();
}

/** Sign, submit, wait until in a block; reject on any dispatch error. */
export function submit(api, signer, tx, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    let unsub = null;
    const timer = setTimeout(() => {
      if (unsub) unsub();
      reject(new Error('extrinsic not included in time'));
    }, timeoutMs);
    tx.signAndSend(signer, { nonce: -1 }, async res => {
      try {
        const { status, dispatchError, events, txHash } = res;
        if (status.isInvalid || status.isDropped || status.isUsurped) {
          clearTimeout(timer);
          if (unsub) unsub();
          return reject(new Error(`extrinsic ${status.type}`));
        }
        if (!status.isInBlock) return;
        clearTimeout(timer);
        if (unsub) unsub();
        if (dispatchError) return reject(new Error(`dispatch error: ${describeDispatchError(api, dispatchError)}`));
        const failed = events.find(({ event }) => api.events.system.ExtrinsicFailed.is(event));
        if (failed) return reject(new Error(`extrinsic failed: ${describeDispatchError(api, failed.event.data[0])}`));
        const blockHash = status.asInBlock.toHex();
        const header = await api.rpc.chain.getHeader(blockHash);
        const idx = events.find(e => e.phase.isApplyExtrinsic)?.phase.asApplyExtrinsic.toNumber();
        resolve({ hash: txHash.toHex(), blockHash, block: header.number.toNumber(), index: idx, events });
      } catch (e) {
        reject(e);
      }
    }).then(u => { unsub = u; }).catch(e => { clearTimeout(timer); reject(e); });
  });
}
