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
  const { videoId } = req.body;
  console.log('Procesando:', videoId);

  try {
    // 1. Obtener URL directa del audio via RapidAPI
    console.log('Obteniendo audio de RapidAPI...');
    const mp3Res = await fetch(
      `https://youtube-info-download-api.p.rapidapi.com/ajax/download.php?format=mp3&add_info=0&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${videoId}&audio_quality=128&allow_extended_duration=1&no_merge=false&audio_language=en`,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-rapidapi-host': 'youtube-info-download-api.p.rapidapi.com',
          'x-rapidapi-key': process.env.RAPIDAPI_KEY,
        }
      }
    );
    const mp3Data = await mp3Res.json();
    console.log('RapidAPI response:', JSON.stringify(mp3Data).substring(0, 200));

    const progressUrl = mp3Data.progress_url;
    if (!progressUrl) throw new Error('Sin progress_url: ' + JSON.stringify(mp3Data));

    // 2. Esperar audio listo
    let audioUrl = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const progressRes = await fetch(progressUrl);
      const progressData = await progressRes.json();
      console.log('Progress:', progressData.text, progressData.progress);
      if (progressData.success === 1 && progressData.download_url) {
        audioUrl = progressData.download_url;
        console.log('Audio URL:', audioUrl);
        break;
      }
    }
    if (!audioUrl) throw new Error('Timeout obteniendo audio');

    // 3. Enviar URL directa a AssemblyAI
    console.log('Enviando a AssemblyAI...');
    const submitRes = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        'Authorization': process.env.ASSEMBLYAI_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audio_url: audioUrl,
        language_code: 'ca',
        speech_models: ['universal-2'],
      }),
    });
    const submitData = await submitRes.json();
    console.log('AssemblyAI submit:', JSON.stringify(submitData).substring(0, 200));
    if (submitData.error) throw new Error('AssemblyAI error: ' + submitData.error);
    const transcriptId = submitData.id;

    // 4. Esperar transcripción
    let transcript = null;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 10000));
      const pollRes = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
        headers: { 'Authorization': process.env.ASSEMBLYAI_KEY },
      });
      const pollData = await pollRes.json();
      console.log('Estado:', pollData.status);
      if (pollData.status === 'completed') {
        transcript = pollData;
        break;
      } else if (pollData.status === 'error') {
        throw new Error('AssemblyAI transcription error: ' + pollData.error);
      }
    }
    if (!transcript) throw new Error('Timeout esperando transcripción');

    // 5. Traducir al español con Groq en chunks
    console.log('Traduciendo con Groq...');
    const words = transcript.words || [];
    const segments = [];
    let chunk = [];

    for (const word of words) {
      chunk.push(word);
      if (chunk.length >= 20 || word.text.includes('.') || word.text.includes(',')) {
        const text = chunk.map(w => w.text).join(' ');
        const start = chunk[0].start / 1000;
        const end = chunk[chunk.length - 1].end / 1000;

        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'llama3-8b-8192',
            messages: [
              { role: 'system', content: 'Traduce del catalán al español. Responde solo con la traducción, sin explicaciones.' },
              { role: 'user', content: text }
            ],
            max_tokens: 200,
          }),
        });
        const groqData = await groqRes.json();
        const translated = groqData.choices?.[0]?.message?.content || text;
        segments.push({ start, end, text: translated });
        chunk = [];
      }
    }

    console.log('Segmentos:', segments.length);
    res.json({ segments });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
