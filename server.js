import express from 'express';
import fetch from 'node-fetch';

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

app.post('/api/transcribe', async (req, res) => {
  const { videoId, startTime = 0 } = req.body;
  console.log('Procesando:', videoId, 'desde:', startTime);

  try {
    // 1. Iniciar descarga
    const mp3Res = await fetch(
      `https://youtube-info-download-api.p.rapidapi.com/ajax/download.php?format=mp3&add_info=0&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${videoId}&audio_quality=128&allow_extended_duration=1&no_merge=false&audio_language=en&start_time=${startTime}&end_time=${startTime + 600}`,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-rapidapi-host': 'youtube-info-download-api.p.rapidapi.com',
          'x-rapidapi-key': process.env.RAPIDAPI_KEY,
        }
      }
    );
    const mp3Data = await mp3Res.json();
    const progressUrl = mp3Data.progress_url;
    if (!progressUrl) throw new Error('Sin progress_url: ' + JSON.stringify(mp3Data));

    // 2. Esperar audio
    let audioUrl = null;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const progressRes = await fetch(progressUrl);
      const progressData = await progressRes.json();
      console.log('Progress:', progressData.text, progressData.progress);
      if (progressData.success === 1 && progressData.download_url) {
        audioUrl = progressData.download_url;
        break;
      }
    }
    if (!audioUrl) throw new Error('Timeout en trozo ' + startTime);

    // 3. Descargar audio
    console.log('Descargando audio:', audioUrl);
    const audioRes = await fetch(audioUrl);
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
    console.log('Audio descargado:', audioBuffer.length, 'bytes');

    // 4. Enviar a Groq con boundary manual
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
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
