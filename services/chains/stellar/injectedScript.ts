/**
 * Stellar injected-provider script — content-script `postMessage`
 * emulator, per `docs/stellar-dapp-bridge-spec.md` §5.
 *
 * NOT a callable-object shim (unlike Solana/Sui's direct `window`
 * assignment). Real Freighter-bundling dApp code (`@stellar/freighter-api`)
 * never calls a global object's methods — every exported function posts a
 * `{ source: "FREIGHTER_EXTERNAL_MSG_REQUEST", messageId, type, ...args }`
 * message on `window` and waits for a same-window `message` event tagged
 * `source: "FREIGHTER_EXTERNAL_MSG_RESPONSE"` with a matching (and
 * intentionally misspelled, per Freighter's own source) `messagedId`
 * (§1.2–§1.4). This script is the content-script side of that protocol.
 *
 * `type` on the wire is `EXTERNAL_SERVICE_TYPES`'s NUMERIC ordinal (a
 * plain, unvalued TS enum defaults to 0, 1, 2, …) — confirmed by reading
 * `@shared/constants/services.ts` directly (§1.4). `TYPE_NAMES` below is
 * that exact ordinal list; the listener maps the incoming number to the
 * canonical string name before forwarding to `StellarAdapter.handleRequest`
 * via the shared `bridge_request` transport, so `ChainRequest.method`
 * downstream is always the readable name (§4.1's dispatch table), never a
 * bare number.
 *
 * Invariants (§1.5, §5.1, §5.3, §11):
 *   - Idempotent — the `message` listener is added exactly once per page
 *     load; the guard wraps `addEventListener` itself (re-adding it would
 *     double-answer every request), not just the `window.freighter` flag.
 *   - `window.__takumi_stellar_nonce` is refreshed on every inject call
 *     (even when the rest of the install is a no-op) so a re-inject after
 *     a session-nonce rotation still carries the current nonce.
 *   - Always-respond — every `FREIGHTER_EXTERNAL_MSG_REQUEST` yields
 *     exactly one `FREIGHTER_EXTERNAL_MSG_RESPONSE`, including when the
 *     internal `bridgeRequest` promise rejects (backstopped by the
 *     listener's own `.catch`, not a client-side timeout — most message
 *     types have none, §1.5).
 */

export interface StellarInjectedScriptParams {
  sessionNonce?: string;
}

/**
 * `EXTERNAL_SERVICE_TYPES` ordinal → name, fetched directly from
 * `@shared/constants/services.ts` (§1.4). Order is load-bearing — this is
 * a plain numeric TS enum, so index IS the wire value.
 */
export const EXTERNAL_SERVICE_TYPE_NAMES = [
  "REQUEST_ACCESS",
  "REQUEST_PUBLIC_KEY",
  "SUBMIT_TOKEN",
  "SUBMIT_TRANSACTION",
  "SUBMIT_BLOB",
  "SUBMIT_AUTH_ENTRY",
  "REQUEST_NETWORK",
  "REQUEST_NETWORK_DETAILS",
  "REQUEST_CONNECTION_STATUS",
  "REQUEST_ALLOWED_STATUS",
  "SET_ALLOWED_STATUS",
  "REQUEST_USER_INFO",
] as const;

export function getStellarInjectedScript(
  p: StellarInjectedScriptParams = {},
): string {
  const N = JSON.stringify(p.sessionNonce ?? "");
  const TYPE_NAMES_LITERAL = JSON.stringify(EXTERNAL_SERVICE_TYPE_NAMES);
  return `(function(){
try{
  window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({
    type:"takumi_diagnostic",
    tag:"stellar_inject",
    at:Date.now(),
    alreadyInstalled:!!window.__takumi_stellar_installed,
    location:window.location.href
  }));
}catch(e){}
window.__takumi_stellar_nonce=${N};
if(window.__takumi_stellar_installed){return;}
window.__takumi_stellar_installed=1;
window.freighter=true;

var EXT_REQ="FREIGHTER_EXTERNAL_MSG_REQUEST";
var EXT_RES="FREIGHTER_EXTERNAL_MSG_RESPONSE";
var TYPE_NAMES=${TYPE_NAMES_LITERAL};
function typeName(t){
  if(typeof t==="string")return t;
  return TYPE_NAMES[t]||("UNKNOWN_"+t);
}

// ── bridge_request/response transport — shared native round trip ──────
var P=window.__takumi_stellar_pending=window.__takumi_stellar_pending||new Map();
function R(){return Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,10);}
function bridgeRequest(type,params){
  return new Promise(function(ok,ng){
    var id=R();
    P.set(id,{r:ok,j:ng});
    try{
      var nc=window.__takumi_stellar_nonce||"";
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type:"bridge_request",
        namespace:"stellar",
        id:id,
        method:type,
        params:params||{},
        __takumi_nonce:nc,
        __takumi_origin:(function(){try{return window.top.location.origin;}catch(e){return location.origin;}})()
      }));
    }catch(e){P.delete(id);ng(new Error("bridge transport failed"));}
  });
}
var H=window._handleEthereumResponse;
window._handleEthereumResponse=function(x){
  try{
    if(x&&x.type==="bridge_response"&&P.has(x.id)){
      var p=P.get(x.id);P.delete(x.id);
      if(x.error){var e=new Error(x.error.message||"rejected");e.code=x.error.code;p.j(e);}
      else p.r(x.result);
      return;
    }
  }catch(e){}
  if(H)try{H(x);}catch(e){}
};

// §1.1 — SEP-0043's 4-code taxonomy. Mirrors
// services/chains/stellar/errorCodes.ts#toSep0043Code; duplicated here
// (not imported — this string has zero module dependencies by design,
// §5.1) so the injected payload stays small and self-contained.
function mapErrCode(c){
  if(c===4001)return -4;
  if(c===4100||c===-32602||c===4200||c===-32002)return -3;
  if(c===-32001)return -2;
  return -1;
}

// ── The real surface: a content-script "message" listener, not a
// callable object (§1.2). Idempotency guard above wraps this whole
// installation, so this only ever runs once per page load.
window.addEventListener("message",function(event){
  if(event.source!==window)return;
  if(!event.data||event.data.source!==EXT_REQ)return;
  var req=event.data;
  var reply=function(fields){
    try{
      window.postMessage(Object.assign({source:EXT_RES,messagedId:req.messageId},fields||{}),window.location.origin);
    }catch(e){}
  };
  var params={};
  for(var k in req){if(k!=="source"&&k!=="messageId"&&k!=="type")params[k]=req[k];}
  var name=typeName(req.type);
  bridgeRequest(name,params)
    .then(function(result){reply(result||{});})
    .catch(function(err){
      reply({apiError:{code:mapErrCode(err&&err.code),message:(err&&err.message)||"The wallet encountered an internal error. Please try again or contact the wallet if the problem persists."}});
    });
},false);

// ── §5.5 — defensive-only window.freighterApi convenience object, for
// dApp code that checks \`typeof window.freighterApi !== "undefined"\`
// directly instead of bundling the npm package or loading the CDN
// script. Each method reuses the SAME bridgeRequest call the listener
// above uses — not a second protocol, not a second source of truth.
function dispatch(type,args){return bridgeRequest(type,args||{});}
function pickNetwork(r){var nd=r&&r.networkDetails;return{network:nd&&nd.network,networkPassphrase:nd&&nd.networkPassphrase};}
function pickNetworkDetails(r){return (r&&r.networkDetails)||{};}
function pickSignTx(r){return{signedTxXdr:r&&r.signedTransaction,signerAddress:r&&r.signerAddress};}
function pickSignMsg(r){return{signedMessage:r&&r.signedBlob,signerAddress:r&&r.signerAddress};}
function pickSignAuthEntry(r){return{signedAuthEntry:r&&r.signedAuthEntry,signerAddress:r&&r.signerAddress};}
window.freighterApi={
  isConnected:function(){return dispatch("REQUEST_CONNECTION_STATUS",{});},
  getAddress:function(){return dispatch("REQUEST_PUBLIC_KEY",{}).then(function(r){return{address:r&&r.publicKey};});},
  requestAccess:function(){return dispatch("REQUEST_ACCESS",{}).then(function(r){return{address:r&&r.publicKey};});},
  getNetwork:function(){return dispatch("REQUEST_NETWORK_DETAILS",{}).then(pickNetwork);},
  getNetworkDetails:function(){return dispatch("REQUEST_NETWORK_DETAILS",{}).then(pickNetworkDetails);},
  signTransaction:function(xdr,opts){return dispatch("SUBMIT_TRANSACTION",Object.assign({transactionXdr:xdr},opts)).then(pickSignTx);},
  signMessage:function(msg,opts){return dispatch("SUBMIT_BLOB",Object.assign({blob:msg},opts)).then(pickSignMsg);},
  // SEP-43 signAuthEntry(entryXdr, { networkPassphrase, address }).
  signAuthEntry:function(entryXdr,opts){return dispatch("SUBMIT_AUTH_ENTRY",Object.assign({authEntryXdr:entryXdr},opts)).then(pickSignAuthEntry);},
  isAllowed:function(){return dispatch("REQUEST_ALLOWED_STATUS",{});},
  setAllowed:function(){return dispatch("SET_ALLOWED_STATUS",{});},
};
})();`;
}
