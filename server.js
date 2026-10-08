const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const dgram = require('dgram');

const VERSION = '0.7.5';
const PORT = Number(process.env.PORT || 10000);
const BMS_HOST = process.env.BMS_HOST || 'bms.biancoprecast.com.au';
const TCP_TIMEOUT_MS = Number(process.env.TCP_TIMEOUT_MS || 4500);
const ENABLE_WRITES = /^(1|true|yes)$/i.test(process.env.ENABLE_WRITES || 'false');
const ENABLE_PROGRAM_WRITES = /^(1|true|yes)$/i.test(process.env.ENABLE_PROGRAM_WRITES || 'false');
const PROGRAM_IMAGE_BYTES = 2000;
const PROGRAM_BLOCK_BYTES = 400;
const PROGRAM_BLOCK_COUNT = 5;
const PROGRAM_SLOT_COUNT = 16;
const PROGRAM_BRIDGE_URL = String(process.env.PROGRAM_BRIDGE_URL || '').replace(/\/$/, '');
const PROGRAM_BRIDGE_TOKEN = String(process.env.PROGRAM_BRIDGE_TOKEN || '');
const PROGRAM_WRITE_TRANSPORT_READY = Boolean(PROGRAM_BRIDGE_URL); // writes stay bridge-locked until separately verified
const PROGRAM_READ_TRANSPORT_READY = true; // direct read-only Temco BACnet/IP transport
const BACNET_HOST = process.env.BACNET_HOST || BMS_HOST;
const BACNET_PORT = Number(process.env.BACNET_PORT || 47808);
const BACNET_DEVICE_INSTANCE = Number(process.env.BACNET_DEVICE_INSTANCE || 110605);
const BACNET_PROBE_TIMEOUT_MS = Number(process.env.BACNET_PROBE_TIMEOUT_MS || 3500);

const systems = {
  planks: {
    id:'planks', name:'Bianco Planks', host:BMS_HOST,
    port:Number(process.env.PLANKS_PORT || 502), unitId:Number(process.env.PLANKS_UNIT_ID || 69),
    inputs:[
      {id:'in1',name:'Planks In',kind:'signed32Analog',highRegister:7484,register:7485,units:'°C'},
      {id:'in2',name:'Planks Out',kind:'signed32Analog',highRegister:7486,register:7487,units:'°C'},
      {id:'ambient',name:'Ambient',kind:'signed32Analog',highRegister:7488,register:7489,units:'°C'},
      {id:'concrete',name:'Planks Concrete',kind:'signed32Analog',highRegister:7490,register:7491,units:'°C'},
      {id:'tank',name:'Planks Tank',kind:'signed32Analog',highRegister:7492,register:7493,units:'°C'},
      {id:'diff',name:'Concrete - Ambient Differential',kind:'signed32Analog',highRegister:7502,register:7503,units:'°C'}
    ],
    outputs:[
      {id:'out1Boiler',name:'OUT1 - Boiler Enable',kind:'uint16',register:7101,units:'0/1',writable:false,note:'Actual output state'},
      {id:'out2Pump',name:'OUT2 - Pump Enable',kind:'uint16',register:7103,units:'0/1',writable:false,note:'Actual output state'},
      {id:'out9SecondaryPump',name:'OUT9 - Secondary Pump',kind:'uint16',register:7117,units:'%',writable:false,note:'Actual output value 0-100%'}
    ],
    overrides:[
      {id:'boilerEnable',name:'Boiler Override Command',kind:'uint16',register:8115,units:'0/1',writable:true,min:0,max:1},
      {id:'pumpEnable',name:'Pump Override Command',kind:'uint16',register:8113,units:'0/1',writable:true,min:0,max:1},
      {id:'appOverride',name:'AUTO / MANUAL Command',kind:'uint16',register:8111,units:'0/1',writable:true,min:0,max:1},
      {id:'lossWaterFlow',name:'Loss of Water Flow',kind:'uint16',register:8117,units:'0/1',writable:false}
    ],
    variables:[
      {id:'ambientDifferential',name:'Ambient differential',kind:'uint16',register:952,units:'raw',note:'Known Bravo/T3000 variable register from the Windows project. Scaling is intentionally left raw until verified.'}
    ]
  },
  tbeams: {
    id:'tbeams', name:'Bianco T-Beams', host:BMS_HOST,
    port:Number(process.env.TBEAMS_PORT || 505), unitId:Number(process.env.TBEAMS_UNIT_ID || 68),
    inputs:[
      {id:'in1',name:'T-Beams In',kind:'signed32Analog',highRegister:7484,register:7485,units:'°C'},
      {id:'in2',name:'T-Beams Out',kind:'signed32Analog',highRegister:7486,register:7487,units:'°C'},
      {id:'ambient',name:'Ambient',kind:'signed32Analog',highRegister:8136,register:8137,units:'°C'},
      {id:'concrete',name:'T-Beams Concrete',kind:'signed32Analog',highRegister:7490,register:7491,units:'°C'},
      {id:'tank',name:'T-Beams Tank',kind:'signed32Analog',highRegister:7492,register:7493,units:'°C'},
      {id:'diff',name:'Concrete - Ambient Differential',kind:'signed32Analog',highRegister:7502,register:7503,units:'°C'}
    ],
    outputs:[],
    overrides:[
      {id:'boilerEnable',name:'T-Beams Boiler Override Command',kind:'uint16',register:8115,units:'0/1',writable:true,min:0,max:1},
      {id:'pumpEnable',name:'T-Beams Pump Override Command',kind:'uint16',register:8113,units:'0/1',writable:true,min:0,max:1},
      {id:'appOverride',name:'T-Beams AUTO / MANUAL Command',kind:'uint16',register:8111,units:'0/1',writable:true,min:0,max:1},
      {id:'lossWaterFlow',name:'Loss of Water Flow',kind:'uint16',register:8117,units:'0/1',writable:false}
    ],
    variables:[]
  }
};

let transactionId = 1;
const nextTx = () => { transactionId=(transactionId%0xffff)+1; return transactionId; };
function makeRequest(unitId, fn, register, valueOrQty){
  const tx=nextTx(), req=Buffer.alloc(12);
  req.writeUInt16BE(tx,0); req.writeUInt16BE(0,2); req.writeUInt16BE(6,4); req.writeUInt8(unitId,6); req.writeUInt8(fn,7); req.writeUInt16BE(register,8); req.writeUInt16BE(valueOrQty,10);
  return {tx,req};
}
function socketExchange({host,port,request,tx,timeoutMs=TCP_TIMEOUT_MS}){
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection({host,port}); const chunks=[]; let settled=false;
    const finish=(err,val)=>{if(settled)return;settled=true;socket.destroy();err?reject(err):resolve(val)};
    socket.setTimeout(timeoutMs); socket.on('connect',()=>socket.write(request)); socket.on('timeout',()=>finish(new Error(`TCP timeout ${host}:${port}`))); socket.on('error',finish);
    socket.on('data',chunk=>{chunks.push(chunk);const buf=Buffer.concat(chunks);if(buf.length<9)return;const frameLength=6+buf.readUInt16BE(4);if(buf.length<frameLength)return;if(buf.readUInt16BE(0)!==tx)return finish(new Error('Modbus transaction ID mismatch'));finish(null,buf.subarray(0,frameLength));});
  });
}
async function modbusReadHolding({host,port,unitId,startRegister,quantity}){
  if(!Number.isInteger(quantity)||quantity<1||quantity>125)throw new Error('quantity must be 1..125');
  const {tx,req}=makeRequest(unitId,3,startRegister,quantity); const buf=await socketExchange({host,port,request:req,tx});
  const fn=buf.readUInt8(7); if(fn&0x80)throw new Error(`Modbus exception ${buf.readUInt8(8)}`); if(fn!==3)throw new Error(`Unexpected Modbus function ${fn}`);
  const byteCount=buf.readUInt8(8); if(byteCount!==quantity*2)throw new Error(`Unexpected byte count ${byteCount}`);
  const registers=[];for(let i=0;i<quantity;i++)registers.push(buf.readUInt16BE(9+i*2));
  return {registers,rawHex:buf.toString('hex').toUpperCase()};
}
async function modbusWriteSingle({host,port,unitId,register,value}){
  const {tx,req}=makeRequest(unitId,6,register,value); const buf=await socketExchange({host,port,request:req,tx});
  const fn=buf.readUInt8(7); if(fn&0x80)throw new Error(`Modbus exception ${buf.readUInt8(8)}`); if(fn!==6)throw new Error(`Unexpected Modbus function ${fn}`);
  if(buf.length<12||buf.readUInt16BE(8)!==register||buf.readUInt16BE(10)!==value)throw new Error('FC06 write verification echo mismatch');
  return {register:buf.readUInt16BE(8),value:buf.readUInt16BE(10),rawHex:buf.toString('hex').toUpperCase()};
}
function decodeSigned32(high,low,scale=1000){const u=(BigInt(high)<<16n)|BigInt(low);const s=(u&0x80000000n)?u-0x100000000n:u;return Number(s)/scale}
async function readPoint(system,point){
  if(point.kind==='signed32Analog'){const start=Math.min(point.highRegister,point.register),qty=Math.abs(point.register-point.highRegister)+1;const r=await modbusReadHolding({host:system.host,port:system.port,unitId:system.unitId,startRegister:start,quantity:qty});const hi=r.registers[point.highRegister-start],lo=r.registers[point.register-start];return {...point,value:decodeSigned32(hi,lo),raw:[hi,lo],ok:true};}
  if(point.kind==='uint16'){const r=await modbusReadHolding({host:system.host,port:system.port,unitId:system.unitId,startRegister:point.register,quantity:1});return {...point,value:r.registers[0],raw:[r.registers[0]],ok:true};}
  throw new Error(`Unsupported point kind ${point.kind}`);
}
async function readCategory(id,category){const s=systems[id];if(!s)throw new Error('Unknown system');const defs=s[category];if(!Array.isArray(defs))throw new Error('Unknown category');const started=Date.now(),points=[];for(const p of defs){try{points.push(await readPoint(s,p))}catch(e){points.push({...p,value:null,ok:false,error:e.message})}}const okCount=points.filter(p=>p.ok).length;return{id:s.id,name:s.name,category,host:s.host,port:s.port,unitId:s.unitId,online:defs.length?okCount>0:true,okCount,pointCount:points.length,elapsedMs:Date.now()-started,timestamp:new Date().toISOString(),points};}
async function connectionTest(s){const started=Date.now();try{const p=s.inputs[0],point=await readPoint(s,p);return{id:s.id,name:s.name,online:true,host:s.host,port:s.port,unitId:s.unitId,elapsedMs:Date.now()-started,sample:{name:p.name,value:point.value,units:p.units}}}catch(e){return{id:s.id,name:s.name,online:false,host:s.host,port:s.port,unitId:s.unitId,elapsedMs:Date.now()-started,error:e.message}}}
function getWritablePoint(system,id){return (system.overrides||[]).find(p=>p.id===id&&p.writable);}
async function guardedWrite(systemId,pointId,value){
  if(!ENABLE_WRITES)throw new Error('Writes are disabled on the server. Set ENABLE_WRITES=true in Render only after verification.');
  const s=systems[systemId];if(!s)throw new Error('Unknown system');const p=getWritablePoint(s,pointId);if(!p)throw new Error('Point is not on the write allow-list');
  if(!Number.isInteger(value)||value<p.min||value>p.max)throw new Error(`Value must be an integer from ${p.min} to ${p.max}`);
  const before=(await readPoint(s,p)).value; const wr=await modbusWriteSingle({host:s.host,port:s.port,unitId:s.unitId,register:p.register,value});
  const after=(await readPoint(s,p)).value;if(after!==value)throw new Error(`Write read-back mismatch: requested ${value}, controller returned ${after}`);
  return {ok:true,system:systemId,point:pointId,name:p.name,register:p.register,before,requested:value,readBack:after,write:wr,timestamp:new Date().toISOString()};
}

function sha256(buf){return crypto.createHash('sha256').update(buf).digest('hex');}


// -----------------------------------------------------------------------------
// BACnet/IP read-only diagnostics
// -----------------------------------------------------------------------------
function hex(buf){return Buffer.from(buf||[]).toString('hex').toUpperCase();}
function buildBacnetUnicast(npduApdu){
  const body=Buffer.from(npduApdu);
  const out=Buffer.alloc(4+body.length);
  out[0]=0x81; // BVLC type: BACnet/IP
  out[1]=0x0A; // Original-Unicast-NPDU
  out.writeUInt16BE(out.length,2);
  body.copy(out,4);
  return out;
}
function buildWhoIs(){
  // NPDU version 1, no destination/source specifier, then Unconfirmed-REQ / Who-Is.
  return buildBacnetUnicast(Buffer.from([0x01,0x00,0x10,0x08]));
}
function bacnetNpduApduOffset(buf){
  if(!Buffer.isBuffer(buf)||buf.length<8||buf[0]!==0x81)return null;
  let p=4;
  if(buf[p++]!==0x01)return null;
  const control=buf[p++];
  if(control&0x20){if(p+3>buf.length)return null;p+=2;const dlen=buf[p++];p+=dlen+1;}
  if(control&0x08){if(p+3>buf.length)return null;p+=2;const slen=buf[p++];p+=slen;}
  if(control&0x80)return {offset:p,networkMessage:true,control};
  return {offset:p,networkMessage:false,control};
}
function parseIAm(buf,rinfo){
  const h=bacnetNpduApduOffset(buf);if(!h||h.networkMessage||h.offset+2>buf.length)return null;
  const pdu=buf[h.offset], service=buf[h.offset+1];
  if((pdu&0xF0)!==0x10||service!==0x00)return null; // Unconfirmed I-Am
  let p=h.offset+2, deviceInstance=null, objectType=null;
  for(let i=p;i+4<buf.length;i++){
    if(buf[i]===0xC4){const oid=buf.readUInt32BE(i+1);objectType=(oid>>>22)&0x3FF;deviceInstance=oid&0x3FFFFF;break;}
  }
  return {type:'I-Am',from:`${rinfo.address}:${rinfo.port}`,deviceInstance,objectType,rawHex:hex(buf)};
}
function classifyBacnetReply(buf,rinfo){
  const h=bacnetNpduApduOffset(buf);const base={from:`${rinfo.address}:${rinfo.port}`,rawHex:hex(buf)};
  if(!h)return {...base,type:'Unknown BACnet/IP frame'};
  if(h.networkMessage)return {...base,type:'BACnet network-layer message'};
  if(h.offset>=buf.length)return {...base,type:'Empty APDU'};
  const t=(buf[h.offset]>>4)&0x0F;
  const names={0:'Confirmed-Request',1:'Unconfirmed-Request',2:'Simple-ACK',3:'Complex-ACK',4:'Segment-ACK',5:'Error',6:'Reject',7:'Abort'};
  const out={...base,type:names[t]||`APDU-${t}`,pduType:t};
  if(t===1&&buf[h.offset+1]===0)return parseIAm(buf,rinfo)||out;
  if([2,3,5,6,7].includes(t)&&h.offset+1<buf.length)out.invokeId=buf[h.offset+1];
  if([2,3,5].includes(t)&&h.offset+2<buf.length)out.serviceChoice=buf[h.offset+2];
  if([0,3,5].includes(t)){try{const a=analyzePrivateTransferFrame(hex(buf));if(a.serviceChoice===0x12)out.privateTransfer={vendorId:a.vendorId,serviceNumber:a.serviceNumber,parametersHex:a.parametersHex,temcoVendor:a.temcoVendor};}catch{}}
  if(t===6&&h.offset+2<buf.length)out.rejectReason=buf[h.offset+2];
  if(t===7&&h.offset+2<buf.length)out.abortReason=buf[h.offset+2];
  return out;
}
function udpRequest(packet,{host=BACNET_HOST,port=BACNET_PORT,timeoutMs=BACNET_PROBE_TIMEOUT_MS,collectAll=false}={}){
  return new Promise((resolve,reject)=>{
    const sock=dgram.createSocket('udp4');const replies=[];let settled=false;
    const done=(err)=>{if(settled)return;settled=true;clearTimeout(timer);try{sock.close()}catch{};err?reject(err):resolve(replies)};
    const timer=setTimeout(()=>done(),timeoutMs);
    sock.on('error',done);
    sock.on('message',(msg,rinfo)=>{replies.push({buffer:Buffer.from(msg),rinfo});if(!collectAll)done();});
    sock.bind(0,()=>sock.send(packet,port,host,err=>{if(err)done(err)}));
  });
}
async function bacnetWhoIsProbe(){
  const tx=buildWhoIs(),started=Date.now();
  const replies=await udpRequest(tx,{collectAll:true});
  return {ok:true,host:BACNET_HOST,port:BACNET_PORT,expectedDeviceInstance:BACNET_DEVICE_INSTANCE,elapsedMs:Date.now()-started,txHex:hex(tx),replyCount:replies.length,replies:replies.map(x=>classifyBacnetReply(x.buffer,x.rinfo))};
}
function encodeContextUnsigned(tag,value){
  if(!Number.isInteger(value)||value<0)throw new Error('BACnet unsigned value must be a non-negative integer');
  let bytes;if(value<=0xFF)bytes=Buffer.from([value]);else if(value<=0xFFFF){bytes=Buffer.alloc(2);bytes.writeUInt16BE(value)}else{bytes=Buffer.alloc(4);bytes.writeUInt32BE(value>>>0)}
  if(tag<0||tag>14)throw new Error('Only simple context tags are supported by this diagnostic encoder');
  return Buffer.concat([Buffer.from([(tag<<4)|0x08|bytes.length]),bytes]);
}
function encodeApplicationOctetString(data){
  data=Buffer.from(data||[]);const tag=6;
  if(data.length<=4)return Buffer.concat([Buffer.from([(tag<<4)|data.length]),data]);
  if(data.length<=253)return Buffer.concat([Buffer.from([(tag<<4)|5,data.length]),data]);
  throw new Error('Diagnostic octet string is intentionally limited to 253 bytes');
}
function buildNoEffectPrivateTransfer(invokeId=1){
  // ANSI/ASHRAE reserved ConfirmedPrivateTransfer interoperability test:
  // Vendor ID 0, Service Number 0, serviceParameters = application OCTET STRING.
  const params=Buffer.concat([
    encodeContextUnsigned(0,0),
    encodeContextUnsigned(1,0),
    Buffer.from([0x2E]), // opening context tag 2
    encodeApplicationOctetString(Buffer.from([0x00])),
    Buffer.from([0x2F])  // closing context tag 2
  ]);
  const apdu=Buffer.concat([Buffer.from([0x00,0x05,invokeId&0xFF,0x12]),params]);
  return buildBacnetUnicast(Buffer.concat([Buffer.from([0x01,0x04]),apdu])); // expecting reply
}
async function bacnetPrivateTransferNoEffectTest(){
  const invokeId=(Date.now()&0xFF)||1,tx=buildNoEffectPrivateTransfer(invokeId),started=Date.now();
  const replies=await udpRequest(tx,{collectAll:false});
  return {ok:true,safeTest:true,standardTest:'ConfirmedPrivateTransfer Vendor 0 / Service 0',host:BACNET_HOST,port:BACNET_PORT,invokeId,elapsedMs:Date.now()-started,txHex:hex(tx),replyCount:replies.length,replies:replies.map(x=>classifyBacnetReply(x.buffer,x.rinfo)),note:'This probe uses the ASHRAE-reserved private-transfer test message and does not send any Temco program command.'};
}


// -----------------------------------------------------------------------------
// Temco/T3000 direct program read transport (READ ONLY)
// Matches T3000 GetPrivateData(): Vendor 148, private service 1, application
// OCTET STRING containing the 7-byte Str_user_data_header.
// -----------------------------------------------------------------------------
function buildTemcoPrivateHeader(command,startInstance,endInstance,entitySize){
  if(!Number.isInteger(command)||command<0||command>255)throw new Error('Temco command must be 0..255');
  if(!Number.isInteger(startInstance)||startInstance<0||startInstance>255)throw new Error('Temco start instance must be 0..255');
  if(!Number.isInteger(endInstance)||endInstance<0||endInstance>255)throw new Error('Temco end instance must be 0..255');
  if(!Number.isInteger(entitySize)||entitySize<0||entitySize>65535)throw new Error('Temco entity size must be 0..65535');
  const h=Buffer.alloc(7);
  h.writeUInt16LE(7,0); // PRIVATE_HEAD_LENGTH / total_length for a read request
  h[2]=command; h[3]=startInstance; h[4]=endInstance; h.writeUInt16LE(entitySize,5);
  return h;
}
function buildTemcoConfirmedPrivateTransfer({invokeId,command,startInstance,endInstance,entitySize}){
  const vendorId=148,serviceNumber=1;
  const privateHeader=buildTemcoPrivateHeader(command,startInstance,endInstance,entitySize);
  const serviceParameters=encodeApplicationOctetString(privateHeader);
  const params=Buffer.concat([
    encodeContextUnsigned(0,vendorId),
    encodeContextUnsigned(1,serviceNumber),
    Buffer.from([0x2E]),
    serviceParameters,
    Buffer.from([0x2F])
  ]);
  // Max-Segments-Accepted >64 and Max-APDU-Accepted 1476. The controller's
  // program response is split into 400-byte Temco packages.
  const apdu=Buffer.concat([Buffer.from([0x00,0x75,invokeId&0xFF,0x12]),params]);
  const frame=buildBacnetUnicast(Buffer.concat([Buffer.from([0x01,0x04]),apdu]));
  return {frame,privateHeader,vendorId,serviceNumber};
}
function parsePrivateTransferPayload(payload){
  let cursor=0,vendorId=null,serviceNumber=null,paramBytes=null;
  while(cursor<payload.length){
    const tag=readBacnetTag(payload,cursor);cursor=tag.next;
    if(tag.context&&!tag.opening&&!tag.closing&&tag.tagNumber===0&&vendorId===null){vendorId=unsignedFromBytes(tag.value);continue;}
    if(tag.context&&!tag.opening&&!tag.closing&&tag.tagNumber===1&&serviceNumber===null){serviceNumber=unsignedFromBytes(tag.value);continue;}
    if(tag.context&&tag.opening&&tag.tagNumber===2){
      const app=readBacnetTag(payload,cursor);
      if(app.context||app.tagNumber!==6)throw new Error('Temco PrivateTransfer serviceParameters is not an application OCTET STRING');
      paramBytes=Buffer.from(app.value);cursor=app.next;
      if(cursor<payload.length){const close=readBacnetTag(payload,cursor);if(!(close.context&&close.closing&&close.tagNumber===2))throw new Error('Temco PrivateTransfer context-2 closing tag is missing');}
      break;
    }
  }
  if(vendorId===null||serviceNumber===null||!paramBytes)throw new Error('Incomplete PrivateTransfer acknowledgement');
  return {vendorId,serviceNumber,paramBytes};
}
function parseComplexAckFragment(buf,rinfo){
  const h=bacnetNpduApduOffset(buf);if(!h||h.networkMessage||h.offset>=buf.length)return null;
  const p=h.offset,first=buf[p],type=(first>>4)&0x0F;
  if(type===6)return {error:`BACnet Reject ${buf[p+2]??'?'}`,rawHex:hex(buf),from:rinfo?`${rinfo.address}:${rinfo.port}`:null};
  if(type===7)return {error:`BACnet Abort ${buf[p+2]??'?'}`,rawHex:hex(buf),from:rinfo?`${rinfo.address}:${rinfo.port}`:null};
  if(type===5)return {error:'BACnet Error response',rawHex:hex(buf),from:rinfo?`${rinfo.address}:${rinfo.port}`:null};
  if(type!==3)return null;
  const segmented=Boolean(first&0x08),moreFollows=Boolean(first&0x04),invokeId=buf[p+1];
  let sequenceNumber=null,windowSize=null,serviceChoice=null,payloadStart=null;
  if(segmented){
    if(p+5>buf.length)return null;
    sequenceNumber=buf[p+2];windowSize=buf[p+3];serviceChoice=buf[p+4];payloadStart=p+5;
  }else{
    if(p+3>buf.length)return null;
    serviceChoice=buf[p+2];payloadStart=p+3;
  }
  return {invokeId,segmented,moreFollows,sequenceNumber,windowSize,serviceChoice,payload:Buffer.from(buf.subarray(payloadStart)),rawHex:hex(buf),from:rinfo?`${rinfo.address}:${rinfo.port}`:null};
}
function decodeTemcoOctets(octets){
  if(!Buffer.isBuffer(octets)||octets.length<7)throw new Error('Temco private payload is shorter than its 7-byte header');
  return {
    totalLength:octets.readUInt16LE(0),
    command:octets[2],
    startInstance:octets[3],
    endInstance:octets[4],
    entitySize:octets.readUInt16LE(5),
    data:Buffer.from(octets.subarray(7)),
    rawHex:hex(octets)
  };
}
function extractTemcoAcks(replies,invokeId){
  const fragments=[],errors=[];
  for(const r of replies){const f=parseComplexAckFragment(r.buffer,r.rinfo);if(!f)continue;if(f.error){errors.push(f);continue;}if(f.invokeId===invokeId&&f.serviceChoice===0x12)fragments.push(f);}
  const out=[];
  // Standard BACnet segmented Complex-ACK: concatenate APDU payload fragments first.
  const segmented=fragments.filter(f=>f.segmented).sort((a,b)=>a.sequenceNumber-b.sequenceNumber);
  if(segmented.length){
    try{
      const combined=Buffer.concat(segmented.map(f=>f.payload));
      const pt=parsePrivateTransferPayload(combined);
      if(pt.vendorId===148&&pt.serviceNumber===1)out.push({...decodeTemcoOctets(pt.paramBytes),transport:'segmented-complex-ack',segments:segmented.length});
    }catch(e){errors.push({error:'Segmented PrivateTransfer decode: '+e.message});}
  }
  // Some Temco firmware emits a separate full PrivateTransfer ACK for each
  // 400-byte program package. Preserve and decode every one of them.
  for(const f of fragments.filter(f=>!f.segmented)){
    try{
      const pt=parsePrivateTransferPayload(f.payload);
      if(pt.vendorId!==148||pt.serviceNumber!==1)continue;
      out.push({...decodeTemcoOctets(pt.paramBytes),transport:'complex-ack',from:f.from});
    }catch(e){errors.push({error:'PrivateTransfer decode: '+e.message,rawHex:f.rawHex});}
  }
  return {acks:out,errors,replyCount:replies.length};
}
async function temcoPrivateRead({command,startInstance,endInstance,entitySize,timeoutMs=Math.max(BACNET_PROBE_TIMEOUT_MS,5000)}){
  const invokeId=((Date.now()+command+startInstance)&0xFF)||1;
  const built=buildTemcoConfirmedPrivateTransfer({invokeId,command,startInstance,endInstance,entitySize});
  const started=Date.now();
  const replies=await udpRequest(built.frame,{host:BACNET_HOST,port:BACNET_PORT,timeoutMs,collectAll:true});
  const decoded=extractTemcoAcks(replies,invokeId);
  if(!decoded.acks.length){
    const detail=decoded.errors.length?decoded.errors.map(x=>x.error).join('; '):'no matching Complex-ACK received';
    throw new Error(`Temco command ${command} received ${replies.length} BACnet frame(s) but ${detail}`);
  }
  return {invokeId,command,startInstance,endInstance,entitySize,elapsedMs:Date.now()-started,txHex:hex(built.frame),...decoded};
}
function cleanAscii(buf){return Buffer.from(buf).toString('latin1').replace(/\0.*$/s,'').trim();}
function decodeProgramMetadata(ack,slotIndex){
  if(ack.command!==7)throw new Error(`Expected Temco command 7 metadata, received command ${ack.command}`);
  if(ack.startInstance!==slotIndex)throw new Error(`Program metadata slot mismatch: expected ${slotIndex}, received ${ack.startInstance}`);
  if(ack.data.length<37)throw new Error(`Program metadata payload is ${ack.data.length} bytes; expected at least 37`);
  const d=ack.data.subarray(0,37);
  const bytes=d.readUInt16LE(30);
  return {description:cleanAscii(d.subarray(0,21)),label:cleanAscii(d.subarray(21,30)),bytes,onOff:d[32],autoManual:d[33],comProgram:d[34],errCode:d[35],unused:d[36],rawHex:hex(d)};
}
async function readProgramMetadataDirect(slot){
  const slotIndex=slot-1;
  const r=await temcoPrivateRead({command:7,startInstance:slotIndex,endInstance:slotIndex,entitySize:37,timeoutMs:4500});
  const ack=r.acks.find(a=>a.command===7&&a.startInstance===slotIndex)||r.acks[0];
  return {metadata:decodeProgramMetadata(ack,slotIndex),transport:r};
}
async function readProgramCodeDirect(slot,metadataBytes){
  const slotIndex=slot-1;
  const requestedBytes=Math.max(0,Math.min(PROGRAM_IMAGE_BYTES,Number(metadataBytes)||0));
  const entitySize=Math.min(65535,(requestedBytes||400)+10);
  const image=Buffer.alloc(PROGRAM_IMAGE_BYTES,0),packages=new Map(),attempts=[],shortResponses=[];
  for(let attempt=1;attempt<=3&&packages.size<PROGRAM_BLOCK_COUNT;attempt++){
    const r=await temcoPrivateRead({command:16,startInstance:slotIndex,endInstance:slotIndex,entitySize,timeoutMs:5500});
    attempts.push({attempt,invokeId:r.invokeId,replyCount:r.replyCount,ackCount:r.acks.length,errors:r.errors});
    for(const ack of r.acks){
      if(ack.command!==16||ack.startInstance!==slotIndex)continue;
      const packageIndex=(ack.entitySize>>9)&0x7F;
      if(ack.data.length<PROGRAM_BLOCK_BYTES){
        shortResponses.push({attempt,packageIndex,entitySize:ack.entitySize,dataLength:ack.data.length,first64Hex:hex(ack.data.subarray(0,64))});
        continue;
      }
      if(packageIndex<0||packageIndex>=PROGRAM_BLOCK_COUNT)continue;
      if(!packages.has(packageIndex))packages.set(packageIndex,Buffer.from(ack.data.subarray(0,PROGRAM_BLOCK_BYTES)));
    }
  }
  for(const [idx,data] of packages)data.copy(image,idx*PROGRAM_BLOCK_BYTES);
  const embeddedLength=packages.has(0)?packages.get(0).readUInt16LE(0):null;
  if(packages.size!==PROGRAM_BLOCK_COUNT){
    const detail=shortResponses.length?' Short responses: '+shortResponses.map(x=>'attempt '+x.attempt+' index '+x.packageIndex+' '+x.dataLength+' bytes (entitySize '+x.entitySize+', first64 '+x.first64Hex+')').join('; '):' No short code responses captured.';
    throw new Error('Program read incomplete: '+packages.size+'/5 full 400-byte packages; received '+shortResponses.length+' short response(s).'+detail+' Raw data preserved in diagnostic error; no write attempted.');
  }
  if(embeddedLength!==null&&embeddedLength>PROGRAM_IMAGE_BYTES)throw new Error('Controller returned invalid embedded program length '+embeddedLength);
  return {image,embeddedLength,packages:[...packages.keys()].sort(),attempts,entitySize};
}
async function loadProgramDirect(systemId,slot){
  if(!validProgramSlot(slot))throw new Error('Program slot must be 1..16');
  const system=systems[systemId];if(!system)throw new Error('Unknown system');
  const meta=await readProgramMetadataDirect(slot);
  const code=await readProgramCodeDirect(slot,meta.metadata.bytes);
  return {system:systemId,slot,controller:{host:system.host,port:system.port,unitId:system.unitId,bacnetHost:BACNET_HOST,bacnetPort:BACNET_PORT,deviceInstance:BACNET_DEVICE_INSTANCE},metadata:meta.metadata,image:code.image,embeddedLength:code.embeddedLength,packages:code.packages,attempts:code.attempts,entitySize:code.entitySize};
}
function cleanHexInput(text){
  const clean=String(text||'').replace(/0x/gi,'').replace(/[^0-9a-f]/gi,'');
  if(!clean)throw new Error('No BACnet packet hex supplied');
  if(clean.length%2)throw new Error('BACnet packet hex contains an incomplete byte');
  return clean;
}
function readBacnetTag(buf,pos){
  if(pos>=buf.length)throw new Error('Unexpected end of BACnet tag stream');
  const first=buf[pos++],tagNumber=(first>>4)&0x0F,context=Boolean(first&0x08),lvt=first&0x07;
  if(tagNumber===0x0F)throw new Error('Extended BACnet tag numbers are not supported by this analyzer yet');
  if(context&&(lvt===6||lvt===7))return {tagNumber,context,opening:lvt===6,closing:lvt===7,length:0,headerLength:1,next:pos};
  let length=lvt;
  if(lvt===5){
    if(pos>=buf.length)throw new Error('Missing extended BACnet tag length');
    const ext=buf[pos++];
    if(ext<=253)length=ext;
    else if(ext===254){if(pos+2>buf.length)throw new Error('Truncated 16-bit BACnet tag length');length=buf.readUInt16BE(pos);pos+=2;}
    else{if(pos+4>buf.length)throw new Error('Truncated 32-bit BACnet tag length');length=buf.readUInt32BE(pos);pos+=4;}
  }
  if(pos+length>buf.length)throw new Error('BACnet tag value is truncated');
  const value=buf.subarray(pos,pos+length);
  return {tagNumber,context,opening:false,closing:false,length,headerLength:pos-(arguments[1]||0),value,next:pos+length};
}
function unsignedFromBytes(data){
  if(!data.length)return 0;
  if(data.length>4)throw new Error('Unsigned BACnet value is longer than 32 bits');
  let n=0;for(const b of data)n=(n*256)+b;return n>>>0;
}
function locatePrivateTransferApdu(buf){
  const h=bacnetNpduApduOffset(buf);
  if(h&&!h.networkMessage&&h.offset<buf.length)return {apduOffset:h.offset,bvlc:true,npduControl:h.control};
  // Also accept a raw APDU pasted directly from a packet capture.
  for(let i=0;i<Math.min(buf.length,64);i++){
    const t=(buf[i]>>4)&0x0F;
    if((t===0&&i+4<buf.length&&buf[i+3]===0x12)||(t===3&&i+3<buf.length&&buf[i+2]===0x12)||(t===5&&i+3<buf.length&&buf[i+2]===0x12))return {apduOffset:i,bvlc:false,npduControl:null};
  }
  throw new Error('Could not locate a ConfirmedPrivateTransfer APDU (service choice 18 / 0x12)');
}
function analyzePrivateTransferFrame(inputHex){
  const clean=cleanHexInput(inputHex),buf=Buffer.from(clean,'hex'),loc=locatePrivateTransferApdu(buf),p=loc.apduOffset;
  const pduType=(buf[p]>>4)&0x0F;
  let invokeId=null,serviceChoice=null,payloadStart=null,pduName='Unknown';
  if(pduType===0){
    pduName='Confirmed-Request';
    if(p+4>buf.length)throw new Error('Truncated Confirmed-Request APDU');
    invokeId=buf[p+2];serviceChoice=buf[p+3];payloadStart=p+4;
  }else if(pduType===3){
    pduName='Complex-ACK';
    if(p+3>buf.length)throw new Error('Truncated Complex-ACK APDU');
    invokeId=buf[p+1];serviceChoice=buf[p+2];payloadStart=p+3;
  }else if(pduType===5){
    pduName='Error';
    if(p+3>buf.length)throw new Error('Truncated Error APDU');
    invokeId=buf[p+1];serviceChoice=buf[p+2];payloadStart=p+3;
  }else throw new Error(`APDU type ${pduType} is not a supported PrivateTransfer request/reply`);
  if(serviceChoice!==0x12)throw new Error(`APDU service choice is ${serviceChoice}, not ConfirmedPrivateTransfer (18)`);

  let cursor=payloadStart,vendorId=null,serviceNumber=null,parameters=Buffer.alloc(0),tags=[];
  while(cursor<buf.length){
    const start=cursor,tag=readBacnetTag(buf,cursor);cursor=tag.next;
    tags.push({offset:start,tagNumber:tag.tagNumber,context:tag.context,opening:tag.opening,closing:tag.closing,length:tag.length,valueHex:tag.value?hex(tag.value):''});
    if(tag.context&&!tag.opening&&!tag.closing&&tag.tagNumber===0&&vendorId===null){vendorId=unsignedFromBytes(tag.value);continue;}
    if(tag.context&&!tag.opening&&!tag.closing&&tag.tagNumber===1&&serviceNumber===null){serviceNumber=unsignedFromBytes(tag.value);continue;}
    if(tag.context&&tag.opening&&tag.tagNumber===2){
      // Vendor serviceParameters are deliberately preserved as opaque bytes. Some
      // Temco payloads are not safely parseable as generic BACnet application tags.
      // The outer context-2 closing tag terminates the serviceParameters field.
      const paramStart=cursor,lastClose=buf.lastIndexOf(0x2F);
      if(lastClose<paramStart)throw new Error('PrivateTransfer serviceParameters closing tag was not found');
      parameters=buf.subarray(paramStart,lastClose);
      tags.push({offset:lastClose,tagNumber:2,context:true,opening:false,closing:true,length:0,valueHex:''});
      cursor=lastClose+1;
      break;
    }
  }
  return {
    byteLength:buf.length,frameHex:hex(buf),bvlcFrame:loc.bvlc,apduOffset:p,pduType,pduName,invokeId,serviceChoice,
    vendorId,serviceNumber,temcoVendor:vendorId===148,parametersHex:hex(parameters),parametersByteLength:parameters.length,
    parameterHexDump:hexdump(parameters),tags,
    note:vendorId===148?'Temco Controls vendor ID 148 detected. The parameters are preserved byte-for-byte for comparison with T3000 captures.':'Vendor ID is not Temco 148 (or could not be decoded).'
  };
}
function buildConfirmedPrivateTransferPreview(vendorId,serviceNumber,parametersHex=''){
  const paramBytes=Buffer.from(String(parametersHex||'').replace(/[^0-9a-f]/gi,''),'hex');
  const params=[encodeContextUnsigned(0,vendorId),encodeContextUnsigned(1,serviceNumber)];
  if(paramBytes.length){params.push(Buffer.from([0x2E]),paramBytes,Buffer.from([0x2F]));}
  const apdu=Buffer.concat([Buffer.from([0x00,0x05,0x01,0x12]),...params]);
  const frame=buildBacnetUnicast(Buffer.concat([Buffer.from([0x01,0x04]),apdu]));
  return {vendorId,serviceNumber,parametersHex:hex(paramBytes),frameHex:hex(frame),byteLength:frame.length,note:'Preview only. This endpoint never transmits the vendor-specific packet.'};
}

function parseProgramHex(text){const clean=String(text||'').replace(/0x/gi,'').replace(/[^0-9a-f]/gi,'');if(!clean.length)throw new Error('No program data supplied');if(clean.length%2)throw new Error('Program hex must contain an even number of hexadecimal characters');return Buffer.from(clean,'hex');}
function normalizeProgramImage(buf){if(!Buffer.isBuffer(buf))buf=Buffer.from(buf||[]);if(buf.length>PROGRAM_IMAGE_BYTES)throw new Error(`Program image is ${buf.length} bytes; maximum is ${PROGRAM_IMAGE_BYTES}`);const image=Buffer.alloc(PROGRAM_IMAGE_BYTES,0);buf.copy(image,0);return image;}
function programBlocks(image){const n=normalizeProgramImage(image);return Array.from({length:PROGRAM_BLOCK_COUNT},(_,i)=>{const data=Buffer.from(n.subarray(i*PROGRAM_BLOCK_BYTES,(i+1)*PROGRAM_BLOCK_BYTES));return {index:i+1,offset:i*PROGRAM_BLOCK_BYTES,length:data.length,sha256:sha256(data),hex:data.toString('hex').toUpperCase()};});}
function programImageInfo(buf){const image=normalizeProgramImage(buf);return {byteLength:image.length,sha256:sha256(image),blocks:programBlocks(image).map(({index,offset,length,sha256})=>({index,offset,length,sha256}))};}
function validProgramSlot(slot){return Number.isInteger(slot)&&slot>=1&&slot<=PROGRAM_SLOT_COUNT;}
async function bridgeJson(pathname,payload){
  if(!PROGRAM_BRIDGE_URL)throw new Error('Verified program transport bridge is not configured. No controller request was sent.');
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),15000);
  try{
    const headers={'Content-Type':'application/json'}; if(PROGRAM_BRIDGE_TOKEN)headers['Authorization']='Bearer '+PROGRAM_BRIDGE_TOKEN;
    const response=await fetch(PROGRAM_BRIDGE_URL+pathname,{method:'POST',headers,body:JSON.stringify(payload),signal:controller.signal});
    const text=await response.text(); let data={}; try{data=text?JSON.parse(text):{}}catch{throw new Error('Program bridge returned invalid JSON');}
    if(!response.ok||data.ok===false)throw new Error(data.error||`Program bridge HTTP ${response.status}`);
    return data;
  }catch(e){if(e.name==='AbortError')throw new Error('Program bridge timeout');throw e;}finally{clearTimeout(timer);}
}
async function loadProgramFromController(systemId,slot){
  const direct=await loadProgramDirect(systemId,slot);
  return direct;
}
async function sendProgramToController(systemId,slot,image){
  if(!ENABLE_WRITES||!ENABLE_PROGRAM_WRITES)throw new Error('Program writes are locked. ENABLE_WRITES=true and ENABLE_PROGRAM_WRITES=true are both required.');
  const system=systems[systemId];if(!system)throw new Error('Unknown system');if(!validProgramSlot(slot))throw new Error('Program slot must be 1..16');
  image=normalizeProgramImage(image); const expectedHash=sha256(image); const blocks=programBlocks(image);
  const sent=await bridgeJson('/program/send',{system:systemId,slot,controller:{host:system.host,port:system.port,unitId:system.unitId},imageHex:image.toString('hex').toUpperCase(),sha256:expectedHash,blocks,writeCommand:116,verify:true});
  const verify=await loadProgramFromController(systemId,slot); const verifyImage=verify.image; const readBackHash=sha256(verifyImage);
  if(!verifyImage.equals(image))throw new Error(`Program verification FAILED: sent ${expectedHash}, read back ${readBackHash}`);
  return {system:systemId,slot,byteLength:image.length,sha256:expectedHash,readBackSha256:readBackHash,verified:true,bridgeResult:sent};
}
function hexdump(buf){const out=[];for(let i=0;i<buf.length;i+=16){const b=buf.subarray(i,i+16);out.push(i.toString(16).padStart(4,'0').toUpperCase()+'  '+[...b].map(x=>x.toString(16).padStart(2,'0').toUpperCase()).join(' ').padEnd(47)+'  '+[...b].map(x=>(x>=32&&x<=126)?String.fromCharCode(x):'.').join(''));}return out.join('\n');}
function decodeProgramBuffer(buf){const strings=[];let cur='';for(const b of buf){if((b>=32&&b<=126)||b===9){cur+=String.fromCharCode(b)}else{if(cur.trim().length>=3)strings.push(cur.trim());cur=''}}if(cur.trim().length>=3)strings.push(cur.trim());const unique=[...new Set(strings)];return{byteLength:buf.length,printableStrings:unique,preview:unique.join('\n'),hexDump:hexdump(buf),note:'Raw bytes are preserved. Printable text extraction works now; full Temco/Bravo token-to-Control-Basic decoding still requires the exact program memory/token map.'};}
function sendJson(res,status,obj){const body=Buffer.from(JSON.stringify(obj));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':body.length,'Cache-Control':'no-store'});res.end(body)}
function serveStatic(req,res){let rel=req.url.split('?')[0];if(rel==='/')rel='/index.html';const safe=path.normalize(rel).replace(/^([.][.][/\\])+/,'');const root=path.join(__dirname,'public'),file=path.join(root,safe);if(!file.startsWith(root)){res.writeHead(403);return res.end('Forbidden')}fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);return res.end('Not found')}const ext=path.extname(file).toLowerCase();const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-store, no-cache, must-revalidate, max-age=0','Pragma':'no-cache','Expires':'0'});res.end(data)})}
async function readBody(req,max=1024*1024){return await new Promise((resolve,reject)=>{let size=0,chunks=[];req.on('data',c=>{size+=c.length;if(size>max){reject(new Error('Request too large'));req.destroy();return}chunks.push(c)});req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject)})}

const server=http.createServer(async(req,res)=>{try{
  const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  if(u.pathname==='/healthz')return sendJson(res,200,{ok:true,app:'Greenair BACnet Explorer Web',version:VERSION});
  if(u.pathname==='/api/status')return sendJson(res,200,{ok:true,app:'Greenair BACnet Explorer Web',version:VERSION,transport:'Modbus TCP via Render',writesEnabled:ENABLE_WRITES,programWritesEnabled:ENABLE_WRITES&&ENABLE_PROGRAM_WRITES,programTransportReady:PROGRAM_READ_TRANSPORT_READY,bacnet:{host:BACNET_HOST,port:BACNET_PORT,expectedDeviceInstance:BACNET_DEVICE_INSTANCE,vendorId:148,probeOnly:true,privateTransferAnalyzer:true},systems:Object.values(systems).map(s=>({id:s.id,name:s.name,host:s.host,port:s.port,unitId:s.unitId}))});
  if(u.pathname==='/api/connect')return sendJson(res,200,{ok:true,timestamp:new Date().toISOString(),results:await Promise.all(Object.values(systems).map(connectionTest))});
  const cat=u.pathname.match(/^\/api\/system\/(planks|tbeams)\/(inputs|outputs|overrides|variables)$/);if(cat)return sendJson(res,200,await readCategory(cat[1],cat[2]));
  const raw=u.pathname.match(/^\/api\/raw\/(planks|tbeams)$/);if(raw){const s=systems[raw[1]],register=Number(u.searchParams.get('register')),quantity=Math.min(125,Math.max(1,Number(u.searchParams.get('quantity')||1)));if(!Number.isInteger(register)||register<0||register>65535)return sendJson(res,400,{error:'register must be 0..65535'});const r=await modbusReadHolding({host:s.host,port:s.port,unitId:s.unitId,startRegister:register,quantity});return sendJson(res,200,{system:s.id,register,quantity,...r});}
  const wr=u.pathname.match(/^\/api\/system\/(planks|tbeams)\/write$/);if(wr&&req.method==='POST'){const body=JSON.parse((await readBody(req)).toString('utf8')||'{}');return sendJson(res,200,await guardedWrite(wr[1],String(body.pointId||''),Number(body.value)));}
  if(u.pathname==='/api/bacnet/whois') { try{return sendJson(res,200,await bacnetWhoIsProbe());}catch(e){return sendJson(res,503,{ok:false,error:e.message,host:BACNET_HOST,port:BACNET_PORT});} }
  if(u.pathname==='/api/bacnet/private-transfer-test') { try{return sendJson(res,200,await bacnetPrivateTransferNoEffectTest());}catch(e){return sendJson(res,503,{ok:false,error:e.message,host:BACNET_HOST,port:BACNET_PORT,safeTest:true});} }
  if(u.pathname==='/api/bacnet/private-transfer-preview'&&req.method==='POST'){const body=JSON.parse((await readBody(req)).toString('utf8')||'{}');try{return sendJson(res,200,{ok:true,...buildConfirmedPrivateTransferPreview(Number(body.vendorId??148),Number(body.serviceNumber??0),String(body.parametersHex||''))});}catch(e){return sendJson(res,400,{ok:false,error:e.message});}}
  if(u.pathname==='/api/bacnet/private-transfer-analyze'&&req.method==='POST'){const body=JSON.parse((await readBody(req)).toString('utf8')||'{}');try{return sendJson(res,200,{ok:true,...analyzePrivateTransferFrame(String(body.hex||body.frameHex||''))});}catch(e){return sendJson(res,400,{ok:false,error:e.message});}}
  if(u.pathname==='/api/program/status')return sendJson(res,200,{ok:true,version:VERSION,slotCount:PROGRAM_SLOT_COUNT,imageBytes:PROGRAM_IMAGE_BYTES,blockBytes:PROGRAM_BLOCK_BYTES,blockCount:PROGRAM_BLOCK_COUNT,transportReady:PROGRAM_READ_TRANSPORT_READY,readTransport:'direct-temco-bacnet-ip',writeTransportReady:PROGRAM_WRITE_TRANSPORT_READY,writesEnabled:ENABLE_WRITES,programWritesEnabled:ENABLE_WRITES&&ENABLE_PROGRAM_WRITES&&PROGRAM_WRITE_TRANSPORT_READY,metadataCommand:7,readCommand:16,writeCommand:116,privateServiceNumber:1,vendorId:148,bridgeConfigured:PROGRAM_WRITE_TRANSPORT_READY,bridgeUrl:PROGRAM_BRIDGE_URL||null,note:'Controller Load uses the direct read-only Temco BACnet/IP transport. Program Send remains locked behind the separately verified write bridge and both write flags.'});
  if(u.pathname==='/api/program/package-diagnostic'&&req.method==='GET'){
    const slot=Number(u.searchParams.get('slot')||1),system=String(u.searchParams.get('system')||'planks');
    if(!systems[system]||!validProgramSlot(slot))return sendJson(res,400,{ok:false,error:'Invalid controller or slot'});
    try{
      const meta=await readProgramMetadataDirect(slot);
      const size=Math.min(65535,Math.max(400,Math.min(PROGRAM_IMAGE_BYTES,meta.metadata.bytes||400))+10);
      const result=await temcoPrivateRead({command:16,startInstance:slot-1,endInstance:slot-1,entitySize:size,timeoutMs:5500});
      return sendJson(res,200,{ok:true,version:VERSION,system,slot,metadata:meta.metadata,requestedEntitySize:size,replyCount:result.replyCount,errors:result.errors.map(e=>({error:e.error})),acks:result.acks.map(a=>({command:a.command,startInstance:a.startInstance,endInstance:a.endInstance,entitySize:a.entitySize,packageIndex:(a.entitySize>>9)&127,dataLength:a.data.length,totalLength:a.totalLength,transport:a.transport,first32Hex:hex(a.data.subarray(0,32))})),note:'Read-only diagnostics; no program writes or changes to the transfer algorithm.'});
    }catch(e){return sendJson(res,503,{ok:false,version:VERSION,system,slot,error:e.message});}
  }
  if(u.pathname==='/api/program/direct-probe'&&req.method==='GET'){const slot=Number(u.searchParams.get('slot')||1),system=String(u.searchParams.get('system')||'planks');try{const result=await loadProgramDirect(system,slot);return sendJson(res,200,{ok:true,version:VERSION,system,slot,metadata:result.metadata,embeddedLength:result.embeddedLength,packages:result.packages,attempts:result.attempts,sha256:sha256(result.image),first64Hex:hex(result.image.subarray(0,64))});}catch(e){return sendJson(res,503,{ok:false,version:VERSION,system,slot,error:e.message,bacnetHost:BACNET_HOST,bacnetPort:BACNET_PORT});}}
  if(u.pathname==='/api/program/prepare'&&req.method==='POST'){const body=JSON.parse((await readBody(req)).toString('utf8')||'{}');const slot=Number(body.slot||1);if(!validProgramSlot(slot))return sendJson(res,400,{ok:false,error:'Program slot must be 1..16'});try{const src=parseProgramHex(body.hex||'');const image=normalizeProgramImage(src);return sendJson(res,200,{ok:true,slot,sourceBytes:src.length,imageHex:image.toString('hex').toUpperCase(),...programImageInfo(image)});}catch(e){return sendJson(res,400,{ok:false,error:e.message});}}
  if(u.pathname==='/api/program/controller/load'&&req.method==='POST'){const body=JSON.parse((await readBody(req)).toString('utf8')||'{}');const slot=Number(body.slot||1);try{const result=await loadProgramFromController(String(body.system||'planks'),slot);const image=result.image;return sendJson(res,200,{ok:true,system:result.system,slot,metadata:result.metadata,embeddedLength:result.embeddedLength,packages:result.packages,attempts:result.attempts,controller:result.controller,imageHex:image.toString('hex').toUpperCase(),...programImageInfo(image)});}catch(e){return sendJson(res,503,{ok:false,error:e.message,transportReady:PROGRAM_READ_TRANSPORT_READY,readTransport:'direct-temco-bacnet-ip'});}}
  if(u.pathname==='/api/program/controller/send'&&req.method==='POST'){const body=JSON.parse((await readBody(req)).toString('utf8')||'{}');const slot=Number(body.slot||1);try{const image=normalizeProgramImage(parseProgramHex(body.hex||''));const result=await sendProgramToController(String(body.system||'planks'),slot,image);return sendJson(res,200,{ok:true,...result});}catch(e){return sendJson(res,503,{ok:false,error:e.message,transportReady:PROGRAM_WRITE_TRANSPORT_READY,writesEnabled:ENABLE_WRITES,programWritesEnabled:ENABLE_WRITES&&ENABLE_PROGRAM_WRITES&&PROGRAM_WRITE_TRANSPORT_READY});}}
  if(u.pathname==='/api/program/decode'&&req.method==='POST'){const body=JSON.parse((await readBody(req)).toString('utf8')||'{}');const hex=String(body.hex||'').replace(/[^0-9a-f]/gi,'');if(!hex)return sendJson(res,200,{ok:true,empty:true,rawHex:'',byteLength:0,printableStrings:[],preview:'Waiting for program data.',hexDump:'',note:'No raw program bytes loaded yet. Use Read on a verified register block or paste captured Bravo program bytes.'});if(hex.length%2)return sendJson(res,400,{error:'Program data contains an incomplete hex byte. Check the final character.'});const buf=Buffer.from(hex,'hex');return sendJson(res,200,{ok:true,rawHex:buf.toString('hex').toUpperCase(),...decodeProgramBuffer(buf)});}
  if(u.pathname.startsWith('/api/'))return sendJson(res,404,{error:'API route not found'});serveStatic(req,res);
}catch(e){console.error('[Explorer]',e);sendJson(res,500,{error:e.message||String(e)})}});
server.listen(PORT,'0.0.0.0',()=>{console.log(`Greenair BACnet Explorer Web v${VERSION}`);console.log(`Listening on 0.0.0.0:${PORT}`);console.log(`Writes: ${ENABLE_WRITES?'ENABLED':'LOCKED'}`);console.log(`BACnet probe -> ${BACNET_HOST}:${BACNET_PORT} expected device ${BACNET_DEVICE_INSTANCE}`);for(const s of Object.values(systems))console.log(`${s.name} -> ${s.host}:${s.port} unit ${s.unitId}`)});