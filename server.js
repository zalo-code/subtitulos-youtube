import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';

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
  console.log('Procesando videoId:', videoId, 'startTime:', startTime);

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
    console.log('MP3 response:', JSON.stringify(mp3Data).substring(0, 200));
    
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
        console.log('Audio URL obtenida:', audioUrl);
        break;
      }
    }
    if (!audioUrl) throw new Error('Timeout esperando audio en trozo ' + startTime);

    // 3. Descargar audio
    console.log('Descargando audio...');
    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) throw new Error('Error descargando audio: ' + audioRes.status);
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
    console.log('Audio descargado, tamaño:', audioBuffer.length, 'bytes');

    // 4. Enviar a Groq Whisper
    console.log('Enviando a Groq...');
    const formData = new FormData();
    formData.append('file', audioBuffer, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
    formData.append('model', 'whisper-large-v3');
    formData.append('language', 'ca');
    formData.append('task', 'translate');
    formData.append('response_format', 'verbose_json');

    const groqRes = await fetch(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          ...formData.getHeaders()
        },
        body: formData,
      }
    );
    const groqData = await groqRes.json();
    console.log('Groq respuesta:', JSON.stringify(groqData).substring(0, 300));

    if (groqData.error) throw new Error('Groq error: ' + groqData.error.message);

    const segments = (groqData.segments || []).map(s => ({
      start: s.start + startTime,
      end: s.end + startTime,
      text: s.text,
    }));

    console.log('Segmentos generados:', segments.length);
    res.json({ segments, nextStart: startTime + 600 });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
