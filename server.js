import express from 'express';
import fetch from 'node-fetch';
import YTDlpWrapModule from 'yt-dlp-wrap';
const YTDlpWrap = YTDlpWrapModule.default || YTDlpWrapModule;
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});
app.use(express.static('.'));

// Descargar binario de yt-dlp al arrancar
const ytDlpBinaryPath = join(tmpdir(), 'yt-dlp');
const ytDlpWrap = new YTDlpWrap(ytDlpBinaryPath);

console.log('Descargando binario yt-dlp...');
YTDlpWrap.downloadFromGithub(ytDlpBinaryPath).then(() => {
  console.log('yt-dlp listo en:', ytDlpBinaryPath);
}).catch(e => console.error('Error descargando yt-dlp:', e.message));

app.post('/api/transcribe', async (req, res) => {
  const { videoId, startTime = 0 } = req.body;
  const outputPath = join(tmpdir(), `audio_${videoId}_${startTime}.mp3`);
  console.log('Procesando:', videoId, 'desde:', startTime);

  try {
    console.log('Descargando con yt-dlp...');
    await ytDlpWrap.execPromise([
      `https://www.youtube.com/watch?v=${videoId}`,
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '128K',
      '--download-sections', `*${startTime}-${startTime + 600}`,
      '--force-keyframes-at-cuts',
      '-o', outputPath,
    ]);
    console.log('Audio descargado');

    const { readFileSync } = await import('fs');
    const audioBuffer = readFileSync(outputPath);
    console.log('Audio leído:', audioBuffer.length, 'bytes');

    const boundary = '----FormBoundary' + Math.random().toString(36);
    const bodyParts = [];
    bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3\r\n`));
    bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nca\r\n`));
    bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="task"\r\n\r\ntranslate\r\n`));
    bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n`));
    bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`));
    bodyParts.push(audioBuffer);
    bodyParts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(bodyParts);

    console.log('Enviando a Groq...');
    const groqRes = await fetch(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
        body,
      }
    );
    const groqData = await groqRes.json();
    console.log('Groq:', JSON.stringify(groqData).substring(0, 300));

    if (groqData.error) throw new Error('Groq error: ' + JSON.stringify(groqData.error));

    const segments = (groqData.segments || []).map(s => ({
      start: s.start + startTime,
      end: s.end + startTime,
      text: s.text,
    }));

    console.log('Segmentos:', segments.length);
    res.json({ segments, nextStart: startTime + 600 });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    if (existsSync(outputPath)) unlinkSync(outputPath);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
