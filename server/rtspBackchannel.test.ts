import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  encodePcmToG711,
  extractPcm16Mono8k,
  parseBackchannelTrackFromSdp,
  rtspBackchannelPool,
} from './rtspBackchannel.ts';

function buildTestWav(samplesCount = 160, sampleRate = 16000): Buffer {
  const dataSize = samplesCount * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samplesCount; i++) {
    buf.writeInt16LE(Math.round(Math.sin(i / 8) * 12000), 44 + i * 2);
  }
  return buf;
}

test('extractPcm16Mono8k resamples 16kHz WAV to 8kHz and encodes to G.711 PCMU', () => {
  const wav = buildTestWav(320, 16000);
  const pcm8k = extractPcm16Mono8k(wav);
  assert.equal(pcm8k.length, 160);
  const ulaw = encodePcmToG711(pcm8k, 'PCMU');
  assert.equal(ulaw.length, 160);
});

test('parseBackchannelTrackFromSdp extracts sendonly audio track and control URL', () => {
  const sdp = [
    'v=0',
    'o=- 0 0 IN IP4 192.168.1.50',
    's=Session',
    'm=video 0 RTP/AVP 96',
    'a=control:trackID=1',
    'a=recvonly',
    'm=audio 0 RTP/AVP 0',
    'a=rtpmap:0 PCMU/8000',
    'a=control:trackID=2',
    'a=sendonly',
  ].join('\r\n');

  const track = parseBackchannelTrackFromSdp(sdp, 'rtsp://192.168.1.50:554/live');
  assert.ok(track);
  assert.equal(track.codec, 'PCMU');
  assert.equal(track.payloadType, 0);
  assert.equal(track.controlUrl, 'rtsp://192.168.1.50:554/live/trackID=2');
});

test('rtspBackchannelPool performs DESCRIBE -> SETUP -> PLAY and streams TCP interleaved RTP frames', async () => {
  let receivedRtpBytes = 0;
  let sawBackchannelRequire = false;

  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length > 0) {
        if (buf[0] === 0x24) {
          if (buf.length < 4) return;
          const len = buf.readUInt16BE(2);
          if (buf.length < 4 + len) return;
          receivedRtpBytes += len - 12;
          buf = buf.subarray(4 + len);
          continue;
        }
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const reqText = buf.subarray(0, idx).toString('utf8');
        buf = buf.subarray(idx + 4);
        const cseqMatch = reqText.match(/CSeq:\s*(\d+)/i);
        const cseq = cseqMatch ? cseqMatch[1] : '1';
        if (reqText.includes('www.onvif.org/ver20/backchannel')) {
          sawBackchannelRequire = true;
        }

        if (reqText.startsWith('DESCRIBE')) {
          const sdp =
            'v=0\r\nm=audio 0 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\na=control:track2\r\na=sendonly\r\n';
          socket.write(
            `RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nContent-Type: application/sdp\r\nContent-Length: ${Buffer.byteLength(sdp)}\r\n\r\n${sdp}`
          );
        } else if (reqText.startsWith('SETUP')) {
          socket.write(
            `RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nSession: 123456\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n`
          );
        } else if (reqText.startsWith('PLAY')) {
          socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nSession: 123456\r\n\r\n`);
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as net.AddressInfo;
  const rtspUrl = `rtsp://127.0.0.1:${addr.port}/live`;

  const res = await rtspBackchannelPool.sendAudio(rtspUrl, buildTestWav(320, 16000));
  assert.equal(res.ok, true);
  assert.equal(res.codec, 'PCMU');
  assert.equal(res.bytesSent, 160);

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(sawBackchannelRequire, true);
  assert.equal(receivedRtpBytes, 160);

  rtspBackchannelPool.stop(rtspUrl);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
