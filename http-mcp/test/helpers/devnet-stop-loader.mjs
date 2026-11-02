// Only constructor dependencies are replaced. Run the real entrypoint and
// real stop/signal boundary against an operator with a deterministic refusal.
// STOP_MARKER=none|mutable makes the external module an earlier-contract one:
// it returns no frozen ownedShutdown marker, and its app/agent closes are recorded.
// STOP_HANG=1 makes the purchase wait until close, as a run interrupted by a signal.
// STOP_EARLY holds a compose startup step until SIGTERM: "app" holds createApp
// (a stop before the marker; that app's close then throws), "attach" holds
// attachSellerAgent, which then returns the marker (a stop before listen()).
// A signal listener alone does not keep the process alive, so the wait holds a timer.
const untilStop = "const untilStop=()=>new Promise(resolve=>{const alive=setInterval(()=>{},1000);process.once('SIGTERM',()=>{clearInterval(alive);resolve();});});";
const operator = `${untilStop}
const bad=()=>{const error=Object.assign(new Error('retained holder'),{code:'journal-busy'});return Promise.reject(error);};
const out=(value)=>process.stdout.write(JSON.stringify(value)+String.fromCharCode(10));
let listener,stopped;const closed=new Promise(resolve=>{stopped=resolve;});
const close=()=>{out({ownedStopCalled:true});stopped();if(process.env.STOP_REFUSE==='1')return bad();clearInterval(listener);return Promise.resolve();};
export const prepareDevnetDemo=async()=>({composition:{},config:{},devnetAgreementTransport:{},close});
export const attachSellerAgent=async()=>{
  if(process.env.STOP_EARLY==='attach'){out({attachStarted:true});await untilStop();}
  return process.env.STOP_MARKER==='none'?undefined:process.env.STOP_MARKER==='mutable'?{ownedShutdown:1}:Object.freeze({ownedShutdown:1});
};
export const listen=async()=>{out({listenCalled:true});listener=setInterval(()=>{},1000);return {publicDescription:'test'};};
const purchase=async()=>{if(process.env.STOP_HANG!=='1')return {status:'held'};out({purchaseStarted:true});await closed;throw new Error('the native transport is closed');};
export const createBuyerDriver=()=>({purchase,resume:purchase});
export const createDevnetDemoOperator=async()=>({prepareDevnetDemo,attachSellerAgent,listen,createBuyerDriver,close});
`;
const legacy = "['none','mutable'].includes(process.env.STOP_MARKER)";
const early = "process.env.STOP_EARLY==='app'";
const out = "const out=(value)=>process.stdout.write(JSON.stringify(value)+String.fromCharCode(10));";
export async function load(url, context, next) {
  if(url.endsWith('/src/app.mjs'))return {format:'module',shortCircuit:true,source:`${out}${untilStop}export const createApp=async()=>{if(${early}){out({appCreated:true});await untilStop();}return {close:async()=>{if(${early})throw new Error('app close failed');if(${legacy}){out({appClosed:true});return;}throw new Error('entrypoint bypassed operator close');}};};`};
  if(url.endsWith('/src/devnet-demo/composition.mjs'))return {format:'module',shortCircuit:true,source:`export const createDevnetDemoComposition=async()=>({authority:'test',published:{},dacsProtocol:{},sellerAgent:{close(){if(${legacy}||${early}){process.stdout.write(JSON.stringify({agentClosed:true})+String.fromCharCode(10));return;}throw new Error('entrypoint closed agent itself');}}});`};
  if(url.endsWith('/src/devnet-demo/operator.mjs')||url.endsWith('/devnet-stop-operator.mjs'))return {format:'module',shortCircuit:true,source:operator};
  return next(url,context);
}
