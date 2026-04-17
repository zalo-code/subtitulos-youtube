import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());
app.use(express.static('.'));

app.post('/api/transcribe', async (req, res) => {
  const { videoId, startTime = 0 } = req.body;

  try {
    // 1. Iniciar descarga del trozo
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

    // 2. Esperar hasta que el audio esté listo (hasta 10 minutos)
    let audioUrl = null;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 10000));
      const progressRes = await fetch(progressUrl);
      const progressData = await progressRes.json();
      console.log('Progress check:', JSON.stringify(progressData));
      if (progressData.url) { audioUrl = progressData.url; break; }
      if (progressData.download_url) { audioUrl = progressData.download_url; break; }
      if (progressData.content) { audioUrl = progressData.content; break; }
    }
    if (!audioUrl) throw new Error('Timeout en trozo ' + startTime);

    // 3. Descargar el audio
    const audioRes = await fetch(audioUrl);
    const audioBuffer = await audioRes.arrayBuffer();
    const audioBlob = new Blob([audioBuffer], { type: 'audio/mpeg' });

    // 4. Transcribir con Groq Whisper
    const formData = new FormData();
    formData.append('file', audioBlob, 'audio.mp3');
    formData.append('model', 'whisper-large-v3');
    formData.append('language', 'ca');
    formData.append('task', 'translate');
    formData.append('response_format', 'verbose_json');

    const groqRes = await fetch(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
        body: formData,
      }
    );
    const groqData = await groqRes.json();

    // 5. Ajustar timestamps
    const segments = (groqData.segments || []).map(s => ({
      start: s.start + startTime,
      end: s.end + startTime,
      text: s.text,
    }));

    res.json({ segments, nextStart: startTime + 600 });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
