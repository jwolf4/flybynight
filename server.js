const WebSocket = require('ws');
const server = new WebSocket.Server({ port: 8080 });
console.log('[server] Fly By Night signaling server running on ws://0.0.0.0:8080');

const slots = {
  1: {
    flyer: null,
    viewer: null
  }
};

server.on('connection', (ws) => {
  console.log('[server] New WebSocket connection established');

  ws.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch (e) {
      console.error('[server] Failed to parse message:', msg);
      return;
    }

    const slot = slots[data.slot];
    if (!slot) return;

    switch (data.type) {
      case 'go_live':
        console.log(`[server] Flyer started in slot ${data.slot}`);
        slot.flyer = ws;
        ws.on('close', () => {
          console.log(`[server] Flyer in slot ${data.slot} disconnected`);
          slot.flyer = null;
        });
        break;

      case 'jack_in':
        if (slot.flyer) {
          console.log(`[server] Viewer jacked into slot ${data.slot}`);
          slot.viewer = ws;
          slot.flyer.send(JSON.stringify({ type: 'need_offer', slot: data.slot }));

          ws.on('close', () => {
            console.log(`[server] Viewer in slot ${data.slot} disconnected`);
            slot.viewer = null;
          });
        } else {
          console.log(`[server] Viewer attempted to jack into empty slot ${data.slot}`);
          ws.send(JSON.stringify({ type: 'need_offer', slot: data.slot }));

          // Set up flyer logic in same session if they proceed
          ws.on('close', () => {
            if (slot.flyer === ws) {
              slot.flyer = null;
              console.log(`[server] Solo flyer disconnected from slot ${data.slot}`);
            }
          });
        }
        break;

      case 'offer':
        console.log(`[server] Offer received for slot ${data.slot}`);
        if (slot.viewer && slot.viewer.readyState === WebSocket.OPEN) {
          slot.viewer.send(JSON.stringify({ type: 'offer', offer: data.offer }));
        }
        break;

      case 'answer':
        console.log(`[server] Answer received for slot ${data.slot}`);
        if (slot.flyer && slot.flyer.readyState === WebSocket.OPEN) {
          slot.flyer.send(JSON.stringify({ type: 'answer', answer: data.answer }));
        }
        break;

      case 'ice':
        if (slot.flyer === ws && slot.viewer && slot.viewer.readyState === WebSocket.OPEN) {
          slot.viewer.send(JSON.stringify({ type: 'ice', candidate: data.candidate }));
        } else if (slot.viewer === ws && slot.flyer && slot.flyer.readyState === WebSocket.OPEN) {
          slot.flyer.send(JSON.stringify({ type: 'ice', candidate: data.candidate }));
        }
        break;

      default:
        console.log(`[server] Unknown message type: ${data.type}`);
    }
  });

  ws.on('close', () => {
    for (const slot of Object.values(slots)) {
      if (slot.flyer === ws) slot.flyer = null;
      if (slot.viewer === ws) slot.viewer = null;
    }
  });
});