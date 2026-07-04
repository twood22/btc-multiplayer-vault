export async function bitcoinRpc(method, params = []) {
  const url = process.env.BITCOIN_RPC_URL || 'http://127.0.0.1:38332';
  const username = process.env.BITCOIN_RPC_USER || process.env.BITCOIN_RPC_USERNAME;
  const password = process.env.BITCOIN_RPC_PASSWORD;
  const headers = { 'content-type': 'application/json' };
  if (username || password) {
    headers.authorization = `Basic ${Buffer.from(`${username || ''}:${password || ''}`).toString('base64')}`;
  }

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '1.0',
        id: 'btc-multiplayer-vault',
        method,
        params,
      }),
    });
  } catch (error) {
    throw new Error(
      `Bitcoin RPC ${method} could not reach ${url}. Start Bitcoin Core on signet or set BITCOIN_RPC_URL/BITCOIN_RPC_USER/BITCOIN_RPC_PASSWORD. ${error.message}`,
    );
  }
  const body = await response.json();
  if (!response.ok || body.error) {
    throw new Error(
      `Bitcoin RPC ${method} failed: ${body.error?.message || response.statusText}`,
    );
  }
  return body.result;
}

export async function getTxOut(txid, vout) {
  return bitcoinRpc('gettxout', [txid, vout, true]);
}

export async function getBlockchainInfo() {
  return bitcoinRpc('getblockchaininfo');
}

export async function getDescriptorInfo(descriptor) {
  return bitcoinRpc('getdescriptorinfo', [descriptor]);
}

export async function importDescriptors(requests) {
  return bitcoinRpc('importdescriptors', [requests]);
}

export async function decodeRawTransaction(rawTxHex) {
  return bitcoinRpc('decoderawtransaction', [rawTxHex]);
}

export async function getRawTransaction(txid, verbose = true) {
  return bitcoinRpc('getrawtransaction', [txid, verbose]);
}

export async function testMempoolAccept(rawTxHex, maxFeeRateBtcPerKvB) {
  const params = [[rawTxHex]];
  if (maxFeeRateBtcPerKvB !== undefined) params.push(maxFeeRateBtcPerKvB);
  return bitcoinRpc('testmempoolaccept', params);
}

export async function walletProcessPsbt(psbtBase64, { sign = true, sighashType = 'ALL', bip32Derivs = true } = {}) {
  return bitcoinRpc('walletprocesspsbt', [psbtBase64, sign, sighashType, bip32Derivs]);
}

export async function combinePsbts(psbtBase64s) {
  return bitcoinRpc('combinepsbt', [psbtBase64s]);
}

export async function finalizePsbt(psbtBase64, extract = true) {
  return bitcoinRpc('finalizepsbt', [psbtBase64, extract]);
}

export async function sendRawTransaction(rawTxHex) {
  return bitcoinRpc('sendrawtransaction', [rawTxHex]);
}
