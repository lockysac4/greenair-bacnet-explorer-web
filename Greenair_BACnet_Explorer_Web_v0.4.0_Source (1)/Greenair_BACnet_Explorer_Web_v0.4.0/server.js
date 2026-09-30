const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');

const VERSION = '0.4.0';
const PORT = Number(process.env.PORT || 10000);
const BMS_HOST = process.env.BMS_HOST || 'bms.biancoprecast.com.au';
const PLANKS_PORT = Number(process.env.PLANKS_PORT || 502);
const PLANKS_UNIT_ID = Number(process.env.PLANKS_UNIT_ID || 69);
const TBEAMS_PORT = Number(process.env.TBEAMS_PORT || 505);
const TBEAMS_UNIT_ID = Number(process.env.TBEAMS_UNIT_ID || 68);
const TCP_TIMEOUT_MS = Number(process.env.TCP_TIMEOUT_MS || 4500);

const systems = {
  planks: {
    id: 'planks', name: 'Bianco Planks', host: BMS_HOST, port: PLANKS_PORT, unitId: PLANKS_UNIT_ID,
    points: [
      { id:'in1', name:'Planks In', kind:'signed32Analog', highRegister:7484, register:7485, units:'°C' },
      { id:'in2', name:'Planks Out', kind:'signed32Analog', highRegister:7486, register:7487, units:'°C' },
      { id:'ambient', name:'Ambient', kind:'signed32Analog', highRegister:7488, register:7489, units:'°C' },
      { id:'concrete', name:'Planks Concrete', kind:'signed32Analog', highRegister:7490, register:7491, units:'°C' },
      { id:'tank', name:'Planks Tank', kind:'signed32Analog', highRegister:7492, register:7493, units:'°C' },
      { id:'diff', name:'Ambient - Concrete Differential', kind:'signed32Analog', highRegister:7502, register:7503, units:'°C' }
    ]
  },
  tbeams: {
    id: 'tbeams', name: 'Bianco T-Beams', host: BMS_HOST, port: TBEAMS_PORT, unitId: TBEAMS_UNIT_ID,
    points: [
      { id:'in1', name:'T-Beams In', kind:'signed32Analog', highRegister:7484, register:7485, units:'°C' },
      { id:'in2', name:'T-Beams Out', kind:'signed32Analog', highRegister:7486, register:7487, units:'°C' },
      { id:'ambient', name:'Ambient', kind:'signed32Analog', highRegister:8136, register:8137, units:'°C' },
      { id:'concrete', name:'T-Beams Concrete', kind:'signed32Analog', highRegister:7490, register:7491, units:'°C' },
      { id:'tank', name:'T-Beams Tank', kind:'signed32Analog', highRegister:7492, register:7493, units:'°C' },
      { id:'diff', name:'Ambient - Concrete Differential', kind:'signed32Analog', highRegister:7502, register:7503, units:'°C' }
    ]
  }
};

let transactionId = 1;
const nextTx = () => { transactionId = (transactionId % 0xffff) + 1; return transactionId; };

function modbusReadHolding({host, port, unitId, startRegister, quantity, timeoutMs = TCP_TIMEOUT_MS}) {
  return new Promise((resolve, reject) => {
    const tx = nextTx();
    const req = Buffer.alloc(12);
    req.writeUInt16BE(tx, 0);       // transaction id
    req.writeUInt16BE(0, 2);        // protocol id
    req.writeUInt16BE(6, 4);        // length
    req.writeUInt8(unitId, 6);      // unit
    req.writeUInt8(3, 7);           // FC03
    req.writeUInt16BE(startRegister, 8);
    req.writeUInt16BE(quantity, 10);

    const socket = net.createConnection({host, port});
    const chunks = [];
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => socket.write(req));
    socket.on('timeout', () => finish(new Error(`TCP timeout ${host}:${port} unit ${unitId}`)));
    socket.on('error', err => finish(err));
    socket.on('data', chunk => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (buf.length < 9) return;
      const mbapLength = buf.readUInt16BE(4);
      const frameLength = 6 + mbapLength;
      if (buf.length < frameLength) return;
      if (buf.readUInt16BE(0) !== tx) return finish(new Error('Modbus transaction ID mismatch'));
      const fn = buf.readUInt8(7);
      if (fn & 0x80) return finish(new Error(`Modbus exception ${buf.readUInt8(8)}`));
      if (fn !== 3) return finish(new Error(`Unexpected Modbus function ${fn}`));
      const byteCount = buf.readUInt8(8);
      if (byteCount !== quantity * 2) return finish(new Error(`Unexpected byte count ${byteCount}`));
      const regs = [];
      for (let i = 0; i < quantity; i++) regs.push(buf.readUInt16BE(9 + i * 2));
      finish(null, { registers: regs, rawHex: buf.subarray(0, frameLength).toString('hex').toUpperCase() });
    });
  });
}

function decodeSigned32(high, low, scale = 1000) {
  const u = ((BigInt(high) << 16n) | BigInt(low));
  const s = (u & 0x80000000n) ? u - 0x100000000n : u;
  return Number(s) / scale;
}

async function readPoint(system, point) {
  if (point.kind === 'signed32Analog') {
    const start = Math.min(point.highRegister, point.register);
    const qty = Math.abs(point.register - point.highRegister) + 1;
    const result = await modbusReadHolding({host: system.host, port: system.port, unitId: system.unitId, startRegister:start, quantity:qty});
    const hi = result.registers[point.highRegister - start];
    const lo = result.registers[point.register - start];
    return {...point, value: decodeSigned32(hi, lo), raw:[hi, lo], rawHex:result.rawHex, ok:true};
  }
  throw new Error(`Unsupported point kind ${point.kind}`);
}

async function readSystem(id) {
  const system = systems[id];
  if (!system) throw new Error('Unknown system');
  const started = Date.now();
  const points = [];
  for (const point of system.points) {
    try { points.push(await readPoint(system, point)); }
    catch (err) { points.push({...point, value:null, ok:false, error:err.message}); }
  }
  const okCount = points.filter(p => p.ok).length;
  return {
    id: system.id, name: system.name, host: system.host, port: system.port, unitId: system.unitId,
    online: okCount > 0, okCount, pointCount: points.length, elapsedMs: Date.now()-started,
    timestamp: new Date().toISOString(), points
  };
}

async function connectionTest(system) {
  const started = Date.now();
  try {
    const p = system.points[0];
    const point = await readPoint(system, p);
    return {id:system.id, name:system.name, online:true, host:system.host, port:system.port, unitId:system.unitId, elapsedMs:Date.now()-started, sample:{name:p.name,value:point.value,units:p.units}};
  } catch (err) {
    return {id:system.id, name:system.name, online:false, host:system.host, port:system.port, unitId:system.unitId, elapsedMs:Date.now()-started, error:err.message};
  }
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Content-Length':body.length,'Cache-Control':'no-store'});
  res.end(body);
}

function serveStatic(req, res) {
  let rel = req.url.split('?')[0];
  if (rel === '/') rel = '/index.html';
  const safe = path.normalize(rel).replace(/^([.][.][/\\])+/, '');
  const file = path.join(__dirname, 'public', safe);
  if (!file.startsWith(path.join(__dirname,'public'))) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
    res.writeHead(200, {'Content-Type':types[ext] || 'application/octet-stream','Cache-Control':'no-cache'});
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (u.pathname === '/api/status') return sendJson(res, 200, {ok:true, app:'Greenair BACnet Explorer Web', version:VERSION, transport:'Modbus TCP via Render', host:BMS_HOST, systems:Object.values(systems).map(s=>({id:s.id,name:s.name,port:s.port,unitId:s.unitId}))});
    if (u.pathname === '/api/connect') {
      const results = await Promise.all(Object.values(systems).map(connectionTest));
      return sendJson(res, 200, {ok:results.some(r=>r.online), timestamp:new Date().toISOString(), results});
    }
    if (u.pathname === '/api/systems') return sendJson(res, 200, {systems:Object.values(systems).map(s=>({id:s.id,name:s.name,host:s.host,port:s.port,unitId:s.unitId}))});
    const m = u.pathname.match(/^\/api\/system\/(planks|tbeams)$/);
    if (m) return sendJson(res, 200, await readSystem(m[1]));
    const raw = u.pathname.match(/^\/api\/raw\/(planks|tbeams)$/);
    if (raw) {
      const s = systems[raw[1]];
      const register = Number(u.searchParams.get('register'));
      const quantity = Math.min(64, Math.max(1, Number(u.searchParams.get('quantity') || 1)));
      if (!Number.isInteger(register) || register < 0 || register > 65535) return sendJson(res,400,{error:'register must be 0..65535'});
      const result = await modbusReadHolding({host:s.host,port:s.port,unitId:s.unitId,startRegister:register,quantity});
      return sendJson(res,200,{system:s.id,register,quantity,...result});
    }
    if (u.pathname.startsWith('/api/')) return sendJson(res,404,{error:'API route not found'});
    serveStatic(req,res);
  } catch (err) {
    console.error('[Explorer]', err);
    sendJson(res,500,{error:err.message || String(err)});
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Greenair BACnet Explorer Web v${VERSION}`);
  console.log(`Listening on 0.0.0.0:${PORT}`);
  console.log(`Bianco Planks -> ${BMS_HOST}:${PLANKS_PORT} unit ${PLANKS_UNIT_ID}`);
  console.log(`Bianco T-Beams -> ${BMS_HOST}:${TBEAMS_PORT} unit ${TBEAMS_UNIT_ID}`);
});
