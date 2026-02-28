const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8080 });

const slots = {
  1: null,
  2: null,
  3: null,
  4: null,
  5: null
};

wss.on('connection', (ws) => {
  console.log('New connection');

  ws.on('message', (message) => {
    console.log('Received:', message);

    let msg;
    try {
      msg = JSON.parse(message);
    } catch (e) {
      console.log('Invalid JSON');
      return;
    }

    if (msg.type === 'go_live') {
      const slot = msg.slot || 1;  // Default to Slot 1 for now
      slots[slot] = ws;
      ws.slot = slot;
      ws.isFlyer = true;
      console.log(`Flyer went live in Slot ${slot}`);
    }

    if (msg.type === 'jack_in') {
      const slot = msg.slot || 1;
      const flyer = slots[slot];
      if (flyer) {
        console.log(`Viewer jacked into Slot ${slot}`);
        // In a real implementation you'd relay SDP offers/candidates here.
        flyer.send(JSON.stringify({ type: 'viewer_joined', slot }));
      } else {
        console.log(`Viewer tried to jack into empty Slot ${slot}`);
      }
    }

    if (msg.type === 'signal') {
      // Just log signaling message for now
      console.log(`Signal message: ${JSON.stringify(msg)}`);
    }
  });

  ws.on('close', () => {
    if (ws.isFlyer && ws.slot) {
      console.log(`Flyer disconnected from Slot ${ws.slot}`);
      slots[ws.slot] = null;
    }
  });
});

console.log('Fly By Night signaling server running on ws://0.0.0.0:8080');