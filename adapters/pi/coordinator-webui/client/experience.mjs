import view from "./entry.mjs";

const handlers = new Set();
const key = "pi-coordinator-experience-client";
let clientId;
try { clientId = localStorage.getItem(key); if (!clientId) { clientId = crypto.randomUUID(); localStorage.setItem(key, clientId); } }
catch { clientId = crypto.randomUUID(); }
let socket, reconnect, disposed = false;
const pending = [];
const publish = (payload) => { for (const handler of handlers) handler(payload); };
const send = (payload) => {
 const message = JSON.stringify({ type: "plugin_message", pluginId: "pi-coordinator", payload });
 if (socket?.readyState === WebSocket.OPEN) socket.send(message);
 else { if (pending.length >= 100) throw Error("Connection queue is full"); pending.push(message); }
};
const unmount = view.mount(document.querySelector("#coordinator"), {
 send,
 onData(handler) { handlers.add(handler); return () => handlers.delete(handler); },
});
function connect() {
 if (disposed) return;
 socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
 socket.addEventListener("open", () => {
  socket.send(JSON.stringify({ type: "hello", clientId, locale: "zh" }));
  for (const message of pending.splice(0)) socket.send(message);
  send({ type: "coordinator-get" });
 });
 socket.addEventListener("message", (event) => {
  let message; try { message = JSON.parse(event.data); } catch { return; }
  if (message.type === "plugin_data" && message.pluginId === "pi-coordinator") publish(message.payload);
 });
 socket.addEventListener("close", () => { if (!disposed) reconnect = setTimeout(connect, 1500); });
 socket.addEventListener("error", () => socket.close());
}
window.addEventListener("pagehide", () => { disposed = true; clearTimeout(reconnect); socket?.close(); unmount?.(); }, { once: true });
connect();
